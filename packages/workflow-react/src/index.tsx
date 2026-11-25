import {
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
  type NodeProps
} from '@xyflow/react'
import {
  acceptsOutput,
  availableSources,
  canConnect,
  canUseAsBody,
  createEmptyWorkflow,
  httpRequestHeadersForLog,
  isJsonObject,
  isLogicConditions,
  logicOperators,
  nodeKey,
  validateWorkflow,
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
  type WorkflowRun
} from '@ideawithai/workflow-express/schema'

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
    public fields?: { kind: 'input' | 'config'; field: string; label: string }[]
  ) {
    super(code)
  }
}

async function requestJson<T>(request: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init)
  const data = await response.json()
  if (!response.ok)
    throw new RequestError(response.status, data.error ?? 'request_failed', data.fields)
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
  catalog
}: {
  label: string
  value: JsonValue | undefined
  change: (value: string | undefined) => void
  base: string
  workflowId: string
  request: typeof fetch
  catalog: readonly NodeDescriptor[]
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
              ({ id, definition }) => id !== workflowId && canUseAsBody(definition, catalog)
            )
          )
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not load saved workflows.')
      })
    return () => controller.abort()
  }, [base, workflowId, request, catalog])

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
    'base' | 'workflowId' | 'request' | 'catalog'
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
  input
}: {
  node: WorkflowNode
  descriptor: NodeDescriptor
  base: string
  request: typeof fetch
  input?: JsonObject
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
          {result.status === 'failed' && <p>{result.error.replaceAll('_', ' ')}</p>}
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

function BodyRunDetails({
  passes,
  documents,
  descriptors
}: {
  passes: WorkflowBodyRun[]
  documents: readonly WorkflowDocument[]
  descriptors: ReadonlyMap<string, NodeDescriptor>
}): ReactNode {
  const [passIndex, setPassIndex] = useState(passes.length - 1)
  const [nodeId, setNodeId] = useState<string>()
  const pass = passes[passIndex]
  const document = documents.find(({ id }) => id === pass.workflowId)
  const describe = (
    nodeId: string
  ): { label: string; descriptor?: NodeDescriptor; node?: WorkflowNode } => {
    const node = document?.definition.nodes.find(({ id }) => id === nodeId)
    const descriptor = node && descriptors.get(nodeKey(node.type, node.version))
    return { label: node?.label || descriptor?.label || nodeId, descriptor, node }
  }
  const step = pass.steps.find((item) => item.nodeId === nodeId) ?? pass.steps.at(-1)

  return (
    <details className="wf-run-body-passes">
      <summary>Body passes · {passes.length}</summary>
      <div className="wf-run-pass-fields">
        <label className="wf-field">
          Pass
          <select
            value={passIndex}
            onChange={(event) => {
              setPassIndex(Number(event.target.value))
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
        {step && (
          <label className="wf-field">
            Body step
            <select value={step.nodeId} onChange={(event) => setNodeId(event.target.value)}>
              {pass.steps.map(({ nodeId, port }) => {
                const { label, descriptor } = describe(nodeId)
                const branch =
                  port && (descriptor?.ports.find(({ id }) => id === port)?.label || port)
                return (
                  <option key={nodeId} value={nodeId}>
                    {label}
                    {branch && ` · ${branch}`}
                  </option>
                )
              })}
            </select>
          </label>
        )}
      </div>
      {pass.error && (
        <p className="wf-run-error">
          {pass.error.nodeId && `${describe(pass.error.nodeId).label} · `}
          {pass.error.code.replaceAll('_', ' ')}
        </p>
      )}
      {step?.httpRequest && <HttpRequestDetails request={step.httpRequest} />}
      {step && (
        <StepOutput
          output={step.output}
          http={describe(step.nodeId).node?.type === 'workflow:http'}
        />
      )}
    </details>
  )
}

function TraceLog({
  id,
  runId,
  runUrl,
  run,
  status,
  descriptors,
  busy,
  loadError,
  onRefresh,
  onClose
}: {
  id: string
  runId?: string
  runUrl?: string
  run: WorkflowRun | undefined
  status: WorkflowRun['status'] | undefined
  descriptors: ReadonlyMap<string, NodeDescriptor>
  busy: boolean
  loadError?: string
  onRefresh: () => Promise<void>
  onClose: () => void
}): ReactNode {
  const [selectedNode, setSelectedNode] = useState<string>()
  const [refreshError, setRefreshError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const details = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    heading.current?.focus({ preventScroll: true })
  }, [])

  async function checkRun(): Promise<void> {
    setRefreshError('')
    try {
      await onRefresh()
    } catch (error) {
      setRefreshError(message(error))
    }
  }

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
    callback?: boolean
  }[] = (run?.steps ?? []).map(({ nodeId, port, output, httpRequest, releasedWait }) => {
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
      callback: releasedWait || type === 'workflow:wait-for-call'
    }
  })
  if (run?.status === 'waiting' && run.waiting) {
    const { nodeId, message: detail } = run.waiting
    entries.push({
      nodeId,
      ...describe(nodeId),
      branch: run.waiting.form ? 'Waiting for input' : 'Waiting for call',
      tone: 'warning',
      callback: true,
      detail
    })
  }
  const runError = run?.error
  if (run && runError?.nodeId) {
    entries.push({
      nodeId: runError.nodeId,
      ...describe(runError.nodeId),
      branch: run.status === 'interrupted' ? 'Interrupted' : 'Failed',
      tone: 'error',
      detail: runError.code.replaceAll('_', ' ')
    })
  }
  const selected = entries.find(({ nodeId }) => nodeId === selectedNode) ?? entries.at(-1)
  const selectedNodeId = selected?.nodeId
  const selectedRequest =
    selected?.httpRequest ??
    configuredHttpRequest(run?.definition.nodes.find(({ id }) => id === selectedNodeId))
  const passes = run?.bodyRuns?.filter(({ parentNodeId }) => parentNodeId === selectedNodeId)
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
            <button type="button" disabled={busy} onClick={checkRun}>
              Check run
            </button>
          )}
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </header>
      {(refreshError || loadError) && (
        <p className="wf-run-error" role="alert">
          {refreshError || loadError}
        </p>
      )}
      {runError && !runError.nodeId && (
        <p className="wf-run-error" role="alert">
          {runError.code.replaceAll('_', ' ')}
        </p>
      )}
      {selected ? (
        <div className="wf-run-split">
          <ol className="wf-run-steps" aria-label="Workflow steps" ref={list}>
            {entries.map(({ nodeId, title, type, branch, tone }) => (
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
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <section className="wf-run-detail" aria-label="Step details" ref={details} tabIndex={0}>
            <div className="wf-run-detail-heading">
              <h3>{selected.title}</h3>
              <span data-tone={selected.tone}>{selected.branch}</span>
            </div>
            {selected.detail && <p>{selected.detail}</p>}
            {selected.callback && runUrl && (
              <CallbackUrl path={waitReleasePath(runUrl, selected.nodeId)} />
            )}
            {selectedRequest && (
              <HttpRequestDetails request={selectedRequest} configured={!selected.httpRequest} />
            )}
            {!!passes?.length && (
              <BodyRunDetails
                key={`${runId}:${selected.nodeId}`}
                passes={passes}
                documents={run?.bodyWorkflows ?? []}
                descriptors={descriptors}
              />
            )}
            {selected.output && (
              <StepOutput output={selected.output} http={selected.type === 'workflow:http'} />
            )}
          </section>
        </div>
      ) : (
        <p className="wf-run-empty">
          {!runId
            ? 'Run this workflow to see its steps.'
            : status === 'running'
              ? 'Waiting for the first step to finish…'
              : 'No steps recorded.'}
        </p>
      )}
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
  const [operation, setOperation] = useState<'save' | 'run' | 'release' | null>(null)
  const [error, setError] = useState('')
  const [run, setRun] = useState<WorkflowRun>()
  const [traceLogOpen, setTraceLogOpen] = useState(false)
  const traceLogId = useId()
  const traceLogButton = useRef<HTMLButtonElement>(null)
  const runStorageKey = `workflow-run:${url}`
  const [runId, setRunId] = useState(
    () => window.sessionStorage.getItem(runStorageKey) ?? undefined
  )
  const [releasePayload, setReleasePayload] = useState('{}')
  const runUrl = runId ? `${base}/runs/${encodeURIComponent(runId)}` : undefined
  const releaseUrl =
    runUrl && run?.status === 'waiting' && run.waiting
      ? waitReleasePath(runUrl, run.waiting.nodeId)
      : undefined
  const activeRun = run?.status === 'running' || run?.status === 'waiting'
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

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!runUrl || operation === 'run' || operation === 'release' || (run && !activeRun)) return
    const controller = new AbortController()
    let polling: ReturnType<typeof setTimeout> | undefined

    async function poll(): Promise<void> {
      if (!runUrl) return
      try {
        const latest = await requestJson<WorkflowRun>(request, runUrl, {
          signal: controller.signal
        })
        if (!controller.signal.aborted) setRun(latest)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof RequestError && error.status === 404) {
          window.sessionStorage.removeItem(runStorageKey)
          setRunId(undefined)
          return
        }
        polling = setTimeout(poll, 1000)
      }
    }

    if (run) polling = setTimeout(poll, 1000)
    else void poll()
    return () => {
      clearTimeout(polling)
      controller.abort()
    }
  }, [activeRun, operation, request, run, runStorageKey, runUrl])

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
        const previous = Object.hasOwn(value.layout, id)
          ? value.layout[id]
          : { x: index * 200, y: 0 }
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
    const id = createId()
    setRunId(id)
    window.sessionStorage.setItem(runStorageKey, id)
    setReleasePayload('{}')
    setRun(undefined)
    setOperation('run')
    setError('')
    try {
      setRun(
        await requestJson<WorkflowRun>(
          request,
          `${url}/runs`,
          send('POST', { revision: saved.revision, runId: id, input: runInput ?? {} })
        )
      )
    } catch (error) {
      setError(message(error))
    } finally {
      setOperation(null)
    }
  }

  async function refreshRun(): Promise<void> {
    if (!runUrl) return
    setOperation('run')
    setError('')
    try {
      setRun(await requestJson<WorkflowRun>(request, runUrl))
    } finally {
      setOperation(null)
    }
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
    if (!releaseUrl) return
    setOperation('release')
    setError('')
    try {
      setRun(await requestJson<WorkflowRun>(request, releaseUrl, send('POST', body)))
      setReleasePayload('{}')
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
        : 'Loading run…')
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

  const nodes = useMemo<Card[]>(
    () =>
      definition.nodes.map((node, index) => ({
        id: node.id,
        type: 'workflow',
        position:
          (Object.hasOwn(moving, node.id) ? moving[node.id] : undefined) ??
          (Object.hasOwn(definition.layout, node.id)
            ? definition.layout[node.id]
            : { x: index * 200, y: 0 }),
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
              !!operation || activeRun || runDisabled || dirty || !saved.revision || !!issues.length
            }
            onClick={execute}
          >
            <span aria-hidden="true" className="wf-action-icon">
              ▶
            </span>
            Run
          </button>
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
        {error ? (
          <p className="wf-toolbar-feedback" role="alert" title={error}>
            {error}
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
          className="wf-wait-panel"
          aria-label={waitingForInput ? 'Human input' : 'Wait for call'}
        >
          <CallbackUrl path={releaseUrl} />
          {waitingForInput ? (
            <HumanInputForm
              key={run.waiting.nodeId}
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
                  onChange={(event) => setReleasePayload(event.target.value)}
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
                        bodyPicker={{ base, request, workflowId: document.id, catalog }}
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
              {descriptor && (
                <NodeTest
                  key={selected.id}
                  node={selected}
                  descriptor={descriptor}
                  base={base}
                  request={request}
                  input={runInput}
                />
              )}
              {descriptor?.inputs?.map((field) => {
                const binding = Object.hasOwn(selected.bindings ?? {}, field.key)
                  ? selected.bindings?.[field.key]
                  : undefined
                const current = binding ? JSON.stringify([binding.nodeId, binding.field]) : ''
                const choices = definition.nodes.flatMap((node, index) => {
                  if (!sources.has(node.id)) return []
                  const source = descriptors.get(nodeKey(node.type, node.version))
                  return (source?.outputs ?? [])
                    .filter((output) => acceptsOutput(field, output))
                    .map((output) => ({
                      value: JSON.stringify([node.id, output.key]),
                      label: `${index + 1}. ${node.label || source?.label} · ${output.label}`,
                      binding: { nodeId: node.id, field: output.key }
                    }))
                })
                return (
                  <label className="wf-field" key={field.key}>
                    {field.label}
                    <select
                      value={current}
                      onChange={(event) => {
                        const choice = choices.find((item) => item.value === event.target.value)
                        const bindings = { ...selected.bindings }
                        if (choice)
                          Object.defineProperty(bindings, field.key, {
                            value: choice.binding,
                            enumerable: true,
                            configurable: true,
                            writable: true
                          })
                        else delete bindings[field.key]
                        updateNode(selected.id, { bindings })
                      }}
                    >
                      <option value="">Choose an output…</option>
                      {current && !choices.some((item) => item.value === current) && (
                        <option value={current}>Unavailable output</option>
                      )}
                      {choices.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </>
          )}
          {selection.edge && (
            <button
              type="button"
              className="wf-destructive"
              onClick={() => removeSelection([], [selection.edge!])}
            >
              Delete connection
            </button>
          )}
          {!selected && !selection.edge && <p>Select a node to edit its settings.</p>}
          {!!issues.length && (
            <details className="wf-issues">
              <summary>
                {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
              </summary>
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>
                    {formatIssue?.(issue) ??
                      `${issue.code.replaceAll('_', ' ')}${issue.field ? ` · ${issue.field}` : ''}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </aside>
      </div>

      {traceLogOpen && (
        <TraceLog
          id={traceLogId}
          runId={runId}
          runUrl={runUrl}
          run={run}
          status={runStatus}
          descriptors={descriptors}
          busy={!!operation}
          loadError={runId && !run ? error : undefined}
          onRefresh={refreshRun}
          onClose={closeTraceLog}
        />
      )}
    </div>
  )
}
