import { expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@ideawithai/workflow-express/schema'
import { insertionPoint, nodePosition } from '../src/graph-layout.js'

test('edge insertion uses the displayed positions when imported node IDs have no layout entries', () => {
  const definition: WorkflowDefinition = {
    schemaVersion: 1,
    name: 'Imported positions',
    entry: 'constructor',
    layout: {},
    nodes: [
      { id: 'constructor', type: 'workflow:input', version: 1, config: {} },
      { id: 'toString', type: 'workflow:result', version: 1, config: {} }
    ],
    edges: [{ id: 'next', from: 'constructor', port: 'next', to: 'toString' }]
  }

  expect(nodePosition(definition.layout, 'constructor', 0)).toEqual({ x: 0, y: 0 })
  expect(nodePosition(definition.layout, 'toString', 1)).toEqual({ x: 200, y: 0 })
  expect(insertionPoint(definition, definition.edges[0], new Map())).toEqual({ x: 100, y: 124 })

  const positioned = { ...definition, layout: { constructor: { x: 40, y: 10 } } }
  expect(nodePosition(positioned.layout, 'constructor', 0)).toEqual({ x: 40, y: 10 })
  expect(insertionPoint(positioned, positioned.edges[0], new Map())).toEqual({ x: 120, y: 129 })
})
