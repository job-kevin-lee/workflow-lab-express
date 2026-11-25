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
export type NodeConfigField =
  | (NodeField & { type: 'string' | 'number' | 'boolean' })
  | ConditionsField
  | { key: string; label: string; type: 'workflow'; required?: boolean }

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
  bindings?: Record<string, OutputBinding>
}

export interface OutputBinding {
  nodeId: string
  field: string
}

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
  httpRequest?: WorkflowHttpRequest
  releasedWait?: true
}

export interface WorkflowHumanInput {
  label: string
  type: 'text' | 'number' | 'boolean'
}

export interface WorkflowBodyRun {
  parentNodeId: string
  workflowId: string
  status: 'completed' | 'failed' | 'interrupted'
  steps: WorkflowStepResult[]
  error?: { code: string; nodeId?: string }
}

export interface WorkflowRun {
  id: string
  workflowId: string
  revision: number
  definition: WorkflowDefinition
  input: JsonObject
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted'
  waiting?: { nodeId: string; port: string; message: string; form?: WorkflowHumanInput }
  bodyWorkflows?: WorkflowDocument[]
  bodyRuns?: WorkflowBodyRun[]
  steps: WorkflowStepResult[]
  error?: { code: string; nodeId?: string }
}

export type WorkflowNodeTestResult = (
  | { status: 'completed'; port: string | null; output: JsonObject }
  | { status: 'waiting'; message: string }
  | { status: 'failed'; error: string }
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

function validBindings(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.entries(value).every(
        ([key, binding]) =>
          isId(key) && isRecord(binding) && isId(binding.nodeId) && isId(binding.field)
      ))
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

export function acceptsOutput(input: NodeField, output: NodeField): boolean {
  return (
    (input.type === 'json' || input.type === output.type) && (!input.required || !!output.required)
  )
}

function upstreamSources(definition: WorkflowDefinition): Map<string, Set<string>> {
  const sources = new Map<string, Set<string>>()
  if (!definition.entry) return sources

  const outgoing = new Map<string, Set<string>>()
  for (const { from, to } of definition.edges) {
    const targets = outgoing.get(from) ?? new Set<string>()
    targets.add(to)
    outgoing.set(from, targets)
  }
  const reachable = new Set<string>()
  const pending = [definition.entry]
  for (const id of pending) {
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const target of outgoing.get(id) ?? []) if (!reachable.has(target)) pending.push(target)
  }

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
      const value = Object.hasOwn(node.config, field.key) ? node.config[field.key] : undefined
      if (!matchesField(value, field)) {
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
      const source = nodes.get(binding.nodeId)
      const output =
        source &&
        descriptors
          .get(nodeKey(source.type, source.version))
          ?.outputs?.find((item) => item.key === binding.field)
      if (!sources?.has(binding.nodeId) || !output || !acceptsOutput(field, output)) {
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
  catalog: readonly NodeDescriptor[]
): boolean {
  if (validateWorkflow(definition, catalog).length) return false
  const descriptors = new Map(catalog.map((node) => [nodeKey(node.type, node.version), node]))
  return !definition.nodes.some((node) => {
    const descriptor = descriptors.get(nodeKey(node.type, node.version))
    return descriptor?.pausesRun || descriptor?.fields?.some(({ type }) => type === 'workflow')
  })
}
