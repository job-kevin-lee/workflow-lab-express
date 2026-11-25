import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router, json } from 'express'
import type { ErrorRequestHandler } from 'express'
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
  matchesField,
  validateWorkflow,
  type JsonObject,
  type NodeDescriptor,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowHttpRequest,
  type WorkflowHumanInput,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowNodeTestResult,
  type WorkflowRun
} from './schema.js'
import type { WorkflowStore } from './store.js'

export * from './schema.js'
export { createMemoryWorkflowStore, type WorkflowRemoval, type WorkflowStore } from './store.js'

export interface WorkflowNodeContext {
  runId: string
  nodeId: string
  input: JsonObject
  config: JsonObject
  inputs: JsonObject
  signal: AbortSignal
  runBody?: (workflowId: string, input: JsonObject) => Promise<JsonObject>
}

export type WorkflowNodeResult =
  | { port: string | null; output: JsonObject; httpRequest?: WorkflowHttpRequest }
  | { waitForCall: { port: string; message: string; form?: WorkflowHumanInput } }

export interface WorkflowNodeRegistration {
  descriptor: NodeDescriptor
  execute(context: WorkflowNodeContext): WorkflowNodeResult | Promise<WorkflowNodeResult>
}

export interface WorkflowRouterOptions {
  store: WorkflowStore
  nodes: readonly WorkflowNodeRegistration[]
  signal?: AbortSignal
  runTimeoutMs?: number
  onNodeError?: (error: unknown, context: { runId: string; nodeId: string }) => void
}

type ExecuteBody = (
  parentNodeId: string,
  workflowId: string,
  input: JsonObject
) => Promise<JsonObject>

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
  runBody?: ExecuteBody
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
    try {
      signal.throwIfAborted()
      const inputs = Object.fromEntries(
        (registration.descriptor.inputs ?? []).flatMap(({ key }) => {
          const binding = Object.hasOwn(node.bindings ?? {}, key) ? node.bindings?.[key] : undefined
          const output = binding && outputs.get(binding.nodeId)
          return binding && output && Object.hasOwn(output, binding.field)
            ? [[key, output[binding.field]]]
            : []
        })
      )
      const result = await registration.execute({
        runId: run.id,
        nodeId: node.id,
        input: structuredClone(run.input),
        config: structuredClone(node.config),
        inputs: structuredClone(inputs),
        signal,
        runBody: runBody && ((workflowId, input) => runBody(node.id, workflowId, input))
      })
      signal.throwIfAborted()
      if (!validResult(result, registration.descriptor)) {
        run.status = 'failed'
        run.error = { code: 'invalid_node_result', nodeId: node.id }
        return
      }
      if ('waitForCall' in result) {
        const { port, message, form } = result.waitForCall
        run.waiting = {
          nodeId: node.id,
          port,
          message,
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
      run.status = signal.aborted ? 'interrupted' : 'failed'
      run.error = { code: signal.aborted ? 'run_interrupted' : 'node_failed', nodeId: node.id }
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
  for (const { descriptor: definition, execute } of options.nodes) {
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
    if (
      !isId(descriptor.type) ||
      !isVersion(descriptor.version) ||
      nodes.has(key) ||
      !ports.every(isId) ||
      new Set(ports).size !== ports.length ||
      invalidFields ||
      invalidExamples
    ) {
      throw new Error(`Invalid workflow node registration: ${key}`)
    }
    nodes.set(key, { descriptor, execute })
  }
  const catalog = [...nodes.values()].map(({ descriptor }) => descriptor)
  const router = Router()

  function bodyReferences(
    definitionNodes: readonly WorkflowNode[]
  ): { id: string; nodeId: string; field: string }[] {
    return definitionNodes.flatMap((node) =>
      (nodes.get(nodeKey(node.type, node.version))?.descriptor.fields ?? []).flatMap((field) => {
        const id = node.config[field.key]
        return field.type === 'workflow' && isId(id)
          ? [{ id, nodeId: node.id, field: field.key }]
          : []
      })
    )
  }

  async function loadBodyWorkflows(
    definitionNodes: readonly WorkflowNode[],
    parentId?: string
  ): Promise<{ documents: WorkflowDocument[]; issues: WorkflowIssue[] }> {
    const references = bodyReferences(definitionNodes)
    const docs = await Promise.all(
      [...new Set(references.map(({ id }) => id))].map(async (id) => {
        if (id === parentId) return null
        const doc = await store.get(id)
        return doc && canUseAsBody(doc.definition, catalog) ? doc : null
      })
    )
    const documents = docs.filter((doc) => doc !== null)
    const validIds = new Set(documents.map(({ id }) => id))
    const issues = references.flatMap(({ id, nodeId, field }) =>
      validIds.has(id) ? [] : [{ code: 'invalid_body_workflow', nodeId, field }]
    )
    return { documents, issues }
  }

  function bodyExecutor(
    documents: readonly WorkflowDocument[],
    signal: AbortSignal,
    parent?: WorkflowRun
  ): ExecuteBody {
    return async (parentNodeId, workflowId, input) => {
      signal.throwIfAborted()
      const document = documents.find(({ id }) => id === workflowId)
      if (!document) throw new Error('Body workflow is unavailable')
      const child: WorkflowRun = {
        id: randomUUID(),
        workflowId,
        revision: document.revision,
        definition: document.definition,
        input,
        steps: [],
        status: 'running'
      }
      await executeRun(child, child.definition, nodes, signal, options.onNodeError)
      if (parent) {
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

  router.use(json({ limit: '256kb' }))
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
    const invalid = [
      { values: body.config, fields: node.descriptor.fields ?? [], kind: 'config' },
      { values: body.inputs, fields: node.descriptor.inputs ?? [], kind: 'input' }
    ].flatMap(({ values, fields, kind }) =>
      fields
        .filter(
          (field) =>
            !matchesField(Object.hasOwn(values, field.key) ? values[field.key] : undefined, field)
        )
        .map((field) => ({ kind, field: field.key, label: field.label }))
    )
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
      const { documents, issues } = await loadBodyWorkflows([
        { id: nodeId, type: body.type, version: body.version, config: body.config }
      ])
      if (issues.length) {
        respond({ status: 'failed', error: 'invalid_body_workflow', durationMs: elapsed() })
        return
      }
      const runBody = bodyExecutor(documents, signal)
      const result = await node.execute({
        runId,
        nodeId,
        input: body.input ?? {},
        config: body.config,
        inputs: body.inputs,
        signal,
        runBody: (workflowId, input) => runBody(nodeId, workflowId, input)
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
      options.onNodeError?.(error, { runId, nodeId })
      respond({
        status: 'failed',
        error: signal.aborted ? 'node_test_interrupted' : 'node_failed',
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
    const references = [...new Set(bodyReferences(next.definition.nodes).map(({ id }) => id))]
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
      bodyReferences(document.definition.nodes).some((reference) => reference.id === id)
    )
    if (result === 'deleted') res.status(204).end()
    else res.status(result === 'workflow_not_found' ? 404 : 409).json({ error: result })
  })
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
    const issues = validateWorkflow(current.definition, catalog)
    if (issues.length) {
      res.status(422).json({ error: 'invalid_workflow', issues })
      return
    }
    const bodies = await loadBodyWorkflows(current.definition.nodes, workflowId)
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
      }
    } finally {
      await store.finishRun(run)
    }
    return run
  }

  router.post('/runs/:id/waits/:nodeId/release', async (req, res) => {
    const { id, nodeId } = req.params
    const body: unknown = req.body === undefined ? {} : req.body
    if (!isId(nodeId) || !isJsonObject(body)) {
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
    if (run.status !== 'waiting' || run.waiting?.nodeId !== nodeId) {
      res.status(409).json({ error: 'wait_not_active' })
      return
    }
    if (run.waiting.form && !isHumanInputValue(body.value, run.waiting.form.type)) {
      res.status(422).json({ error: 'invalid_human_input' })
      return
    }
    const issues = validateWorkflow(run.definition, catalog)
    if (issues.length) {
      res.status(422).json({ error: 'invalid_workflow', issues })
      return
    }
    const node = run.definition.nodes.find((node) => node.id === nodeId)
    const descriptor = node && nodes.get(nodeKey(node.type, node.version))?.descriptor
    const output = { payload: body }
    if (
      !descriptor?.ports.some(({ id }) => id === run.waiting?.port) ||
      descriptor.outputs?.some(
        (field) => !matchesField(field.key === 'payload' ? body : undefined, field)
      )
    ) {
      res.status(422).json({ error: 'invalid_wait_output' })
      return
    }
    run.steps.push({ nodeId, port: run.waiting.port, output, releasedWait: true })
    run.status = 'running'
    delete run.waiting
    if (!(await store.claimWaitingRun(run, nodeId))) {
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
