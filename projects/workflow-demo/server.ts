import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import express from 'express'
import {
  createWorkflowRouter,
  type WorkflowStore,
  type WorkflowDocument,
  type WorkflowRemoval,
  type WorkflowRun,
  type WorkflowRunSummary
} from '@ideawithai/workflow-express'
import { nodesForDemo } from './nodes.js'
import { examples } from './examples.js'
import { cargoPods } from './game-examples.js'
import { createWorkflowSharingRouter } from './workflow-sharing.js'
import { createWorkflowTriggers } from './workflow-triggers.js'

const databasePath = process.env.WORKFLOW_DEMO_DB ?? 'workflow-demo.sqlite'
const db = new Database(databasePath)
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
`)

const documents = db.query<{ body: string }, []>(
  'SELECT body FROM workflows WHERE revision > 0 ORDER BY id'
)
const document = db.query<{ body: string; revision: number }, [string]>(
  'SELECT body, revision FROM workflows WHERE id = ? AND revision > 0'
)
const create = db.query(
  'INSERT INTO workflows (id, revision, body) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'
)
const update = db.query('UPDATE workflows SET revision = ?, body = ? WHERE id = ? AND revision = ?')
const remove = db.query(
  "UPDATE workflows SET revision = 0, body = '{}' WHERE id = ? AND revision = ?"
)
const writeWorkflow = db.transaction(
  (next: WorkflowDocument, expected: number, references: readonly string[]): boolean => {
    if (references.some((id) => id !== next.id && !document.get(id))) return false
    const body = JSON.stringify(next)
    const result =
      expected === 0
        ? create.run(next.id, next.revision, body)
        : update.run(next.revision, body, next.id, expected)
    return result.changes === 1
  }
)
const removeWorkflow = db.transaction(
  (
    id: string,
    expected: number,
    referencesTarget: (document: WorkflowDocument) => boolean
  ): WorkflowRemoval => {
    const current = document.get(id)
    if (!current) return 'workflow_not_found'
    if (current.revision !== expected) return 'revision_conflict'
    for (const { body } of documents.all()) {
      const other: WorkflowDocument = JSON.parse(body)
      if (other.id !== id && referencesTarget(other)) return 'workflow_in_use'
    }
    return remove.run(id, expected).changes === 1 ? 'deleted' : 'revision_conflict'
  }
)
const claimWait = db.query(`
  UPDATE workflow_runs SET body = ? WHERE id = ?
    AND json_extract(body, '$.status') = 'waiting'
    AND COALESCE(json_extract(body, '$.waiting.id'), json_extract(body, '$.waiting.nodeId')) = ?
`)
const run = db.query<{ body: string }, [string]>('SELECT body FROM workflow_runs WHERE id = ?')
const createRun = db.query(
  'INSERT INTO workflow_runs (id, body) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
)
const finishRun = db.query('UPDATE workflow_runs SET body = ? WHERE id = ?')
const history = db.query<
  Omit<WorkflowRunSummary, 'startedAt' | 'finishedAt'> & {
    startedAt: WorkflowRunSummary['startedAt'] | null
    finishedAt: WorkflowRunSummary['finishedAt'] | null
  },
  [string, string | null, string | null, number, number]
>(`
  SELECT id, json_extract(body, '$.workflowId') as workflowId,
    json_extract(body, '$.revision') as revision,
    json_extract(body, '$.status') as status,
    json_extract(body, '$.startedAt') as startedAt,
    json_extract(body, '$.finishedAt') as finishedAt
  FROM workflow_runs
  WHERE json_extract(body, '$.workflowId') = ?
    AND (? IS NULL OR json_extract(body, '$.status') = ?)
  ORDER BY rowid DESC
  LIMIT ? OFFSET ?
`)
const importWorkflows = db.transaction((values: WorkflowDocument[]): void => {
  for (const value of values) {
    if (create.run(value.id, value.revision, JSON.stringify(value)).changes !== 1) {
      throw new Error('An imported workflow ID already exists.')
    }
  }
})

function readDocument(id: string): WorkflowDocument | null {
  const row = document.get(id)
  return row ? JSON.parse(row.body) : null
}

db.exec(`
  UPDATE workflow_runs
  SET body = json_set(body, '$.status', 'interrupted', '$.error', json_object('code', 'run_interrupted'))
  WHERE json_extract(body, '$.status') = 'running';
`)

const store: WorkflowStore = {
  list: async () => documents.all().map(({ body }): WorkflowDocument => JSON.parse(body)),
  get: async (id) => readDocument(id),
  write: async (next, expected, references = []) =>
    writeWorkflow.immediate(next, expected, references),
  remove: async (id, expected, referencesTarget) =>
    removeWorkflow.immediate(id, expected, referencesTarget),
  getRun: async (id) => {
    const row = run.get(id)
    return row ? (JSON.parse(row.body) as WorkflowRun) : null
  },
  listRuns: async (id, { status, limit, offset }) =>
    history
      .all(id, status ?? null, status ?? null, limit, offset)
      .map(({ startedAt, finishedAt, ...summary }) => ({
        ...summary,
        ...(startedAt !== null && { startedAt }),
        ...(finishedAt !== null && { finishedAt })
      })),
  createRun: async (value) => createRun.run(value.id, JSON.stringify(value)).changes === 1,
  claimWaitingRun: async (value, nodeId) =>
    claimWait.run(JSON.stringify(value), value.id, nodeId).changes === 1,
  finishRun: async (value) => {
    finishRun.run(JSON.stringify(value), value.id)
  }
}

const port = Number(process.env.PORT ?? '4175')
const host = process.env.HOST ?? '127.0.0.1'
const app = express()
for (const [id, definition] of Object.entries(examples)) {
  await store.write({ id, definition, revision: 1 }, 0)
}
app.get('/api/demo/resources/:state', (req, res) => {
  const state = req.params.state
  if (state === 'comet-cargo') {
    res.json({ pods: cargoPods })
  } else if (state === 'supplier-quote') {
    const primary = req.query.source === 'primary'
    res.json({
      supplier: primary ? 'Primary supplier' : 'Backup supplier',
      price: primary ? 18 : 21,
      currency: 'USD'
    })
  } else if (state === 'items') {
    const items = [
      { sku: 'A-01', quantity: 4 },
      { sku: 'B-07', quantity: 2 },
      { sku: 'C-03', quantity: 8 }
    ]
    const sku = req.query.sku
    res.json(typeof sku === 'string' ? items.filter((item) => item.sku === sku) : items)
  } else if (state === 'ready' || state === 'unmatched') {
    res.json(state === 'ready' ? { status: 'ready', count: 3 } : { status: 'pending', count: 0 })
  } else {
    res.status(404).json({ error: 'resource_not_found' })
  }
})
const origin = `http://127.0.0.1:${port}`
const nodes = nodesForDemo(origin)
const catalog = nodes.map(({ descriptor }) => descriptor)
const triggers = createWorkflowTriggers({
  base: `${origin}/api/workflow`,
  settingsPath: databasePath === ':memory:' ? undefined : `${databasePath}.triggers.json`,
  catalog,
  getWorkflow: readDocument,
  getRun: store.getRun
})

app.use('/api/workflow', createWorkflowRouter({ store, nodes, enableWorkflowTests: true }))
app.use(
  '/api/demo',
  createWorkflowSharingRouter(
    {
      get: readDocument,
      read: (operation) => db.transaction(operation).deferred(),
      create: (values) => importWorkflows.immediate(values)
    },
    catalog
  ),
  triggers.router
)
app.use(express.static(fileURLToPath(new URL('./dist', import.meta.url))))
app.listen(port, host, () => {
  triggers.startSchedules()
  console.log(`Workflow demo listening on ${host}:${port}`)
})
