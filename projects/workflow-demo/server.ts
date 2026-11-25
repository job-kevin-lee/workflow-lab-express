import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import express from 'express'
import {
  createWorkflowRouter,
  type WorkflowStore,
  type WorkflowDocument,
  type WorkflowRemoval,
  type WorkflowRun
} from '@ideawithai/workflow-express'
import { nodesForDemo } from './nodes.js'
import { examples } from './examples.js'

const db = new Database(process.env.WORKFLOW_DEMO_DB ?? 'workflow-demo.sqlite')
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
    AND json_extract(body, '$.waiting.nodeId') = ?
`)
const run = db.query<{ body: string }, [string]>('SELECT body FROM workflow_runs WHERE id = ?')
const createRun = db.query(
  'INSERT INTO workflow_runs (id, body) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
)
const finishRun = db.query('UPDATE workflow_runs SET body = ? WHERE id = ?')

db.exec(`
  UPDATE workflow_runs
  SET body = json_set(body, '$.status', 'interrupted', '$.error', json_object('code', 'run_interrupted'))
  WHERE json_extract(body, '$.status') = 'running';
`)

const store: WorkflowStore = {
  list: async () => documents.all().map(({ body }): WorkflowDocument => JSON.parse(body)),
  get: async (id) => {
    const row = document.get(id)
    return row ? JSON.parse(row.body) : null
  },
  write: async (next, expected, references = []) =>
    writeWorkflow.immediate(next, expected, references),
  remove: async (id, expected, referencesTarget) =>
    removeWorkflow.immediate(id, expected, referencesTarget),
  getRun: async (id) => {
    const row = run.get(id)
    return row ? (JSON.parse(row.body) as WorkflowRun) : null
  },
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
  if (state === 'items') {
    res.json([
      { sku: 'A-01', quantity: 4 },
      { sku: 'B-07', quantity: 2 },
      { sku: 'C-03', quantity: 8 }
    ])
  } else if (state === 'ready' || state === 'unmatched') {
    res.json(state === 'ready' ? { status: 'ready', count: 3 } : { status: 'pending', count: 0 })
  } else {
    res.status(404).json({ error: 'resource_not_found' })
  }
})
app.use(
  '/api/workflow',
  createWorkflowRouter({ store, nodes: nodesForDemo(`http://127.0.0.1:${port}`) })
)
app.use(express.static(fileURLToPath(new URL('./dist', import.meta.url))))
app.listen(port, host, () => console.log(`Workflow demo listening on ${host}:${port}`))
