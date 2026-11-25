import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  acceptsOutput,
  isRecord,
  matchesField,
  nodeKey,
  readOutputBinding,
  readValuePath,
  resolveInputBinding,
  workflowBranchSourceLimit,
  type JsonObject,
  type JsonValue,
  type NodeDescriptor,
  type NodeInput,
  type OutputBinding,
  type WorkflowDefinition,
  type WorkflowInputBinding,
  type WorkflowNode,
  type WorkflowRun
} from '@ideawithai/workflow-express/schema'

interface OutputChoice {
  binding: OutputBinding
  label: string
  type: string
  sample: JsonValue | undefined
}

const typeLabels = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  json: 'JSON'
}

export function observedOutputs(
  definition: WorkflowDefinition,
  run?: WorkflowRun
): ReadonlyMap<string, JsonObject> {
  const outputs = new Map<string, JsonObject>()
  if (!run) return outputs
  const ran = new Map(run.definition.nodes.map((node) => [node.id, node]))
  const current = new Map(definition.nodes.map((node) => [node.id, node]))
  for (const step of run.steps) {
    const before = ran.get(step.nodeId)
    const after = current.get(step.nodeId)
    if (
      before &&
      after &&
      before.type === after.type &&
      before.version === after.version &&
      JSON.stringify(before.config) === JSON.stringify(after.config) &&
      JSON.stringify(before.bindings) === JSON.stringify(after.bindings)
    ) {
      outputs.set(step.nodeId, step.output)
    }
  }
  return outputs
}

export function boundSample(
  node: WorkflowNode,
  inputs: readonly NodeInput[],
  outputs: ReadonlyMap<string, JsonObject>,
  sources: ReadonlySet<string>,
  possibleSources: ReadonlySet<string>
): JsonObject {
  return Object.fromEntries(
    inputs.flatMap((field) => {
      const binding = Object.hasOwn(node.bindings ?? {}, field.key)
        ? node.bindings?.[field.key]
        : undefined
      if (!binding) return []
      const { source, value } = resolveInputBinding(outputs, binding)
      const allowed = 'branches' in binding ? possibleSources : sources
      return source &&
        allowed.has(source.nodeId) &&
        value !== undefined &&
        matchesField(value, field)
        ? [[field.key, value]]
        : []
    })
  )
}

function formatPath(path: readonly string[]): string {
  return path
    .map((part) => {
      if (/^(0|[1-9]\d*)$/.test(part)) return `[${part}]`
      if (/^[a-zA-Z_$][\w$]*$/.test(part)) return `.${part}`
      return `[${JSON.stringify(part)}]`
    })
    .join('')
}

function parsePointer(value: string): string[] | undefined {
  if (!value.startsWith('/')) return undefined
  const parts = value.slice(1).split('/')
  if (parts.length > 32 || parts.some((part) => /~(?:[^01]|$)/.test(part))) return undefined
  const path = parts.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  return path.every((part) => part.length <= 160) ? path : undefined
}

function bindingKey(binding: OutputBinding): string {
  return JSON.stringify([binding.nodeId, binding.field, binding.path ?? []])
}

function observedType(value: JsonValue): string {
  if (Array.isArray(value)) return 'Array'
  if (value === null) return 'Null'
  if (typeof value === 'object') return 'Object'
  return typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'Text'
}

function sampleLabel(value: JsonValue): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).length
    return `${keys} ${keys === 1 ? 'field' : 'fields'}`
  }
  const text = JSON.stringify(value)
  return text.length > 96 ? `${text.slice(0, 95)}…` : text
}

function nestedValues(value: JsonValue | undefined): { path: string[]; sample: JsonValue }[] {
  const values: { path: string[]; sample: JsonValue }[] = []
  function visit(current: JsonValue | undefined, parent: string[]): void {
    if (parent.length >= 8 || !(Array.isArray(current) || isRecord(current))) return
    for (const key in current) {
      if (values.length >= 160) break
      if (key.length > 160 || !Object.hasOwn(current, key)) continue
      const sample = readValuePath(current, [key])
      if (sample === undefined) continue
      const path = [...parent, key]
      values.push({ path, sample })
      visit(sample, path)
    }
  }
  visit(value, [])
  return values
}

function outputChoices(
  definition: WorkflowDefinition,
  descriptors: ReadonlyMap<string, NodeDescriptor>,
  outputs: ReadonlyMap<string, JsonObject>,
  sources: ReadonlySet<string>,
  field: NodeInput,
  requiredOutputsOnly: boolean
): { choices: OutputChoice[]; jsonSources: OutputChoice[] } {
  const choices: OutputChoice[] = []
  const jsonSources: OutputChoice[] = []
  for (const node of definition.nodes) {
    if (!sources.has(node.id)) continue
    const descriptor = descriptors.get(nodeKey(node.type, node.version))
    for (const output of descriptor?.outputs ?? []) {
      if (requiredOutputsOnly && !output.required) continue
      const binding = { nodeId: node.id, field: output.key }
      const label = `${node.label || descriptor?.label || node.type} · ${output.label}`
      const sample = readOutputBinding(outputs.get(node.id), binding)
      const choice = { binding, label, type: typeLabels[output.type], sample }
      if (acceptsOutput(field, output)) choices.push(choice)
      if (!acceptsOutput(field, output, ['field'])) continue
      jsonSources.push(choice)
      for (const item of nestedValues(sample)) {
        if (!acceptsOutput(field, output, item.path) || !matchesField(item.sample, field)) continue
        choices.push({
          binding: { ...binding, path: item.path },
          label: label + formatPath(item.path),
          type: observedType(item.sample),
          sample: item.sample
        })
      }
    }
  }
  return { choices, jsonSources }
}

interface BindingSources {
  field: NodeInput
  definition: WorkflowDefinition
  descriptors: ReadonlyMap<string, NodeDescriptor>
  outputs: ReadonlyMap<string, JsonObject>
  sources: ReadonlySet<string>
}

export const branchBindingIssueText =
  'Choose required, compatible outputs from at least two nodes. Each path to this node must reach exactly one selected source.'

export function InputBindingPicker({
  field,
  binding,
  definition,
  descriptors,
  outputs,
  sources,
  possibleSources,
  invalidBranchBinding,
  onChange
}: BindingSources & {
  binding?: WorkflowInputBinding
  possibleSources: ReadonlySet<string>
  invalidBranchBinding: boolean
  onChange: (value?: WorkflowInputBinding) => void
}): ReactNode {
  const name = useId()
  const branches = binding && 'branches' in binding ? binding.branches : undefined
  const branchSources = useMemo(() => {
    const compatible = new Set<string>()
    for (const node of definition.nodes) {
      if (!possibleSources.has(node.id) || sources.has(node.id)) continue
      const descriptor = descriptors.get(nodeKey(node.type, node.version))
      if (
        descriptor?.outputs?.some(
          (output) =>
            output.required &&
            (acceptsOutput(field, output) || acceptsOutput(field, output, ['field']))
        )
      ) {
        compatible.add(node.id)
      }
    }
    return compatible
  }, [field, definition, descriptors, possibleSources, sources])
  const canAdd =
    branches &&
    branches.length < workflowBranchSourceLimit &&
    [...branchSources].some((id) => !branches.some(({ nodeId }) => nodeId === id))

  return (
    <fieldset className="wf-binding" aria-labelledby={name}>
      <legend id={name}>
        {field.label}{' '}
        <span>
          {typeLabels[field.type]}
          {field.required && ' · Required'}
        </span>
      </legend>
      {branches ? (
        <div className="wf-branch-binding">
          {(canAdd ? [...branches, undefined] : branches).map((candidate, index) => {
            const selected = new Set(
              branches.flatMap((choice, other) => (index !== other ? [choice.nodeId] : []))
            )
            const first = branches.findIndex(({ nodeId }) => nodeId === candidate?.nodeId)
            const key = candidate
              ? JSON.stringify(first === index ? [candidate.nodeId] : [candidate.nodeId, index])
              : 'add'
            return (
              <BindingPicker
                key={key}
                field={field}
                binding={candidate}
                definition={definition}
                descriptors={descriptors}
                outputs={outputs}
                sources={new Set([...branchSources].filter((id) => !selected.has(id)))}
                requiredOutputsOnly
                searchLabel={`Search outputs for ${field.label}, branch ${index + 1}`}
                placeholder="Add branch output…"
                clearLabel="Remove branch output"
                onChange={(choice) => {
                  const next = [...branches]
                  if (choice) next[index] = choice
                  else next.splice(index, 1)
                  onChange({ branches: next })
                }}
              />
            )
          })}
          {invalidBranchBinding && (
            <p className="wf-binding-issue" role="status">
              {branchBindingIssueText}
            </p>
          )}
        </div>
      ) : (
        <BindingPicker
          field={field}
          binding={binding && !('branches' in binding) ? binding : undefined}
          definition={definition}
          descriptors={descriptors}
          outputs={outputs}
          sources={sources}
          onChange={onChange}
        />
      )}
      {(branches || branchSources.size >= 2) && (
        <button
          className="wf-binding-mode"
          type="button"
          onClick={() => onChange(branches ? undefined : { branches: [] })}
        >
          {branches ? 'Use a single output' : 'Use branch outputs'}
        </button>
      )}
    </fieldset>
  )
}

function BindingPicker({
  field,
  binding,
  definition,
  descriptors,
  outputs,
  sources,
  requiredOutputsOnly = false,
  searchLabel = `Search outputs for ${field.label}`,
  placeholder = 'Choose an output…',
  clearLabel = 'Clear binding',
  onChange
}: BindingSources & {
  binding?: OutputBinding
  requiredOutputsOnly?: boolean
  searchLabel?: string
  placeholder?: string
  clearLabel?: string
  onChange: (value?: OutputBinding) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [sourceKey, setSourceKey] = useState('')
  const [pointer, setPointer] = useState('')
  const details = useRef<HTMLDetailsElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const summary = useRef<HTMLElement>(null)
  const { choices, jsonSources } = useMemo(
    () => outputChoices(definition, descriptors, outputs, sources, field, requiredOutputsOnly),
    [definition, descriptors, outputs, sources, field, requiredOutputsOnly]
  )
  const current = binding && bindingKey(binding)
  const selected = current && choices.find((choice) => bindingKey(choice.binding) === current)
  const selectedSource = binding && definition.nodes.find(({ id }) => id === binding.nodeId)
  const sourceDescriptor =
    selectedSource && descriptors.get(nodeKey(selectedSource.type, selectedSource.version))
  const selectedOutput = sourceDescriptor?.outputs?.find(({ key }) => key === binding?.field)
  const selectedLabel = binding
    ? selected
      ? selected.label
      : `${selectedSource?.label || sourceDescriptor?.label || binding.nodeId} · ${selectedOutput?.label ?? binding.field}${formatPath(binding.path ?? [])}`
    : placeholder
  const limit = 36
  const filtered = choices.filter(({ binding: choice, label, type }) =>
    `${label} ${type} ${choice.field}`.toLowerCase().includes(query.trim().toLowerCase())
  )

  const pathSource =
    jsonSources.find((choice) => bindingKey(choice.binding) === sourceKey) ?? jsonSources[0]
  const path = parsePointer(pointer)
  const pathSample = pathSource && path ? readValuePath(pathSource.sample, path) : undefined
  const pathCompatible = pathSample === undefined || matchesField(pathSample, field)

  function select(value?: OutputBinding): void {
    onChange(value)
    setQuery('')
    setPointer('')
    if (details.current) details.current.open = false
    summary.current?.focus()
  }

  return (
    <details
      ref={details}
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open)
          search.current?.focus()
      }}
    >
      <summary ref={summary} title={selectedLabel}>
        {selectedLabel}
      </summary>
      <div className="wf-binding-picker">
        <input
          ref={search}
          type="search"
          aria-label={searchLabel}
          placeholder="Search outputs"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {binding && (
          <button type="button" onClick={() => select()}>
            {clearLabel}
          </button>
        )}
        <ul aria-label="Compatible outputs">
          {filtered.slice(0, limit).map((choice) => {
            const key = bindingKey(choice.binding)
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-pressed={key === current}
                  onClick={() => select(choice.binding)}
                >
                  <strong>{choice.label}</strong>
                  <small>
                    {choice.type}
                    {choice.sample !== undefined && ` · ${sampleLabel(choice.sample)}`}
                  </small>
                </button>
              </li>
            )
          })}
        </ul>
        {!filtered.length && (
          <p>
            {query.trim()
              ? 'No matching outputs.'
              : pathSource
                ? 'Enter a field path to bind a JSON value.'
                : 'No compatible upstream outputs.'}
          </p>
        )}
        {filtered.length > limit && <p>Search to narrow the results.</p>}
        {pathSource && (
          <details className="wf-binding-manual">
            <summary>Enter a field path</summary>
            <label className="wf-field">
              JSON output
              <select
                value={bindingKey(pathSource.binding)}
                onChange={(event) => setSourceKey(event.currentTarget.value)}
              >
                {jsonSources.map((source) => (
                  <option key={bindingKey(source.binding)} value={bindingKey(source.binding)}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wf-field">
              JSON path
              <input
                value={pointer}
                placeholder="/items/0/quantity"
                onChange={(event) => setPointer(event.currentTarget.value)}
              />
            </label>
            {!pathCompatible && (
              <p role="status">The last observed value has an incompatible type.</p>
            )}
            <button
              type="button"
              disabled={!path || !pathCompatible}
              onClick={() => {
                if (path && pathCompatible) select({ ...pathSource.binding, path })
              }}
            >
              Bind path
            </button>
          </details>
        )}
      </div>
    </details>
  )
}
