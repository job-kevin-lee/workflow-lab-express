import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  builtinWorkflowNodes,
  createHttpRequestNode,
  createMemoryWorkflowStore,
  createWorkflowRouter,
  type JsonObject,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeRegistration,
  type WorkflowRun
} from './index.js'

const memory = createMemoryWorkflowStore()
const store = {
  ...memory,
  write: mock(memory.write),
  createRun: mock(memory.createRun),
  finishRun: mock(memory.finishRun)
}
const requestHttp = mock(async () => Response.json({ source: 'live' }))
const executeEffect = mock<WorkflowNodeRegistration['execute']>(({ nodeId }) => ({
  port: 'next',
  output: { message: `Executed ${nodeId}` }
}))
const executeWait = mock<WorkflowNodeRegistration['execute']>(() => ({
  waitForCall: { port: 'received', message: 'Waiting for a callback' }
}))
const nodes: WorkflowNodeRegistration[] = [
  ...builtinWorkflowNodes,
  createHttpRequestNode({ origin: 'https://example.test', request: requestHttp }),
  {
    descriptor: {
      type: 'test:effect',
      version: 1,
      label: 'Effect',
      inputs: [{ key: 'payload', label: 'Payload', type: 'json' }],
      outputs: [{ key: 'message', label: 'Message', type: 'string', required: true }],
      ports: [{ id: 'next', label: 'Next' }]
    },
    execute: executeEffect
  },
  {
    descriptor: {
      type: 'test:wait',
      version: 1,
      label: 'Wait',
      ports: [{ id: 'received', label: 'Received' }]
    },
    testSafe: true,
    execute: executeWait
  }
]

const app = express()
app.use('/enabled', createWorkflowRouter({ store, nodes, enableWorkflowTests: true }))
app.use('/disabled', createWorkflowRouter({ store, nodes }))
const server = await new Promise<Server>((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
})
afterAll(() => server.close())
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test listener unavailable')
const origin = `http://127.0.0.1:${address.port}`

beforeEach(() => {
  for (const recording of [
    store.write,
    store.createRun,
    store.finishRun,
    requestHttp,
    executeEffect,
    executeWait
  ]) {
    recording.mockClear()
  }
})

function request(path: string, method = 'GET', body?: object): Promise<Response> {
  return fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  })
}

function graph(
  name: string,
  definition: Pick<WorkflowDefinition, 'entry' | 'nodes' | 'edges'>
): WorkflowDefinition {
  return { schemaVersion: 1, name, ...definition, layout: {} }
}

function node(id: string, type: string, config: JsonObject = {}): WorkflowNode {
  return { id, type, version: 1, config }
}

function edge(from: string, port: string, to: string): WorkflowDefinition['edges'][number] {
  return { id: `${from}-${port}`, from, port, to }
}

function result(id: string, messageNodeId: string): WorkflowNode {
  return {
    ...node(id, 'workflow:result', { message: 'Default result' }),
    bindings: { message: { nodeId: messageNodeId, field: 'message' } }
  }
}

const branching = graph('Draft branch', {
  entry: 'input',
  nodes: [
    node('input', 'workflow:input', { path: 'payload' }),
    {
      ...node('fetch', 'workflow:http', { method: 'POST', url: '/lookup' }),
      bindings: { body: { nodeId: 'input', field: 'value' } }
    },
    {
      ...node('effect', 'test:effect'),
      bindings: { payload: { nodeId: 'fetch', field: 'body' } }
    },
    {
      ...node('live-effect', 'test:effect'),
      bindings: { payload: { nodeId: 'fetch', field: 'body' } }
    },
    result('done', 'effect'),
    result('live-done', 'live-effect')
  ],
  edges: [
    edge('input', 'next', 'fetch'),
    edge('fetch', 'error', 'effect'),
    edge('fetch', 'ok', 'live-effect'),
    edge('effect', 'next', 'done'),
    edge('live-effect', 'next', 'live-done')
  ]
})
const input = { payload: { id: 42 } }
const httpFixture = {
  nodeId: 'fetch',
  port: 'error',
  output: { status: 503, body: { retry: true } }
}
const effectFixture = { nodeId: 'effect', port: 'next', output: { message: 'Fixture result' } }

function postTest(
  id: string,
  definition: WorkflowDefinition,
  fixtures: readonly unknown[] = [],
  testInput: JsonObject = {}
): Promise<Response> {
  return request(`/enabled/workflows/${id}/test`, 'POST', {
    definition,
    input: testInput,
    fixtures
  })
}

async function expectEphemeral(run: WorkflowRun): Promise<void> {
  expect(store.write).not.toHaveBeenCalled()
  expect(store.createRun).not.toHaveBeenCalled()
  expect(store.finishRun).not.toHaveBeenCalled()
  const history = await request(`/enabled/workflows/${run.workflowId}/runs`)
  expect(history.status).toBe(200)
  expect(await history.json()).toEqual([])
  expect((await request(`/enabled/runs/${run.id}`)).status).toBe(404)
}

test('fixtures choose the draft branch and feed bindings without invoking HTTP or custom handlers', async () => {
  const saved = { id: 'branch', revision: 1, definition: { ...branching, name: 'Saved branch' } }
  expect(await memory.write(saved, 0)).toBe(true)

  const response = await postTest(saved.id, branching, [httpFixture, effectFixture], input)
  expect(response.status).toBe(200)
  const run: WorkflowRun = await response.json()
  expect(run).toMatchObject({
    workflowId: saved.id,
    revision: 0,
    status: 'completed',
    definition: branching
  })
  expect(run.steps).toMatchObject([
    { nodeId: 'input', output: { value: input.payload } },
    { ...httpFixture, fixture: true, inputs: { body: input.payload } },
    { ...effectFixture, fixture: true, inputs: { payload: httpFixture.output.body } },
    { nodeId: 'done', output: { message: effectFixture.output.message } }
  ])
  expect(run.steps[1].httpRequest).toBeUndefined()
  expect(requestHttp).not.toHaveBeenCalled()
  expect(executeEffect).not.toHaveBeenCalled()
  await expectEphemeral(run)
  expect(await memory.get(saved.id)).toEqual(saved)

  const liveResponse = await request(`/enabled/workflows/${saved.id}/runs`, 'POST', {
    runId: 'live-branch-run',
    revision: 1,
    input
  })
  expect(liveResponse.status).toBe(201)
  const live: WorkflowRun = await liveResponse.json()
  expect(live).toMatchObject({ status: 'completed', revision: 1, definition: saved.definition })
  expect(live.steps.map(({ nodeId }) => nodeId)).toEqual([
    'input',
    'fetch',
    'live-effect',
    'live-done'
  ])
  expect(live.steps.at(-1)?.output.message).toBe('Executed live-effect')
  expect(live.steps.some(({ fixture }) => fixture)).toBe(false)
  expect(requestHttp).toHaveBeenCalledTimes(1)
  expect(executeEffect).toHaveBeenCalledTimes(1)
  expect(store.createRun).toHaveBeenCalledTimes(1)
  expect(store.finishRun).toHaveBeenCalledTimes(1)
})

test('a reached effect without a fixture fails the draft without running or saving it', async () => {
  const response = await postTest('unsaved-branch', branching, [httpFixture], input)
  expect(response.status).toBe(200)
  const run: WorkflowRun = await response.json()
  expect(run).toMatchObject({
    workflowId: 'unsaved-branch',
    status: 'failed',
    error: { code: 'test_fixture_required', nodeId: 'effect' }
  })
  expect(run.steps.map(({ nodeId }) => nodeId)).toEqual(['input', 'fetch'])
  expect(requestHttp).not.toHaveBeenCalled()
  expect(executeEffect).not.toHaveBeenCalled()
  await expectEphemeral(run)
  expect((await request('/enabled/workflows/unsaved-branch')).status).toBe(404)
})

test('a wait returned by an opted-in handler fails the test without creating a callback', async () => {
  const waiting = graph('Unexpected wait', {
    entry: 'wait',
    nodes: [node('wait', 'test:wait'), node('done', 'workflow:result', { message: 'Done' })],
    edges: [edge('wait', 'received', 'done')]
  })
  const response = await postTest('waiting-draft', waiting)
  expect(response.status).toBe(200)
  const run: WorkflowRun = await response.json()
  expect(run).toMatchObject({
    status: 'failed',
    error: { code: 'test_fixture_required', nodeId: 'wait' }
  })
  expect(run.waiting).toBeUndefined()
  expect(run.loopCheckpoint).toBeUndefined()
  expect(executeWait).toHaveBeenCalledTimes(1)
  await expectEphemeral(run)
})

test('workflow tests require an enabled router and a valid request', async () => {
  const disabled = await request('/disabled/workflows/draft/test', 'POST', {
    definition: branching,
    input,
    fixtures: []
  })
  expect(disabled.status).toBe(404)
  const malformed = await postTest('draft', branching, [{ nodeId: 'fetch', port: 'error' }], input)
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ error: 'invalid_workflow_test' })
})

test('a downstream invalid fixture rejects the test before an opted-in handler executes', async () => {
  const definition = graph('Validate before executing', {
    entry: 'wait',
    nodes: [node('wait', 'test:wait'), node('done', 'workflow:result', { message: 'Done' })],
    edges: [edge('wait', 'received', 'done')]
  })
  const response = await postTest('preflight-draft', definition, [
    { nodeId: 'done', port: 'unknown', output: {} }
  ])
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({
    error: 'invalid_workflow_fixture',
    nodeId: 'done'
  })
  expect(executeWait).not.toHaveBeenCalled()
})

test.each<[string, readonly unknown[]]>([
  ['unknown workflow scope', [{ ...httpFixture, workflowId: 'unknown' }]],
  ['unknown node', [{ ...httpFixture, nodeId: 'unknown' }]],
  ['undeclared port', [{ ...httpFixture, port: 'other' }]],
  ['terminal port for a branching node', [{ ...httpFixture, port: null }]],
  ['wrong output type', [{ ...httpFixture, output: { status: '503', body: {} } }]],
  ['missing required output', [{ ...httpFixture, output: { status: 503 } }]],
  ['duplicate node in the same scope', [httpFixture, { ...httpFixture, workflowId: 'draft' }]]
])('workflow test rejects %s', async (_name, fixtures) => {
  const response = await postTest('draft', branching, fixtures, input)
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: 'invalid_workflow_fixture' })
  expect(requestHttp).not.toHaveBeenCalled()
  expect(executeEffect).not.toHaveBeenCalled()
})

test('a terminal fixture can name the unsaved root workflow explicitly', async () => {
  const definition = graph('Terminal draft', {
    entry: 'done',
    nodes: [node('done', 'workflow:result', { message: 'Original' })],
    edges: []
  })
  const fixture = { nodeId: 'done', port: null, output: { message: 'Fixture result' } }
  const response = await postTest('terminal-draft', definition, [
    { ...fixture, workflowId: 'terminal-draft' }
  ])
  expect(response.status).toBe(200)
  const run: WorkflowRun = await response.json()
  expect(run.status).toBe('completed')
  expect(run.steps).toMatchObject([{ ...fixture, fixture: true }])
  await expectEphemeral(run)
  expect((await request('/enabled/workflows/terminal-draft')).status).toBe(404)
})

test('a saved Loop body applies its scoped fixture on every pass with a matching root node ID', async () => {
  const body = graph('Loop body', {
    entry: 'effect',
    nodes: [node('effect', 'test:effect'), result('done', 'effect')],
    edges: [edge('effect', 'next', 'done')]
  })
  expect(await memory.write({ id: 'fixture-body', revision: 1, definition: body }, 0)).toBe(true)
  const parent = graph('Loop draft', {
    entry: 'loop',
    nodes: [
      node('loop', 'workflow:loop', { workflowId: 'fixture-body', maxCount: 3 }),
      node('effect', 'test:effect'),
      result('done', 'effect')
    ],
    edges: [
      edge('loop', 'done', 'effect'),
      edge('loop', 'limit', 'effect'),
      edge('effect', 'next', 'done')
    ]
  })
  const bodyFixture = {
    workflowId: 'fixture-body',
    ...effectFixture,
    output: { message: 'Body fixture' }
  }

  const response = await postTest('fixture-loop', parent, [effectFixture, bodyFixture])
  expect(response.status).toBe(200)
  const run: WorkflowRun = await response.json()
  expect(run.status).toBe('completed')
  expect(run.steps[0]).toMatchObject({
    nodeId: 'loop',
    port: 'done',
    output: { count: 3, last: { message: 'Body fixture' } }
  })
  expect(run.steps[1]).toMatchObject({ ...effectFixture, fixture: true })
  expect(run.bodyRuns).toHaveLength(3)
  for (const pass of run.bodyRuns ?? []) {
    expect(pass).toMatchObject({
      workflowId: 'fixture-body',
      parentNodeId: 'loop',
      status: 'completed'
    })
    expect(pass.steps[0]).toMatchObject({
      nodeId: 'effect',
      fixture: true,
      output: bodyFixture.output
    })
    expect(pass.steps[1].output.message).toBe('Body fixture')
  }
  expect(executeEffect).not.toHaveBeenCalled()
  await expectEphemeral(run)
})
