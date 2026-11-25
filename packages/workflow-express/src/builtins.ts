import { setTimeout } from 'node:timers/promises'
import type { WorkflowNodeRegistration } from './index.js'
import {
  isJsonObject,
  isId,
  isLogicConditions,
  isRecord,
  type JsonValue,
  type LogicCondition,
  type WorkflowHumanInput
} from './schema.js'

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const operators = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']

function read(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const key of path.split('.').filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)]
    else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key] as JsonValue
    else return undefined
  }
  return current
}

export function createHttpRequestNode(options: {
  origin: string
  allowedOrigins?: readonly string[]
  request?: (url: URL, init: RequestInit) => Promise<Response>
}): WorkflowNodeRegistration {
  const origin = new URL(options.origin)
  const allowedOrigins = new Set(
    [origin, ...(options.allowedOrigins ?? []).map((value) => new URL(value))].map((url) => {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid HTTP node origin')
      return url.origin
    })
  )
  const request = options.request ?? fetch
  return {
    descriptor: {
      type: 'workflow:http',
      version: 1,
      label: 'HTTP Request',
      description: 'Call an endpoint and branch on the response.',
      fields: [
        { key: 'method', label: 'Method', type: 'string', options: methods, required: true },
        { key: 'url', label: 'URL or path', type: 'string', required: true },
        { key: 'headers', label: 'Headers (JSON object)', type: 'string', multiline: true },
        { key: 'body', label: 'Request body (JSON)', type: 'string', multiline: true },
        { key: 'successPath', label: 'Success field (optional)', type: 'string' }
      ],
      inputs: [{ key: 'body', label: 'Body from previous output', type: 'json' }],
      outputs: [
        { key: 'status', label: 'HTTP status', type: 'number', required: true },
        { key: 'body', label: 'Response body', type: 'json', required: true }
      ],
      ports: [
        { id: 'ok', label: 'Success' },
        { id: 'error', label: 'Error' }
      ]
    },
    async execute({ config, inputs, signal }) {
      const url = new URL(String(config.url), origin)
      if (!allowedOrigins.has(url.origin) || url.username || url.password)
        throw new Error('HTTP URL is outside the configured origin')
      const method = String(config.method)
      const headerData: unknown = config.headers ? JSON.parse(String(config.headers)) : {}
      if (
        !isJsonObject(headerData) ||
        Object.values(headerData).some((value) => typeof value !== 'string')
      ) {
        throw new Error('HTTP headers must contain string values')
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(headerData)) headers.set(key, String(value))
      const payload: JsonValue | undefined = Object.hasOwn(inputs, 'body')
        ? inputs.body
        : config.body
          ? JSON.parse(String(config.body))
          : undefined
      const withBody = payload !== undefined && method !== 'GET' && method !== 'HEAD'
      if (withBody && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      const httpRequest = { method, url: url.href, headers: Object.fromEntries(headers) }
      try {
        const response = await request(url, {
          method,
          headers,
          signal,
          redirect: 'error',
          body: withBody ? JSON.stringify(payload) : undefined
        })
        const text = await response.text()
        let body: JsonValue = text || null
        if (text && response.headers.get('content-type')?.includes('json')) {
          body = JSON.parse(text)
        }
        const ok =
          response.ok && (!config.successPath || read(body, String(config.successPath)) === true)
        return { port: ok ? 'ok' : 'error', output: { status: response.status, body }, httpRequest }
      } catch (error) {
        signal.throwIfAborted()
        return {
          port: 'error',
          output: { status: 0, body: error instanceof Error ? error.message : 'Request failed' },
          httpRequest
        }
      }
    }
  }
}

export const conditionNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:condition',
    version: 1,
    label: 'Condition',
    category: 'Logic',
    description: 'Compare a value and choose Yes or No.',
    fields: [
      { key: 'path', label: 'Field path', type: 'string' },
      {
        key: 'operator',
        label: 'Operator',
        type: 'string',
        required: true,
        options: operators,
        optionLabels: {
          eq: 'Equals',
          ne: 'Does not equal',
          lt: 'Less than',
          lte: 'At most',
          gt: 'Greater than',
          gte: 'At least'
        }
      },
      { key: 'expected', label: 'Expected JSON value', type: 'string', required: true }
    ],
    inputs: [{ key: 'value', label: 'Value to check', type: 'json', required: true }],
    outputs: [{ key: 'matched', label: 'Matched', type: 'boolean', required: true }],
    ports: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' }
    ]
  },
  execute({ config, inputs }) {
    const matched = matchesCondition(inputs.value, {
      path: String(config.path ?? ''),
      operator: config.operator as LogicCondition['operator'],
      expected: String(config.expected)
    })
    return { port: matched ? 'yes' : 'no', output: { matched } }
  }
}

export const resultNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:result',
    version: 1,
    label: 'Result',
    description: 'End the run with a message and optional data.',
    fields: [
      { key: 'message', label: 'Message', type: 'string', required: true },
      {
        key: 'tone',
        label: 'Result tone',
        type: 'string',
        options: ['info', 'success', 'warning', 'error']
      }
    ],
    inputs: [{ key: 'value', label: 'Result data', type: 'json' }],
    ports: []
  },
  execute: ({ config, inputs }) => ({
    port: null,
    output: { message: config.message, tone: config.tone ?? 'info', ...inputs }
  })
}

function matchesCondition(
  value: JsonValue,
  { path, operator, expected: raw }: LogicCondition
): boolean {
  const actual = read(value, path)
  if (operator === 'exists') return actual !== undefined
  if (actual === undefined) throw new Error('Condition field is missing')
  const expected: unknown = JSON.parse(raw ?? '')
  if (operator === 'eq' || operator === 'ne') {
    if (expected !== null && typeof expected === 'object')
      throw new Error('Condition equality expects a scalar')
    return operator === 'eq' ? actual === expected : actual !== expected
  }
  if (operator === 'contains') {
    if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
    if (Array.isArray(actual)) return actual.some((item) => item === expected)
    throw new Error('Contains requires a string or array')
  }
  if (typeof actual !== 'number' || typeof expected !== 'number')
    throw new Error('Condition requires numbers')
  switch (operator) {
    case 'lt':
      return actual < expected
    case 'lte':
      return actual <= expected
    case 'gt':
      return actual > expected
    case 'gte':
      return actual >= expected
    default:
      throw new Error('Unknown condition operator')
  }
}

export const logicNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:logic',
    version: 1,
    label: 'If / Else',
    category: 'Logic',
    description: 'Combine conditions and take the If or Else branch.',
    fields: [
      {
        key: 'mode',
        label: 'Match',
        type: 'string',
        required: true,
        options: ['all', 'any'],
        optionLabels: { all: 'All conditions (AND)', any: 'Any condition (OR)' }
      },
      { key: 'conditions', label: 'Conditions', type: 'conditions', required: true }
    ],
    inputs: [{ key: 'value', label: 'Value to check', type: 'json', required: true }],
    outputs: [{ key: 'matched', label: 'Matched', type: 'boolean', required: true }],
    ports: [
      { id: 'yes', label: 'If' },
      { id: 'no', label: 'Else' }
    ]
  },
  execute({ config, inputs }) {
    if (!isLogicConditions(config.conditions) || !config.conditions.length)
      throw new Error('No logic conditions')
    const check = (condition: LogicCondition): boolean => matchesCondition(inputs.value, condition)
    const matched =
      config.mode === 'any' ? config.conditions.some(check) : config.conditions.every(check)
    return { port: matched ? 'yes' : 'no', output: { matched } }
  }
}

export const waitNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:wait',
    version: 1,
    label: 'Wait',
    description: 'Continue after a fixed delay.',
    fields: [{ key: 'seconds', label: 'Seconds', type: 'number', required: true }],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  async execute({ config, signal }) {
    const seconds = config.seconds
    if (typeof seconds !== 'number' || seconds < 0 || seconds > 86400)
      throw new Error('Invalid wait duration')
    await setTimeout(seconds * 1000, undefined, { signal })
    return { port: 'next', output: { seconds } }
  }
}

export const waitForCallNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:wait-for-call',
    version: 1,
    label: 'Wait for Call',
    pausesRun: true,
    description: 'Pause until the run receives an HTTP POST.',
    fields: [{ key: 'message', label: 'Waiting message', type: 'string' }],
    outputs: [{ key: 'payload', label: 'Callback payload', type: 'json', required: true }],
    ports: [{ id: 'received', label: 'Call received' }]
  },
  execute: ({ config }) => ({
    waitForCall: {
      port: 'received',
      message: String(config.message || 'Waiting for an HTTP call.')
    }
  })
}

export const humanInputNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:human-input',
    version: 1,
    label: 'Human Input',
    category: 'Logic',
    pausesRun: true,
    description: 'Pause and ask someone to enter a value.',
    fields: [
      { key: 'message', label: 'Prompt', type: 'string', required: true },
      { key: 'label', label: 'Field label', type: 'string', required: true },
      {
        key: 'type',
        label: 'Field type',
        type: 'string',
        required: true,
        options: ['text', 'number', 'boolean'],
        optionLabels: { text: 'Text', number: 'Number', boolean: 'Yes / No' }
      }
    ],
    outputs: [{ key: 'payload', label: 'Submitted data', type: 'json', required: true }],
    ports: [{ id: 'submitted', label: 'Submitted' }]
  },
  execute({ config }) {
    const { label, message, type } = config
    if (
      typeof label !== 'string' ||
      typeof message !== 'string' ||
      (type !== 'text' && type !== 'number' && type !== 'boolean')
    ) {
      throw new Error('Invalid human input settings')
    }
    const form: WorkflowHumanInput = { label, type }
    return { waitForCall: { port: 'submitted', message, form } }
  }
}

export const inputNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:input',
    version: 1,
    label: 'Workflow Input',
    description: 'Read a value from the workflow input.',
    fields: [{ key: 'path', label: 'Input path', type: 'string' }],
    outputs: [{ key: 'value', label: 'Input value', type: 'json', required: true }],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  execute({ input, config }) {
    const value = read(input, String(config.path ?? ''))
    if (value === undefined) throw new Error('Workflow input path is missing')
    return { port: 'next', output: { value } }
  }
}

const bodyWorkflowField = {
  key: 'workflowId',
  label: 'Body workflow',
  type: 'workflow',
  required: true
} as const
const maxRepeatCount = 100

export const iterationNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:iteration',
    version: 1,
    label: 'Iteration',
    category: 'Logic',
    description: 'Run a workflow for each item in a list.',
    fields: [bodyWorkflowField, { key: 'path', label: 'List field path', type: 'string' }],
    inputs: [{ key: 'items', label: 'List or source data', type: 'json', required: true }],
    outputs: [
      { key: 'results', label: 'Ordered results', type: 'json', required: true },
      { key: 'count', label: 'Item count', type: 'number', required: true }
    ],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  async execute({ config, inputs, runBody }) {
    const { workflowId } = config
    if (!isId(workflowId) || !runBody) throw new Error('Iteration requires a body workflow')
    const items = read(inputs.items, String(config.path ?? ''))
    if (!Array.isArray(items) || items.length > maxRepeatCount)
      throw new Error('Iteration requires a list of up to 100 items')
    const results = []
    for (const [index, item] of items.entries()) {
      results.push(await runBody(workflowId, { item, index }))
    }
    return { port: 'next', output: { results, count: results.length } }
  }
}

export const loopNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'workflow:loop',
    version: 1,
    label: 'Loop',
    category: 'Logic',
    description: 'Repeat a workflow until a condition or count is reached.',
    fields: [
      bodyWorkflowField,
      { key: 'maxCount', label: 'Maximum passes (1–100)', type: 'number', required: true },
      { key: 'conditions', label: 'Stop conditions', type: 'conditions' }
    ],
    outputs: [
      { key: 'last', label: 'Last result', type: 'json', required: true },
      { key: 'count', label: 'Passes', type: 'number', required: true }
    ],
    ports: [
      { id: 'done', label: 'Done' },
      { id: 'limit', label: 'Limit reached' }
    ]
  },
  async execute({ config, runBody }) {
    const { workflowId, maxCount, conditions = [] } = config
    if (!isId(workflowId) || !runBody) throw new Error('Loop requires a body workflow')
    if (
      typeof maxCount !== 'number' ||
      !Number.isInteger(maxCount) ||
      maxCount < 1 ||
      maxCount > maxRepeatCount
    ) {
      throw new Error('Loop count must be an integer between 1 and 100')
    }
    if (!isLogicConditions(conditions)) throw new Error('Invalid loop conditions')
    let last: JsonValue = null
    for (let index = 0; index < maxCount; index++) {
      last = await runBody(workflowId, { index, previous: last })
      if (conditions.length && conditions.every((condition) => matchesCondition(last, condition))) {
        return { port: 'done', output: { last, count: index + 1 } }
      }
    }
    return { port: conditions.length ? 'limit' : 'done', output: { last, count: maxCount } }
  }
}
