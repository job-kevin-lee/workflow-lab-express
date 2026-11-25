import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router, json } from 'express'
import type { ErrorRequestHandler } from 'express'
import { WorkflowNodeError } from './node-error.js'
import {
  canUseAsBody,
  isId,
  httpRequestHeadersForLog,
  isHumanInputValue,
  isJsonObject,
  isRecord,
  isVersion,
  isWorkflowDefinition,
  nodeKey,
  matchesConfigField,
  matchesField,
  resolveInputBinding,
  validateWorkflow,
  workflowRunStatuses,
  workflowWriteRequestLimit,
  type JsonObject,
  type JsonValue,
  type NodeDescriptor,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowHttpRequest,
  type WorkflowHumanInput,
  type WorkflowNodeTestResult,
  type WorkflowRun,
  type WorkflowTestFixture,
  type WorkflowWait
} from './schema.js'
import type { WorkflowStore } from './store.js'
import { findWorkflowBodyReferences, loadWorkflowBodies } from './workflow-bodies.js'

export * from './schema.js'
export { WorkflowNodeError } from './node-error.js'
export { createMemoryWorkflowStore, type WorkflowRemoval, type WorkflowStore } from './store.js'
export { loadWorkflowBodies } from './workflow-bodies.js'

export interface WorkflowNodeContext {
  runId: string
  workflowRunId?: string
  nodeId: string
  input: JsonObject
  config: JsonObject
  inputs: JsonObject
  signal: AbortSignal
  runBody?: (workflowId: string, input: JsonObject) => Promise<JsonObject>
  loopProgress?: { index: number; previous: JsonValue }
}

export type WorkflowNodeResult =
  | { port: string | null; output: JsonObject; httpRequest?: WorkflowHttpRequest }
  | { waitForCall: { port: string; message: string; form?: WorkflowHumanInput } }

export interface WorkflowNodeRegistration {
  descriptor: NodeDescriptor
  testSafe?: true
  execute(context: WorkflowNodeContext): WorkflowNodeResult | Promise<WorkflowNodeResult>
}

export interface WorkflowRouterOptions {
  store: WorkflowStore
  nodes: readonly WorkflowNodeRegistration[]
  signal?: AbortSignal
  runTimeoutMs?: number
  enableWorkflowTests?: boolean
  onNodeError?: (error: unknown, context: { runId: string; nodeId: string }) => void
}

type WorkflowFixtures = ReadonlyMap<string, WorkflowTestFixture>

function isWorkflowFixture(value: unknown): value is WorkflowTestFixture {
  return (
    isRecord(value) &&
    (value.workflowId === undefined || isId(value.workflowId)) &&
    isId(value.nodeId) &&
    (value.port === null || isId(value.port)) &&
    isJsonObject(value.output)
  )
}

const fixtureKey = (workflowId: string, nodeId: string): string =>
  JSON.stringify([workflowId, nodeId])

function fixtureRequired(label: string): WorkflowNodeError {
  return new WorkflowNodeError(
    'test_fixture_required',
    `Add a fixture for ${label} to continue this test.`
  )
}

type ExecuteBody = (
  parentNodeId: string,
  workflowId: string,
  input: JsonObject,
  allowWaits: boolean
) => Promise<JsonObject>

class LoopBodyWait extends Error {
  constructor(readonly waiting: WorkflowWait) {
    super(waiting.message)
  }
}

function validResult(result: WorkflowNodeResult, descriptor: NodeDescriptor): boolean {
  if (!result) return false
  const ports = descriptor.ports
  if ('waitForCall' in result) {
    const { form } = result.waitForCall ?? {}
    return (
      typeof result.waitForCall?.message === 'string' &&
      (form === undefined ||
        (isRecord(form) &&
          typeof form.label === 'string' &&
          !!form.label.trim() &&
          (form.type === 'text' || form.type === 'number' || form.type === 'boolean'))) &&
      ports.some(({ id }) => id === result.waitForCall.port)
    )
  }
  return (
    isJsonObject(result.output) &&
    (result.httpRequest === undefined ||
      (isRecord(result.httpRequest) &&
        typeof result.httpRequest.method === 'string' &&
        typeof result.httpRequest.url === 'string' &&
        isRecord(result.httpRequest.headers) &&
        Object.values(result.httpRequest.headers).every((value) => typeof value === 'string'))) &&
    !descriptor.outputs?.some(
      (field) =>
        !matchesField(
          Object.hasOwn(result.output, field.key) ? result.output[field.key] : undefined,
          field
        )
    ) &&
    (ports.length ? ports.some(({ id }) => id === result.port) : result.port === null)
  )
}

async function executeRun(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  nodes: Map<string, WorkflowNodeRegistration>,
  signal: AbortSignal,
  onNodeError: WorkflowRouterOptions['onNodeError'],
  runBody?: ExecuteBody,
  workflowRunId = run.id,
  fixtures?: WorkflowFixtures
): Promise<void> {
  const outputs = new Map(run.steps.map(({ nodeId, output }) => [nodeId, output]))
  const last = run.steps.at(-1)
  let id = last
    ? (definition.edges.find((edge) => edge.from === last.nodeId && edge.port === last.port)?.to ??
      null)
    : definition.entry
  while (id) {
    const node = definition.nodes.find((item) => item.id === id)!
    const registration = nodes.get(nodeKey(node.type, node.version))!
    const checkpoint = run.loopCheckpoint
    const previousDuration = checkpoint?.parentNodeId === node.id ? (checkpoint.durationMs ?? 0) : 0
    const start = performance.now()
    let inputs: JsonObject = {}
    const trace = (): { inputs: JsonObject; durationMs: number } => ({
      inputs,
      durationMs: Math.round(previousDuration + performance.now() - start)
    })
    try {
      signal.throwIfAborted()
      const fields = registration.descriptor.inputs ?? []
      const values = fields.map((field) => {
        const binding = Object.hasOwn(node.bindings ?? {}, field.key)
          ? node.bindings?.[field.key]
          : undefined
        const resolved = binding && resolveInputBinding(outputs, binding)
        return { field, binding, source: resolved?.source, value: resolved?.value }
      })
      inputs = Object.fromEntries(
        values.flatMap(({ field, value }) => (value === undefined ? [] : [[field.key, value]]))
      )
      const invalid = values.find(
        ({ field, binding, source, value }) =>
          !matchesField(value, field) ||
          (value === undefined && (source?.path?.length || (binding && 'branches' in binding)))
      )
      const missingAlternative = registration.descriptor.fields?.find(
        (field) =>
          field.alternativeInput &&
          !matchesConfigField(node.config, field, (key) => Object.hasOwn(inputs, key))
      )
      if (invalid || missingAlternative) {
        run.status = 'failed'
        run.error = {
          code: 'invalid_resolved_input',
          nodeId: node.id,
          field: invalid?.field.key ?? missingAlternative?.alternativeInput,
          ...trace()
        }
        delete run.loopCheckpoint
        return
      }
      const fixture = fixtures?.get(fixtureKey(run.workflowId, node.id))
      if (fixtures && !fixture && !registration.testSafe)
        throw fixtureRequired(node.label ?? registration.descriptor.label)
      const result: WorkflowNodeResult = fixture
        ? { port: fixture.port, output: fixture.output }
        : await registration.execute({
            runId: run.id,
            workflowRunId,
            nodeId: node.id,
            input: structuredClone(run.input),
            config: structuredClone(node.config),
            inputs: structuredClone(inputs),
            signal,
            runBody:
              runBody &&
              ((workflowId, input) =>
                runBody(node.id, workflowId, input, node.type === 'workflow:loop')),
            loopProgress:
              checkpoint?.parentNodeId === node.id
                ? { index: checkpoint.index, previous: checkpoint.input.previous ?? null }
                : undefined
          })
      signal.throwIfAborted()
      if (!validResult(result, registration.descriptor)) {
        run.status = 'failed'
        run.error = { code: 'invalid_node_result', nodeId: node.id, ...trace() }
        return
      }
      if ('waitForCall' in result) {
        if (fixtures) throw fixtureRequired(node.label ?? registration.descriptor.label)
        const { port, message, form } = result.waitForCall
        run.waiting = {
          nodeId: node.id,
          port,
          message,
          ...trace(),
          ...(form && { form: { label: form.label, type: form.type } })
        }
        run.status = 'waiting'
        return
      }
      const output = structuredClone(result.output)
      outputs.set(node.id, output)
      const { httpRequest } = result
      run.steps.push({
        nodeId: node.id,
        port: result.port,
        output,
        ...trace(),
        ...(fixture && { fixture: true }),
        ...(httpRequest && {
          httpRequest: {
            method: httpRequest.method,
            url: httpRequest.url,
            headers: httpRequestHeadersForLog(Object.entries(httpRequest.headers))
          }
        })
      })
      id =
        definition.edges.find((edge) => edge.from === node.id && edge.port === result.port)?.to ??
        null
    } catch (error) {
      if (error instanceof LoopBodyWait) {
        if (run.loopCheckpoint) run.loopCheckpoint.durationMs = trace().durationMs
        run.status = 'waiting'
        run.waiting = error.waiting
        return
      }
      delete run.loopCheckpoint
      run.status = signal.aborted ? 'interrupted' : 'failed'
      const detail = !signal.aborted && error instanceof WorkflowNodeError ? error : undefined
      run.error = {
        code: signal.aborted ? 'run_interrupted' : (detail?.code ?? 'node_failed'),
        ...(detail && { detail: detail.message }),
        nodeId: node.id,
        ...trace()
      }
      onNodeError?.(error, { runId: run.id, nodeId: node.id })
      return
    }
  }
  run.status = 'completed'
}

export function createWorkflowRouter(options: WorkflowRouterOptions): Router {
  const { store } = options
  const timeout = options.runTimeoutMs ?? 30_000
  if (!isVersion(timeout) || timeout > 2_147_483_647) throw new Error('Invalid workflow timeout')

  const nodes = new Map<string, WorkflowNodeRegistration>()
  for (const { descriptor: definition, execute, testSafe } of options.nodes) {
    const descriptor = structuredClone(definition)
    const key = nodeKey(descriptor.type, descriptor.version)
    const ports = descriptor.ports.map(({ id }) => id)
    const fieldGroups = [descriptor.fields ?? [], descriptor.inputs ?? [], descriptor.outputs ?? []]
    const invalidFields = fieldGroups.some((group) => {
      const keys = group.map(({ key }) => key)
      return !keys.every(isId) || new Set(keys).size !== keys.length
    })
    const invalidExamples = descriptor.inputs?.some(
      (field) =>
        field.example !== undefined &&
        (!isJsonObject({ example: field.example }) || !matchesField(field.example, field))
    )
    const invalidAlternatives = descriptor.fields?.some(
      ({ alternativeInput, type }) =>
        alternativeInput !== undefined &&
        !descriptor.inputs?.some(
          ({ key, type: inputType }) => key === alternativeInput && inputType === type
        )
    )
    if (
      !isId(descriptor.type) ||
      !isVersion(descriptor.version) ||
      nodes.has(key) ||
      !ports.every(isId) ||
      new Set(ports).size !== ports.length ||
      invalidFields ||
      invalidExamples ||
      invalidAlternatives
    ) {
      throw new Error(`Invalid workflow node registration: ${key}`)
    }
    nodes.set(key, { descriptor, execute, ...(testSafe === true && { testSafe }) })
  }
  const catalog = [...nodes.values()].map(({ descriptor }) => descriptor)
  const router = Router()

  const getDescriptor = (type: string, version: number): NodeDescriptor | undefined =>
    nodes.get(nodeKey(type, version))?.descriptor

  function prepareRun(
    definition: WorkflowDefinition,
    workflowId: string
  ): ReturnType<typeof loadWorkflowBodies> {
    const issues = validateWorkflow(definition, catalog)
    if (issues.length) return Promise.resolve({ documents: [], issues })
    return loadWorkflowBodies(definition.nodes, catalog, (id) => store.get(id), workflowId)
  }

  function bodyExecutor(
    documents: readonly WorkflowDocument[],
    signal: AbortSignal,
    parent?: WorkflowRun,
    fixtures?: WorkflowFixtures
  ): ExecuteBody {
    return async (parentNodeId, workflowId, input, allowWaits) => {
      signal.throwIfAborted()
      const document = documents.find(({ id }) => id === workflowId)
      if (!document) throw new Error('Body workflow is unavailable')
      const checkpoint = parent?.loopCheckpoint
      const resume =
        checkpoint?.parentNodeId === parentNodeId && checkpoint.workflowId === workflowId
          ? checkpoint
          : undefined
      const child: WorkflowRun = {
        id: resume?.childRunId ?? randomUUID(),
        workflowId,
        revision: document.revision,
        definition: document.definition,
        input: resume?.input ?? input,
        steps: resume?.steps ?? [],
        status: 'running'
      }
      await executeRun(
        child,
        child.definition,
        nodes,
        signal,
        fixtures ? undefined : options.onNodeError,
        undefined,
        parent?.id,
        fixtures
      )
      if (child.waiting && allowWaits && typeof input.index === 'number') {
        if (parent) {
          parent.loopCheckpoint = {
            parentNodeId,
            workflowId,
            childRunId: child.id,
            index: input.index,
            input: child.input,
            steps: child.steps
          }
        }
        throw new LoopBodyWait({
          ...child.waiting,
          id: randomUUID(),
          nodeId: parentNodeId,
          bodyNodeId: child.waiting.nodeId,
          pass: input.index + 1
        })
      }
      if (parent) {
        if (resume) delete parent.loopCheckpoint
        const status =
          child.status === 'interrupted' || child.status === 'completed' ? child.status : 'failed'
        const error = child.waiting
          ? { code: 'body_pause_unsupported', nodeId: child.waiting.nodeId }
          : child.error
        parent.bodyRuns ??= []
        parent.bodyRuns.push({
          parentNodeId,
          workflowId,
          status,
          steps: child.steps,
          ...(error && { error })
        })
      }
      signal.throwIfAborted()
      const last = child.steps.at(-1)
      if (child.status !== 'completed' || !last) {
        throw new Error(
          `Body workflow ${workflowId} did not complete (${child.error?.code ?? child.status})`
        )
      }
      return last.output
    }
  }

  router.use(json({ limit: workflowWriteRequestLimit }))
  router.param('id', (_req, res, next, id: string) => {
    if (isId(id)) next()
    else res.status(400).json({ error: 'invalid_id' })
  })
  router.get('/node-types', (_req, res) => {
    res.json(catalog)
  })
  router.post('/node-types/test', async (req, res) => {
    const body: unknown = req.body
    if (
      !isRecord(body) ||
      !isId(body.nodeId) ||
      !isId(body.type) ||
      !isVersion(body.version) ||
      !isJsonObject(body.config) ||
      !isJsonObject(body.inputs) ||
      (body.input !== undefined && !isJsonObject(body.input))
    ) {
      res.status(400).json({ error: 'invalid_node_test' })
      return
    }
    const node = nodes.get(nodeKey(body.type, body.version))
    if (!node) {
      res.status(404).json({ error: 'node_type_not_found' })
      return
    }
    const { config, inputs } = body
    const invalid = [
      ...(node.descriptor.fields ?? [])
        .filter((field) => !matchesConfigField(config, field, (key) => Object.hasOwn(inputs, key)))
        .map((field) => ({ kind: 'config', field: field.key, label: field.label })),
      ...(node.descriptor.inputs ?? [])
        .filter(
          (field) =>
            !matchesField(Object.hasOwn(inputs, field.key) ? inputs[field.key] : undefined, field)
        )
        .map((field) => ({ kind: 'input', field: field.key, label: field.label }))
    ]
    if (invalid.length) {
      res.status(422).json({ error: 'invalid_node_fields', fields: invalid })
      return
    }
    if (options.signal?.aborted) {
      res.status(503).json({ error: 'workflow_unavailable' })
      return
    }
    const runId = randomUUID()
    const nodeId = body.nodeId
    const start = performance.now()
    const elapsed = (): number => Math.round(performance.now() - start)
    const respond = (result: WorkflowNodeTestResult): void => {
      res.json(result)
    }
    const signal = segmentSignal()
    try {
      const { documents, issues } = await loadWorkflowBodies(
        [{ id: nodeId, type: body.type, version: body.version, config: body.config }],
        catalog,
        (id) => store.get(id)
      )
      if (issues.length) {
        respond({ status: 'failed', error: 'invalid_body_workflow', durationMs: elapsed() })
        return
      }
      const runBody = bodyExecutor(documents, signal)
      const result = await node.execute({
        runId,
        workflowRunId: runId,
        nodeId,
        input: body.input ?? {},
        config: body.config,
        inputs: body.inputs,
        signal,
        runBody: (workflowId, input) =>
          runBody(nodeId, workflowId, input, node.descriptor.type === 'workflow:loop')
      })
      signal.throwIfAborted()
      if (!validResult(result, node.descriptor)) {
        respond({ status: 'failed', error: 'invalid_node_result', durationMs: elapsed() })
      } else if ('waitForCall' in result) {
        respond({ status: 'waiting', message: result.waitForCall.message, durationMs: elapsed() })
      } else {
        respond({
          status: 'completed',
          port: result.port,
          output: result.output,
          durationMs: elapsed()
        })
      }
    } catch (error) {
      if (error instanceof LoopBodyWait) {
        respond({ status: 'waiting', message: error.waiting.message, durationMs: elapsed() })
        return
      }
      options.onNodeError?.(error, { runId, nodeId })
      const detail = !signal.aborted && error instanceof WorkflowNodeError ? error : undefined
      respond({
        status: 'failed',
        error: signal.aborted ? 'node_test_interrupted' : (detail?.code ?? 'node_failed'),
        ...(detail && { detail: detail.message }),
        durationMs: elapsed()
      })
    }
  })
  router.get('/workflows', async (_req, res) => {
    res.json(await store.list())
  })
  router.get('/workflows/:id', async (req, res) => {
    const document = await store.get(req.params.id)
    if (!document) {
      res.status(404).json({ error: 'workflow_not_found' })
      return
    }
    res.json(document)
  })
  router.put('/workflows/:id', async (req, res) => {
    const { id } = req.params
    const body: unknown = req.body
    if (
      !isRecord(body) ||
      !isWorkflowDefinition(body.definition) ||
      (body.expectedRevision !== 0 && !isVersion(body.expectedRevision))
    ) {
      res.status(400).json({ error: 'invalid_definition' })
      return
    }
    const current = await store.get(id)
    const next = {
      id,
      definition: body.definition,
      revision: body.expectedRevision + 1
    }
    if ((current?.revision ?? 0) !== body.expectedRevision) {
      res.status(409).json({ error: 'revision_conflict' })
      return
    }
    const references = [
      ...new Set(
        findWorkflowBodyReferences(next.definition.nodes, getDescriptor).map(({ id }) => id)
      )
    ]
    if (!(await store.write(next, body.expectedRevision, references))) {
      const missingReference = (
        await Promise.all(references.filter((ref) => ref !== id).map((ref) => store.get(ref)))
      ).some((doc) => !doc)
      res
        .status(409)
        .json({ error: missingReference ? 'workflow_reference_missing' : 'revision_conflict' })
      return
    }
    res.status(current ? 200 : 201).json(next)
  })
  router.delete('/workflows/:id', async (req, res) => {
    const { id } = req.params
    const body: unknown = req.body
    if (!isRecord(body) || !isVersion(body.expectedRevision)) {
      res.status(400).json({ error: 'invalid_revision' })
      return
    }
    if (!store.remove) {
      res.status(405).set('Allow', 'GET, PUT').json({ error: 'workflow_deletion_unavailable' })
      return
    }
    const result = await store.remove(id, body.expectedRevision, (document) =>
      findWorkflowBodyReferences(document.definition.nodes, getDescriptor).some(
        (reference) => reference.id === id
      )
    )
    if (result === 'deleted') res.status(204).end()
    else res.status(result === 'workflow_not_found' ? 404 : 409).json({ error: result })
  })
  router.get('/workflows/:id/runs', async (req, res) => {
    if (!store.listRuns) {
      res.status(501).json({ error: 'run_history_unavailable' })
      return
    }
    const number = (value: unknown, fallback: number): number => {
      if (value === undefined) return fallback
      return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
    }
    const limit = number(req.query.limit, 20)
    const offset = number(req.query.offset, 0)
    const status = workflowRunStatuses.find((item) => item === req.query.status)
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      (req.query.status !== undefined && !status)
    ) {
      res.status(400).json({ error: 'invalid_run_filter' })
      return
    }
    res.json(await store.listRuns(req.params.id, { status, limit, offset }))
  })

  if (options.enableWorkflowTests === true) {
    router.post('/workflows/:id/test', async (req, res) => {
      const workflowId = req.params.id
      const body: unknown = req.body
      if (
        !isRecord(body) ||
        !isWorkflowDefinition(body.definition) ||
        !isJsonObject(body.input) ||
        !Array.isArray(body.fixtures) ||
        body.fixtures.length > 100 ||
        !body.fixtures.every(isWorkflowFixture)
      ) {
        res.status(400).json({ error: 'invalid_workflow_test' })
        return
      }
      if (options.signal?.aborted) {
        res.status(503).json({ error: 'workflow_unavailable' })
        return
      }
      const bodies = await prepareRun(body.definition, workflowId)
      if (bodies.issues.length) {
        res.status(422).json({ error: 'invalid_workflow', issues: bodies.issues })
        return
      }
      const testDefinitions = new Map(
        bodies.documents.map(({ id, definition }) => [id, definition])
      )
      testDefinitions.set(workflowId, body.definition)
      const fixtures = new Map<string, WorkflowTestFixture>()
      for (const fixture of body.fixtures) {
        const scope = fixture.workflowId ?? workflowId
        const key = fixtureKey(scope, fixture.nodeId)
        const node = testDefinitions.get(scope)?.nodes.find(({ id }) => id === fixture.nodeId)
        const descriptor = node && getDescriptor(node.type, node.version)
        let detail: string | undefined
        if (fixtures.has(key)) detail = 'Supply one fixture per node.'
        else if (!descriptor) detail = 'Choose a node in this workflow or one of its bodies.'
        else if (!validResult({ port: fixture.port, output: fixture.output }, descriptor))
          detail = 'Use a declared port and an output that matches the node’s fields.'
        if (detail) {
          res.status(422).json({
            error: 'invalid_workflow_fixture',
            workflowId: scope,
            nodeId: fixture.nodeId,
            detail
          })
          return
        }
        fixtures.set(key, fixture)
      }
      const run: WorkflowRun = {
        id: randomUUID(),
        workflowId,
        revision: 0,
        definition: body.definition,
        input: body.input,
        startedAt: new Date().toISOString(),
        status: 'running',
        steps: [],
        ...(bodies.documents.length > 0 && { bodyWorkflows: bodies.documents })
      }
      const signal = segmentSignal()
      await executeRun(
        run,
        run.definition,
        nodes,
        signal,
        undefined,
        bodyExecutor(bodies.documents, signal, run, fixtures),
        run.id,
        fixtures
      )
      run.finishedAt = new Date().toISOString()
      res.json(run)
    })
  }

  router.post('/workflows/:id/runs', async (req, res) => {
    const body: unknown = req.body
    const workflowId = req.params.id
    if (
      !isRecord(body) ||
      !isId(body.runId) ||
      !isVersion(body.revision) ||
      !isJsonObject(body.input)
    ) {
      res.status(400).json({ error: 'invalid_run' })
      return
    }
    const runId = body.runId
    const respondExisting = async (): Promise<boolean> => {
      const existing = await store.getRun(runId)
      if (!existing) return false
      if (
        existing.workflowId !== workflowId ||
        existing.revision !== body.revision ||
        !isDeepStrictEqual(existing.input, body.input)
      ) {
        res.status(409).json({ error: 'run_id_conflict' })
      } else {
        res.json(existing)
      }
      return true
    }
    if (await respondExisting()) return
    if (options.signal?.aborted) {
      res.status(503).json({ error: 'workflow_unavailable' })
      return
    }
    const current = await store.get(workflowId)
    if (!current) {
      res.status(404).json({ error: 'workflow_not_found' })
      return
    }
    if (current.revision !== body.revision) {
      res.status(409).json({ error: 'revision_conflict' })
      return
    }
    const bodies = await prepareRun(current.definition, workflowId)
    if (bodies.issues.length) {
      res.status(422).json({ error: 'invalid_workflow', issues: bodies.issues })
      return
    }
    const run: WorkflowRun = {
      id: runId,
      workflowId,
      revision: body.revision,
      definition: current.definition,
      input: body.input,
      startedAt: new Date().toISOString(),
      status: 'running',
      steps: [],
      ...(bodies.documents.length > 0 && { bodyWorkflows: bodies.documents })
    }
    if (!(await store.createRun(run))) {
      if (!(await respondExisting())) res.status(409).json({ error: 'run_id_conflict' })
      return
    }
    await executeSegment(run)
    res.status(run.status === 'waiting' ? 202 : 201).json(run)
  })

  function segmentSignal(): AbortSignal {
    const deadline = AbortSignal.timeout(timeout)
    return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  }

  async function executeSegment(run: WorkflowRun): Promise<WorkflowRun> {
    try {
      const signal = segmentSignal()
      await executeRun(
        run,
        run.definition,
        nodes,
        signal,
        options.onNodeError,
        bodyExecutor(run.bodyWorkflows ?? [], signal, run)
      )
      if (run.status === 'waiting' && !store.claimWaitingRun) {
        run.status = 'failed'
        run.error = { code: 'waiting_store_unavailable', nodeId: run.waiting?.nodeId }
        delete run.waiting
        delete run.loopCheckpoint
      }
    } finally {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted') {
        run.finishedAt = new Date().toISOString()
      }
      await store.finishRun(run)
    }
    return run
  }

  router.post('/runs/:id/waits/:waitId/release', async (req, res) => {
    const { id, waitId } = req.params
    const body: unknown = req.body === undefined ? {} : req.body
    if (!isId(waitId) || !isJsonObject(body)) {
      res.status(400).json({ error: 'invalid_release' })
      return
    }
    if (options.signal?.aborted || !store.claimWaitingRun) {
      res.status(503).json({ error: 'workflow_unavailable' })
      return
    }
    const run = await store.getRun(id)
    if (!run) {
      res.status(404).json({ error: 'run_not_found' })
      return
    }
    const waiting = run.waiting
    if (run.status !== 'waiting' || !waiting || (waiting.id ?? waiting.nodeId) !== waitId) {
      res.status(409).json({ error: 'wait_not_active' })
      return
    }
    if (waiting.form && !isHumanInputValue(body.value, waiting.form.type)) {
      res.status(422).json({ error: 'invalid_human_input' })
      return
    }
    const issues = validateWorkflow(run.definition, catalog)
    if (issues.length) {
      res.status(422).json({ error: 'invalid_workflow', issues })
      return
    }
    const checkpoint = run.loopCheckpoint
    const bodyDefinition =
      checkpoint && run.bodyWorkflows?.find(({ id }) => id === checkpoint.workflowId)?.definition
    if (checkpoint && (!bodyDefinition || !canUseAsBody(bodyDefinition, catalog, true))) {
      res.status(422).json({
        error: 'invalid_workflow',
        issues: [{ code: 'invalid_body_workflow', nodeId: waiting.nodeId }]
      })
      return
    }
    const nodeId = waiting.bodyNodeId ?? waiting.nodeId
    const node = (bodyDefinition ?? run.definition).nodes.find((node) => node.id === nodeId)
    const descriptor = node && nodes.get(nodeKey(node.type, node.version))?.descriptor
    const output = { payload: body }
    if (
      !descriptor?.ports.some(({ id }) => id === waiting.port) ||
      descriptor.outputs?.some(
        (field) => !matchesField(field.key === 'payload' ? body : undefined, field)
      )
    ) {
      res.status(422).json({ error: 'invalid_wait_output' })
      return
    }
    const steps = checkpoint?.steps ?? run.steps
    steps.push({
      nodeId,
      port: waiting.port,
      output,
      inputs: waiting.inputs,
      durationMs: waiting.durationMs,
      releasedWait: true
    })
    run.status = 'running'
    delete run.waiting
    if (!(await store.claimWaitingRun(run, waitId))) {
      res.status(409).json({ error: 'wait_not_active' })
      return
    }
    const resumed = await executeSegment(run)
    res.status(resumed.status === 'waiting' ? 202 : 200).json(resumed)
  })
  router.get('/runs/:id', async (req, res) => {
    const run = await store.getRun(req.params.id)
    if (!run) {
      res.status(404).json({ error: 'run_not_found' })
      return
    }
    res.json(run)
  })
  const handleJsonError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' })
      return
    }
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'body_too_large' })
      return
    }
    next(error)
  }
  router.use(handleJsonError)
  return router
}

export {
  builtinWorkflowNodes,
  createHttpRequestNode,
  conditionNode,
  humanInputNode,
  inputNode,
  iterationNode,
  logicNode,
  loopNode,
  resultNode,
  waitNode,
  waitForCallNode
} from './builtins.js'

export { mapJsonNode, templateNode } from './transform.js'
