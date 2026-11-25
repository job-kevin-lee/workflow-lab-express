import { afterAll, expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'
import {
  createMemoryWorkflowStore,
  createWorkflowRouter,
  humanInputNode,
  loopNode,
  waitForCallNode,
  type JsonObject,
  type WorkflowDefinition,
  type WorkflowNodeRegistration,
  type WorkflowRun
} from './index.js'

const store = createMemoryWorkflowStore()
const prepared: { runId: string; workflowRunId?: string }[] = []
const nodes: WorkflowNodeRegistration[] = [
  humanInputNode,
  loopNode,
  waitForCallNode,
  {
    descriptor: {
      type: 'test:prepare',
      version: 1,
      label: 'Prepare',
      ports: [{ id: 'next', label: 'Continue' }],
      outputs: [{ key: 'prompt', label: 'Prompt', type: 'string', required: true }]
    },
    execute: ({ config, input, runId, workflowRunId }) => {
      prepared.push({ runId, workflowRunId })
      const previous = input.previous as { hint?: string } | null
      return {
        port: 'next',
        output: {
          prompt: [config.prefix, input.index, previous?.hint]
            .filter((value) => value !== undefined)
            .join(' ')
        }
      }
    }
  },
  {
    descriptor: {
      type: 'test:compare',
      version: 1,
      label: 'Compare',
      ports: [],
      inputs: [{ key: 'guess', label: 'Guess', type: 'json', required: true }]
    },
    execute: ({ inputs }) => {
      const { value } = inputs.guess as { value: number }
      return {
        port: null,
        output: { correct: value === 7, hint: value < 7 ? 'Higher' : 'Lower' }
      }
    }
  },
  {
    descriptor: { type: 'test:end', version: 1, label: 'End', ports: [] },
    execute: () => ({ port: null, output: {} })
  }
]

const app = express()
app.use('/first', createWorkflowRouter({ store, nodes, runTimeoutMs: 100 }))
app.use('/after-restart', createWorkflowRouter({ store, nodes, runTimeoutMs: 100 }))
const server = await new Promise<Server>((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
})
afterAll(() => server.close())
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test listener unavailable')
const origin = `http://127.0.0.1:${address.port}`

function graph(
  name: string,
  definition: Pick<WorkflowDefinition, 'entry' | 'nodes' | 'edges'>
): WorkflowDefinition {
  return { schemaVersion: 1, name, ...definition, layout: {} }
}

function node(
  id: string,
  type: string,
  config: JsonObject = {}
): WorkflowDefinition['nodes'][number] {
  return { id, type, version: 1, config }
}

function edge(from: string, port: string, to: string): WorkflowDefinition['edges'][number] {
  return { id: `${from}-${port}`, from, port, to }
}

function post(path: string, body: JsonObject): Promise<Response> {
  return fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function save(id: string, definition: WorkflowDefinition, expected = 0): Promise<boolean> {
  return store.write({ id, revision: expected + 1, definition }, expected)
}

function parentWorkflow(bodyId: string, maxCount: number): WorkflowDefinition {
  return graph('Parent', {
    entry: 'loop',
    nodes: [
      node('loop', 'workflow:loop', {
        workflowId: bodyId,
        maxCount,
        conditions: [{ path: 'correct', operator: 'eq', expected: 'true' }]
      }),
      node('done', 'test:end'),
      node('limit', 'test:end')
    ],
    edges: [edge('loop', 'done', 'done'), edge('loop', 'limit', 'limit')]
  })
}

function release(id: string, waitId: string, body: JsonObject): Promise<Response> {
  return post(`/after-restart/runs/${id}/waits/${waitId}/release`, body)
}

test('a Loop resumes the pinned pass with a unique callback and a fresh time budget', async () => {
  const body = graph('Human body', {
    entry: 'prepare',
    nodes: [
      node('prepare', 'test:prepare', { prefix: 'Original' }),
      {
        ...node('ask', 'workflow:human-input', {
          message: 'Default',
          label: 'Guess',
          type: 'number'
        }),
        bindings: { prompt: { nodeId: 'prepare', field: 'prompt' } }
      },
      {
        ...node('compare', 'test:compare'),
        bindings: { guess: { nodeId: 'ask', field: 'payload' } }
      }
    ],
    edges: [edge('prepare', 'next', 'ask'), edge('ask', 'submitted', 'compare')]
  })
  expect(await save('human-body', body)).toBe(true)
  expect(await save('human-loop', parentWorkflow('human-body', 3))).toBe(true)

  const started = await post('/first/workflows/human-loop/runs', {
    runId: 'human-loop-run',
    revision: 1,
    input: {}
  })
  expect(started.status).toBe(202)
  const first: WorkflowRun = await started.json()
  expect(first.waiting).toMatchObject({
    nodeId: 'loop',
    bodyNodeId: 'ask',
    pass: 1,
    message: 'Original 0',
    form: { label: 'Guess', type: 'number' }
  })
  const firstId = first.waiting?.id
  if (!firstId) throw new Error('Missing callback ID')
  const invalid = await release(first.id, firstId, { value: '3' })
  expect(await invalid.json()).toEqual({ error: 'invalid_human_input' })
  expect(invalid.status).toBe(422)

  const revised = structuredClone(body)
  revised.nodes[0].config.prefix = 'Revised'
  expect(await save('human-body', revised, 1)).toBe(true)
  await Bun.sleep(125)

  const releases = await Promise.all([
    release(first.id, firstId, { value: 3 }),
    release(first.id, firstId, { value: 3 })
  ])
  expect(releases.map(({ status }) => status).sort()).toEqual([202, 409])
  const second = await store.getRun(first.id)
  expect(second?.waiting).toMatchObject({ pass: 2, message: 'Original 1 Higher' })
  const secondId = second?.waiting?.id
  if (!secondId) throw new Error('Missing second callback ID')
  expect(secondId).not.toBe(firstId)
  expect((await release(first.id, firstId, { value: 7 })).status).toBe(409)

  const completedResponse = await release(first.id, secondId, { value: 7 })
  expect(completedResponse.status).toBe(200)
  const completed: WorkflowRun = await completedResponse.json()
  expect(completed.status).toBe('completed')
  expect(completed.loopCheckpoint).toBeUndefined()
  expect(completed.steps[0]).toMatchObject({ nodeId: 'loop', port: 'done', output: { count: 2 } })
  expect(
    completed.bodyRuns?.map(({ steps }) => steps.find(({ nodeId }) => nodeId === 'ask')?.output)
  ).toEqual([{ payload: { value: 3 } }, { payload: { value: 7 } }])
  expect(prepared.map(({ workflowRunId }) => workflowRunId)).toEqual([first.id, first.id])
  expect(new Set(prepared.map(({ runId }) => runId)).size).toBe(2)
})

test('a waiting Loop body capped at one pass follows Limit reached', async () => {
  expect(
    await save(
      'callback-body',
      graph('Callback body', {
        entry: 'wait',
        nodes: [
          node('wait', 'workflow:wait-for-call', { message: 'Send a callback' }),
          node('end', 'test:end')
        ],
        edges: [edge('wait', 'received', 'end')]
      })
    )
  ).toBe(true)
  const definition = parentWorkflow('callback-body', 1)
  definition.nodes[0].config.conditions = [{ path: 'correct', operator: 'exists' }]
  expect(await save('callback-loop', definition)).toBe(true)
  const started = await post('/first/workflows/callback-loop/runs', {
    runId: 'callback-loop-run',
    revision: 1,
    input: {}
  })
  expect(started.status).toBe(202)
  const run: WorkflowRun = await started.json()
  const waitId = run.waiting?.id
  if (!waitId) throw new Error('Missing callback ID')
  const finished = await release(run.id, waitId, {})
  expect(finished.status).toBe(200)
  const completed: WorkflowRun = await finished.json()
  expect(completed.steps[0]).toMatchObject({ nodeId: 'loop', port: 'limit', output: { count: 1 } })
  expect(completed.bodyRuns?.[0].steps[0]).toMatchObject({
    releasedWait: true,
    output: { payload: {} }
  })
})
