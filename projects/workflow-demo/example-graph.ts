import type {
  JsonObject,
  OutputBinding,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode
} from '@ideawithai/workflow-express/schema'

export const node = (
  id: string,
  type: string,
  label: string,
  config: JsonObject
): WorkflowNode => ({
  id,
  type: `workflow:${type}`,
  label,
  config,
  version: 1
})

export const edge = (from: string, port: string, to: string): WorkflowEdge => ({
  id: `${from}-${port}`,
  from,
  port,
  to
})

export function graph(
  name: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name,
    entry: nodes[0].id,
    nodes,
    edges,
    layout: Object.fromEntries(nodes.map(({ id }, index) => [id, { x: index * 235, y: 42 }]))
  }
}

export function result(
  id: string,
  label: string,
  message: string,
  source?: OutputBinding,
  tone?: 'success' | 'warning' | 'error'
): WorkflowNode {
  return {
    ...node(id, 'result', label, { message, ...(tone && { tone }) }),
    ...(source && { bindings: { value: source } })
  }
}
