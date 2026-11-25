import {
  summarizeWorkflowRun,
  type WorkflowDocument,
  type WorkflowRun,
  type WorkflowRunListOptions,
  type WorkflowRunSummary
} from './schema.js'

export type WorkflowRemoval =
  'deleted' | 'workflow_not_found' | 'revision_conflict' | 'workflow_in_use'

export interface WorkflowStore {
  list(): Promise<WorkflowDocument[]>
  get(id: string): Promise<WorkflowDocument | null>
  write(
    next: WorkflowDocument,
    expectedRevision: number,
    references?: readonly string[]
  ): Promise<boolean>
  remove?(
    id: string,
    expectedRevision: number,
    referencesTarget: (document: WorkflowDocument) => boolean
  ): Promise<WorkflowRemoval>
  getRun(id: string): Promise<WorkflowRun | null>
  listRuns?(workflowId: string, options: WorkflowRunListOptions): Promise<WorkflowRunSummary[]>
  createRun(run: WorkflowRun): Promise<boolean>
  claimWaitingRun?(run: WorkflowRun, waitId: string): Promise<boolean>
  finishRun(run: WorkflowRun): Promise<void>
}

export function createMemoryWorkflowStore(): WorkflowStore {
  const documents = new Map<string, WorkflowDocument>()
  const removed = new Set<string>()
  const runs = new Map<string, WorkflowRun>()
  const get = <T>(records: Map<string, T>, id: string): T | null =>
    structuredClone(records.get(id) ?? null)

  return {
    list: async () => structuredClone([...documents.values()]),
    get: async (id) => get(documents, id),
    write: async (next, expectedRevision, references) => {
      if (
        removed.has(next.id) ||
        (documents.get(next.id)?.revision ?? 0) !== expectedRevision ||
        references?.some((id) => id !== next.id && !documents.has(id))
      )
        return false
      documents.set(next.id, structuredClone(next))
      return true
    },
    remove: async (id, expectedRevision, referencesTarget) => {
      const current = documents.get(id)
      if (!current) return 'workflow_not_found'
      if (current.revision !== expectedRevision) return 'revision_conflict'
      for (const document of documents.values()) {
        if (document.id !== id && referencesTarget(document)) return 'workflow_in_use'
      }
      documents.delete(id)
      removed.add(id)
      return 'deleted'
    },
    getRun: async (id) => get(runs, id),
    listRuns: async (workflowId, { status, limit, offset }) =>
      [...runs.values()]
        .reverse()
        .filter((run) => run.workflowId === workflowId && (!status || run.status === status))
        .slice(offset, offset + limit)
        .map(summarizeWorkflowRun),
    createRun: async (run) => {
      if (runs.has(run.id)) return false
      runs.set(run.id, structuredClone(run))
      return true
    },
    claimWaitingRun: async (run, waitId) => {
      const current = runs.get(run.id)
      if (
        current?.status !== 'waiting' ||
        (current.waiting?.id ?? current.waiting?.nodeId) !== waitId
      )
        return false
      runs.set(run.id, structuredClone(run))
      return true
    },
    finishRun: async (run) => {
      runs.set(run.id, structuredClone(run))
    }
  }
}
