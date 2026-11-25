import type { LogicCondition, WorkflowDefinition } from '@ideawithai/workflow-express/schema'
import { edge, graph, node, result } from './example-graph.js'
import { gameBodies, gameBodyExamples, games } from './game-examples.js'

const guessExample = { id: 'guess-a-number-loop', label: 'Guess a number' } as const

export const gameExampleNames = [
  guessExample,
  ...Object.entries(games).map(([id, { name }]) => ({ id, label: name }))
]

export const exampleNames = [
  { id: 'check-ready', label: 'Ready data' },
  { id: 'check-unmatched', label: 'Unmatched data' },
  { id: 'check-github', label: 'Live GitHub data' },
  { id: 'collect-quantity', label: 'Human input' },
  { id: 'iterate-inventory', label: 'Iteration' },
  { id: 'repeat-until-ready', label: 'Loop' },
  { id: 'check-inventory-stock', label: 'Stock check (custom node)' },
  { id: 'format-inventory', label: 'Map JSON and Template' },
  { id: 'find-inventory-item', label: 'Look up an inventory item' },
  { id: 'supplier-quote', label: 'Read a supplier quote' }
] as const

export const numberGame = {
  minimum: 1,
  maximum: 100,
  attempts: 10,
  roundType: 'lab:guess-round',
  finishType: 'lab:finish-guess',
  promptType: 'lab:guess-prompt',
  checkType: 'lab:check-guess'
} as const

export const bodyExampleNames = [
  {
    id: 'inventory-item-body',
    label: 'Inspect inventory item',
    input: { item: { sku: 'A-01', quantity: 4 }, index: 0 }
  },
  { id: 'loop-index-body', label: 'Read pass index', input: { index: 0, previous: null } },
  { id: 'guess-turn', label: 'Guess a number · One turn', input: { index: 0, previous: null } },
  ...gameBodyExamples
] as const

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

const guessTurn = graph(
  'Guess a number · One turn',
  [
    { id: 'prompt', type: numberGame.promptType, config: {}, version: 1 },
    {
      ...node('guess', 'human-input', 'Enter a guess', {
        message: 'Guess a number from 1 to 100.',
        label: 'Your guess',
        type: 'number'
      }),
      bindings: { prompt: { nodeId: 'prompt', field: 'text' } }
    },
    {
      id: 'check',
      type: numberGame.checkType,
      version: 1,
      config: {},
      bindings: { guess: { nodeId: 'guess', field: 'payload' } }
    }
  ],
  [edge('prompt', 'next', 'guess'), edge('guess', 'submitted', 'check')]
)

const guessANumber = graph(
  'Guess a number',
  [
    node('loop', 'loop', 'Guess up to ten times', {
      workflowId: 'guess-turn',
      maxCount: numberGame.attempts,
      conditions: [{ path: 'correct', operator: 'eq', expected: 'true' }]
    }),
    {
      ...node('win', 'result', 'Correct guess', {
        message: 'You guessed the number.',
        tone: 'success'
      }),
      bindings: { message: { nodeId: 'loop', field: 'last', path: ['message'] } }
    },
    {
      ...node('limit', 'result', 'Out of guesses', {
        message: 'You used all ten guesses.',
        tone: 'warning'
      }),
      bindings: { message: { nodeId: 'loop', field: 'last', path: ['message'] } }
    }
  ],
  [edge('loop', 'done', 'win'), edge('loop', 'limit', 'limit')]
)
guessANumber.layout.win = { x: 260, y: 10 }
guessANumber.layout.limit = { x: 260, y: 150 }

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

const formatInventory = graph(
  'Format inventory JSON',
  [
    node('fetch', 'http', 'Fetch inventory', { method: 'GET', url: '/api/demo/resources/items' }),
    {
      ...node('map', 'map-json', 'Select the first item', {
        mapping: JSON.stringify({ sku: '[0].sku', quantity: '[0].quantity' }, null, 2)
      }),
      bindings: { value: { nodeId: 'fetch', field: 'body' } }
    },
    {
      ...node('text', 'template', 'Create an inventory note', {
        template: 'Item {{sku}} has {{quantity}} units in stock.'
      }),
      bindings: { value: { nodeId: 'map', field: 'value' } }
    },
    {
      ...node('done', 'result', 'Inventory note', {
        message: 'Inventory mapped.',
        tone: 'success'
      }),
      bindings: { message: { nodeId: 'text', field: 'text' } }
    },
    result('error', 'Inventory unavailable', 'The inventory request failed.', undefined, 'error')
  ],
  [
    edge('fetch', 'ok', 'map'),
    edge('fetch', 'error', 'error'),
    edge('map', 'next', 'text'),
    edge('text', 'next', 'done')
  ]
)
formatInventory.layout.error = { x: 235, y: 170 }

const findInventoryItem = graph(
  'Look up an inventory item',
  [
    node('sku', 'human-input', 'Enter a SKU', {
      message: 'Look up an inventory item. Try A-01, B-07 or C-03.',
      label: 'SKU',
      type: 'text'
    }),
    {
      ...node('query', 'map-json', 'Build query parameters', {
        mapping: JSON.stringify({ sku: 'value' }, null, 2)
      }),
      bindings: { value: { nodeId: 'sku', field: 'payload' } }
    },
    {
      ...node('fetch', 'http', 'Find the item', {
        method: 'GET',
        url: '/api/demo/resources/items'
      }),
      bindings: { query: { nodeId: 'query', field: 'value' } }
    },
    result('done', 'Look-up complete', 'Open Trace Log to see the matching items.', {
      nodeId: 'fetch',
      field: 'body'
    }),
    result('error', 'Inventory unavailable', 'The inventory request failed.', undefined, 'error')
  ],
  [
    edge('sku', 'submitted', 'query'),
    edge('query', 'next', 'fetch'),
    edge('fetch', 'ok', 'done'),
    edge('fetch', 'error', 'error')
  ]
)
findInventoryItem.layout.error = { x: 705, y: 170 }

const supplierQuote = graph(
  'Read a supplier quote',
  [
    node('pick', 'human-input', 'Choose a supplier', {
      message: 'Request a quote from the primary supplier? Choose No for the backup supplier.',
      label: 'Use primary supplier',
      type: 'boolean'
    }),
    {
      ...node('route', 'logic', 'Primary supplier?', {
        mode: 'all',
        conditions: [{ path: 'value', operator: 'eq', expected: 'true' }]
      }),
      bindings: { value: { nodeId: 'pick', field: 'payload' } }
    },
    node('primary', 'http', 'Primary quote', {
      method: 'GET',
      url: '/api/demo/resources/supplier-quote?source=primary'
    }),
    node('backup', 'http', 'Backup quote', {
      method: 'GET',
      url: '/api/demo/resources/supplier-quote?source=backup'
    }),
    {
      ...node('summary', 'template', 'Format the selected quote', {
        template: '{{supplier}} quotes {{price}} {{currency}}.'
      }),
      bindings: {
        value: {
          branches: [
            { nodeId: 'primary', field: 'body' },
            { nodeId: 'backup', field: 'body' }
          ]
        }
      }
    },
    {
      ...result('done', 'Quote received', 'The supplier returned a quote.', undefined, 'success'),
      bindings: { message: { nodeId: 'summary', field: 'text' } }
    },
    result('error', 'Quote unavailable', 'The supplier request failed.', undefined, 'error')
  ],
  [
    edge('pick', 'submitted', 'route'),
    edge('route', 'yes', 'primary'),
    edge('route', 'no', 'backup'),
    edge('primary', 'ok', 'summary'),
    edge('backup', 'ok', 'summary'),
    edge('primary', 'error', 'error'),
    edge('backup', 'error', 'error'),
    edge('summary', 'next', 'done')
  ]
)
supplierQuote.layout.backup = { x: 470, y: 190 }
supplierQuote.layout.summary = { x: 705, y: 42 }
supplierQuote.layout.error = { x: 705, y: 190 }
supplierQuote.layout.done = { x: 940, y: 42 }

export const examples: Record<string, WorkflowDefinition> = {
  ...gameBodies,
  ...games,
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
  [guessExample.id]: guessANumber,
  'guess-turn': guessTurn,
  'check-inventory-stock': checkInventoryStock,
  'format-inventory': formatInventory,
  'find-inventory-item': findInventoryItem,
  'supplier-quote': supplierQuote,
  'inventory-item-body': bodyWorkflow('Inspect inventory item', 'item'),
  'loop-index-body': bodyWorkflow('Read pass index', 'index')
}
