import type { JsonObject, WorkflowDefinition } from '@ideawithai/workflow-express/schema'
import { edge, graph, node, result } from './example-graph.js'

const crossing = graph(
  'Lantern Crossing',
  [
    node('route', 'human-input', 'Choose a route', {
      message: 'Two marked routes lead across the ravine. Enter bridge or tunnel.',
      label: 'Route',
      type: 'text'
    }),
    {
      ...node('marked', 'logic', 'Is the route marked?', {
        mode: 'any',
        conditions: [
          { path: 'value', operator: 'eq', expected: '"bridge"' },
          { path: 'value', operator: 'eq', expected: '"tunnel"' }
        ]
      }),
      bindings: { value: { nodeId: 'route', field: 'payload' } }
    },
    node('lantern', 'human-input', 'Relight the lantern?', {
      message: 'A gust blows out your lantern. Relight it before you cross?',
      label: 'Relight the lantern',
      type: 'boolean'
    }),
    {
      ...node('lit', 'logic', 'Is the lantern lit?', {
        mode: 'all',
        conditions: [{ path: '', operator: 'eq', expected: 'true' }]
      }),
      bindings: { value: { nodeId: 'lantern', field: 'payload', path: ['value'] } }
    },
    node('cross', 'wait', 'Cross the ravine', { seconds: 1 }),
    result(
      'arrived',
      'Reached the other side',
      'Your lantern lit the way across.',
      { nodeId: 'route', field: 'payload', path: ['value'] },
      'success'
    ),
    result('lost', 'Off the trail', 'The unmarked route led back to camp.', undefined, 'warning'),
    result('dark', 'Too dark to cross', 'You returned to camp in the dark.', undefined, 'warning')
  ],
  [
    edge('route', 'submitted', 'marked'),
    edge('marked', 'yes', 'lantern'),
    edge('marked', 'no', 'lost'),
    edge('lantern', 'submitted', 'lit'),
    edge('lit', 'yes', 'cross'),
    edge('lit', 'no', 'dark'),
    edge('cross', 'next', 'arrived')
  ]
)
crossing.layout.lost = { x: 470, y: 185 }
crossing.layout.dark = { x: 940, y: 185 }

const relayTurnId = 'beacon-relay-turn'
const relayTurn = graph(
  'Beacon Relay · One signal',
  [
    node('signal', 'wait-for-call', 'Receive a beacon signal', {
      message: 'Beacon offline. Send a JSON signal with frequency 42 and locked set to true.'
    }),
    {
      ...node('match', 'logic', 'Does the signal match?', {
        mode: 'all',
        conditions: [
          { path: 'frequency', operator: 'exists' },
          { path: 'frequency', operator: 'eq', expected: '42' },
          { path: 'locked', operator: 'exists' },
          { path: 'locked', operator: 'eq', expected: 'true' }
        ]
      }),
      bindings: { value: { nodeId: 'signal', field: 'payload' } }
    },
    result(
      'locked',
      'Beacon locked',
      'The beacon accepted the signal.',
      { nodeId: 'signal', field: 'payload' },
      'success'
    ),
    result(
      'retry',
      'Signal rejected',
      'The frequency or lock flag did not match.',
      { nodeId: 'signal', field: 'payload' },
      'warning'
    )
  ],
  [
    edge('signal', 'received', 'match'),
    edge('match', 'yes', 'locked'),
    edge('match', 'no', 'retry')
  ]
)
relayTurn.layout.retry = { x: 470, y: 185 }

const relay = graph(
  'Beacon Relay',
  [
    node('relay', 'loop', 'Listen up to three times', {
      workflowId: relayTurnId,
      maxCount: 3,
      conditions: [{ path: 'tone', operator: 'eq', expected: '"success"' }]
    }),
    result(
      'online',
      'Beacon online',
      'The relay is ready to transmit.',
      { nodeId: 'relay', field: 'last', path: ['value'] },
      'success'
    ),
    result(
      'offline',
      'Signal window closed',
      'Three signals arrived without a match.',
      { nodeId: 'relay', field: 'last', path: ['value'] },
      'warning'
    )
  ],
  [edge('relay', 'done', 'online'), edge('relay', 'limit', 'offline')]
)
relay.layout.offline = { x: 235, y: 185 }

export const cargoPods = [
  { id: 'Lumen', load: { kg: 9 }, sealed: true },
  { id: 'Orbit', load: { kg: 17 }, sealed: true },
  { id: 'Nova', load: { kg: 7 }, sealed: false },
  { id: 'Halley', load: { kg: 12 }, sealed: true }
]

const cargoPodId = 'comet-cargo-pod'
const cargoPod = graph(
  'Comet Cargo · Inspect one pod',
  [
    node('pod', 'input', 'Read the cargo pod', { path: 'item' }),
    {
      ...node('manifest', 'map-json', 'Map manifest fields', {
        mapping: JSON.stringify({ pod: 'id', mass: 'load.kg', sealed: 'sealed' }, null, 2)
      }),
      bindings: { value: { nodeId: 'pod', field: 'value' } }
    },
    {
      ...node('eligible', 'logic', 'Safe to launch?', {
        mode: 'all',
        conditions: [
          { path: 'mass', operator: 'lte', expected: '12' },
          { path: 'sealed', operator: 'eq', expected: 'true' }
        ]
      }),
      bindings: { value: { nodeId: 'manifest', field: 'value' } }
    },
    result(
      'cleared',
      'Cleared for launch',
      'The pod is sealed and weighs 12 kg or less.',
      { nodeId: 'manifest', field: 'value' },
      'success'
    ),
    result(
      'held',
      'Held for inspection',
      'The pod is too heavy or its seal is open.',
      { nodeId: 'manifest', field: 'value' },
      'warning'
    )
  ],
  [
    edge('pod', 'next', 'manifest'),
    edge('manifest', 'next', 'eligible'),
    edge('eligible', 'yes', 'cleared'),
    edge('eligible', 'no', 'held')
  ]
)
cargoPod.layout.held = { x: 705, y: 185 }

const cargo = graph(
  'Comet Cargo',
  [
    node('fetch', 'http', 'Fetch launch manifest', {
      method: 'GET',
      url: '/api/demo/resources/comet-cargo'
    }),
    {
      ...node('inspect', 'iteration', 'Inspect each cargo pod', {
        workflowId: cargoPodId,
        path: 'pods'
      }),
      bindings: { items: { nodeId: 'fetch', field: 'body' } }
    },
    {
      ...node('summary', 'template', 'Summarize the inspection', {
        template: 'Inspected {{.}} cargo pods. Open Trace Log to see which pods can launch.'
      }),
      bindings: { value: { nodeId: 'inspect', field: 'count' } }
    },
    {
      ...result('done', 'Launch manifest reviewed', 'Inspection complete.'),
      bindings: {
        message: { nodeId: 'summary', field: 'text' },
        value: { nodeId: 'inspect', field: 'results' }
      }
    },
    result(
      'unavailable',
      'Manifest unavailable',
      'The launch manifest could not be loaded.',
      undefined,
      'error'
    )
  ],
  [
    edge('fetch', 'ok', 'inspect'),
    edge('fetch', 'error', 'unavailable'),
    edge('inspect', 'next', 'summary'),
    edge('summary', 'next', 'done')
  ]
)
cargo.layout.unavailable = { x: 235, y: 185 }

export const games = {
  'lantern-crossing': crossing,
  'beacon-relay': relay,
  'comet-cargo': cargo
} satisfies Record<string, WorkflowDefinition>

export const gameBodies = { [relayTurnId]: relayTurn, [cargoPodId]: cargoPod }

export const gameBodyExamples: { id: string; label: string; input: JsonObject }[] = [
  { id: relayTurnId, label: relayTurn.name, input: { index: 0, previous: null } },
  { id: cargoPodId, label: cargoPod.name, input: { item: cargoPods[0], index: 0 } }
]
