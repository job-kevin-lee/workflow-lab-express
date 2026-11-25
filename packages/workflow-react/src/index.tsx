import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from '@xyflow/react'
import {
  availableSources,
  canConnect,
  canUseAsBody,
  createEmptyWorkflow,
  httpRequestHeadersForLog,
  isJsonObject,
  isLogicConditions,
  logicOperators,
  nodeKey,
  possibleUpstreamSources,
  validateWorkflow,
  workflowRunStatuses,
  type JsonObject,
  type JsonValue,
  type LogicCondition,
  type NodeConfigField,
  type NodeDescriptor,
  type WorkflowBodyRun,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowHttpRequest,
  type WorkflowHumanInput,
  type WorkflowIssue,
  type WorkflowNodeTestResult,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowStepResult,
  type WorkflowTestFixture
} from '@ideawithai/workflow-express/schema'
import {
  InputBindingPicker,
  boundSample,
  branchBindingIssueText,
  observedOutputs
} from './binding-picker.js'
import { arrangeLayout, insertionPoint, nodePosition } from './graph-layout.js'
import { WorkflowTestDialog } from './workflow-test-dialog.js'

export type {
  JsonObject,
  NodeDescriptor,
  WorkflowDefinition,
  WorkflowDocument
} from '@ideawithai/workflow-express/schema'

export interface WorkflowEditorProps {
  apiBase: string
  workflowId: string
  request?: typeof fetch
  runInput?: JsonObject
  runDisabled?: boolean
  enableWorkflowTests?: boolean
  documentTarget?: HTMLElement | null
  paletteTypes?: readonly string[]
  onLoaded?: (document: WorkflowDocument) => void
  onSaved?: (document: WorkflowDocument) => void
  onDirtyChange?: (dirty: boolean) => void
  renderConfig?: (props: {
    node: WorkflowNode
    descriptor: NodeDescriptor
    setConfig: (config: JsonObject) => void
  }) => ReactNode
  formatIssue?: (issue: WorkflowIssue) => string
}

type Card = Node<
  {
    node: WorkflowNode
    descriptor: NodeDescriptor | undefined
    entry: boolean
    invalid: boolean
    visited: boolean
    waiting: boolean
  },
  'workflow'
>

const nodeSymbols = new Map([
  ['workflow:wait', '◷'],
  ['workflow:http', '↗'],
  ['workflow:logic', '⑂'],
  ['workflow:condition', '⑂'],
  ['workflow:human-input', '✎'],
  ['workflow:iteration', '⟳'],
  ['workflow:loop', '↻'],
  ['workflow:input', '↦'],
  ['workflow:wait-for-call', '↧'],
  ['workflow:result', '•']
])

function NodeSymbol({ type, tone }: { type: string; tone?: string }): ReactNode {
  const symbol = tone === 'error' ? '!' : tone === 'success' ? '✓' : (nodeSymbols.get(type) ?? '◇')
  return (
    <span className="wf-symbol" data-type={type} data-tone={tone} aria-hidden="true">
      {symbol}
    </span>
  )
}

function WorkflowCard({ data, selected }: NodeProps<Card>): ReactNode {
  const { node, descriptor, entry, invalid, visited, waiting } = data
  const tone =
    node.type === 'workflow:result' && typeof node.config.tone === 'string'
      ? node.config.tone
      : undefined
  return (
    <div
      className="wf-node"
      data-selected={selected}
      data-invalid={invalid}
      data-visited={visited}
      data-waiting={waiting}
    >
      {!entry && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-heading">
        <NodeSymbol type={node.type} tone={tone} />
        <div>
          {entry && <span className="wf-start">Start</span>}
          <strong>{node.label || descriptor?.label || node.type}</strong>
        </div>
      </div>
      {descriptor?.ports.map((port) => (
        <div className="wf-output" key={port.id}>
          {port.label}
          <Handle type="source" id={port.id} position={Position.Right} />
        </div>
      ))}
    </div>
  )
}

function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const nodeTypes = { workflow: WorkflowCard }
const newDefinition = createEmptyWorkflow()

class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fields?: { kind: 'input' | 'config'; field: string; label: string }[],
    public body?: {
      detail?: string
      nodeId?: string
      workflowId?: string
      issues?: WorkflowIssue[]
    }
  ) {
    super(code)
  }
}

async function requestJson<T>(request: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init)
  const data = await response.json()
  if (!response.ok)
    throw new RequestError(response.status, data.error ?? 'request_failed', data.fields, data)
  return data
}

function message(error: unknown): string {
  if (error instanceof RequestError && error.code === 'revision_conflict') {
    return 'Another session saved this workflow. Your changes are still here. Reload only after reviewing them.'
  }
  if (error instanceof RequestError) return error.code.replaceAll('_', ' ')
  return 'Could not reach the workflow service.'
}

function send(method: string, body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function WorkflowEditor(props: WorkflowEditorProps): ReactNode {
  return <WorkflowLoader key={JSON.stringify([props.apiBase, props.workflowId])} {...props} />
}

function WorkflowLoader(props: WorkflowEditorProps): ReactNode {
  const { apiBase, workflowId, request = fetch, onLoaded } = props
  const base = apiBase.replace(/\/$/, '')
  const url = `${base}/workflows/${encodeURIComponent(workflowId)}`
  const [loaded, setLoaded] = useState<{ document: WorkflowDocument; catalog: NodeDescriptor[] }>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const init = { signal: controller.signal }
    const getDocument = async (): Promise<WorkflowDocument> => {
      try {
        return await requestJson<WorkflowDocument>(request, url, init)
      } catch (error) {
        if (
          error instanceof RequestError &&
          error.status === 404 &&
          error.code === 'workflow_not_found'
        ) {
          return { id: workflowId, revision: 0, definition: newDefinition }
        }
        throw error
      }
    }
    Promise.all([getDocument(), requestJson<NodeDescriptor[]>(request, `${base}/node-types`, init)])
      .then(([document, catalog]) => {
        if (!controller.signal.aborted) setLoaded({ document, catalog })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(message(error))
      })
    return () => controller.abort()
  }, [request, url, base, workflowId, attempt])

  useEffect(() => {
    if (loaded) onLoaded?.(loaded.document)
  }, [loaded, onLoaded])

  if (loaded) return <Editor {...props} {...loaded} url={url} base={base} />
  return (
    <div className="wf-editor wf-loading">
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError('')
              setAttempt(attempt + 1)
            }}
          >
            Retry
          </button>
        </>
      ) : (
        <p role="status">Loading workflow…</p>
      )}
    </div>
  )
}

function LogicConditionsEditor({
  label,
  value,
  change
}: {
  label: string
  value: JsonValue | undefined
  change: (conditions: JsonValue) => void
}): ReactNode {
  const rows = isLogicConditions(value) ? value : []
  function changeRow(index: number, update: Partial<LogicCondition>): void {
    change(rows.map((row, at) => (at === index ? { ...row, ...update } : { ...row })))
  }
  return (
    <fieldset className="wf-rules">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="wf-rule" key={index}>
          <label className="wf-field">
            Field path
            <input
              aria-label={`Field path ${index + 1}`}
              value={row.path}
              placeholder="e.g. status"
              maxLength={160}
              onChange={(event) => changeRow(index, { path: event.target.value })}
            />
          </label>
          <label className="wf-field">
            Operator
            <select
              aria-label={`Operator ${index + 1}`}
              value={row.operator}
              onChange={(event) => {
                const operator = logicOperators.find(({ id }) => id === event.target.value)
                if (operator) changeRow(index, { operator: operator.id })
              }}
            >
              {logicOperators.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {row.operator !== 'exists' && (
            <label className="wf-field">
              Expected JSON
              <input
                aria-label={`Expected JSON ${index + 1}`}
                value={row.expected ?? ''}
                placeholder={'e.g. "ready"'}
                maxLength={1000}
                onChange={(event) => changeRow(index, { expected: event.target.value })}
              />
            </label>
          )}
          <button
            type="button"
            aria-label={`Remove condition ${index + 1}`}
            onClick={() => change(rows.filter((_, at) => at !== index).map((row) => ({ ...row })))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={rows.length >= 32}
        onClick={() =>
          change([...rows.map((row) => ({ ...row })), { path: '', operator: 'eq', expected: '' }])
        }
      >
        Add condition
      </button>
    </fieldset>
  )
}

function WorkflowBodyField({
  label,
  value,
  change,
  base,
  workflowId,
  request,
  catalog,
  allowWaits
}: {
  label: string
  value: JsonValue | undefined
  change: (value: string | undefined) => void
  base: string
  workflowId: string
  request: typeof fetch
  catalog: readonly NodeDescriptor[]
  allowWaits: boolean
}): ReactNode {
  const [options, setOptions] = useState<WorkflowDocument[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    requestJson<WorkflowDocument[]>(request, `${base}/workflows`, { signal: controller.signal })
      .then((documents) => {
        if (!controller.signal.aborted) {
          setOptions(
            documents.filter(
              ({ id, definition }) =>
                id !== workflowId && canUseAsBody(definition, catalog, allowWaits)
            )
          )
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not load saved workflows.')
      })
    return () => controller.abort()
  }, [base, workflowId, request, catalog, allowWaits])

  const current = typeof value === 'string' ? value : ''
  return (
    <label className="wf-field">
      {label}
      <select
        value={current}
        disabled={!options}
        onChange={(event) => change(event.currentTarget.value || undefined)}
      >
        <option value="">
          {options
            ? options.length
              ? 'Choose a saved workflow…'
              : 'No eligible workflows'
            : error || 'Loading workflows…'}
        </option>
        {current && !options?.some(({ id }) => id === current) && (
          <option value={current}>{current}</option>
        )}
        {options?.map(({ id, definition }) => (
          <option key={id} value={id}>
            {definition.name}
          </option>
        ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </label>
  )
}

function NodeConfigurationField({
  node,
  field,
  setConfig,
  bodyPicker
}: {
  node: WorkflowNode
  field: NodeConfigField
  setConfig: (config: JsonObject) => void
  bodyPicker: Pick<
    Parameters<typeof WorkflowBodyField>[0],
    'base' | 'workflowId' | 'request' | 'catalog' | 'allowWaits'
  >
}): ReactNode {
  const value = Object.hasOwn(node.config, field.key) ? node.config[field.key] : undefined
  const change = (value: JsonValue | undefined): void => {
    const config = { ...node.config }
    if (value === undefined) delete config[field.key]
    else
      Object.defineProperty(config, field.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      })
    setConfig(config)
  }
  if (field.type === 'conditions') {
    return (
      <LogicConditionsEditor key={field.key} label={field.label} value={value} change={change} />
    )
  }
  if (field.type === 'workflow') {
    return <WorkflowBodyField {...bodyPicker} label={field.label} value={value} change={change} />
  }
  return (
    <label className="wf-field" key={field.key}>
      {node.type === 'workflow:http' && field.key === 'url' ? 'Request URL or path' : field.label}
      {field.options ? (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => change(event.target.value || undefined)}
        >
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
      ) : field.multiline ? (
        <textarea
          rows={3}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => change(event.target.value || undefined)}
        />
      ) : field.type === 'boolean' ? (
        <select
          value={typeof value === 'boolean' ? String(value) : ''}
          onChange={(event) =>
            change(event.target.value === '' ? undefined : event.target.value === 'true')
          }
        >
          <option value="">Choose…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          step="any"
          value={typeof value === field.type ? String(value) : ''}
          onChange={(event) =>
            change(
              field.type === 'string'
                ? event.target.value
                : event.target.value === ''
                  ? undefined
                  : event.target.valueAsNumber
            )
          }
        />
      )}
    </label>
  )
}

function NodeTest({
  node,
  descriptor,
  base,
  request,
  input,
  sample
}: {
  node: WorkflowNode
  descriptor: NodeDescriptor
  base: string
  request: typeof fetch
  input?: JsonObject
  sample: JsonObject
}): ReactNode {
  const inputFields = descriptor.inputs ?? []
  const [exampleText] = useState(() =>
    JSON.stringify(
      Object.fromEntries(
        inputFields.flatMap(({ key, example }) => (example === undefined ? [] : [[key, example]]))
      ),
      null,
      2
    )
  )
  const [inputsText, setInputsText] = useState(exampleText)
  const inputHintsId = useId()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [test, setTest] = useState<{
    result: WorkflowNodeTestResult
    config: JsonObject
    inputs: string
  }>()
  const sampleCount = Object.keys(sample).length
  const bindings = Object.keys(node.bindings ?? {}).length
  function useRunValues(): void {
    let existing: JsonObject = JSON.parse(exampleText)
    try {
      const value: unknown = JSON.parse(inputsText)
      if (isJsonObject(value)) existing = value
    } catch {
      existing = JSON.parse(exampleText)
    }
    setInputsText(JSON.stringify({ ...existing, ...sample }, null, 2))
    setError('')
  }
  async function runTest(): Promise<void> {
    setError('')
    setTest(undefined)
    let inputs: unknown = {}
    if (inputFields.length) {
      try {
        inputs = JSON.parse(inputsText)
        if (!isJsonObject(inputs)) throw new Error()
      } catch {
        setError('Enter a JSON object for the sample inputs.')
        return
      }
    }

    setRunning(true)
    try {
      const result = await requestJson<WorkflowNodeTestResult>(
        request,
        `${base}/node-types/test`,
        send('POST', {
          nodeId: node.id,
          type: node.type,
          version: node.version,
          config: node.config,
          inputs,
          input
        })
      )
      setTest({ result, config: node.config, inputs: inputsText })
    } catch (error) {
      setError(
        error instanceof RequestError && error.fields?.length
          ? `Check ${error.fields.map(({ kind, field, label }) => (kind === 'input' ? `sample input "${field}"` : label)).join(', ')}.`
          : message(error)
      )
    } finally {
      setRunning(false)
    }
  }

  const result = test?.result
  const port =
    result?.status === 'completed' && descriptor.ports.find(({ id }) => id === result.port)
  const httpStatus =
    node.type === 'workflow:http' && result?.status === 'completed' && result.output.status
  const failed =
    result?.status === 'failed' || (result?.status === 'completed' && result.port === 'error')
  return (
    <section className="wf-node-test" aria-label="Node test">
      {!!inputFields.length && (
        <div className="wf-node-test-inputs">
          <ul id={inputHintsId} role="list">
            {inputFields.map(({ key, label, type, required, description }) => (
              <li key={key}>
                <code>{key}</code> <span>{label}</span>
                <p>
                  {type === 'json' ? 'JSON value' : type} · {required ? 'Required' : 'Optional'}
                </p>
                {description && <p>{description}</p>}
              </li>
            ))}
          </ul>
          <label className="wf-field">
            Sample inputs (JSON)
            <textarea
              aria-describedby={inputHintsId}
              rows={Math.min(8, Math.max(3, exampleText.split('\n').length))}
              spellCheck={false}
              value={inputsText}
              onChange={(event) => setInputsText(event.target.value)}
            />
          </label>
        </div>
      )}
      <div className="wf-node-actions">
        <button type="button" disabled={running} onClick={runTest}>
          {running ? 'Testing…' : 'Test Node'}
        </button>
        {!!bindings && (
          <button
            type="button"
            disabled={running || !sampleCount}
            title={
              !sampleCount ? 'Run the workflow to capture values for these bindings.' : undefined
            }
            onClick={useRunValues}
          >
            Use last run values
          </button>
        )}
        {exampleText !== '{}' && (
          <button
            type="button"
            disabled={running || inputsText === exampleText}
            onClick={() => {
              setInputsText(exampleText)
              setError('')
            }}
          >
            Reset example
          </button>
        )}
      </div>
      {error && (
        <p className="wf-node-test-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div
          className="wf-node-test-result"
          data-failed={failed}
          aria-label="Node test result"
          role="status"
        >
          <strong>
            {typeof httpStatus === 'number' &&
              (httpStatus ? `HTTP ${httpStatus} · ` : 'No HTTP response · ')}
            {result.status === 'waiting'
              ? 'Wait reached'
              : failed
                ? 'Error'
                : port
                  ? port.label
                  : 'Completed'}
          </strong>
          <span> · {result.durationMs} ms</span>
          {node.type === 'workflow:http' && test && (
            <code className="wf-tested-request">
              {String(test.config.method)} {String(test.config.url)}
            </code>
          )}
          {test && (test.config !== node.config || test.inputs !== inputsText) && (
            <p>Settings changed since this test.</p>
          )}
          {result.status === 'failed' && (
            <p>{result.detail ?? result.error.replaceAll('_', ' ')}</p>
          )}
          {result.status === 'waiting' && (
            <p>{result.message} Callback URLs are created during full workflow runs.</p>
          )}
          {result.status === 'completed' && (
            <pre aria-label={node.type === 'workflow:http' ? 'Response body' : 'Node output'}>
              {JSON.stringify(
                node.type === 'workflow:http' ? result.output.body : result.output,
                null,
                2
              )}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}

interface History {
  past: WorkflowDefinition[]
  current: WorkflowDefinition
  future: WorkflowDefinition[]
}

const runStatusLabels = {
  running: 'Running',
  waiting: 'Waiting for call',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted'
} satisfies Record<WorkflowRun['status'], string>

function runHistoryPath(workflowUrl: string, limit: number, offset = 0, status = ''): string {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (status) params.set('status', status)
  return `${workflowUrl}/runs?${params}`
}

function runDetailsPath(base: string, runId: string): string {
  return `${base}/runs/${encodeURIComponent(runId)}`
}

async function requestRun(
  request: typeof fetch,
  url: string,
  id: string,
  init?: RequestInit
): Promise<WorkflowRun> {
  const run = await requestJson<WorkflowRun>(request, url, init)
  if (run?.id !== id || !workflowRunStatuses.includes(run.status)) {
    throw new Error('Invalid workflow run response.')
  }
  return run
}

async function lookupRun(
  request: typeof fetch,
  url: string,
  id: string,
  init?: RequestInit
): Promise<WorkflowRun | null> {
  try {
    return await requestRun(request, url, id, init)
  } catch (error) {
    if (error instanceof RequestError && error.status === 404 && error.code === 'run_not_found') {
      return null
    }
    throw error
  }
}

function rejectedRunStart(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    ((error.status === 400 && ['invalid_run', 'invalid_json'].includes(error.code)) ||
      (error.status === 404 && error.code === 'workflow_not_found') ||
      (error.status === 409 && error.code === 'revision_conflict') ||
      (error.status === 413 && error.code === 'body_too_large') ||
      (error.status === 422 && error.code === 'invalid_workflow') ||
      (error.status === 503 && error.code === 'workflow_unavailable'))
  )
}

function runSummaryLabel(summary: WorkflowRunSummary): string {
  const started = summary.startedAt && new Date(summary.startedAt)
  const date = started && Number.isFinite(started.getTime()) ? started.toLocaleString() : ''
  const status = summary.status === 'waiting' ? 'Waiting' : runStatusLabels[summary.status]
  return [status, date, `r${summary.revision} · ${summary.id.slice(0, 8)}`]
    .filter(Boolean)
    .join(' · ')
}

function RunHistoryControls({
  workflowUrl,
  request,
  currentId,
  currentStatus,
  selectedId,
  onSelect
}: {
  workflowUrl: string
  request: typeof fetch
  currentId?: string
  currentStatus?: WorkflowRun['status']
  selectedId: string
  onSelect: (id: string) => void
}): ReactNode {
  const [filter, setFilter] = useState('')
  const [offset, setOffset] = useState(0)
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [retained, setRetained] = useState<WorkflowRunSummary>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const pageSize = 20
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    requestJson<WorkflowRunSummary[]>(
      request,
      runHistoryPath(workflowUrl, pageSize + 1, offset, filter),
      { signal: controller.signal }
    )
      .then((summaries) => {
        if (!controller.signal.aborted) setRuns(summaries)
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setRuns([])
        setError(
          failure instanceof RequestError && (failure.status === 404 || failure.status === 501)
            ? 'Run history is unavailable.'
            : message(failure)
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workflowUrl, request, filter, offset, currentId, currentStatus])

  const page = runs.slice(0, pageSize).filter(({ id }) => id !== currentId)
  return (
    <section className="wf-run-history" aria-label="Run history">
      <label className="wf-field">
        Workflow run
        <select
          value={selectedId}
          onChange={(event) => {
            const id = event.currentTarget.value
            setRetained(page.find((summary) => summary.id === id))
            onSelect(id)
          }}
        >
          <option value="">{currentId ? 'Current run' : 'Choose a saved run…'}</option>
          {retained && retained.id === selectedId && !page.some(({ id }) => id === selectedId) && (
            <option value={retained.id}>{runSummaryLabel(retained)}</option>
          )}
          {page.map((summary) => (
            <option key={summary.id} value={summary.id}>
              {runSummaryLabel(summary)}
            </option>
          ))}
        </select>
      </label>
      <label className="wf-field">
        Status
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.currentTarget.value)
            setOffset(0)
          }}
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="waiting">Waiting</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="interrupted">Interrupted</option>
        </select>
      </label>
      {(offset > 0 || runs.length > pageSize) && (
        <div className="wf-node-actions" aria-label="Run history pages">
          <button
            type="button"
            disabled={loading || offset === 0}
            onClick={() => setOffset(offset - pageSize)}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={loading || runs.length <= pageSize}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </button>
        </div>
      )}
      {(error || loading || !page.length) && (
        <p role="status">
          {error ||
            (loading ? 'Loading history…' : currentId ? 'No other runs found.' : 'No runs found.')}
        </p>
      )}
    </section>
  )
}

function waitReleasePath(runUrl: string, nodeId: string): string {
  return `${runUrl}/waits/${encodeURIComponent(nodeId)}/release`
}

function CallbackUrl({ path }: { path: string }): ReactNode {
  return (
    <label className="wf-field wf-callback-url">
      Callback URL · POST
      <input
        readOnly
        value={new URL(path, window.location.href).href}
        onClick={(event) => event.currentTarget.select()}
      />
    </label>
  )
}

function HumanInputForm({
  form,
  busy,
  onSubmit
}: {
  form: WorkflowHumanInput
  busy: boolean
  onSubmit: (value: JsonObject) => void
}): ReactNode {
  return (
    <form
      className="wf-human-input"
      onSubmit={(event) => {
        event.preventDefault()
        const raw = String(new FormData(event.currentTarget).get('value') ?? '')
        const value =
          form.type === 'number'
            ? Number(raw)
            : form.type === 'boolean'
              ? raw === 'true'
              : raw.trim()
        onSubmit({ value })
      }}
    >
      <label className="wf-field">
        {form.label}
        {form.type === 'boolean' ? (
          <select name="value" required defaultValue="">
            <option value="">Choose…</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : (
          <input name="value" type={form.type} step="any" required />
        )}
      </label>
      <button className="wf-primary" type="submit" disabled={busy}>
        Submit input
      </button>
    </form>
  )
}

function configuredHttpRequest(node: WorkflowNode | undefined): WorkflowHttpRequest | undefined {
  if (node?.type !== 'workflow:http') return
  const { method, url, headers } = node.config
  if (typeof method !== 'string' || typeof url !== 'string') return
  let parsed: unknown
  if (typeof headers === 'string' && headers) {
    try {
      parsed = JSON.parse(headers)
    } catch {
      return { method, url, headers: {} }
    }
  }
  const entries = isJsonObject(parsed)
    ? Object.entries(parsed).flatMap(([name, value]) =>
        typeof value === 'string' ? [[name, value] as const] : []
      )
    : []
  return { method, url, headers: httpRequestHeadersForLog(entries) }
}

function HttpRequestDetails({
  request,
  configured = false
}: {
  request: WorkflowHttpRequest
  configured?: boolean
}): ReactNode {
  return (
    <section className="wf-run-request" aria-label="HTTP request details">
      <h4>{configured ? 'Configured request' : 'Request'}</h4>
      <div className="wf-run-request-target">
        <strong>{request.method}</strong>
        <code>{request.url}</code>
      </div>
      {Object.keys(request.headers).length ? (
        <div className="wf-run-request-headers">
          <h4>Node request headers</h4>
          <pre tabIndex={0} aria-label="Node request headers">
            <code>{JSON.stringify(request.headers, null, 2)}</code>
          </pre>
        </div>
      ) : (
        <p>No node request headers.</p>
      )}
    </section>
  )
}

function StepInputs({ inputs }: { inputs: JsonObject }): ReactNode {
  return (
    <section className="wf-run-inputs">
      <h4>Inputs</h4>
      <pre tabIndex={0} aria-label="Resolved node inputs">
        <code>{JSON.stringify(inputs, null, 2)}</code>
      </pre>
    </section>
  )
}

function StepOutput({ output, http }: { output: JsonObject; http: boolean }): ReactNode {
  return (
    <section className="wf-run-output">
      <h4>{http ? 'Response' : 'Output'}</h4>
      <pre tabIndex={0} aria-label="Node output">
        <code>{JSON.stringify(output, null, 2)}</code>
      </pre>
    </section>
  )
}

type TraceBodyPass = Omit<WorkflowBodyRun, 'status'> & {
  status: WorkflowRun['status']
  waiting?: WorkflowRun['waiting']
}

function BodyRunDetails({
  passes,
  documents,
  descriptors
}: {
  passes: TraceBodyPass[]
  documents: readonly WorkflowDocument[]
  descriptors: ReadonlyMap<string, NodeDescriptor>
}): ReactNode {
  const [chosenPass, setChosenPass] = useState<number>()
  const [nodeId, setNodeId] = useState<string>()
  const passIndex = chosenPass !== undefined && passes[chosenPass] ? chosenPass : passes.length - 1
  const pass = passes[passIndex]
  const document = documents.find(({ id }) => id === pass.workflowId)
  const describe = (
    nodeId: string
  ): { label: string; descriptor?: NodeDescriptor; node?: WorkflowNode } => {
    const node = document?.definition.nodes.find(({ id }) => id === nodeId)
    const descriptor = node && descriptors.get(nodeKey(node.type, node.version))
    return { label: node?.label || descriptor?.label || nodeId, descriptor, node }
  }
  const waitingNode = pass.waiting?.bodyNodeId
  const selectedNode =
    nodeId && (nodeId === waitingNode || pass.steps.some((step) => step.nodeId === nodeId))
      ? nodeId
      : (waitingNode ?? pass.steps.at(-1)?.nodeId)
  const waiting = selectedNode && selectedNode === waitingNode ? pass.waiting : undefined
  const step = waiting ? undefined : pass.steps.find((step) => step.nodeId === selectedNode)
  const inputs = step?.inputs ?? waiting?.inputs
  const durationMs = step?.durationMs ?? waiting?.durationMs

  return (
    <details className="wf-run-body-passes" open={pass.status === 'waiting' ? true : undefined}>
      <summary>Body passes · {passes.length}</summary>
      <div className="wf-run-pass-fields">
        <label className="wf-field">
          Pass
          <select
            value={passIndex}
            onChange={(event) => {
              setChosenPass(Number(event.target.value))
              setNodeId(undefined)
            }}
          >
            {passes.map(({ status }, index) => (
              <option value={index} key={index}>
                Pass {index + 1} · {runStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        {selectedNode && (
          <label className="wf-field">
            Body step
            <select value={selectedNode} onChange={(event) => setNodeId(event.target.value)}>
              {pass.steps.map(({ nodeId, port, fixture }) => {
                const { label, descriptor } = describe(nodeId)
                const branch =
                  port && (descriptor?.ports.find(({ id }) => id === port)?.label || port)
                return (
                  <option key={nodeId} value={nodeId}>
                    {label}
                    {branch && ` · ${branch}`}
                    {fixture && ' · Fixture (mocked)'}
                  </option>
                )
              })}
              {waitingNode && (
                <option value={waitingNode}>
                  {describe(waitingNode).label} ·{' '}
                  {pass.waiting?.form ? 'Waiting for input' : 'Waiting for call'}
                </option>
              )}
            </select>
          </label>
        )}
      </div>
      {pass.error && (
        <p className="wf-run-error">
          {pass.error.nodeId && `${describe(pass.error.nodeId).label} · `}
          {[pass.error.detail ?? pass.error.code.replaceAll('_', ' '), pass.error.field]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {waiting && <p>{waiting.message}</p>}
      {step?.fixture && <p>Fixture (mocked)</p>}
      {durationMs !== undefined && <p>Duration · {durationMs} ms</p>}
      {step?.httpRequest && <HttpRequestDetails request={step.httpRequest} />}
      {inputs && <StepInputs inputs={inputs} />}
      {step && (
        <StepOutput
          output={step.output}
          http={!step.fixture && describe(step.nodeId).node?.type === 'workflow:http'}
        />
      )}
    </details>
  )
}

function RunSteps({
  run,
  runId,
  runUrl,
  descriptors,
  emptyMessage = 'No steps recorded.'
}: {
  run?: WorkflowRun
  runId?: string
  runUrl?: string
  descriptors: ReadonlyMap<string, NodeDescriptor>
  emptyMessage?: string
}): ReactNode {
  const [selectedNode, setSelectedNode] = useState<string>()
  const list = useRef<HTMLOListElement>(null)
  const details = useRef<HTMLElement>(null)

  function describe(nodeId: string): { title: string; type: string; nodeType?: NodeDescriptor } {
    const node = run?.definition.nodes.find(({ id }) => id === nodeId)
    const nodeType = node && descriptors.get(nodeKey(node.type, node.version))
    return { title: node?.label || nodeType?.label || nodeId, type: node?.type ?? '', nodeType }
  }

  const entries: {
    nodeId: string
    title: string
    type: string
    branch: string
    tone?: 'success' | 'warning' | 'error'
    output?: JsonObject
    detail?: string
    httpRequest?: WorkflowHttpRequest
    callback?: string
    inputs?: WorkflowStepResult['inputs']
    durationMs?: WorkflowStepResult['durationMs']
    fixture?: WorkflowStepResult['fixture']
  }[] = (run?.steps ?? []).map(
    ({ nodeId, port, output, httpRequest, releasedWait, inputs, durationMs, fixture }) => {
      const { title, type, nodeType } = describe(nodeId)
      const tone =
        port === 'error' || output.tone === 'error'
          ? 'error'
          : output.tone === 'warning'
            ? 'warning'
            : output.tone === 'success' || (type === 'workflow:http' && port === 'ok')
              ? 'success'
              : undefined
      const branch = port
        ? (nodeType?.ports.find(({ id }) => id === port)?.label ?? port)
        : tone === 'error'
          ? 'Error'
          : tone === 'warning'
            ? 'Warning'
            : 'Completed'
      return {
        nodeId,
        title,
        type,
        branch,
        tone,
        output,
        httpRequest,
        callback: releasedWait || type === 'workflow:wait-for-call' ? nodeId : undefined,
        inputs,
        durationMs,
        fixture
      }
    }
  )
  if (run?.status === 'waiting' && run.waiting) {
    const { nodeId, message: detail, id: waitId, bodyNodeId, pass } = run.waiting
    const { title, type } = describe(nodeId)
    const bodyWorkflowId = run.definition.nodes.find(({ id }) => id === nodeId)?.config.workflowId
    const body = run.bodyWorkflows?.find(({ id }) => id === bodyWorkflowId)
    const bodyNode = body?.definition.nodes.find(({ id }) => id === bodyNodeId)
    const bodyLabel = bodyNode
      ? bodyNode.label || descriptors.get(nodeKey(bodyNode.type, bodyNode.version))?.label
      : undefined
    entries.push({
      nodeId,
      title: bodyNodeId ? `${title} · Pass ${pass ?? '?'} · ${bodyLabel ?? bodyNodeId}` : title,
      type,
      branch: run.waiting.form ? 'Waiting for input' : 'Waiting for call',
      tone: 'warning',
      callback: waitId ?? nodeId,
      detail,
      inputs: run.waiting.inputs,
      durationMs: run.waiting.durationMs
    })
  }
  const runError = run?.error
  if (run && runError?.nodeId) {
    entries.push({
      nodeId: runError.nodeId,
      ...describe(runError.nodeId),
      branch: run.status === 'interrupted' ? 'Interrupted' : 'Failed',
      tone: 'error',
      detail: [runError.detail ?? runError.code.replaceAll('_', ' '), runError.field]
        .filter(Boolean)
        .join(' · '),
      inputs: runError.inputs,
      durationMs: runError.durationMs
    })
  }
  const selected = entries.find(({ nodeId }) => nodeId === selectedNode) ?? entries.at(-1)
  const selectedNodeId = selected?.nodeId
  const selectedRequest =
    selected?.httpRequest ??
    (runUrl && configuredHttpRequest(run?.definition.nodes.find(({ id }) => id === selectedNodeId)))
  const passes: TraceBodyPass[] =
    run?.bodyRuns?.filter(({ parentNodeId }) => parentNodeId === selectedNodeId) ?? []
  const pending = run?.loopCheckpoint
  if (pending && run?.status === 'waiting' && pending.parentNodeId === selectedNodeId) {
    passes.push({ ...pending, status: 'waiting', waiting: run.waiting })
  }
  useEffect(() => {
    if (details.current) details.current.scrollTop = 0
    const steps = list.current
    const row = steps?.querySelector<HTMLButtonElement>('[aria-pressed=true]')
    if (!steps || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < steps.scrollTop) steps.scrollTop = top
    if (bottom > steps.scrollTop + steps.clientHeight) steps.scrollTop = bottom - steps.clientHeight
  }, [runId, selectedNodeId])
  return (
    <>
      {runError && !runError.nodeId && (
        <p className="wf-run-error" role="alert">
          {runError.detail ?? runError.code.replaceAll('_', ' ')}
        </p>
      )}
      {selected ? (
        <div className="wf-run-split">
          <ol className="wf-run-steps" aria-label="Workflow steps" ref={list}>
            {entries.map(({ nodeId, title, type, branch, tone, fixture }) => (
              <li key={nodeId}>
                <button
                  type="button"
                  aria-pressed={selected.nodeId === nodeId}
                  onClick={() => setSelectedNode(nodeId)}
                >
                  <NodeSymbol type={type} />
                  <span className="wf-run-step-text">
                    <strong>{title}</strong>
                    <small data-tone={tone}>{branch}</small>
                    {fixture && <small>Fixture (mocked)</small>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <section className="wf-run-detail" aria-label="Step details" ref={details} tabIndex={0}>
            <div className="wf-run-detail-heading">
              <h3>{selected.title}</h3>
              <span data-tone={selected.tone}>{selected.branch}</span>
              {selected.fixture && <span>Fixture (mocked)</span>}
              {selected.durationMs !== undefined && <span>{selected.durationMs} ms</span>}
            </div>
            {selected.detail && <p>{selected.detail}</p>}
            {selected.callback && runUrl && (
              <CallbackUrl path={waitReleasePath(runUrl, selected.callback)} />
            )}
            {selectedRequest && (
              <HttpRequestDetails request={selectedRequest} configured={!selected.httpRequest} />
            )}
            {!!passes.length && (
              <BodyRunDetails
                key={`${runId}:${selected.nodeId}`}
                passes={passes}
                documents={run?.bodyWorkflows ?? []}
                descriptors={descriptors}
              />
            )}
            {selected.inputs && <StepInputs inputs={selected.inputs} />}
            {selected.output && (
              <StepOutput
                output={selected.output}
                http={!selected.fixture && selected.type === 'workflow:http'}
              />
            )}
          </section>
        </div>
      ) : (
        <p className="wf-run-empty">{emptyMessage}</p>
      )}
    </>
  )
}

function TraceLog({
  id,
  runId: currentId,
  run: currentRun,
  status: currentStatus,
  workflowUrl,
  base,
  request,
  descriptors,
  busy,
  runInProgress,
  loadError,
  onRefresh,
  onOpenWaitingRun,
  onClose
}: {
  id: string
  runId?: string
  run: WorkflowRun | undefined
  status: WorkflowRun['status'] | undefined
  workflowUrl: string
  base: string
  request: typeof fetch
  descriptors: ReadonlyMap<string, NodeDescriptor>
  busy: boolean
  runInProgress: boolean
  loadError?: string
  onRefresh: () => Promise<void>
  onOpenWaitingRun: (run: WorkflowRun) => void
  onClose: () => void
}): ReactNode {
  const [refreshError, setRefreshError] = useState('')
  const [pastId, setPastId] = useState('')
  const [pastRun, setPastRun] = useState<WorkflowRun>()
  const [loadingPast, setLoadingPast] = useState(false)
  const [reloadPast, setReloadPast] = useState(0)
  const run = pastId ? pastRun : currentRun
  const runId = pastId || currentId
  const runUrl = runId ? runDetailsPath(base, runId) : undefined
  const status = pastId ? pastRun?.status : currentStatus
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    heading.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!pastId) return
    const controller = new AbortController()
    setLoadingPast(true)
    requestJson<WorkflowRun>(request, runDetailsPath(base, pastId), { signal: controller.signal })
      .then((savedRun) => {
        if (!controller.signal.aborted) setPastRun(savedRun)
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setRefreshError(message(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPast(false)
      })
    return () => controller.abort()
  }, [base, request, pastId, reloadPast])

  function selectRun(id: string): void {
    setPastId(id)
    setPastRun(undefined)
    setLoadingPast(!!id)
    setRefreshError('')
  }

  async function checkRun(): Promise<void> {
    setRefreshError('')
    if (pastId) {
      setReloadPast(reloadPast + 1)
      return
    }
    try {
      await onRefresh()
    } catch (error) {
      setRefreshError(message(error))
    }
  }

  const count = run?.steps.length ?? 0
  const statusLabel =
    status === 'waiting' && run?.waiting?.form
      ? 'Waiting for input'
      : status
        ? runStatusLabels[status]
        : 'Result unavailable'

  return (
    <dialog
      id={id}
      ref={dialog}
      className="wf-trace"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="wf-run-toolbar">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          Trace Log
        </h2>
        {runId && (
          <>
            <span className="wf-run-status" data-status={status} role="status">
              {statusLabel}
            </span>
            <span className="wf-run-count">
              {count} {count === 1 ? 'step' : 'steps'} executed
            </span>
          </>
        )}
        <div className="wf-run-actions">
          {runId && (!run || run.status === 'running' || run.status === 'waiting') && (
            <button type="button" disabled={pastId ? loadingPast : busy} onClick={checkRun}>
              Check run
            </button>
          )}
          {pastRun?.status === 'waiting' && !runInProgress && (
            <button
              type="button"
              disabled={busy || loadingPast}
              onClick={() => {
                onOpenWaitingRun(pastRun)
                dialog.current?.close()
              }}
            >
              Open waiting run
            </button>
          )}
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </header>
      <RunHistoryControls
        workflowUrl={workflowUrl}
        request={request}
        currentId={currentId}
        currentStatus={currentStatus}
        selectedId={pastId}
        onSelect={selectRun}
      />
      {(refreshError || (!pastId && loadError)) && (
        <p className="wf-run-error" role="alert">
          {refreshError || loadError}
        </p>
      )}
      <RunSteps
        key={pastId}
        run={run}
        runId={runId}
        runUrl={runUrl}
        descriptors={descriptors}
        emptyMessage={
          loadingPast
            ? 'Loading run…'
            : !runId
              ? 'Run this workflow to see its steps.'
              : status === 'running'
                ? 'Waiting for the first step to finish…'
                : undefined
        }
      />
      {runId && (
        <footer className="wf-run-footer">
          Run ID <code>{runId}</code>
        </footer>
      )}
    </dialog>
  )
}

function Editor({
  document,
  catalog,
  url,
  base,
  request = fetch,
  runInput,
  runDisabled,
  enableWorkflowTests,
  documentTarget,
  paletteTypes,
  onSaved,
  onDirtyChange,
  renderConfig,
  formatIssue
}: WorkflowEditorProps & {
  document: WorkflowDocument
  catalog: NodeDescriptor[]
  url: string
  base: string
}): ReactNode {
  const [history, setHistory] = useState<History>({
    past: [],
    current: document.definition,
    future: []
  })
  const [saved, setSaved] = useState(document)
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>({})
  const [moving, setMoving] = useState<WorkflowDefinition['layout']>({})
  const [measurements, setMeasurements] = useState(new Map<string, Card['measured']>())
  const [operation, setOperation] = useState<'save' | 'run' | 'check' | 'release' | null>(null)
  const [error, setError] = useState('')
  const [runLookupError, setRunLookupError] = useState('')
  const [lastSavedRun, setLastSavedRun] = useState<WorkflowRun>()
  const canvas = useRef<ReactFlowInstance<Card, Edge>>(null)
  const [traceLogOpen, setTraceLogOpen] = useState(false)
  const traceLogId = useId()
  const traceLogButton = useRef<HTMLButtonElement>(null)
  const [workflowTestOpen, setWorkflowTestOpen] = useState(false)
  const workflowTestId = useId()
  const workflowTestButton = useRef<HTMLButtonElement>(null)
  const loadTestBody = useCallback(
    (id: string, signal: AbortSignal) =>
      requestJson<WorkflowDocument>(request, `${base}/workflows/${encodeURIComponent(id)}`, {
        signal
      }),
    [base, request]
  )
  const runStorageKey = `workflow-run:${url}`
  const [trackedRun, setTrackedRun] = useState<
    { id: string; run?: WorkflowRun | null } | undefined
  >(() => {
    const id = window.sessionStorage.getItem(runStorageKey)
    return id ? { id } : undefined
  })
  const [releaseDraft, setReleaseDraft] = useState<{ waitId?: string; text: string }>()
  const run = trackedRun?.run ?? undefined
  const runId = trackedRun?.run === null ? undefined : trackedRun?.id
  const runUrl = runId ? runDetailsPath(base, runId) : undefined
  const waitId = run?.waiting && (run.waiting.id ?? run.waiting.nodeId)
  const releasePayload = releaseDraft?.waitId === waitId ? (releaseDraft?.text ?? '{}') : '{}'
  const releaseUrl =
    runUrl && run?.status === 'waiting' && waitId ? waitReleasePath(runUrl, waitId) : undefined
  const runInProgress = !!runId && (!run || run.status === 'running' || run.status === 'waiting')
  const definition = history.current
  const dirty = saved.definition !== definition
  const descriptors = useMemo(
    () => new Map(catalog.map((item) => [nodeKey(item.type, item.version), item])),
    [catalog]
  )
  const issues = useMemo(() => validateWorkflow(definition, catalog), [definition, catalog])
  const palette = useMemo(() => {
    const groups = new Map<string, NodeDescriptor[]>()
    for (const node of catalog) {
      if (paletteTypes && !paletteTypes.includes(node.type)) continue
      const category = node.category || 'Actions'
      const group = groups.get(category) ?? []
      group.push(node)
      groups.set(category, group)
    }
    return [...groups]
  }, [catalog, paletteTypes])
  const selected = definition.nodes.find((node) => node.id === selection.node)
  const descriptor = selected && descriptors.get(nodeKey(selected.type, selected.version))
  const sources = useMemo(
    () => (selection.node ? availableSources(definition, selection.node) : new Set<string>()),
    [definition, selection.node]
  )
  const possibleSources = useMemo(
    () =>
      selection.node ? possibleUpstreamSources(definition, selection.node) : new Set<string>(),
    [definition, selection.node]
  )
  const selectedEdge = definition.edges.find(({ id }) => id === selection.edge)
  const latest =
    run &&
    (!lastSavedRun ||
      run.id === lastSavedRun.id ||
      (run.startedAt && run.startedAt >= (lastSavedRun.startedAt ?? '')))
      ? run
      : lastSavedRun
  const outputs = useMemo(() => observedOutputs(definition, latest), [definition, latest])
  const inspectedInputNode = descriptor?.inputs?.length ? selected?.id : undefined

  useEffect(() => {
    if (!saved.revision) return
    const controller = new AbortController()
    const init = { signal: controller.signal }
    let version = 0
    function refresh(): void {
      const requestVersion = ++version
      requestJson<WorkflowRunSummary[]>(request, runHistoryPath(url, 1), init)
        .then(
          async ([recent]) =>
            recent &&
            (await requestJson<WorkflowRun>(request, runDetailsPath(base, recent.id), init))
        )
        .then((sample) => {
          if (!controller.signal.aborted && version === requestVersion)
            setLastSavedRun(sample || undefined)
        })
        .catch(() => {
          if (!controller.signal.aborted && version === requestVersion) setLastSavedRun(undefined)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [base, url, request, saved.revision, inspectedInputNode])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!runId || !runUrl || !runInProgress || (operation && operation !== 'save')) return
    const controller = new AbortController()
    let polling: ReturnType<typeof setTimeout> | undefined
    const id = runId
    const path = runUrl

    async function poll(): Promise<void> {
      try {
        const latest = await lookupRun(request, path, id, { signal: controller.signal })
        if (controller.signal.aborted) return
        setTrackedRun({ id, run: latest })
        setRunLookupError((previous) =>
          !latest && previous ? 'Run was not found. Try again.' : ''
        )
      } catch (error) {
        if (controller.signal.aborted) return
        if (!run) setRunLookupError(message(error))
        polling = setTimeout(poll, 1000)
      }
    }

    if (run) polling = setTimeout(poll, 1000)
    else void poll()
    return () => {
      clearTimeout(polling)
      controller.abort()
    }
  }, [runInProgress, operation, request, run, runId, runUrl])

  function edit(update: (value: WorkflowDefinition) => WorkflowDefinition): void {
    setHistory(({ past, current, future }) => {
      const next = update(current)
      return next === current
        ? { past, current, future }
        : { past: [...past.slice(-49), current], current: next, future: [] }
    })
  }

  function handleNodeChanges(changes: NodeChange<Card>[]): void {
    const active = changes.find((change) => change.type === 'select' && change.selected)
    if (active?.type === 'select') setSelection({ node: active.id })

    const sizes = changes.flatMap((change) =>
      change.type === 'dimensions' && change.dimensions
        ? [[change.id, change.dimensions] as const]
        : []
    )
    if (sizes.length) setMeasurements((previous) => new Map([...previous, ...sizes]))

    const positions = changes.flatMap((change) =>
      change.type === 'position' && change.position
        ? [{ ...change, position: change.position }]
        : []
    )
    if (!positions.length) return

    setMoving((previous) => {
      const next = { ...previous }
      for (const { id, position, dragging } of positions) {
        if (dragging) next[id] = position
        else delete next[id]
      }
      return next
    })

    const settled = positions.filter(({ dragging }) => !dragging)
    if (!settled.length) return
    edit((value) => {
      const updated = settled.filter(({ id, position }) => {
        const index = value.nodes.findIndex((node) => node.id === id)
        if (index < 0) return false
        const previous = nodePosition(value.layout, id, index)
        return previous.x !== position.x || previous.y !== position.y
      })
      if (!updated.length) return value
      return {
        ...value,
        layout: {
          ...value.layout,
          ...Object.fromEntries(updated.map(({ id, position }) => [id, position]))
        }
      }
    })
  }

  function undo(): void {
    setHistory(({ past, current, future }) =>
      past.length
        ? { past: past.slice(0, -1), current: past[past.length - 1], future: [current, ...future] }
        : { past, current, future }
    )
  }

  function redo(): void {
    setHistory(({ past, current, future }) =>
      future.length
        ? { past: [...past, current], current: future[0], future: future.slice(1) }
        : { past, current, future }
    )
  }

  function removeSelection(ids: string[], edgeIds: string[] = []): void {
    edit((value) => ({
      ...value,
      entry: value.entry && ids.includes(value.entry) ? null : value.entry,
      nodes: value.nodes.filter(({ id }) => !ids.includes(id)),
      edges: value.edges.filter(
        ({ id, from, to }) => !edgeIds.includes(id) && !ids.includes(from) && !ids.includes(to)
      ),
      layout: Object.fromEntries(Object.entries(value.layout).filter(([id]) => !ids.includes(id)))
    }))
    setSelection({})
  }

  function addNode(item: NodeDescriptor): void {
    if (definition.nodes.length >= 100) return
    const id = createId()
    edit((value) => ({
      ...value,
      entry: value.nodes.length === 0 ? id : value.entry,
      nodes: [...value.nodes, { id, type: item.type, version: item.version, config: {} }],
      layout: {
        ...value.layout,
        [id]: {
          x: (value.nodes.length % 4) * 245 + 20,
          y: Math.floor(value.nodes.length / 4) * 140 + 30
        }
      }
    }))
    setSelection({ node: id })
  }

  function autoArrange(): void {
    edit((value) => {
      const layout = arrangeLayout(value, measurements)
      return value.nodes.every(
        ({ id }) =>
          Object.hasOwn(value.layout, id) &&
          value.layout[id].x === layout[id].x &&
          value.layout[id].y === layout[id].y
      )
        ? value
        : { ...value, layout }
    })
    requestAnimationFrame(() => void canvas.current?.fitView())
  }

  function insertNode(edgeId: string, item: NodeDescriptor): void {
    if (item.ports.length !== 1 || definition.nodes.length >= 100 || definition.edges.length >= 400)
      return
    const id = createId()
    const outgoingId = createId()
    const port = item.ports[0].id
    edit((value) => {
      const edge = value.edges.find((wire) => wire.id === edgeId)
      if (!edge || value.nodes.length >= 100 || value.edges.length >= 400) return value
      const node = { id, type: item.type, version: item.version, config: {} }
      const next = {
        ...value,
        nodes: [...value.nodes, node],
        edges: value.edges.filter((wire) => wire.id !== edgeId),
        layout: { ...value.layout, [id]: insertionPoint(value, edge, measurements) }
      }
      const incoming = { ...edge, to: id }
      const outgoing = { id: outgoingId, from: id, port, to: edge.to }
      if (!canConnect(next, catalog, incoming)) return value
      next.edges.push(incoming)
      if (!canConnect(next, catalog, outgoing)) return value
      next.edges.push(outgoing)
      return next
    })
    setSelection({ node: id })
  }

  function updateNode(id: string, update: Partial<WorkflowNode>): void {
    edit((value) => ({
      ...value,
      nodes: value.nodes.map((node) => (node.id === id ? { ...node, ...update } : node))
    }))
  }

  function connect(connection: Pick<Connection, 'source' | 'sourceHandle' | 'target'>): void {
    if (!connection.sourceHandle) return
    const edge = {
      id: createId(),
      from: connection.source,
      port: connection.sourceHandle,
      to: connection.target
    }
    if (definition.edges.length < 400 && canConnect(definition, catalog, edge)) {
      edit((value) => ({ ...value, edges: [...value.edges, edge] }))
    }
  }

  async function save(): Promise<void> {
    const snapshot = definition
    setOperation('save')
    setError('')
    let result: WorkflowDocument
    try {
      result = await requestJson<WorkflowDocument>(
        request,
        url,
        send('PUT', { definition: snapshot, expectedRevision: saved.revision })
      )
      setSaved({ ...result, definition: snapshot })
    } catch (error) {
      setError(message(error))
      return
    } finally {
      setOperation(null)
    }
    onSaved?.(result)
  }

  async function execute(): Promise<void> {
    if (runInProgress || operation) return
    const id = trackedRun?.run === null ? trackedRun.id : createId()
    window.sessionStorage.setItem(runStorageKey, id)
    setTrackedRun({ id })
    setReleaseDraft(undefined)
    setOperation('run')
    setError('')
    setRunLookupError('')
    try {
      const result = await requestRun(
        request,
        `${url}/runs`,
        id,
        send('POST', { revision: saved.revision, runId: id, input: runInput ?? {} })
      )
      setTrackedRun({ id, run: result })
    } catch (error) {
      if (rejectedRunStart(error)) {
        setTrackedRun({ id, run: null })
        setError(message(error))
      } else {
        setRunLookupError(message(error))
      }
    } finally {
      setOperation(null)
    }
  }

  async function refreshRun(): Promise<void> {
    if (!runId || !runUrl || operation) return
    setOperation('check')
    setError('')
    try {
      const latest = await lookupRun(request, runUrl, runId)
      setTrackedRun({ id: runId, run: latest })
      setRunLookupError(latest ? '' : 'Run was not found. Try again.')
    } finally {
      setOperation(null)
    }
  }

  function issueText(issue: WorkflowIssue): string {
    return (
      formatIssue?.(issue) ??
      (issue.code === 'invalid_branch_binding'
        ? `${issue.field ? `${issue.field} · ` : ''}${branchBindingIssueText}`
        : `${issue.code.replaceAll('_', ' ')}${issue.field ? ` · ${issue.field}` : ''}`)
    )
  }

  async function testWorkflow(
    input: JsonObject,
    fixtures: WorkflowTestFixture[],
    signal: AbortSignal
  ): Promise<WorkflowRun> {
    const result = await requestJson<WorkflowRun>(request, `${url}/test`, {
      ...send('POST', { definition, input, fixtures }),
      signal
    }).catch((failure: unknown) => {
      if (failure instanceof RequestError) {
        if (failure.code === 'invalid_workflow' && failure.body?.issues?.length) {
          throw new Error(failure.body.issues.map(issueText).join('\n'))
        }
        if (failure.code === 'invalid_workflow_fixture' && failure.body?.detail) {
          const { nodeId, workflowId, detail } = failure.body
          const node =
            workflowId === document.id
              ? definition.nodes.find(({ id }) => id === nodeId)
              : undefined
          const descriptor = node && descriptors.get(nodeKey(node.type, node.version))
          const label = node?.label || descriptor?.label || nodeId
          const scope = workflowId !== document.id ? workflowId : undefined
          throw new Error([scope, label, detail].filter(Boolean).join(' · '))
        }
      }
      throw new Error(message(failure))
    })
    if (
      result?.revision !== 0 ||
      result.workflowId !== document.id ||
      !workflowRunStatuses.includes(result.status) ||
      !Array.isArray(result.definition?.nodes) ||
      !Array.isArray(result.steps)
    ) {
      throw new Error('The workflow service returned an invalid test result.')
    }
    return result
  }

  function openWaitingRun(run: WorkflowRun): void {
    if (runInProgress || operation || run.status !== 'waiting') return
    window.sessionStorage.setItem(runStorageKey, run.id)
    setTrackedRun({ id: run.id, run })
    setReleaseDraft(undefined)
    setError('')
    setRunLookupError('')
  }

  function sendCallback(): void {
    try {
      const body: unknown = JSON.parse(releasePayload)
      if (!isJsonObject(body)) throw new Error('Invalid payload')
      void release(body)
    } catch {
      setError('Enter a JSON object for the callback payload.')
    }
  }

  async function release(body: JsonObject): Promise<void> {
    if (!runId || !releaseUrl || operation) return
    setOperation('release')
    setError('')
    try {
      const result = await requestRun(request, releaseUrl, runId, send('POST', body))
      setTrackedRun({ id: runId, run: result })
      setReleaseDraft(undefined)
    } catch (error) {
      setError(message(error))
    } finally {
      setOperation(null)
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select, [contenteditable=true]')
    )
      return
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  }

  const currentRun = run?.revision === saved.revision && !dirty ? run : undefined
  const executed = useMemo(
    () => new Map(currentRun?.steps.map((step) => [step.nodeId, step.port])),
    [currentRun]
  )
  const lastStep = run?.steps.at(-1)
  const outcome = lastStep?.output.message
  const tone = lastStep?.output.tone
  const terminal =
    typeof outcome === 'string' && run?.definition.nodes.find(({ id }) => id === lastStep?.nodeId)
  const runStatus = !run && operation === 'run' ? 'running' : run?.status
  const waitingForInput = runStatus === 'waiting' && run?.waiting?.form
  const statusLabel =
    (runStatus === 'completed' && terminal && terminal.label) ||
    (waitingForInput
      ? 'Waiting for input'
      : runStatus
        ? runStatusLabels[runStatus]
        : 'Checking run…')
  const statusMessage =
    runStatus === 'waiting'
      ? run?.waiting?.message
      : runStatus === 'completed'
        ? outcome
        : undefined

  function closeTraceLog(): void {
    setTraceLogOpen(false)
    traceLogButton.current?.focus()
  }

  function closeWorkflowTest(): void {
    setWorkflowTestOpen(false)
    workflowTestButton.current?.focus()
  }

  const nodes = useMemo<Card[]>(
    () =>
      definition.nodes.map((node, index) => ({
        id: node.id,
        type: 'workflow',
        position:
          (Object.hasOwn(moving, node.id) ? moving[node.id] : undefined) ??
          nodePosition(definition.layout, node.id, index),
        measured: measurements.get(node.id),
        selected: node.id === selection.node,
        data: {
          node,
          descriptor: descriptors.get(nodeKey(node.type, node.version)),
          entry: node.id === definition.entry,
          invalid: issues.some((issue) => issue.nodeId === node.id),
          visited: executed.has(node.id),
          waiting: currentRun?.waiting?.nodeId === node.id
        }
      })),
    [
      definition.nodes,
      definition.layout,
      definition.entry,
      moving,
      measurements,
      selection.node,
      descriptors,
      issues,
      executed,
      currentRun?.waiting?.nodeId
    ]
  )
  const edges = useMemo<Edge[]>(
    () =>
      definition.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        sourceHandle: edge.port,
        target: edge.to,
        className: issues.some((issue) => issue.edgeId === edge.id)
          ? 'wf-invalid-edge'
          : executed.get(edge.from) === edge.port
            ? 'wf-visited-edge'
            : undefined,
        selected: edge.id === selection.edge
      })),
    [definition.edges, selection.edge, issues, executed]
  )

  const documentControls = (
    <div className="wf-document" data-portaled={!!documentTarget}>
      <input
        aria-label="Workflow name"
        placeholder="Workflow name"
        title={definition.name}
        value={definition.name}
        maxLength={160}
        onChange={(event) => {
          const name = event.target.value
          edit((value) => ({ ...value, name }))
        }}
      />
      <span className="wf-document-status" role="status" data-dirty={dirty || !saved.revision}>
        {operation === 'save' ? 'Saving…' : dirty || !saved.revision ? 'Unsaved' : 'Saved'}
      </span>
    </div>
  )

  return (
    <div className="wf-editor" onKeyDown={keyboard}>
      <header className="wf-toolbar" aria-label="Workflow controls">
        {documentTarget === undefined && documentControls}
        {documentTarget && createPortal(documentControls, documentTarget)}
        <div className="wf-toolbar-actions">
          <button type="button" disabled={!history.past.length} onClick={undo}>
            <span aria-hidden="true" className="wf-action-icon">
              ↶
            </span>{' '}
            Undo
          </button>
          <button type="button" disabled={!history.future.length} onClick={redo}>
            <span aria-hidden="true" className="wf-action-icon">
              ↷
            </span>{' '}
            Redo
          </button>
          <button type="button" disabled={!definition.nodes.length} onClick={autoArrange}>
            Auto Arrange
          </button>
          <button
            type="button"
            disabled={!!operation || (!dirty && !!saved.revision) || !definition.name.trim()}
            onClick={save}
          >
            Save
          </button>
          <button
            className="wf-primary"
            type="button"
            disabled={
              !!operation ||
              runInProgress ||
              runDisabled ||
              dirty ||
              !saved.revision ||
              !!issues.length
            }
            onClick={execute}
          >
            <span aria-hidden="true" className="wf-action-icon">
              ▶
            </span>
            Run
          </button>
          {enableWorkflowTests && (
            <button
              type="button"
              ref={workflowTestButton}
              aria-haspopup="dialog"
              aria-controls={workflowTestId}
              onClick={() => setWorkflowTestOpen(true)}
            >
              Test Workflow…
            </button>
          )}
          <button
            type="button"
            ref={traceLogButton}
            aria-haspopup="dialog"
            aria-controls={traceLogOpen ? traceLogId : undefined}
            onClick={() => setTraceLogOpen(true)}
          >
            Trace Log
          </button>
        </div>
        {error || runLookupError ? (
          <p className="wf-toolbar-feedback" role="alert" title={error || runLookupError}>
            {error || runLookupError}
          </p>
        ) : (
          <div
            className="wf-toolbar-feedback wf-run-outcome"
            role="status"
            data-status={runStatus}
            data-tone={runStatus === 'completed' && typeof tone === 'string' ? tone : undefined}
            hidden={!runId}
          >
            {runId && (
              <>
                <strong title={statusLabel}>{statusLabel}</strong>
                {typeof statusMessage === 'string' && (
                  <span title={statusMessage}>{statusMessage}</span>
                )}
              </>
            )}
          </div>
        )}
      </header>

      {releaseUrl && run?.waiting && (
        <section
          key={waitId}
          className="wf-wait-panel"
          aria-label={waitingForInput ? 'Human input' : 'Wait for call'}
        >
          <CallbackUrl path={releaseUrl} />
          {waitingForInput ? (
            <HumanInputForm
              key={waitId}
              form={waitingForInput}
              busy={!!operation}
              onSubmit={release}
            />
          ) : (
            <>
              <label className="wf-field">
                Callback payload
                <textarea
                  rows={2}
                  value={releasePayload}
                  onChange={(event) => setReleaseDraft({ waitId, text: event.target.value })}
                />
              </label>
              <button
                className="wf-primary"
                type="button"
                disabled={!!operation}
                onClick={sendCallback}
              >
                Send callback
              </button>
            </>
          )}
        </section>
      )}

      <div className="wf-workspace">
        <aside className="wf-panel" aria-label="Node library" data-grouped={palette.length > 1}>
          <h2 className="wf-pane-title">Node Library</h2>
          {palette.map(([category, items]) => (
            <section key={category} className="wf-catalog-group" aria-label={category}>
              {(palette.length > 1 || category !== 'Actions') && <h3>{category}</h3>}
              {items.map((item) => (
                <button
                  className="wf-catalog-item"
                  type="button"
                  key={nodeKey(item.type, item.version)}
                  title={palette.length > 1 ? item.description : undefined}
                  disabled={definition.nodes.length >= 100}
                  onClick={() => addNode(item)}
                >
                  <NodeSymbol type={item.type} />
                  <span>
                    <strong>{item.label}</strong>
                    {item.description && <small>{item.description}</small>}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </aside>

        <section className="wf-canvas" aria-label="Workflow canvas">
          <ReactFlow<Card, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            onInit={(instance) => {
              canvas.current = instance
            }}
            minZoom={0.2}
            maxZoom={2}
            edgesReconnectable={false}
            multiSelectionKeyCode={null}
            onPaneClick={() => setSelection({})}
            onConnect={connect}
            isValidConnection={(edge) =>
              !!edge.sourceHandle &&
              definition.edges.length < 400 &&
              canConnect(definition, catalog, {
                from: edge.source,
                port: edge.sourceHandle,
                to: edge.target
              })
            }
            onDelete={({ nodes, edges }) =>
              removeSelection(
                nodes.map(({ id }) => id),
                edges.map(({ id }) => id)
              )
            }
            onNodesChange={handleNodeChanges}
            onEdgesChange={(changes) => {
              const active = changes.find((change) => change.type === 'select' && change.selected)
              if (active && 'id' in active) setSelection({ edge: active.id })
            }}
          >
            <Background gap={18} size={1} color="var(--wf-grid)" />
            <Controls showInteractive={false} />
          </ReactFlow>
          {!nodes.length && <p className="wf-empty">Add a node to start your workflow.</p>}
        </section>

        <aside className="wf-panel" aria-label="Node settings">
          <h2 className="wf-pane-title">Inspector</h2>
          {selected && (
            <div className="wf-inspector-heading">
              <NodeSymbol type={selected.type} />
              <strong>{selected.label || descriptor?.label || selected.type}</strong>
            </div>
          )}
          {selected && (
            <>
              <div className="wf-node-actions">
                <button
                  type="button"
                  disabled={
                    definition.entry === selected.id ||
                    definition.edges.some((edge) => edge.to === selected.id)
                  }
                  onClick={() => edit((value) => ({ ...value, entry: selected.id }))}
                >
                  Set as start
                </button>
                <button
                  type="button"
                  onClick={() => removeSelection([selected.id])}
                  className="wf-destructive"
                >
                  Delete node
                </button>
              </div>
              <label className="wf-field">
                Node name
                <input
                  value={selected.label ?? ''}
                  placeholder={descriptor?.label}
                  maxLength={80}
                  onChange={(event) => updateNode(selected.id, { label: event.target.value })}
                />
              </label>
              {descriptor &&
                (renderConfig?.({
                  node: selected,
                  descriptor,
                  setConfig: (config) => updateNode(selected.id, { config })
                }) ??
                  (() => {
                    const fields = descriptor.fields ?? []
                    const renderField = (field: NodeConfigField): ReactNode => (
                      <NodeConfigurationField
                        key={field.key}
                        node={selected}
                        field={field}
                        setConfig={(config) => updateNode(selected.id, { config })}
                        bodyPicker={{
                          base,
                          request,
                          workflowId: document.id,
                          catalog,
                          allowWaits: selected.type === 'workflow:loop'
                        }}
                      />
                    )
                    if (selected.type !== 'workflow:http') return fields.map(renderField)
                    return (
                      <>
                        {fields.filter((field) => field.required).map(renderField)}
                        <details className="wf-http-options">
                          <summary>Headers, body, and response rules</summary>
                          {fields.filter((field) => !field.required).map(renderField)}
                        </details>
                      </>
                    )
                  })())}
              {descriptor?.inputs?.map((field) => (
                <InputBindingPicker
                  key={`${selected.id}:${field.key}`}
                  field={field}
                  binding={
                    Object.hasOwn(selected.bindings ?? {}, field.key)
                      ? selected.bindings?.[field.key]
                      : undefined
                  }
                  definition={definition}
                  descriptors={descriptors}
                  outputs={outputs}
                  sources={sources}
                  possibleSources={possibleSources}
                  invalidBranchBinding={issues.some(
                    (issue) =>
                      issue.code === 'invalid_branch_binding' &&
                      issue.nodeId === selected.id &&
                      issue.field === field.key
                  )}
                  onChange={(binding) => {
                    const bindings = { ...selected.bindings }
                    if (binding) {
                      Object.defineProperty(bindings, field.key, {
                        value: binding,
                        enumerable: true,
                        configurable: true,
                        writable: true
                      })
                    } else {
                      delete bindings[field.key]
                    }
                    updateNode(selected.id, { bindings })
                  }}
                />
              ))}
              {descriptor && (
                <NodeTest
                  key={selected.id}
                  node={selected}
                  descriptor={descriptor}
                  base={base}
                  request={request}
                  input={runInput}
                  sample={boundSample(
                    selected,
                    descriptor.inputs ?? [],
                    outputs,
                    sources,
                    possibleSources
                  )}
                />
              )}
            </>
          )}
          {selectedEdge && (
            <>
              <div className="wf-node-actions">
                <button
                  type="button"
                  className="wf-destructive"
                  onClick={() => removeSelection([], [selectedEdge.id])}
                >
                  Delete connection
                </button>
              </div>
              <label className="wf-field">
                Insert node
                <select
                  value=""
                  disabled={definition.nodes.length >= 100 || definition.edges.length >= 400}
                  onChange={(event) => {
                    const item = descriptors.get(event.currentTarget.value)
                    if (item) insertNode(selectedEdge.id, item)
                  }}
                >
                  <option value="">Choose a node…</option>
                  {palette
                    .flatMap(([, items]) => items.filter(({ ports }) => ports.length === 1))
                    .map((item) => (
                      <option
                        key={nodeKey(item.type, item.version)}
                        value={nodeKey(item.type, item.version)}
                      >
                        {item.label}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          {!selected && !selectedEdge && <p>Select a node to edit its settings.</p>}
          {!!issues.length && (
            <details className="wf-issues">
              <summary>
                {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
              </summary>
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>{issueText(issue)}</li>
                ))}
              </ul>
            </details>
          )}
        </aside>
      </div>

      {enableWorkflowTests && (
        <WorkflowTestDialog
          id={workflowTestId}
          open={workflowTestOpen}
          workflowId={document.id}
          definition={definition}
          descriptors={descriptors}
          defaultInput={runInput}
          loadBody={loadTestBody}
          onRun={testWorkflow}
          renderSteps={(run) => (
            <RunSteps key={run.id} runId={run.id} run={run} descriptors={descriptors} />
          )}
          onClose={closeWorkflowTest}
        />
      )}
      {traceLogOpen && (
        <TraceLog
          id={traceLogId}
          runId={runId}
          run={run}
          status={runStatus}
          workflowUrl={url}
          base={base}
          request={request}
          descriptors={descriptors}
          busy={!!operation}
          runInProgress={runInProgress}
          loadError={runId && !run ? runLookupError : undefined}
          onRefresh={refreshRun}
          onOpenWaitingRun={openWaitingRun}
          onClose={closeTraceLog}
        />
      )}
    </div>
  )
}
