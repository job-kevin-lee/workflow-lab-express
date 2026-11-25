import { afterAll, expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  createMemoryWorkflowStore,
  createEmptyWorkflow,
  createWorkflowRouter,
  humanInputNode,
  iterationNode,
  loopNode,
  waitNode,
  type JsonObject,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeRegistration,
  type WorkflowRun
} from './index.js'

const store = createMemoryWorkflowStore()
const nodes: WorkflowNodeRegistration[] = [
  humanInputNode,
  iterationNode,
  loopNode,
  waitNode,
  {
    descriptor: {
      type: 'test:input',
      version: 1,
      label: 'List',
      ports: [{ id: 'next', label: 'Continue' }],
      outputs: [{ key: 'items', label: 'Items', type: 'json', required: true }]
    },
    execute: ({ input }) => ({ port: 'next', output: { items: input.items } })
  },
  {
    descriptor: {
      type: 'test:end',
      version: 1,
      label: 'End',
      ports: [],
      inputs: [{ key: 'value', label: 'Value', type: 'json' }]
    },
    execute: ({ config, input, inputs }) => ({
      port: null,
      output: { ...config, ...input, ...inputs }
    })
  },
  {
    descriptor: { type: 'test:counter', version: 1, label: 'Counter', ports: [] },
    execute: ({ input }) => {
      const previous = input.previous
      const count =
        previous && typeof previous === 'object' && !Array.isArray(previous)
          ? Number(previous.count) + 1
          : 1
      return { port: null, output: { count } }
    }
  }
]
const app = express()
app.use('/api', createWorkflowRouter({ store, nodes }))
app.use('/limited', createWorkflowRouter({ store, nodes, runTimeoutMs: 25 }))
const server = await new Promise<Server>((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
})
afterAll(() => {
  server.close()
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test listener unavailable')
const origin = `http://127.0.0.1:${address.port}`

const node = (id: string, type: string, config: JsonObject = {}): WorkflowNode => ({
  id,
  type,
  version: 1,
  config
})
const edge = (from: string, port: string, to: string): WorkflowEdge => ({
  id: `${from}-${port}`,
  from,
  port,
  to
})

async function save(
  id: string,
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
  expected = 0
): Promise<void> {
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: id,
    entry: nodes[0].id,
    nodes,
    edges,
    layout: {}
  }
  expect(await store.write({ id, revision: expected + 1, definition }, expected)).toBe(true)
}

function post(path: string, body?: JsonObject): Promise<Response> {
  return fetch(
    `${origin}${path}`,
    body === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
  )
}

function start(id: string, input: JsonObject = {}, prefix = '/api'): Promise<Response> {
  return post(`${prefix}/workflows/${id}/runs`, { revision: 1, runId: id, input })
}

function iteration(body: string): WorkflowNode {
  return {
    ...node('each', 'workflow:iteration', { workflowId: body, path: 'items' }),
    bindings: { items: { nodeId: 'list', field: 'items' } }
  }
}

function loop(body: string, maxCount: number): WorkflowNode {
  return node('loop', 'workflow:loop', {
    workflowId: body,
    maxCount,
    conditions: [{ path: 'count', operator: 'gte', expected: '3' }]
  })
}

test('Human Input validates a typed submission before one atomic release', async () => {
  await save(
    'human',
    [
      node('ask', 'workflow:human-input', {
        message: 'In stock?',
        label: 'Available',
        type: 'boolean'
      }),
      node('end', 'test:end')
    ],
    [edge('ask', 'submitted', 'end')]
  )
  const started = await start('human')
  expect(started.status).toBe(202)
  expect((await started.json()).waiting).toMatchObject({
    form: { label: 'Available', type: 'boolean' }
  })
  const path = '/api/runs/human/waits/ask/release'
  expect((await post(path)).status).toBe(422)
  expect((await post(path, { value: 'false' })).status).toBe(422)
  expect((await store.getRun('human'))?.status).toBe('waiting')
  const releases = await Promise.all([post(path, { value: false }), post(path, { value: true })])
  expect(releases.map(({ status }) => status).sort()).toEqual([200, 409])
  const run = await store.getRun('human')
  expect(run?.steps[0]).toMatchObject({
    nodeId: 'ask',
    releasedWait: true,
    output: { payload: { value: expect.any(Boolean) } }
  })
})

test('Iteration preserves item order, handles empty input, and pins the body through a pause', async () => {
  await save('item-body', [node('end', 'test:end', { tag: 'original' })])
  const list = node('list', 'test:input')
  const end = node('end', 'test:end')
  const listEdges = [edge('list', 'next', 'each'), edge('each', 'next', 'end')]
  await save(
    'iterate',
    [
      node('ask', 'workflow:human-input', { message: 'Start?', label: 'Notes', type: 'text' }),
      list,
      iteration('item-body'),
      end
    ],
    [edge('ask', 'submitted', 'list'), ...listEdges]
  )
  const started = await start('iterate', { items: { items: ['b', 'a'] } })
  expect(started.status).toBe(202)
  expect((await started.json()).bodyWorkflows[0].revision).toBe(1)
  await save('item-body', [node('end', 'test:end', { tag: 'changed' })], [], 1)
  const resumed = await post('/api/runs/iterate/waits/ask/release', { value: 'start' })
  const run: WorkflowRun = await resumed.json()
  expect(run.status).toBe('completed')
  expect(run.steps.map(({ nodeId }) => nodeId)).toEqual(['ask', 'list', 'each', 'end'])
  expect(run.steps[2].output).toEqual({
    count: 2,
    results: [
      { item: 'b', index: 0, tag: 'original' },
      { item: 'a', index: 1, tag: 'original' }
    ]
  })
  expect(
    run.bodyRuns?.map(({ parentNodeId, workflowId, status, steps }) => ({
      parentNodeId,
      workflowId,
      status,
      item: steps[0].output.item
    }))
  ).toEqual([
    { parentNodeId: 'each', workflowId: 'item-body', status: 'completed', item: 'b' },
    { parentNodeId: 'each', workflowId: 'item-body', status: 'completed', item: 'a' }
  ])
  await save('empty', [list, iteration('item-body'), end], listEdges)
  const empty: WorkflowRun = await (await start('empty', { items: { items: [] } })).json()
  expect(empty.steps[1].output).toEqual({ count: 0, results: [] })
})

test('Loop passes previous output and branches on the stop condition or limit', async () => {
  await save('counter', [node('counter', 'test:counter')])
  const ends = [node('done', 'test:end'), node('limit', 'test:end')]
  const edges = [edge('loop', 'done', 'done'), edge('loop', 'limit', 'limit')]
  await save('loop-done', [loop('counter', 5), ...ends], edges)
  await save('loop-limit', [loop('counter', 2), ...ends], edges)
  const done: WorkflowRun = await (await start('loop-done')).json()
  const limited: WorkflowRun = await (await start('loop-limit')).json()
  expect(done.steps[0]).toMatchObject({ port: 'done', output: { count: 3, last: { count: 3 } } })
  expect(limited.steps[0]).toMatchObject({
    port: 'limit',
    output: { count: 2, last: { count: 2 } }
  })
})

test('Invalid bodies are rejected at run start and the same segment deadline covers child nodes', async () => {
  await save(
    'unavailable-body',
    [
      node('ask', 'workflow:human-input', { message: 'Ready?', label: 'Ready', type: 'boolean' }),
      node('end', 'test:end')
    ],
    [edge('ask', 'submitted', 'end')]
  )
  const tail = [node('done', 'test:end'), node('limit', 'test:end')]
  const edges = [edge('loop', 'done', 'done'), edge('loop', 'limit', 'limit')]
  await save('invalid-body', [loop('unavailable-body', 3), ...tail], edges)
  const invalid = await start('invalid-body')
  expect(invalid.status).toBe(422)
  expect((await invalid.json()).issues).toContainEqual({
    code: 'invalid_body_workflow',
    nodeId: 'loop',
    field: 'workflowId'
  })
  expect(await store.getRun('invalid-body')).toBeNull()
  await save(
    'slow-body',
    [node('wait', 'workflow:wait', { seconds: 0.08 }), node('end', 'test:end')],
    [edge('wait', 'next', 'end')]
  )
  await save('loop-timeout', [loop('slow-body', 8), ...tail], edges)
  const timeout: WorkflowRun = await (await start('loop-timeout', {}, '/limited')).json()
  expect(timeout).toMatchObject({
    status: 'interrupted',
    error: { code: 'run_interrupted', nodeId: 'loop' },
    bodyRuns: [
      {
        parentNodeId: 'loop',
        status: 'interrupted',
        error: { code: 'run_interrupted', nodeId: 'wait' }
      }
    ]
  })
})

test('cannot delete an in-use body or concurrently save a reference to a deleted body', async () => {
  await save('locked-body', [node('end', 'test:end')])
  await save('race-body', [node('end', 'test:end')])
  const dependent = createEmptyWorkflow('Unfinished loop')
  dependent.entry = 'loop'
  dependent.nodes = [loop('locked-body', 5)]
  const send = (id: string, method: 'PUT' | 'DELETE', body: object): Promise<Response> =>
    fetch(`${origin}/api/workflows/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  expect(
    (await send('dependent', 'PUT', { definition: dependent, expectedRevision: 0 })).status
  ).toBe(201)
  const locked = await send('locked-body', 'DELETE', { expectedRevision: 1 })
  expect(locked.status).toBe(409)
  expect(await locked.json()).toEqual({ error: 'workflow_in_use' })

  const [deleted, saved] = await Promise.all([
    send('race-body', 'DELETE', { expectedRevision: 1 }),
    send('dependent', 'PUT', {
      definition: { ...dependent, nodes: [loop('race-body', 5)] },
      expectedRevision: 1
    })
  ])
  if (deleted.status === 204) {
    expect(saved.status).toBe(409)
    expect(await saved.json()).toEqual({ error: 'workflow_reference_missing' })
    expect((await store.get('dependent'))?.revision).toBe(1)
  } else {
    expect(deleted.status).toBe(409)
    expect(await deleted.json()).toEqual({ error: 'workflow_in_use' })
    expect(saved.status).toBe(200)
    expect(await store.get('race-body')).not.toBeNull()
  }
})
