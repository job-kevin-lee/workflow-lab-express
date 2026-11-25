import type {
  JsonObject,
  LogicCondition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode
} from '@ideawithai/workflow-express/schema'

export const exampleNames = [
  { id: 'guess-a-number', label: 'Guess a number' },
  { id: 'check-ready', label: 'Ready data' },
  { id: 'check-unmatched', label: 'Unmatched data' },
  { id: 'check-github', label: 'Live GitHub data' },
  { id: 'collect-quantity', label: 'Human input' },
  { id: 'iterate-inventory', label: 'Iteration' },
  { id: 'repeat-until-ready', label: 'Loop' },
  { id: 'check-inventory-stock', label: 'Stock check (custom node)' }
] as const

export const numberGame = {
  minimum: 1,
  maximum: 100,
  attempts: 10,
  roundType: 'lab:guess-round',
  finishType: 'lab:finish-guess'
} as const

export const bodyExampleNames = [
  {
    id: 'inventory-item-body',
    label: 'Inspect inventory item',
    input: { item: { sku: 'A-01', quantity: 4 }, index: 0 }
  },
  { id: 'loop-index-body', label: 'Read pass index', input: { index: 0, previous: null } }
] as const

const node = (id: string, type: string, label: string, config: JsonObject): WorkflowNode => ({
  id,
  type: `workflow:${type}`,
  label,
  config,
  version: 1
})

const edge = (from: string, port: string, to: string): WorkflowEdge => ({
  id: `${from}-${port}`,
  from,
  port,
  to
})

function buildExample(name: string, url: string, conditions: LogicCondition[]): WorkflowDefinition {
  return {
    name,
    schemaVersion: 1,
    entry: 'delay',
    nodes: [
      node('delay', 'wait', 'Wait 3 seconds', { seconds: 3 }),
      node('fetch', 'http', 'Fetch JSON data', { method: 'GET', url }),
      {
        ...node('check', 'logic', 'Does the data match?', {
          mode: 'all',
          conditions: conditions.map((condition) => ({ ...condition }))
        }),
        bindings: { value: { nodeId: 'fetch', field: 'body' } }
      },
      node('pause', 'wait-for-call', 'Wait for external call', {
        message: 'The data matched. Send a callback to continue.'
      }),
      {
        ...node('done', 'result', 'Callback received', {
          message: 'The workflow resumed and received the callback payload.',
          tone: 'success'
        }),
        bindings: { value: { nodeId: 'pause', field: 'payload' } }
      },
      node('skip', 'result', 'Conditions did not match', {
        message: 'The Else branch finished without waiting for a callback.',
        tone: 'info'
      }),
      {
        ...node('error', 'result', 'Unable to fetch data', {
          message: 'The HTTP Request followed its Error branch.',
          tone: 'error'
        }),
        bindings: { value: { nodeId: 'fetch', field: 'body' } }
      }
    ],
    edges: [
      edge('delay', 'next', 'fetch'),
      edge('fetch', 'ok', 'check'),
      edge('fetch', 'error', 'error'),
      edge('check', 'yes', 'pause'),
      edge('check', 'no', 'skip'),
      edge('pause', 'received', 'done')
    ],
    layout: {
      delay: { x: 0, y: 64 },
      fetch: { x: 225, y: 64 },
      check: { x: 450, y: 64 },
      pause: { x: 675, y: 15 },
      done: { x: 900, y: 15 },
      skip: { x: 675, y: 173 },
      error: { x: 450, y: 229 }
    }
  }
}

const rules: LogicCondition[] = [
  { path: 'status', operator: 'eq', expected: '"ready"' },
  { path: 'count', operator: 'gte', expected: '1' }
]

function graph(name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name,
    entry: nodes[0].id,
    nodes,
    edges,
    layout: Object.fromEntries(nodes.map(({ id }, index) => [id, { x: index * 235, y: 42 }]))
  }
}

function result(
  id: string,
  label: string,
  message: string,
  source?: { nodeId: string; field: string },
  tone?: 'success' | 'error'
): WorkflowNode {
  return {
    ...node(id, 'result', label, { message, ...(tone && { tone }) }),
    ...(source && { bindings: { value: source } })
  }
}

function bodyWorkflow(name: string, path: string): WorkflowDefinition {
  return graph(
    name,
    [
      node('input', 'input', 'Read workflow input', { path }),
      result('result', 'Return value', name, { nodeId: 'input', field: 'value' })
    ],
    [edge('input', 'next', 'result')]
  )
}

const collectQuantity = graph(
  'Collect a stock count',
  [
    node('input', 'human-input', 'Enter stock count', {
      message: 'How many items are on the shelf?',
      label: 'Stock count',
      type: 'number'
    }),
    result(
      'received',
      'Stock count received',
      'The submitted count is available to the workflow.',
      { nodeId: 'input', field: 'payload' }
    )
  ],
  [edge('input', 'submitted', 'received')]
)

const iterateInventory = graph(
  'Inspect inventory items',
  [
    node('fetch', 'http', 'Fetch inventory list', {
      method: 'GET',
      url: '/api/demo/resources/items'
    }),
    {
      ...node('each', 'iteration', 'Inspect each item', { workflowId: 'inventory-item-body' }),
      bindings: { items: { nodeId: 'fetch', field: 'body' } }
    },
    result('done', 'Inventory inspected', 'The ordered results are available in Trace Log.', {
      nodeId: 'each',
      field: 'results'
    }),
    result('error', 'Inventory unavailable', 'The inventory request failed.')
  ],
  [edge('fetch', 'ok', 'each'), edge('each', 'next', 'done'), edge('fetch', 'error', 'error')]
)
iterateInventory.layout.error = { x: 235, y: 165 }

const repeatUntilReady = graph(
  'Repeat until ready',
  [
    node('repeat', 'loop', 'Check until pass three', {
      workflowId: 'loop-index-body',
      maxCount: 5,
      conditions: [{ path: 'value', operator: 'gte', expected: '2' }]
    }),
    result(
      'done',
      'Stop condition met',
      'The loop stopped when its output matched the condition.',
      { nodeId: 'repeat', field: 'last' }
    ),
    result(
      'limit',
      'Pass limit reached',
      'The loop reached its limit before the condition matched.',
      { nodeId: 'repeat', field: 'last' }
    )
  ],
  [edge('repeat', 'done', 'done'), edge('repeat', 'limit', 'limit')]
)
repeatUntilReady.layout.limit = { x: 235, y: 151 }

const guessingRounds: WorkflowNode[] = Array.from({ length: numberGame.attempts - 1 }, (_, i) => {
  const attempt = i + 2
  return {
    id: `guess-${attempt}`,
    type: numberGame.roundType,
    version: 1,
    label: `Guess ${attempt}`,
    config: { attempt },
    bindings: { guess: { nodeId: `guess-${attempt - 1}`, field: 'payload' } }
  }
})

const guessANumber = graph(
  'Guess a number',
  [
    node('guess-1', 'human-input', 'Guess 1', {
      message: `I picked a whole number from ${numberGame.minimum} to ${numberGame.maximum}. Guess 1 of ${numberGame.attempts}.`,
      label: 'Your guess',
      type: 'number'
    }),
    ...guessingRounds,
    result('win', 'Correct guess', 'You guessed the number.', undefined, 'success'),
    {
      id: 'finish',
      type: numberGame.finishType,
      version: 1,
      config: {},
      bindings: { guess: { nodeId: `guess-${numberGame.attempts}`, field: 'payload' } }
    }
  ],
  [
    edge('guess-1', 'submitted', guessingRounds[0].id),
    ...guessingRounds.flatMap(({ id }, i) => [
      edge(id, 'submitted', guessingRounds[i + 1]?.id ?? 'finish'),
      edge(id, 'correct', 'win')
    ])
  ]
)
for (const [i, { id }] of guessANumber.nodes.slice(0, numberGame.attempts).entries()) {
  guessANumber.layout[id] = { x: (i % 5) * 225, y: i < 5 ? 32 : 235 }
}
guessANumber.layout.win = { x: 1125, y: 133 }
guessANumber.layout.finish = { x: 1125, y: 235 }

const checkInventoryStock = graph(
  'Check inventory stock',
  [
    node('fetch', 'http', 'Fetch inventory', { method: 'GET', url: '/api/demo/resources/items' }),
    {
      id: 'stock',
      type: 'lab:stock-check',
      version: 1,
      config: { minimum: 3 },
      bindings: { items: { nodeId: 'fetch', field: 'body' } }
    },
    result('low', 'Low stock found', 'Some items are below the minimum quantity.', {
      nodeId: 'stock',
      field: 'summary'
    }),
    result(
      'stocked',
      'Stock levels met',
      'Every item met the minimum quantity.',
      { nodeId: 'stock', field: 'summary' },
      'success'
    ),
    result('error', 'Inventory unavailable', 'The inventory request failed.', undefined, 'error')
  ],
  [
    edge('fetch', 'ok', 'stock'),
    edge('fetch', 'error', 'error'),
    edge('stock', 'low', 'low'),
    edge('stock', 'stocked', 'stocked')
  ]
)
checkInventoryStock.layout.stocked = { x: 470, y: 162 }
checkInventoryStock.layout.error = { x: 235, y: 162 }

export const examples: Record<string, WorkflowDefinition> = {
  'check-ready': buildExample('Check ready data', '/api/demo/resources/ready', rules),
  'check-unmatched': buildExample('Check unmatched data', '/api/demo/resources/unmatched', rules),
  'check-github': buildExample(
    'Check a public GitHub repository',
    'https://api.github.com/repos/expressjs/express',
    [
      { path: 'name', operator: 'eq', expected: '"express"' },
      { path: 'archived', operator: 'eq', expected: 'false' }
    ]
  ),
  'collect-quantity': collectQuantity,
  'iterate-inventory': iterateInventory,
  'repeat-until-ready': repeatUntilReady,
  'guess-a-number': guessANumber,
  'check-inventory-stock': checkInventoryStock,
  'inventory-item-body': bodyWorkflow('Inspect inventory item', 'item'),
  'loop-index-body': bodyWorkflow('Read pass index', 'index')
}
