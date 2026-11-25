import { randomUUID } from 'node:crypto'
import { Router, json, type ErrorRequestHandler } from 'express'
import {
  isId,
  isRecord,
  isWorkflowDefinition,
  nodeKey,
  workflowWriteRequestLimit,
  type NodeDescriptor,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowDocument
} from '@ideawithai/workflow-express/schema'

const maxWorkflows = 128
export const workflowFileLimit = 2 * 1024 * 1024
const format = 'workflow-lab/bundle'

type SharedWorkflow = { id: string; definition: WorkflowDefinition }

export interface WorkflowBundle {
  format: typeof format
  version: 1
  rootId: string
  workflows: SharedWorkflow[]
}

export interface WorkflowImportResult {
  rootId: string
  documents: WorkflowDocument[]
}

interface SharingStorage {
  get: (id: string) => WorkflowDocument | null
  read: <T>(operation: () => T) => T
  create: (documents: WorkflowDocument[]) => void
}

class SharingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message)
  }
}

function checkWorkflowSize(definition: WorkflowDefinition, expectedRevision: number): void {
  const body = JSON.stringify({ definition, expectedRevision })
  if (Buffer.byteLength(body) > workflowWriteRequestLimit) {
    throw new SharingError(
      'workflow_definition_too_large',
      `Workflow "${definition.name}" exceeds the ${workflowWriteRequestLimit / 1024} KiB save limit.`,
      413
    )
  }
}

function nodeReferences(
  node: WorkflowNode,
  catalog: Map<string, NodeDescriptor>
): { field: string; id: string }[] {
  const descriptor = catalog.get(nodeKey(node.type, node.version))
  if (!descriptor) {
    throw new SharingError(
      'missing_node_type',
      `Register the ${node.type} node at version ${node.version} before importing or exporting this workflow.`
    )
  }

  const references: { field: string; id: string }[] = []
  for (const field of descriptor.fields ?? []) {
    if (field.type !== 'workflow' || !Object.hasOwn(node.config, field.key)) continue
    const id = node.config[field.key]
    if (!isId(id)) {
      throw new SharingError(
        'invalid_workflow_reference',
        `${node.label || descriptor.label} has an invalid workflow reference.`
      )
    }
    references.push({ field: field.key, id })
  }
  return references
}

function collectBundle(
  root: SharedWorkflow,
  lookup: (id: string) => SharedWorkflow | null,
  catalog: Map<string, NodeDescriptor>
): WorkflowBundle {
  const documents = new Map<string, SharedWorkflow>()
  const active = new Set<string>()

  function visit(id: string): void {
    if (active.has(id)) {
      throw new SharingError(
        'workflow_reference_cycle',
        'The workflows contain a circular reference.'
      )
    }
    if (documents.has(id)) return
    const workflow = id === root.id ? root : lookup(id)
    if (!workflow) {
      throw new SharingError(
        'workflow_reference_missing',
        `Missing body workflow "${id}". Export the full workflow bundle from its original lab.`
      )
    }
    if (documents.size >= maxWorkflows) {
      throw new SharingError(
        'workflow_bundle_too_large',
        'The bundle contains too many workflows.',
        413
      )
    }
    documents.set(id, { id, definition: workflow.definition })
    active.add(id)
    for (const { id: childId } of workflow.definition.nodes.flatMap((node) =>
      nodeReferences(node, catalog)
    )) {
      visit(childId)
    }
    active.delete(id)
  }

  visit(root.id)
  return { format, version: 1, rootId: root.id, workflows: [...documents.values()] }
}

function inspectFile(
  data: unknown,
  local: SharingStorage['get'],
  catalog: Map<string, NodeDescriptor>
): WorkflowBundle {
  if (isWorkflowDefinition(data)) {
    return collectBundle({ id: randomUUID(), definition: data }, local, catalog)
  }
  if (
    !isRecord(data) ||
    data.format !== format ||
    data.version !== 1 ||
    !isId(data.rootId) ||
    !Array.isArray(data.workflows) ||
    !data.workflows.length ||
    data.workflows.length > maxWorkflows
  ) {
    throw new SharingError(
      'invalid_workflow_file',
      'Choose a Workflow Lab bundle or a saved workflow JSON file.'
    )
  }

  const documents = new Map<string, SharedWorkflow>()
  for (const item of data.workflows) {
    if (
      !isRecord(item) ||
      !isId(item.id) ||
      documents.has(item.id) ||
      !isWorkflowDefinition(item.definition)
    ) {
      throw new SharingError(
        'invalid_workflow_file',
        'The bundle contains an invalid or duplicate workflow.'
      )
    }
    documents.set(item.id, { id: item.id, definition: item.definition })
  }

  const root = documents.get(data.rootId)
  if (!root) {
    throw new SharingError('invalid_workflow_file', 'The bundle is missing its root workflow.')
  }
  const bundle = collectBundle(root, (id) => documents.get(id) ?? null, catalog)
  if (bundle.workflows.length !== documents.size) {
    throw new SharingError(
      'invalid_workflow_file',
      'The bundle contains workflows unrelated to its root.'
    )
  }
  return bundle
}

function prepareImportDocuments(
  bundle: WorkflowBundle,
  catalog: Map<string, NodeDescriptor>
): WorkflowImportResult {
  const ids = new Map(bundle.workflows.map(({ id }) => [id, randomUUID()]))
  const documents = bundle.workflows.map(({ id, definition }): WorkflowDocument => {
    const nodes = definition.nodes.map((node) => {
      const config = { ...node.config }
      for (const reference of nodeReferences(node, catalog)) {
        Object.defineProperty(config, reference.field, {
          value: ids.get(reference.id)!,
          configurable: true,
          enumerable: true,
          writable: true
        })
      }
      return { ...node, config }
    })
    const document = { id: ids.get(id)!, revision: 1, definition: { ...definition, nodes } }
    checkWorkflowSize(document.definition, document.revision)
    return document
  })
  return { rootId: ids.get(bundle.rootId)!, documents }
}

export function createWorkflowSharingRouter(
  storage: SharingStorage,
  descriptors: readonly NodeDescriptor[]
): Router {
  const router = Router()
  const catalog = new Map(descriptors.map((item) => [nodeKey(item.type, item.version), item]))

  function prepareImport(data: unknown): WorkflowImportResult {
    const bundle = storage.read(() => inspectFile(data, storage.get, catalog))
    return prepareImportDocuments(bundle, catalog)
  }

  router.get('/workflows/:id/export', (req, res) => {
    const bundle = storage.read(() => {
      const root = storage.get(req.params.id)
      if (!root) {
        throw new SharingError('workflow_not_found', 'The workflow is no longer available.', 404)
      }
      if (req.query.revision !== undefined && req.query.revision !== String(root.revision)) {
        throw new SharingError(
          'revision_conflict',
          'The saved workflow changed. Reload it before exporting.',
          409
        )
      }
      checkWorkflowSize(root.definition, root.revision)
      const lookup = (id: string): WorkflowDocument | null => {
        const child = storage.get(id)
        if (child) checkWorkflowSize(child.definition, child.revision)
        return child
      }
      return collectBundle(root, lookup, catalog)
    })
    const content = JSON.stringify(bundle, null, 2)
    if (Buffer.byteLength(content) + 1 > workflowFileLimit) {
      throw new SharingError(
        'workflow_bundle_too_large',
        'The workflow bundle exceeds the 2 MB file limit.',
        413
      )
    }
    prepareImportDocuments(bundle, catalog)
    res.type('application/json').send(content + '\n')
  })

  router.use('/import', json({ limit: workflowFileLimit }))
  router.post('/import/preview', (req, res) => {
    const { documents } = prepareImport(req.body)
    const root = documents[0]
    res.json({ name: root.definition.name, workflowCount: documents.length })
  })

  router.post('/import', (req, res) => {
    const result = prepareImport(req.body)
    storage.create(result.documents)
    res.status(201).json(result)
  })

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof SharingError) {
      res.status(error.status).json({ error: error.code, message: error.message })
    } else if (error?.type === 'entity.parse.failed') {
      res
        .status(400)
        .json({ error: 'invalid_json', message: 'The file does not contain valid JSON.' })
    } else if (error?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: 'workflow_bundle_too_large', message: 'The file exceeds 2 MB.' })
    } else next(error)
  }
  router.use(handleError)
  return router
}
