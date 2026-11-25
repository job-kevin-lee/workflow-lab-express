import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Router, json, type ErrorRequestHandler } from 'express'
import { loadWorkflowBodies } from '@ideawithai/workflow-express'
import {
  isId,
  isJsonObject,
  isRecord,
  validateWorkflow,
  type JsonObject,
  type NodeDescriptor,
  type WorkflowDocument,
  type WorkflowRun
} from '@ideawithai/workflow-express/schema'

export interface TriggerSettings {
  scheduleSeconds: number | null
  webhookEnabled: boolean
}

export interface TriggerStatus extends TriggerSettings {
  lastSchedule?: { at: string; runId?: string; error?: string }
}

interface TriggerOptions {
  base: string
  settingsPath?: string
  catalog: readonly NodeDescriptor[]
  getWorkflow: (id: string) => WorkflowDocument | null
  getRun: (id: string) => Promise<WorkflowRun | null>
}

const disabled: TriggerSettings = { scheduleSeconds: null, webhookEnabled: false }
const maxScheduleSeconds = 86_400
const eventHeader = 'X-Workflow-Event-Id'

class TriggerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function parseSettings(value: unknown): TriggerSettings | null {
  if (!isRecord(value) || typeof value.webhookEnabled !== 'boolean') return null
  const seconds = value.scheduleSeconds
  if (
    seconds !== null &&
    (typeof seconds !== 'number' ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > maxScheduleSeconds)
  )
    return null

  return { scheduleSeconds: seconds, webhookEnabled: value.webhookEnabled }
}

function loadSettings(file?: string): Map<string, TriggerSettings> {
  const settings = new Map<string, TriggerSettings>()
  if (!file) return settings
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return settings
    throw error
  }

  const data: unknown = JSON.parse(raw)
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.workflows)) {
    throw new Error('Invalid workflow trigger settings.')
  }
  for (const [id, value] of Object.entries(data.workflows)) {
    const record = parseSettings(value)
    if (!isId(id) || !record) throw new Error('Invalid workflow trigger settings.')
    settings.set(id, record)
  }
  return settings
}

function saveSettings(file: string | undefined, settings: Map<string, TriggerSettings>): void {
  if (!file) return
  const temporaryPath = `${file}.${randomUUID()}.tmp`
  writeFileSync(
    temporaryPath,
    JSON.stringify({ version: 1, workflows: Object.fromEntries(settings) }) + '\n',
    {
      flag: 'wx',
      mode: 0o600
    }
  )
  renameSync(temporaryPath, file)
}

function eventRunId(kind: 'schedule' | 'webhook', workflowId: string, eventId: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([workflowId, eventId]))
    .digest('hex')
  return `${kind}:${hash}`
}

export function createWorkflowTriggers(options: TriggerOptions): {
  router: Router
  startSchedules: () => void
} {
  let settings = loadSettings(options.settingsPath)
  const timers = new Map<string, ReturnType<typeof setInterval>>()
  const inFlight = new Set<string>()
  const lastSchedule = new Map<string, NonNullable<TriggerStatus['lastSchedule']>>()
  const router = Router()

  function requireWorkflow(id: string): WorkflowDocument {
    const workflow = options.getWorkflow(id)
    if (!workflow)
      throw new TriggerError(
        404,
        'workflow_not_found',
        'The saved workflow is no longer available.'
      )
    return workflow
  }

  function status(id: string): TriggerStatus {
    const recent = lastSchedule.get(id)
    return { ...(settings.get(id) ?? disabled), ...(recent && { lastSchedule: recent }) }
  }

  async function startRun(
    workflow: WorkflowDocument,
    runId: string,
    input: JsonObject
  ): Promise<{ status: number; data: unknown }> {
    const existing = await options.getRun(runId)
    const response = await fetch(
      `${options.base}/workflows/${encodeURIComponent(workflow.id)}/runs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, revision: existing?.revision ?? workflow.revision, input }),
        signal: AbortSignal.timeout(45_000)
      }
    )
    return { status: response.status, data: await response.json() }
  }

  function stopSchedule(id: string): void {
    const timer = timers.get(id)
    if (timer) clearInterval(timer)
    timers.delete(id)
  }

  async function tick(id: string, seconds: number): Promise<void> {
    if (inFlight.has(id)) return
    const workflow = options.getWorkflow(id)
    if (!workflow) {
      stopSchedule(id)
      return
    }
    const at = new Date().toISOString()
    const slot = Math.floor(Date.now() / (seconds * 1000))
    const runId = eventRunId('schedule', id, String(slot))
    inFlight.add(id)
    try {
      const response = await startRun(workflow, runId, {})
      const error =
        isRecord(response.data) && typeof response.data.error === 'string'
          ? response.data.error.replaceAll('_', ' ')
          : undefined
      lastSchedule.set(
        id,
        response.status < 400
          ? { at, runId }
          : { at, error: error ?? 'Could not start the scheduled run.' }
      )
    } catch {
      lastSchedule.set(id, { at, error: 'Could not reach the workflow API.' })
    } finally {
      inFlight.delete(id)
    }
  }

  function schedule(id: string, seconds: number | null): void {
    stopSchedule(id)
    if (seconds === null || !options.getWorkflow(id)) return
    const timer = setInterval(() => void tick(id, seconds), seconds * 1000)
    timer.unref()
    timers.set(id, timer)
  }

  router.use(json({ limit: '256kb' }))
  router.get('/workflows/:id/triggers', (req, res) => {
    requireWorkflow(req.params.id)
    res.json(status(req.params.id))
  })
  router.put('/workflows/:id/triggers', async (req, res) => {
    const workflow = requireWorkflow(req.params.id)
    const configuration = parseSettings(req.body)
    if (!configuration) {
      throw new TriggerError(
        422,
        'invalid_trigger_settings',
        'Enter a schedule interval between 1 and 86,400 seconds, or disable the schedule.'
      )
    }
    if (
      (configuration.scheduleSeconds !== null || configuration.webhookEnabled) &&
      (validateWorkflow(workflow.definition, options.catalog).length ||
        (
          await loadWorkflowBodies(
            workflow.definition.nodes,
            options.catalog,
            options.getWorkflow,
            workflow.id
          )
        ).issues.length)
    ) {
      throw new TriggerError(
        422,
        'invalid_workflow',
        'Save a runnable workflow before enabling triggers.'
      )
    }

    const previous = settings.get(workflow.id) ?? disabled
    const updated = new Map(settings)
    if (configuration.scheduleSeconds === null && !configuration.webhookEnabled)
      updated.delete(workflow.id)
    else updated.set(workflow.id, configuration)
    saveSettings(options.settingsPath, updated)
    settings = updated
    if (previous.scheduleSeconds !== configuration.scheduleSeconds)
      schedule(workflow.id, configuration.scheduleSeconds)
    res.json(status(workflow.id))
  })
  router.post('/workflows/:id/webhook', async (req, res) => {
    const workflow = requireWorkflow(req.params.id)
    if (!settings.get(workflow.id)?.webhookEnabled) {
      throw new TriggerError(
        409,
        'webhook_disabled',
        'Enable this workflow’s webhook before using it.'
      )
    }
    const eventId = req.get(eventHeader)
    if (!isId(eventId)) {
      throw new TriggerError(400, 'invalid_event_id', `Provide a unique ${eventHeader} header.`)
    }
    const input: unknown = req.body === undefined ? {} : req.body
    if (!isJsonObject(input)) {
      throw new TriggerError(
        400,
        'invalid_webhook_input',
        'Send a JSON object as the webhook payload.'
      )
    }

    const result = await startRun(workflow, eventRunId('webhook', workflow.id, eventId), input)
    res.status(result.status).json(result.data)
  })

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof TriggerError)
      res.status(error.status).json({ error: error.code, message: error.message })
    else if (error?.type === 'entity.parse.failed') {
      res
        .status(400)
        .json({ error: 'invalid_json', message: 'The request does not contain valid JSON.' })
    } else if (error?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: 'webhook_input_too_large', message: 'The webhook input exceeds 256 KB.' })
    } else next(error)
  }
  router.use(handleError)

  return {
    router,
    startSchedules() {
      for (const [id, { scheduleSeconds }] of settings) schedule(id, scheduleSeconds)
    }
  }
}
