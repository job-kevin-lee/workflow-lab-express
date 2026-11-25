import { isRecord, type WorkflowNodeRegistration } from '@ideawithai/workflow-express'

export const stockCheckNode: WorkflowNodeRegistration = {
  descriptor: {
    type: 'lab:stock-check',
    version: 1,
    label: 'Stock Check',
    description: 'List items with a quantity below the minimum stock level.',
    category: 'Custom Nodes',
    fields: [{ key: 'minimum', label: 'Minimum quantity', type: 'number', required: true }],
    inputs: [
      {
        key: 'items',
        label: 'Inventory items',
        type: 'json',
        required: true,
        description: 'An array of items with a text sku and a non-negative whole number quantity.',
        example: [{ sku: 'B-07', quantity: 2 }]
      }
    ],
    outputs: [{ key: 'summary', label: 'Stock summary', type: 'json', required: true }],
    ports: [
      { id: 'low', label: 'Low stock' },
      { id: 'stocked', label: 'In stock' }
    ]
  },
  execute: ({ config, inputs }) => {
    const { minimum } = config
    if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0) {
      throw new Error('Minimum quantity must be a non-negative whole number.')
    }

    const { items } = inputs
    if (!Array.isArray(items)) throw new Error('Inventory items must be an array.')

    const lowStock: { sku: string; quantity: number }[] = []
    for (const item of items) {
      if (
        !isRecord(item) ||
        typeof item.sku !== 'string' ||
        !item.sku.trim() ||
        typeof item.quantity !== 'number' ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 0
      ) {
        throw new Error('Each inventory item requires a SKU and a non-negative whole quantity.')
      }
      if (item.quantity < minimum) lowStock.push({ sku: item.sku, quantity: item.quantity })
    }

    return {
      port: lowStock.length > 0 ? 'low' : 'stocked',
      output: { summary: { minimum, checked: items.length, lowStock } }
    }
  }
}
