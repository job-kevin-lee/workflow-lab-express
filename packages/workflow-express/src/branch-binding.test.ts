import { expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  createMemoryWorkflowStore,
  createWorkflowRouter,
  isWorkflowDefinition,
  possibleUpstreamSources,
  resolveInputBinding,
  resultNode,
  validateWorkflow,
  type JsonObject,
  type WorkflowDefinition,
  type WorkflowNodeRegistration,
  type WorkflowRun
} from './index.js'

const registrations: WorkflowNodeRegistration[] = [
  {
    descriptor: {
      type: 'test:choose',
      version: 1,
      label: 'Choose',
      ports: [
        { id: 'left', label: 'Left' },
        { id: 'right', label: 'Right' }
      ],
      outputs: [{ key: 'row', label: 'Row', type: 'json', required: true }]
    },
    execute: ({ input }) => ({
      port: input.left ? 'left' : 'right',
      output: { row: { value: 'from both paths' } }
    })
  },
  {
    descriptor: {
      type: 'test:quote',
      version: 1,
      label: 'Quote',
      ports: [{ id: 'next', label: 'Next' }],
      outputs: [{ key: 'row', label: 'Row', type: 'json', required: true }]
    },
    execute: ({ input }) => ({
      port: 'next',
      output: { row: Object.hasOwn(input, 'value') ? { value: input.value } : {} }
    })
  },
  resultNode
]

const catalog = registrations.map(({ descriptor }) => descriptor)
const left = { nodeId: 'left', field: 'row', path: ['value'] }
const right = { nodeId: 'right', field: 'row', path: ['value'] }
const invalidBinding = { code: 'invalid_branch_binding', nodeId: 'done', field: 'value' }
const definition: WorkflowDefinition = {
  name: 'Branch output',
  schemaVersion: 1,
  entry: 'choose',
  layout: {},
  nodes: [
    { id: 'choose', type: 'test:choose', version: 1, config: {} },
    { id: 'left', type: 'test:quote', version: 1, config: {} },
    { id: 'right', type: 'test:quote', version: 1, config: {} },
    {
      id: 'done',
      type: 'workflow:result',
      version: 1,
      config: { message: 'Quote received' },
      bindings: { value: { branches: [left, right] } }
    }
  ],
  edges: [
    { id: 'left', from: 'choose', port: 'left', to: 'left' },
    { id: 'right', from: 'choose', port: 'right', to: 'right' },
    { id: 'left-done', from: 'left', port: 'next', to: 'done' },
    { id: 'right-done', from: 'right', port: 'next', to: 'done' }
  ]
}

test('branch binding covers exactly one compatible source on each path to the consumer', () => {
  expect(isWorkflowDefinition(JSON.parse(JSON.stringify(definition)))).toBe(true)
  expect(possibleUpstreamSources(definition, 'done')).toEqual(new Set(['choose', 'left', 'right']))
  expect(validateWorkflow(definition, catalog)).toEqual([])

  const bypass = structuredClone(definition)
  bypass.edges[1].to = 'done'
  expect(validateWorkflow(bypass, catalog)).toContainEqual(invalidBinding)
  for (const branches of [
    [],
    [left],
    [left, left],
    [left, { ...right, field: 'unknown' }],
    [left, right, { ...left, nodeId: 'choose' }]
  ]) {
    const draft = structuredClone(definition)
    draft.nodes[3].bindings = { value: { branches } }
    expect(isWorkflowDefinition(draft)).toBe(true)
    expect(validateWorkflow(draft, catalog)).toContainEqual(invalidBinding)
  }

  const deadEnd = structuredClone(definition)
  deadEnd.nodes.push({
    id: 'other',
    type: 'workflow:result',
    version: 1,
    config: { message: 'Different ending' }
  })
  deadEnd.edges[3].to = 'other'
  expect(validateWorkflow(deadEnd, catalog)).toContainEqual(invalidBinding)

  const overlap = structuredClone(definition)
  overlap.edges[2].to = 'right'
  expect(validateWorkflow(overlap, catalog)).toContainEqual(invalidBinding)
})

test('runs bind the executed branch value and reject missing nested output', async () => {
  const store = createMemoryWorkflowStore()
  await store.write({ id: 'quote', definition, revision: 1 }, 0)
  const app = express()
  app.use(createWorkflowRouter({ store, nodes: registrations }))
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  const start = async (runId: string, input: JsonObject): Promise<WorkflowRun> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/workflows/quote/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, revision: 1, input })
    })
    expect(response.status).toBe(201)
    return response.json()
  }
  try {
    for (const [index, [branch, value]] of [
      ['left', 0],
      ['right', false],
      ['right', null]
    ].entries()) {
      const run = await start(`branch-${index}`, { left: branch === 'left', value })
      expect(run.status).toBe('completed')
      expect(run.steps.map(({ nodeId }) => nodeId)).toEqual(['choose', branch, 'done'])
      expect(run.steps.at(-1)?.output.value).toBe(value)
    }
    const missing = await start('missing-value', { left: true })
    expect(missing.status).toBe('failed')
    expect(missing.error).toMatchObject({
      code: 'invalid_resolved_input',
      nodeId: 'done',
      field: 'value'
    })
  } finally {
    server.close()
  }
})

test('historical outputs with multiple branch sources produce no sample', () => {
  const outputs = new Map<string, JsonObject>([
    ['left', { row: { value: 3 } }],
    ['right', { row: { value: 9 } }]
  ])
  expect(resolveInputBinding(outputs, { branches: [left, right] })).toEqual({})
  expect(resolveInputBinding(outputs, right)).toEqual({ source: right, value: 9 })
})
