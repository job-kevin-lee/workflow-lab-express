import { afterAll, beforeAll, expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  createHttpRequestNode,
  createWorkflowRouter,
  createMemoryWorkflowStore,
  type WorkflowNodeRegistration
} from './index.js'
import { createEmptyWorkflow, validateWorkflow, type WorkflowDefinition } from './schema.js'

let executions = 0
let pause: Promise<void> | undefined
let markStarted: (() => void) | undefined
const nodes: WorkflowNodeRegistration[] = [
  {
    descriptor: {
      type: 'value',
      label: 'Value',
      version: 1,
      fields: [{ key: 'count', label: 'Count', type: 'number', required: true }],
      outputs: [{ key: 'count', label: 'Count', type: 'number', required: true }],
      ports: [{ id: 'next', label: 'Next' }]
    },
    execute: async ({ config }) => {
      executions++
      markStarted?.()
      await pause
      return { port: 'next', output: config }
    }
  },
  {
    descriptor: {
      type: 'check',
      label: 'Check',
      version: 1,
      inputs: [
        {
          key: 'count',
          label: 'Count',
          type: 'number',
          required: true,
          description: 'The number of items to check.',
          example: 0
        }
      ],
      ports: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' }
      ]
    },
    execute: ({ inputs }) => ({ port: (inputs.count as number) > 0 ? 'yes' : 'no', output: {} })
  },
  ...['yes', 'no'].map((type) => ({
    descriptor: { type, label: type, version: 1, ports: [] },
    execute: () => ({ port: null, output: { branch: type } })
  })),
  createHttpRequestNode({
    origin: 'https://example.test',
    request: async (_url, { headers }) => {
      expect(new Headers(headers).get('authorization')).toBe('Bearer example-token')
      return Response.json({ ready: true })
    }
  })
]

const graph: WorkflowDefinition = {
  name: 'Inventory',
  schemaVersion: 1,
  entry: 'first',
  layout: {},
  nodes: [
    { id: 'first', type: 'value', version: 1, config: { count: 3 } },
    {
      id: 'check',
      type: 'check',
      version: 1,
      config: {},
      bindings: { count: { nodeId: 'first', field: 'count' } }
    },
    { id: 'yes', type: 'yes', version: 1, config: {} },
    { id: 'no', type: 'no', version: 1, config: {} }
  ],
  edges: [
    { id: 'a', from: 'first', port: 'next', to: 'check' },
    { id: 'b', from: 'check', port: 'yes', to: 'yes' },
    { id: 'c', from: 'check', port: 'no', to: 'no' }
  ]
}

const app = express()
app.use('/api', createWorkflowRouter({ nodes, store: createMemoryWorkflowStore() }))
app.use(
  '/api/timeout',
  createWorkflowRouter({
    store: createMemoryWorkflowStore(),
    runTimeoutMs: 20,
    nodes: [
      {
        descriptor: { type: 'slow', label: 'Slow', version: 1, ports: [] },
        execute: async ({ signal }) => {
          await new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason)
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          return { port: null, output: {} }
        }
      }
    ]
  })
)
let server: Server
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
})
afterAll(() => {
  server.close()
})

function request(path: string, method = 'GET', body?: object): Promise<Response> {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  })
}

test('catalog, atomic saves, incomplete graphs and run validation', async () => {
  const catalog = await (await request('/node-types')).json()
  expect(catalog[0].outputs).toEqual(nodes[0].descriptor.outputs)
  expect(catalog[1].inputs).toEqual(nodes[1].descriptor.inputs)
  expect(catalog[0].execute).toBeUndefined()
  const incomplete = { ...graph, edges: [] }
  const saved = await request('/workflows/incomplete', 'PUT', {
    definition: incomplete,
    expectedRevision: 0
  })
  expect(saved.status).toBe(201)
  const rejected = await request('/workflows/incomplete/runs', 'POST', {
    revision: 1,
    input: {},
    runId: 'invalid'
  })
  expect(rejected.status).toBe(422)
  expect((await rejected.json()).issues).toContainEqual({
    code: 'missing_connection',
    nodeId: 'first',
    field: 'next'
  })
  const writes = await Promise.all([
    request('/workflows/incomplete', 'PUT', { definition: graph, expectedRevision: 1 }),
    request('/workflows/incomplete', 'PUT', { definition: graph, expectedRevision: 1 })
  ])
  expect(writes.map(({ status }) => status).sort()).toEqual([200, 409])
  expect((await (await request('/workflows/incomplete')).json()).revision).toBe(2)
})

test('branch execution binds outputs, pins the saved revision and deduplicates a run ID', async () => {
  expect(
    (await request('/workflows/inventory', 'PUT', { definition: graph, expectedRevision: 0 }))
      .status
  ).toBe(201)
  const old = { revision: 1, input: {}, runId: 'run-one' }
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  markStarted = started.resolve
  pause = gate.promise
  const pending = request('/workflows/inventory/runs', 'POST', old)
  try {
    await started.promise
    const duplicate = await request('/workflows/inventory/runs', 'POST', old)
    expect(duplicate.status).toBe(200)
    expect((await duplicate.json()).status).toBe('running')
    const changed = structuredClone(graph)
    changed.nodes[0].config.count = 0
    expect(
      (await request('/workflows/inventory', 'PUT', { definition: changed, expectedRevision: 1 }))
        .status
    ).toBe(200)
  } finally {
    gate.resolve()
    pause = undefined
    markStarted = undefined
  }
  const before = await (await pending).json()
  expect(before.steps.map(({ nodeId }: { nodeId: string }) => nodeId)).toEqual([
    'first',
    'check',
    'yes'
  ])
  expect(before.definition).toEqual(graph)
  const stale = await request('/workflows/inventory/runs', 'POST', { ...old, runId: 'stale' })
  expect(stale.status).toBe(409)
  const latest = await request('/workflows/inventory/runs', 'POST', {
    ...old,
    revision: 2,
    runId: 'run-two'
  })
  expect((await latest.json()).steps.at(-1).output).toEqual({ branch: 'no' })
  expect(executions).toBe(2)
})

test('bindings require a compatible output on every path to the consumer', () => {
  const changed = structuredClone(graph)
  changed.nodes[1].bindings = { count: { nodeId: 'yes', field: 'count' } }
  expect(
    validateWorkflow(
      changed,
      nodes.map(({ descriptor }) => descriptor)
    )
  ).toContainEqual({ code: 'invalid_binding', field: 'count', nodeId: 'check' })
})

test('run history stores the HTTP request alongside its response and masks credential headers', async () => {
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: 'HTTP request details',
    entry: 'fetch',
    layout: {},
    nodes: [
      {
        id: 'fetch',
        type: 'workflow:http',
        version: 1,
        config: {
          method: 'GET',
          url: '/status?format=json',
          headers: '{"Accept":"application/json","Authorization":"Bearer example-token"}'
        }
      },
      { id: 'done', type: 'yes', version: 1, config: {} }
    ],
    edges: [
      { id: 'ok', from: 'fetch', port: 'ok', to: 'done' },
      { id: 'error', from: 'fetch', port: 'error', to: 'done' }
    ]
  }
  expect(
    (await request('/workflows/request-log', 'PUT', { definition, expectedRevision: 0 })).status
  ).toBe(201)
  const started = await request('/workflows/request-log/runs', 'POST', {
    runId: 'request-log-run',
    revision: 1,
    input: {}
  })
  expect(started.status).toBe(201)
  const stored = await (await request('/runs/request-log-run')).json()
  expect(stored.steps[0].durationMs).toBeGreaterThanOrEqual(0)
  expect(stored.steps[0]).toMatchObject({
    nodeId: 'fetch',
    port: 'ok',
    output: { status: 200, body: { ready: true } },
    httpRequest: {
      method: 'GET',
      url: 'https://example.test/status?format=json',
      headers: { accept: 'application/json', authorization: '[redacted]' }
    }
  })
})

test('a cooperative node timeout leaves a queryable interrupted run', async () => {
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: 'Slow action',
    entry: 'first',
    layout: {},
    nodes: [{ id: 'first', type: 'slow', version: 1, config: {} }],
    edges: []
  }
  expect(
    (await request('/timeout/workflows/demo', 'PUT', { definition, expectedRevision: 0 })).status
  ).toBe(201)
  const result = await request('/timeout/workflows/demo/runs', 'POST', {
    runId: 'timeout-run',
    revision: 1,
    input: {}
  })
  expect(result.status).toBe(201)
  const stored = await request('/timeout/runs/timeout-run')
  expect(await stored.json()).toMatchObject({
    status: 'interrupted',
    error: { code: 'run_interrupted', nodeId: 'first' }
  })
})

test('tests a draft node in isolation and reports invalid settings', async () => {
  const input = {
    nodeId: 'draft-check',
    type: 'check',
    version: 1,
    config: {},
    inputs: { count: 4 }
  }
  const before = executions
  const tested = await request('/node-types/test', 'POST', input)
  expect(tested.status).toBe(200)
  expect(await tested.json()).toMatchObject({ status: 'completed', port: 'yes', output: {} })
  expect(executions).toBe(before)
  const missing = await request('/node-types/test', 'POST', { ...input, inputs: {} })
  expect(missing.status).toBe(422)
  expect(await missing.json()).toMatchObject({
    error: 'invalid_node_fields',
    fields: [{ kind: 'input', field: 'count', label: 'Count' }]
  })
})

test('rejects node examples that do not match the declared input type', () => {
  const check = nodes[1]
  expect(() =>
    createWorkflowRouter({
      store: createMemoryWorkflowStore(),
      nodes: [
        {
          ...check,
          descriptor: {
            ...check.descriptor,
            inputs: [{ key: 'count', label: 'Count', type: 'number', example: '4' }]
          }
        }
      ]
    })
  ).toThrow('Invalid workflow node registration: check@1')
})

test('creates, reads, renames and deletes a saved workflow while retaining its run', async () => {
  const path = '/workflows/crud'
  const created = await request(path, 'PUT', {
    definition: createEmptyWorkflow('Original name'),
    expectedRevision: 0
  })
  expect(created.status).toBe(201)
  expect(await (await request(path)).json()).toMatchObject({
    id: 'crud',
    revision: 1,
    definition: { name: 'Original name', nodes: [] }
  })
  const definition = { ...graph, name: 'Renamed workflow' }
  expect((await request(path, 'PUT', { definition, expectedRevision: 1 })).status).toBe(200)
  expect(await (await request('/workflows')).json()).toContainEqual({
    id: 'crud',
    definition,
    revision: 2
  })
  expect(
    (await request(`${path}/runs`, 'POST', { runId: 'crud-history', revision: 2, input: {} }))
      .status
  ).toBe(201)

  const stale = await request(path, 'DELETE', { expectedRevision: 1 })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ error: 'revision_conflict' })
  expect((await request(path, 'DELETE', { expectedRevision: 2 })).status).toBe(204)
  expect((await request(path)).status).toBe(404)
  expect((await request(path, 'DELETE', { expectedRevision: 2 })).status).toBe(404)
  expect((await request(path, 'PUT', { definition, expectedRevision: 0 })).status).toBe(409)
  expect((await request(path, 'PUT', { definition, expectedRevision: 2 })).status).toBe(409)
  expect(await (await request('/workflows')).json()).not.toContainEqual({
    id: 'crud',
    definition,
    revision: 2
  })
  expect(await (await request('/runs/crud-history')).json()).toMatchObject({
    status: 'completed',
    definition
  })
})

test('compares revisions atomically when saving and deleting the same workflow', async () => {
  const path = '/workflows/crud-race'
  const definition = createEmptyWorkflow('Concurrency')
  expect((await request(path, 'PUT', { definition, expectedRevision: 0 })).status).toBe(201)
  const [updated, deleted] = await Promise.all([
    request(path, 'PUT', { definition: { ...definition, name: 'Changed' }, expectedRevision: 1 }),
    request(path, 'DELETE', { expectedRevision: 1 })
  ])
  if (updated.status === 200) {
    expect(deleted.status).toBe(409)
    expect(await (await request(path)).json()).toMatchObject({
      revision: 2,
      definition: { name: 'Changed' }
    })
  } else {
    expect(updated.status).toBe(409)
    expect(deleted.status).toBe(204)
    expect((await request(path)).status).toBe(404)
  }
})
