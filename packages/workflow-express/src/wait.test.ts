import { afterAll, expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  createMemoryWorkflowStore,
  createWorkflowRouter,
  logicNode,
  resultNode,
  waitNode,
  waitForCallNode,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode
} from './index.js'

const waits = createMemoryWorkflowStore()
let entered = 0
const app = express()
app.use(
  createWorkflowRouter({
    store: waits,
    nodes: [
      waitNode,
      waitForCallNode,
      logicNode,
      resultNode,
      {
        descriptor: {
          type: 'test:source',
          label: 'Source',
          version: 1,
          ports: [{ id: 'next', label: 'Next' }],
          outputs: [{ key: 'data', label: 'Data', type: 'json', required: true }]
        },
        execute: () => {
          entered++
          return { port: 'next', output: { data: { status: 'ready', count: 3 } } }
        }
      }
    ]
  })
)

const server = await new Promise<Server>((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
})
afterAll(() => {
  server.close()
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test listener unavailable')
const request = (path: string, body?: object, method = 'POST'): Promise<Response> =>
  fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  })

const node = (id: string, type: string, config: WorkflowNode['config'] = {}): WorkflowNode => ({
  id,
  type: `workflow:${type}`,
  version: 1,
  config
})
const edge = (from: string, port: string, to: string): WorkflowEdge => ({
  id: `${from}-${port}`,
  from,
  port,
  to
})

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  name: 'Test wait',
  entry: 'delay',
  layout: {},
  nodes: [
    node('delay', 'wait', { seconds: 0.03 }),
    { ...node('source', 'source'), type: 'test:source' },
    {
      ...node('compare', 'logic', {
        mode: 'all',
        conditions: [
          { path: 'status', operator: 'eq', expected: '"ready"' },
          { path: 'count', operator: 'gte', expected: '2' }
        ]
      }),
      bindings: { value: { nodeId: 'source', field: 'data' } }
    },
    node('wait', 'wait-for-call'),
    {
      ...node('done', 'result', { message: 'Done' }),
      bindings: { value: { nodeId: 'wait', field: 'payload' } }
    },
    node('skip', 'result', { message: 'Skipped' })
  ],
  edges: [
    edge('delay', 'next', 'source'),
    edge('source', 'next', 'compare'),
    edge('compare', 'yes', 'wait'),
    edge('compare', 'no', 'skip'),
    edge('wait', 'received', 'done')
  ]
}

test('waits after the delay, resumes the saved graph once and passes the callback to the next node', async () => {
  expect(
    (await request('/workflows/check', { definition, expectedRevision: 0 }, 'PUT')).status
  ).toBe(201)
  const start = (runId: string): Promise<Response> =>
    request('/workflows/check/runs', { revision: 1, input: {}, runId })
  const started = performance.now()
  const first = await start('first')
  expect(performance.now() - started).toBeGreaterThanOrEqual(25)
  expect(first.status).toBe(202)
  expect(await first.json()).toMatchObject({ status: 'waiting', waiting: { nodeId: 'wait' } })
  expect((await start('second')).status).toBe(202)
  expect(
    (
      await request(
        '/workflows/check',
        {
          definition: { ...definition, name: 'Edited later' },
          expectedRevision: 1
        },
        'PUT'
      )
    ).status
  ).toBe(200)
  expect((await request('/runs/first/waits/other/release', {})).status).toBe(409)
  const release = (): Promise<Response> =>
    request('/runs/first/waits/wait/release', { accepted: true })
  const finished = await Promise.all([release(), release()])
  expect(finished.map(({ status }) => status).sort()).toEqual([200, 409])
  const completed = await finished.find(({ status }) => status === 200)?.json()
  expect(completed).toMatchObject({
    status: 'completed',
    revision: 1,
    definition: { name: 'Test wait' }
  })
  expect(completed.steps.map(({ nodeId }: { nodeId: string }) => nodeId)).toEqual([
    'delay',
    'source',
    'compare',
    'wait',
    'done'
  ])
  expect(completed.steps.at(-1).output.value).toEqual({ accepted: true })
  expect(completed.steps[3]).toMatchObject({
    releasedWait: true,
    output: { payload: { accepted: true } }
  })
  expect((await release()).status).toBe(409)
  expect(await waits.getRun('second')).toMatchObject({ status: 'waiting' })
  const url = new URL('/runs/second/waits/wait/release', first.url)
  const released = await fetch(url, { method: 'POST' })
  expect(released.status).toBe(200)
  expect((await released.json()).steps[3]).toMatchObject({
    releasedWait: true,
    output: { payload: {} }
  })
  expect((await fetch(url, { method: 'POST' })).status).toBe(409)
  expect(entered).toBe(2)
})
