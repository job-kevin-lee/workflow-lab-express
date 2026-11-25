import {
  canUseAsBody,
  isId,
  nodeKey,
  type NodeDescriptor,
  type WorkflowDocument,
  type WorkflowIssue,
  type WorkflowNode
} from './schema.js'

export function findWorkflowBodyReferences(
  definitionNodes: readonly WorkflowNode[],
  getDescriptor: (type: string, version: number) => NodeDescriptor | undefined
): { id: string; nodeId: string; field: string; allowWaits: boolean }[] {
  return definitionNodes.flatMap((node) =>
    (getDescriptor(node.type, node.version)?.fields ?? []).flatMap((field) => {
      const id = node.config[field.key]
      return field.type === 'workflow' && isId(id)
        ? [{ id, nodeId: node.id, field: field.key, allowWaits: node.type === 'workflow:loop' }]
        : []
    })
  )
}

export async function loadWorkflowBodies(
  definitionNodes: readonly WorkflowNode[],
  catalog: readonly NodeDescriptor[],
  getWorkflow: (id: string) => WorkflowDocument | null | Promise<WorkflowDocument | null>,
  parentId?: string
): Promise<{ documents: WorkflowDocument[]; issues: WorkflowIssue[] }> {
  const descriptors = new Map(catalog.map((node) => [nodeKey(node.type, node.version), node]))
  const references = findWorkflowBodyReferences(definitionNodes, (type, version) =>
    descriptors.get(nodeKey(type, version))
  )
  const docs = await Promise.all(
    [...new Set(references.map(({ id }) => id))]
      .filter((id) => id !== parentId)
      .map((id) => getWorkflow(id))
  )
  const documents = docs.filter((doc) => doc !== null)
  const definitions = new Map(documents.map(({ id, definition }) => [id, definition]))
  const issues = references.flatMap(({ id, nodeId, field, allowWaits }) => {
    const definition = definitions.get(id)
    return definition && canUseAsBody(definition, catalog, allowWaits)
      ? []
      : [{ code: 'invalid_body_workflow', nodeId, field }]
  })
  return { documents, issues }
}
