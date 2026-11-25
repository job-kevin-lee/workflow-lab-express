import type { WorkflowNodeRegistration } from './index.js'
import { WorkflowNodeError } from './node-error.js'
import { isJsonObject, readValuePath, type JsonValue } from './schema.js'

function select(value: JsonValue | undefined, path: string): JsonValue {
  const parts =
    path === '.'
      ? []
      : path
          .replace(/\[(\d+)\]/g, '.$1')
          .split('.')
          .filter(Boolean)
  const selected = readValuePath(value, parts)
  if (selected === undefined)
    throw new WorkflowNodeError('transform_path_missing', `Input path is missing: ${path}`)
  return selected
}

export const templateNode: WorkflowNodeRegistration = {
  testSafe: true,
  descriptor: {
    type: 'workflow:template',
    version: 1,
    label: 'Template',
    category: 'Transform',
    description: 'Compose text from fields in an upstream value.',
    fields: [
      { key: 'template', label: 'Template', type: 'string', multiline: true, required: true }
    ],
    inputs: [
      {
        key: 'value',
        label: 'Template data',
        type: 'json',
        description:
          'Use {{name}} or {{items[0].sku}} for a field. Use {{.}} for the entire value.',
        example: { name: 'Inventory', items: [{ sku: 'A-01' }] }
      }
    ],
    outputs: [{ key: 'text', label: 'Rendered text', type: 'string', required: true }],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  execute({ config, inputs }) {
    if (typeof config.template !== 'string')
      throw new WorkflowNodeError('invalid_template', 'A text template is required.')
    let length = config.template.length
    const text = config.template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, path: string) => {
      const value = select(inputs.value, path)
      const replacement = typeof value === 'string' ? value : JSON.stringify(value)
      length += replacement.length - match.length
      if (length > 262_144)
        throw new WorkflowNodeError('transform_limit', 'The rendered template is too large.')
      return replacement
    })
    return { port: 'next', output: { text } }
  }
}

export const mapJsonNode: WorkflowNodeRegistration = {
  testSafe: true,
  descriptor: {
    type: 'workflow:map-json',
    version: 1,
    label: 'Map JSON',
    category: 'Transform',
    description: 'Select and rename fields to create a JSON object.',
    fields: [
      {
        key: 'mapping',
        label: 'Output key → input path (JSON)',
        type: 'string',
        multiline: true,
        required: true
      }
    ],
    inputs: [
      {
        key: 'value',
        label: 'Source data',
        type: 'json',
        required: true,
        description: 'Use a JSON object such as {"sku":"items[0].sku"} in the mapping field.',
        example: { items: [{ sku: 'A-01', quantity: 4 }] }
      }
    ],
    outputs: [{ key: 'value', label: 'Mapped object', type: 'json', required: true }],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  execute({ config, inputs }) {
    if (typeof config.mapping !== 'string')
      throw new WorkflowNodeError('invalid_mapping', 'A JSON mapping is required.')
    let mapping: unknown
    try {
      mapping = JSON.parse(config.mapping)
    } catch {
      throw new WorkflowNodeError('invalid_mapping', 'Use a valid JSON object for the mapping.')
    }
    if (!isJsonObject(mapping))
      throw new WorkflowNodeError('invalid_mapping', 'Use a valid JSON object for the mapping.')
    const value = Object.fromEntries(
      Object.entries(mapping).map(([key, path]) => {
        if (!key || typeof path !== 'string' || !path.trim())
          throw new WorkflowNodeError('invalid_mapping', 'Use a field name and a source path.')
        return [key, select(inputs.value, path.trim())]
      })
    )
    return { port: 'next', output: { value } }
  }
}
