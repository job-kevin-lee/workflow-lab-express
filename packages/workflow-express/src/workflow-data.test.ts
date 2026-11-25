import { expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  builtinWorkflowNodes,
  createHttpRequestNode,
  createMemoryWorkflowStore,
  createWorkflowRouter,
  readOutputBinding,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowNodeContext,
  type WorkflowNodeRegistration,
  type WorkflowRun
} from './index.js'
import { mapJsonNode, templateNode } from './transform.js'

test('templates and JSON mappings traverse arrays and preserve the data type', async () => {
  const context: WorkflowNodeContext = {
    runId: 'transform-test',
    nodeId: 'transform',
    input: {},
    signal: new AbortController().signal,
    config: {},
    inputs: { value: { items: [{ quantity: 0, name: 'A-01', active: false, detail: null }] } }
  }
  expect(
    await mapJsonNode.execute({
      ...context,
      config: {
        mapping:
          '{"quantity":"items[0].quantity","active":"items.0.active","detail":"items[0].detail"}'
      }
    })
  ).toEqual({ port: 'next', output: { value: { quantity: 0, active: false, detail: null } } })
  expect(
    await templateNode.execute({
      ...context,
      config: { template: '{{items[0].name}} has {{items[0].quantity}} items.' }
    })
  ).toEqual({ port: 'next', output: { text: 'A-01 has 0 items.' } })
  expect(() =>
    mapJsonNode.execute({ ...context, config: { mapping: '{"missing":"items[2].name"}' } })
  ).toThrow('Input path is missing')
  expect(
    readOutputBinding(
      { value: { name: 'A-01' } },
      { nodeId: 'first', field: 'value', path: ['constructor'] }
    )
  ).toBeUndefined()
})

test('a dynamic HTTP URL satisfies config validation in the graph and node test', async () => {
  const store = createMemoryWorkflowStore()
  const urls: string[] = []
  const http = createHttpRequestNode({
    origin: 'https://example.test',
    request: async (url) => {
      urls.push(url.href)
      return Response.json({ found: true })
    }
  })
  const nodes = [...builtinWorkflowNodes, http]
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: 'Dynamic HTTP URL',
    entry: 'template',
    layout: {},
    nodes: [
      {
        id: 'template',
        type: 'workflow:template',
        version: 1,
        config: { template: '/orders/B-07' }
      },
      {
        id: 'fetch',
        type: 'workflow:http',
        version: 1,
        config: { method: 'GET' },
        bindings: { url: { nodeId: 'template', field: 'text' } }
      },
      { id: 'ok', type: 'workflow:result', version: 1, config: { message: 'Found' } },
      { id: 'fail', type: 'workflow:result', version: 1, config: { message: 'Unavailable' } }
    ],
    edges: [
      { id: 'request', from: 'template', port: 'next', to: 'fetch' },
      { id: 'ok', from: 'fetch', port: 'ok', to: 'ok' },
      { id: 'fail', from: 'fetch', port: 'error', to: 'fail' }
    ]
  }
  const catalog = nodes.map(({ descriptor }) => descriptor)
  const incomplete = structuredClone(definition)
  delete incomplete.nodes[1].bindings
  expect(validateWorkflow(incomplete, catalog)).toContainEqual({
    code: 'invalid_config',
    nodeId: 'fetch',
    field: 'url'
  })
  expect(validateWorkflow(definition, catalog)).toEqual([])

  const app = express()
  app.use(createWorkflowRouter({ store, nodes }))
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  const post = (path: string, body: object): Promise<Response> =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  try {
    await store.write({ id: 'dynamic', revision: 1, definition }, 0)
    const run = await post('/workflows/dynamic/runs', {
      runId: 'dynamic-1',
      revision: 1,
      input: {}
    })
    expect(run.status).toBe(201)
    expect(await run.json()).toMatchObject({ status: 'completed' })
    const testNode = {
      nodeId: 'fetch',
      type: 'workflow:http',
      version: 1,
      config: { method: 'GET' }
    }
    const response = await post('/node-types/test', {
      ...testNode,
      inputs: { url: '/orders/A-01' }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'completed', port: 'ok' })
    expect((await post('/node-types/test', { ...testNode, inputs: {} })).status).toBe(422)
    expect(urls).toEqual(['https://example.test/orders/B-07', 'https://example.test/orders/A-01'])
  } finally {
    server.close()
  }
})

test('resolves typed nested bindings, records actual inputs, and lists filtered run summaries', async () => {
  const store = createMemoryWorkflowStore()
  const producer: WorkflowNodeRegistration = {
    descriptor: {
      type: 'test:source',
      version: 1,
      label: 'Source',
      ports: [{ id: 'next', label: 'Next' }],
      outputs: [{ key: 'value', label: 'Value', type: 'json', required: true }]
    },
    execute: () => ({ port: 'next', output: { value: { rows: [{ quantity: 0, name: 'A-01' }] } } })
  }
  const consumer: WorkflowNodeRegistration = {
    descriptor: {
      type: 'test:target',
      version: 1,
      label: 'Target',
      ports: [],
      inputs: [{ key: 'quantity', label: 'Quantity', type: 'number', required: true }]
    },
    execute: ({ inputs }) => ({ port: null, output: inputs })
  }
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: 'Nested values',
    entry: 'source',
    layout: {},
    nodes: [
      { id: 'source', type: 'test:source', version: 1, config: {} },
      {
        id: 'sink',
        type: 'test:target',
        version: 1,
        config: {},
        bindings: {
          quantity: { nodeId: 'source', field: 'value', path: ['rows', '0', 'quantity'] }
        }
      }
    ],
    edges: [{ id: 'next', from: 'source', port: 'next', to: 'sink' }]
  }
  const app = express()
  app.use(createWorkflowRouter({ store, nodes: [producer, consumer] }))
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  const start = async (id: string, revision: number): Promise<WorkflowRun> => {
    const response = await fetch(origin + '/workflows/data/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: id, revision, input: {} })
    })
    expect(response.status).toBe(201)
    return response.json()
  }
  try {
    await store.write({ id: 'data', revision: 1, definition }, 0)
    const completed = await start('nested-1', 1)
    expect(completed.status).toBe('completed')
    expect(completed.steps.at(-1)).toMatchObject({
      inputs: { quantity: 0 },
      output: { quantity: 0 }
    })
    expect(completed.steps.at(-1)?.durationMs).toBeGreaterThanOrEqual(0)
    expect(completed.startedAt).toBeDefined()
    expect(completed.finishedAt).toBeDefined()

    const invalid = structuredClone(definition)
    invalid.nodes[1].bindings = {
      quantity: { nodeId: 'source', field: 'value', path: ['rows', '0', 'name'] }
    }
    await store.write({ id: 'data', revision: 2, definition: invalid }, 1)
    const failed = await start('nested-2', 2)
    expect(failed.error).toMatchObject({
      code: 'invalid_resolved_input',
      nodeId: 'sink',
      field: 'quantity',
      inputs: { quantity: 'A-01' }
    })
    const completedPage = await fetch(origin + '/workflows/data/runs?status=completed&limit=1')
    expect(await completedPage.json()).toEqual([
      {
        id: 'nested-1',
        workflowId: 'data',
        revision: 1,
        status: 'completed',
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt
      }
    ])
    const latestPage = await fetch(origin + '/workflows/data/runs?limit=1&offset=1')
    expect(await latestPage.json()).toMatchObject([{ id: 'nested-1' }])
    const badFilter = await fetch(origin + '/workflows/data/runs?limit=-1')
    expect(badFilter.status).toBe(400)
  } finally {
    server.close()
  }
})
