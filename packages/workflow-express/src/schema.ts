export const workflowWriteRequestLimit = 256 * 1024
export const workflowBranchSourceLimit = 32

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export interface NodeField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'json'
  options?: readonly string[]
  optionLabels?: Readonly<Record<string, string>>
  multiline?: boolean
  required?: boolean
}

export interface NodeInput extends NodeField {
  description?: string
  example?: JsonValue
}

export const logicOperators = [
  { id: 'eq', label: 'Equals' },
  { id: 'ne', label: 'Does not equal' },
  { id: 'lt', label: 'Less than' },
  { id: 'lte', label: 'At most' },
  { id: 'gt', label: 'Greater than' },
  { id: 'gte', label: 'At least' },
  { id: 'contains', label: 'Contains' },
  { id: 'exists', label: 'Exists' }
] as const

export interface LogicCondition {
  path: string
  operator: (typeof logicOperators)[number]['id']
  expected?: string
}

type ConditionsField = { key: string; label: string; type: 'conditions'; required?: boolean }
export type NodeConfigField = (
  | (NodeField & { type: 'string' | 'number' | 'boolean' })
  | ConditionsField
  | { key: string; label: string; type: 'workflow'; required?: boolean }
) & { alternativeInput?: string }

export function isLogicConditions(value: unknown): value is LogicCondition[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.path === 'string' &&
        row.path.length <= 160 &&
        logicOperators.some(({ id }) => id === row.operator) &&
        (row.expected === undefined ||
          (typeof row.expected === 'string' && row.expected.length <= 1000))
    )
  )
}

export interface NodeDescriptor {
  type: string
  version: number
  label: string
  description?: string
  category?: string
  pausesRun?: true
  fields?: readonly NodeConfigField[]
  inputs?: readonly NodeInput[]
  outputs?: readonly NodeField[]
  ports: readonly { id: string; label: string }[]
}

export interface WorkflowNode {
  id: string
  type: string
  version: number
  config: JsonObject
  label?: string
  bindings?: Record<string, WorkflowInputBinding>
}

export interface OutputBinding {
  nodeId: string
  field: string
  path?: string[]
}

export type WorkflowInputBinding = OutputBinding | { branches: OutputBinding[] }

export interface WorkflowEdge {
  id: string
  from: string
  port: string
  to: string
}

export interface WorkflowDefinition {
  schemaVersion: 1
  name: string
  entry: string | null
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  layout: Record<string, { x: number; y: number }>
}

export function createEmptyWorkflow(name = 'Untitled workflow'): WorkflowDefinition {
  return { schemaVersion: 1, name, entry: null, nodes: [], edges: [], layout: {} }
}

export interface WorkflowDocument {
  id: string
  revision: number
  definition: WorkflowDefinition
}

export interface WorkflowHttpRequest {
  method: string
  url: string
  headers: Record<string, string>
}

export interface WorkflowStepResult {
  nodeId: string
  port: string | null
  output: JsonObject
  inputs?: JsonObject
  durationMs?: number
  httpRequest?: WorkflowHttpRequest
  releasedWait?: true
  fixture?: true
}

export interface WorkflowTestFixture {
  workflowId?: string
  nodeId: string
  port: string | null
  output: JsonObject
}

export interface WorkflowHumanInput {
  label: string
  type: 'text' | 'number' | 'boolean'
}

export interface WorkflowWait {
  id?: string
  nodeId: string
  bodyNodeId?: string
  pass?: number
  port: string
  message: string
  form?: WorkflowHumanInput
  inputs?: JsonObject
  durationMs?: number
}

export interface WorkflowLoopCheckpoint {
  parentNodeId: string
  workflowId: string
  childRunId: string
  index: number
  durationMs?: number
  input: JsonObject
  steps: WorkflowStepResult[]
}

export interface WorkflowNodeFailure {
  code: string
  detail?: string
  nodeId?: string
  field?: string
  inputs?: JsonObject
  durationMs?: number
}

export interface WorkflowBodyRun {
  parentNodeId: string
  workflowId: string
  status: 'completed' | 'failed' | 'interrupted'
  steps: WorkflowStepResult[]
  error?: WorkflowNodeFailure
}

export interface WorkflowRun {
  id: string
  workflowId: string
  revision: number
  definition: WorkflowDefinition
  input: JsonObject
  startedAt?: string
  finishedAt?: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted'
  waiting?: WorkflowWait
  loopCheckpoint?: WorkflowLoopCheckpoint
  bodyWorkflows?: WorkflowDocument[]
  bodyRuns?: WorkflowBodyRun[]
  steps: WorkflowStepResult[]
  error?: WorkflowNodeFailure
}

export type WorkflowRunSummary = Pick<
  WorkflowRun,
  'id' | 'workflowId' | 'revision' | 'status' | 'startedAt' | 'finishedAt'
>

export interface WorkflowRunListOptions {
  status?: WorkflowRun['status']
  limit: number
  offset: number
}

export const workflowRunStatuses = [
  'running',
  'waiting',
  'completed',
  'failed',
  'interrupted'
] as const

export function summarizeWorkflowRun(run: WorkflowRun): WorkflowRunSummary {
  const { id, workflowId, revision, status, startedAt, finishedAt } = run
  return { id, workflowId, revision, status, startedAt, finishedAt }
}

export type WorkflowNodeTestResult = (
  | { status: 'completed'; port: string | null; output: JsonObject }
  | { status: 'waiting'; message: string }
  | { status: 'failed'; error: string; detail?: string }
) & { durationMs: number }

export interface WorkflowIssue {
  code: string
  nodeId?: string
  edgeId?: string
  field?: string
}

export const nodeKey = (type: string, version: number): string => `${type}@${version}`

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value)

export const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function isJson(value: unknown, depth: number): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth === 0) return false
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth - 1))
  return isRecord(value) && Object.values(value).every((item) => isJson(item, depth - 1))
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) && isJson(value, 32)

export function isHumanInputValue(value: unknown, type: WorkflowHumanInput['type']): boolean {
  if (type === 'text') return typeof value === 'string' && value.trim().length > 0
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'boolean'
}

export function httpRequestHeadersForLog(
  headers: Iterable<readonly [string, string]>
): Record<string, string> {
  return Object.fromEntries(
    Array.from(headers, ([name, value]) => [
      name,
      /authorization|cookie|token|secret|api[-_]?key|auth[-_]?key|credential|csrf|session/i.test(
        name
      )
        ? '[redacted]'
        : value
    ])
  )
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 160 ||
    (value.entry !== null && !isId(value.entry))
  )
    return false

  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length > 100 ||
    !Array.isArray(value.edges) ||
    value.edges.length > 400 ||
    !isRecord(value.layout)
  )
    return false

  const nodes = value.nodes as unknown[]
  const edges = value.edges as unknown[]
  return (
    nodes.every(
      (node) =>
        isRecord(node) &&
        isId(node.id) &&
        isId(node.type) &&
        isVersion(node.version) &&
        isJsonObject(node.config) &&
        (node.label === undefined || (typeof node.label === 'string' && node.label.length <= 80)) &&
        validBindings(node.bindings)
    ) &&
    edges.every(
      (edge) =>
        isRecord(edge) && isId(edge.id) && isId(edge.from) && isId(edge.to) && isId(edge.port)
    ) &&
    Object.keys(value.layout).length <= nodes.length &&
    Object.entries(value.layout).every(
      ([id, point]) =>
        isId(id) &&
        isRecord(point) &&
        typeof point.x === 'number' &&
        Number.isFinite(point.x) &&
        typeof point.y === 'number' &&
        Number.isFinite(point.y)
    )
  )
}

function validOutputBinding(binding: unknown): binding is OutputBinding {
  return (
    isRecord(binding) &&
    isId(binding.nodeId) &&
    isId(binding.field) &&
    (binding.path === undefined ||
      (Array.isArray(binding.path) &&
        binding.path.length <= 32 &&
        binding.path.every((part) => typeof part === 'string' && part.length <= 160)))
  )
}

function validBindings(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.entries(value).every(([key, binding]) => {
        if (!isId(key) || !isRecord(binding)) return false
        if (!Object.hasOwn(binding, 'branches')) return validOutputBinding(binding)
        return (
          !Object.hasOwn(binding, 'nodeId') &&
          !Object.hasOwn(binding, 'field') &&
          !Object.hasOwn(binding, 'path') &&
          Array.isArray(binding.branches) &&
          binding.branches.length <= workflowBranchSourceLimit &&
          binding.branches.every(validOutputBinding)
        )
      }))
  )
}

export function matchesField(
  value: JsonValue | undefined,
  field: NodeField | NodeConfigField
): boolean {
  if (value === undefined) return !field.required
  if (field.type === 'workflow') return isId(value)
  if (field.type === 'conditions') {
    if (!isLogicConditions(value) || (field.required && !value.length)) return false
    return value.every((row) => {
      if (row.operator === 'exists') return true
      try {
        const expected: unknown = JSON.parse(row.expected ?? '')
        if (!isJson(expected, 0)) return false
        return (
          row.operator === 'eq' ||
          row.operator === 'ne' ||
          row.operator === 'contains' ||
          typeof expected === 'number'
        )
      } catch {
        return false
      }
    })
  }
  if (field.options && (typeof value !== 'string' || !field.options.includes(value))) return false
  return field.type === 'json' || (typeof value === field.type && (!field.required || value !== ''))
}

export function matchesConfigField(
  config: JsonObject,
  field: NodeConfigField,
  hasInput: (key: string) => boolean
): boolean {
  const value = Object.hasOwn(config, field.key) ? config[field.key] : undefined
  return (
    matchesField(value, field) ||
    ((value === undefined || value === '') &&
      !!field.alternativeInput &&
      hasInput(field.alternativeInput))
  )
}

export function readValuePath(
  value: JsonValue | undefined,
  path: readonly string[]
): JsonValue | undefined {
  for (const part of path) {
    if (Array.isArray(value) && /^(0|[1-9]\d*)$/.test(part)) value = value[Number(part)]
    else if (isRecord(value) && Object.hasOwn(value, part)) value = value[part]
    else return undefined
  }
  return value
}

export function readOutputBinding(
  output: JsonObject | undefined,
  binding: OutputBinding
): JsonValue | undefined {
  if (!output || !Object.hasOwn(output, binding.field)) return undefined
  return readValuePath(output[binding.field], binding.path ?? [])
}

export function resolveInputBinding(
  outputs: ReadonlyMap<string, JsonObject>,
  binding: WorkflowInputBinding
): { source?: OutputBinding; value?: JsonValue } {
  const sources =
    'branches' in binding ? binding.branches.filter(({ nodeId }) => outputs.has(nodeId)) : [binding]
  if (sources.length !== 1) return {}
  const [source] = sources
  return { source, value: readOutputBinding(outputs.get(source.nodeId), source) }
}

export function acceptsOutput(
  input: NodeField,
  output: NodeField,
  path?: readonly string[]
): boolean {
  const compatible = path?.length
    ? output.type === 'json'
    : input.type === 'json' || input.type === output.type
  return compatible && (!input.required || !!output.required)
}

function flowLinks(definition: WorkflowDefinition, reversed = false): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>()
  for (const { from, to } of definition.edges) {
    const source = reversed ? to : from
    const targets = links.get(source) ?? new Set<string>()
    targets.add(reversed ? from : to)
    links.set(source, targets)
  }
  return links
}

function reachableFrom(start: string, links: ReadonlyMap<string, Set<string>>): Set<string> {
  const reachable = new Set<string>()
  const pending = [start]
  for (const id of pending) {
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const target of links.get(id) ?? []) if (!reachable.has(target)) pending.push(target)
  }
  return reachable
}

export function possibleUpstreamSources(
  definition: WorkflowDefinition,
  target: string
): ReadonlySet<string> {
  if (!definition.entry) return new Set()
  const reachable = reachableFrom(definition.entry, flowLinks(definition))
  const upstream = reachableFrom(target, flowLinks(definition, true))
  return new Set([...upstream].filter((id) => id !== target && reachable.has(id)))
}

function upstreamSources(definition: WorkflowDefinition): Map<string, Set<string>> {
  const sources = new Map<string, Set<string>>()
  if (!definition.entry) return sources
  const outgoing = flowLinks(definition)
  const reachable = reachableFrom(definition.entry, outgoing)

  const counts = new Map<string, number>()
  for (const id of reachable) {
    for (const target of outgoing.get(id) ?? []) {
      counts.set(target, (counts.get(target) ?? 0) + 1)
    }
  }
  const queue = [definition.entry]
  sources.set(definition.entry, new Set())
  for (const id of queue) {
    const prior = sources.get(id) ?? new Set<string>()
    for (const target of outgoing.get(id) ?? []) {
      if (target === definition.entry) continue
      const earlier = sources.get(target)
      const next = new Set([...prior, id])
      sources.set(
        target,
        earlier ? new Set([...earlier].filter((source) => next.has(source))) : next
      )
      const remaining = (counts.get(target) ?? 0) - 1
      counts.set(target, remaining)
      if (!remaining) queue.push(target)
    }
  }
  const visited = new Set(queue)
  for (const id of sources.keys()) if (!visited.has(id)) sources.delete(id)
  return sources
}

function coversExclusivePaths(
  definition: WorkflowDefinition,
  target: string,
  choices: ReadonlySet<string>
): boolean {
  if (!definition.entry) return false
  const outgoing = flowLinks(definition)
  const pending = [{ id: definition.entry, count: 0 }]
  const visited = [new Set<string>(), new Set<string>(), new Set<string>()]
  let reached = false
  for (const { id, count } of pending) {
    if (visited[count].has(id)) continue
    visited[count].add(id)
    if (id === target) {
      if (count !== 1) return false
      reached = true
      continue
    }
    const nextCount = choices.has(id) ? Math.min(2, count + 1) : count
    for (const next of outgoing.get(id) ?? []) pending.push({ id: next, count: nextCount })
  }
  return reached
}

export function availableSources(
  definition: WorkflowDefinition,
  target: string
): ReadonlySet<string> {
  return upstreamSources(definition).get(target) ?? new Set()
}

export function canConnect(
  definition: WorkflowDefinition,
  catalog: readonly NodeDescriptor[],
  edge: Pick<WorkflowEdge, 'from' | 'port' | 'to'>
): boolean {
  const source = definition.nodes.find((node) => node.id === edge.from)
  if (
    !source ||
    edge.to === definition.entry ||
    !definition.nodes.some((node) => node.id === edge.to)
  )
    return false
  const descriptor = catalog.find(
    (node) => node.type === source.type && node.version === source.version
  )
  if (!descriptor?.ports.some((port) => port.id === edge.port)) return false
  if (definition.edges.some((wire) => wire.from === edge.from && wire.port === edge.port))
    return false

  const seen = new Set<string>()
  const pending = [edge.to]
  while (pending.length) {
    const id = pending.pop()!
    if (id === edge.from) return false
    if (seen.has(id)) continue
    seen.add(id)
    pending.push(...definition.edges.filter((wire) => wire.from === id).map((wire) => wire.to))
  }
  return true
}

export function validateWorkflow(
  definition: WorkflowDefinition,
  catalog: readonly NodeDescriptor[]
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const descriptors = new Map(catalog.map((node) => [nodeKey(node.type, node.version), node]))
  const edges = new Map<string, Set<string>>()
  const seenEdges = new Set<string>()
  const upstream = upstreamSources(definition)

  function compatibleBinding(field: NodeField, binding: OutputBinding): boolean {
    const source = nodes.get(binding.nodeId)
    const output =
      source &&
      descriptors
        .get(nodeKey(source.type, source.version))
        ?.outputs?.find((item) => item.key === binding.field)
    return !!output && acceptsOutput(field, output, binding.path)
  }

  if (nodes.size !== definition.nodes.length) issues.push({ code: 'duplicate_node' })
  if (!definition.entry || !nodes.has(definition.entry)) issues.push({ code: 'missing_entry' })

  for (const edge of definition.edges) {
    if (seenEdges.has(edge.id)) issues.push({ code: 'duplicate_edge', edgeId: edge.id })
    seenEdges.add(edge.id)
    const source = nodes.get(edge.from)
    if (!source || !nodes.has(edge.to)) {
      issues.push({ code: 'dangling_edge', edgeId: edge.id })
      continue
    }
    if (edge.to === definition.entry) issues.push({ code: 'incoming_entry', edgeId: edge.id })
    const ports = edges.get(edge.from) ?? new Set<string>()
    if (ports.has(edge.port)) issues.push({ code: 'duplicate_connection', edgeId: edge.id })
    ports.add(edge.port)
    edges.set(edge.from, ports)
    const descriptor = descriptors.get(nodeKey(source.type, source.version))
    if (descriptor && !descriptor.ports.some((port) => port.id === edge.port)) {
      issues.push({ code: 'unknown_port', edgeId: edge.id })
    }
  }

  for (const node of definition.nodes) {
    const descriptor = descriptors.get(nodeKey(node.type, node.version))
    if (!descriptor) {
      issues.push({ code: 'unknown_node_type', nodeId: node.id })
      continue
    }
    for (const field of descriptor.fields ?? []) {
      if (
        !matchesConfigField(node.config, field, (key) => Object.hasOwn(node.bindings ?? {}, key))
      ) {
        issues.push({ code: 'invalid_config', nodeId: node.id, field: field.key })
      }
    }
    const sources = upstream.get(node.id)
    for (const field of descriptor.inputs ?? []) {
      const binding = Object.hasOwn(node.bindings ?? {}, field.key)
        ? node.bindings?.[field.key]
        : undefined
      if (!binding) {
        if (field.required)
          issues.push({ code: 'missing_input', nodeId: node.id, field: field.key })
        continue
      }
      if ('branches' in binding) {
        const possible = possibleUpstreamSources(definition, node.id)
        const choices = new Set(binding.branches.map(({ nodeId }) => nodeId))
        const required = { ...field, required: true }
        if (
          choices.size < 2 ||
          binding.branches.length > workflowBranchSourceLimit ||
          choices.size !== binding.branches.length ||
          binding.branches.some(
            (source) => !possible.has(source.nodeId) || !compatibleBinding(required, source)
          ) ||
          !coversExclusivePaths(definition, node.id, choices)
        ) {
          issues.push({ code: 'invalid_branch_binding', nodeId: node.id, field: field.key })
        }
        continue
      }
      if (!sources?.has(binding.nodeId) || !compatibleBinding(field, binding)) {
        issues.push({ code: 'invalid_binding', nodeId: node.id, field: field.key })
      }
    }
    for (const port of descriptor.ports) {
      if (!edges.get(node.id)?.has(port.id))
        issues.push({ code: 'missing_connection', nodeId: node.id, field: port.id })
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) {
      issues.push({ code: 'cycle', nodeId: id })
      return
    }
    if (visited.has(id) || !nodes.has(id)) return
    visiting.add(id)
    for (const edge of definition.edges) if (edge.from === id) visit(edge.to)
    visiting.delete(id)
    visited.add(id)
  }
  if (definition.entry) visit(definition.entry)
  for (const node of definition.nodes) {
    if (!visited.has(node.id)) issues.push({ code: 'unreachable_node', nodeId: node.id })
  }
  return issues
}

export function canUseAsBody(
  definition: WorkflowDefinition,
  catalog: readonly NodeDescriptor[],
  allowWaits = false
): boolean {
  if (validateWorkflow(definition, catalog).length) return false
  const descriptors = new Map(catalog.map((node) => [nodeKey(node.type, node.version), node]))
  return !definition.nodes.some((node) => {
    const descriptor = descriptors.get(nodeKey(node.type, node.version))
    return (
      (!allowWaits && descriptor?.pausesRun) ||
      descriptor?.fields?.some(({ type }) => type === 'workflow')
    )
  })
}
