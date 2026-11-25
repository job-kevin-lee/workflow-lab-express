import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  isId,
  isJsonObject,
  nodeKey,
  type JsonObject,
  type NodeDescriptor,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowRun,
  type WorkflowTestFixture
} from '@ideawithai/workflow-express/schema'

interface FixtureDraft extends Omit<WorkflowTestFixture, 'output'> {
  workflowId: string
  label: string
  output: string
}

const fixtureKey = (workflowId: string, nodeId: string): string =>
  JSON.stringify([workflowId, nodeId])

function jsonObject(text: string, label: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!isJsonObject(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed
}

export function WorkflowTestDialog({
  id,
  open,
  workflowId,
  definition,
  descriptors,
  defaultInput,
  loadBody,
  onRun,
  renderSteps,
  onClose
}: {
  id: string
  open: boolean
  workflowId: string
  definition: WorkflowDefinition
  descriptors: ReadonlyMap<string, NodeDescriptor>
  defaultInput?: JsonObject
  loadBody: (id: string, signal: AbortSignal) => Promise<WorkflowDocument>
  onRun: (
    input: JsonObject,
    fixtures: WorkflowTestFixture[],
    signal: AbortSignal
  ) => Promise<WorkflowRun>
  renderSteps: (run: WorkflowRun) => ReactNode
  onClose: () => void
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const pending = useRef<AbortController>(null)
  const [inputDraft, setInputDraft] = useState<string>()
  const [fixtures, setFixtures] = useState<Record<string, FixtureDraft>>({})
  const [test, setTest] = useState<{
    definition: WorkflowDefinition
    result?: WorkflowRun
    error?: string
  }>()
  const [busy, setBusy] = useState(false)
  const [bodies, setBodies] = useState<{
    ids: string[]
    documents: WorkflowDocument[]
    unavailable: string[]
  }>()
  const input = inputDraft ?? JSON.stringify(defaultInput ?? {}, null, 2)
  const currentTest = test?.definition === definition ? test : undefined
  const result = currentTest?.result
  const error = currentTest?.error
  const status = busy ? 'running' : result?.status
  const nodes = definition.nodes
  const bodyIds = useMemo(
    () => [
      ...new Set(
        nodes.flatMap((node) =>
          (descriptors.get(nodeKey(node.type, node.version))?.fields ?? []).flatMap((field) => {
            const id = node.config[field.key]
            return field.type === 'workflow' && isId(id) && id !== workflowId ? [id] : []
          })
        )
      )
    ],
    [nodes, descriptors, workflowId]
  )
  const loadedBodies = bodies?.ids === bodyIds ? bodies : undefined
  const loadingBodies = !!bodyIds.length && !loadedBodies
  const groups = [
    { id: workflowId, label: 'Current draft', nodes },
    ...(loadedBodies?.documents ?? []).map(({ id, definition }) => ({
      id,
      label: definition.name,
      nodes: definition.nodes
    }))
  ].map(({ id, label, nodes }) => ({
    id,
    label,
    options: nodes.flatMap((node) => {
      const descriptor = descriptors.get(nodeKey(node.type, node.version))
      if (!descriptor) return []
      const name = node.label || descriptor.label
      return [
        {
          key: fixtureKey(id, node.id),
          nodeId: node.id,
          workflowId: id,
          name,
          label: id === workflowId ? name : `${label} · ${name}`,
          descriptor
        }
      ]
    })
  }))
  const fixtureNodes = new Map(
    groups.flatMap((group) => group.options.map((node) => [node.key, node] as const))
  )
  const available = groups.filter(({ options }) => options.some(({ key }) => !fixtures[key]))

  useEffect(() => {
    if (!open || !bodyIds.length) {
      setBodies(undefined)
      return
    }
    const controller = new AbortController()
    void Promise.allSettled(bodyIds.map((id) => loadBody(id, controller.signal))).then(
      (results) => {
        if (controller.signal.aborted) return
        setBodies({
          ids: bodyIds,
          documents: results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : []
          ),
          unavailable: bodyIds.filter((_, index) => results[index].status === 'rejected')
        })
      }
    )
    return () => controller.abort()
  }, [open, bodyIds, loadBody])

  useEffect(() => {
    const element = dialog.current
    if (!open || !element || element.open) return
    element.showModal()
    heading.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => () => pending.current?.abort(), [])

  function addFixture(key: string): void {
    const node = fixtureNodes.get(key)
    if (!node) return
    setFixtures((current) => {
      if (current[key]) return current
      return {
        ...current,
        [key]: {
          nodeId: node.nodeId,
          workflowId: node.workflowId,
          label: node.label,
          port: node.descriptor.ports[0]?.id ?? null,
          output: '{}'
        }
      }
    })
  }

  function editFixture(key: string, change: Partial<Pick<FixtureDraft, 'port' | 'output'>>): void {
    setFixtures((current) => ({ ...current, [key]: { ...current[key], ...change } }))
  }

  function removeFixture(key: string): void {
    setFixtures((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (pending.current || loadingBodies) return
    setTest(undefined)
    const controller = new AbortController()
    try {
      const payload = jsonObject(input, 'Workflow input')
      const samples = Object.entries(fixtures).map(([key, fixture]) => {
        const { nodeId, port, output, workflowId: scope, label } = fixture
        const node = fixtureNodes.get(key)
        if (!node) throw new Error(`Remove the fixture for ${label} or restore its workflow node.`)
        const { ports } = node.descriptor
        if (port === null ? ports.length : !ports.some(({ id }) => id === port)) {
          throw new Error(`Choose an output port for ${node.label}.`)
        }
        return {
          ...(scope !== workflowId && { workflowId: scope }),
          nodeId,
          port,
          output: jsonObject(output, `Output for ${node.label}`)
        }
      })
      pending.current = controller
      setBusy(true)
      const run = await onRun(payload, samples, controller.signal)
      if (!controller.signal.aborted) setTest({ definition, result: run })
    } catch (failure) {
      if (!controller.signal.aborted) {
        setTest({
          definition,
          error: failure instanceof Error ? failure.message : 'Could not run the workflow test.'
        })
      }
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <dialog
      id={id}
      ref={dialog}
      className="wf-trace wf-workflow-test"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="wf-run-toolbar">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          Test Workflow
        </h2>
        {status && (
          <span className="wf-run-status" data-status={status} role="status">
            {status === 'running' ? 'Testing…' : status[0].toUpperCase() + status.slice(1)}
          </span>
        )}
        {result && (
          <span className="wf-run-count">
            {result.steps.length} {result.steps.length === 1 ? 'step' : 'steps'} recorded
          </span>
        )}
        <div className="wf-run-actions">
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </header>
      <div className="wf-workflow-test-content">
        <form
          className="wf-workflow-test-settings"
          aria-label="Workflow test settings"
          onSubmit={submit}
        >
          <p>Test the current draft. Add fixtures for waits and nodes that need to be simulated.</p>
          <label className="wf-field">
            Workflow input (JSON)
            <textarea
              rows={4}
              value={input}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setInputDraft(event.currentTarget.value)}
            />
          </label>
          <section aria-labelledby={`${id}-fixtures`} className="wf-workflow-test-fixtures">
            <h3 id={`${id}-fixtures`}>Node fixtures</h3>
            <p>A fixture supplies a node’s output and chooses its branch.</p>
            {loadingBodies && <p role="status">Loading saved body workflows…</p>}
            {!!loadedBodies?.unavailable.length && (
              <p className="wf-run-error" role="alert">
                Could not load saved body workflows · {loadedBodies.unavailable.join(', ')}
              </p>
            )}
            <label className="wf-field">
              Add node fixture
              <select
                value=""
                disabled={busy || !available.length}
                onChange={(event) => addFixture(event.currentTarget.value)}
              >
                <option value="" disabled>
                  {available.length ? 'Choose a node…' : 'No nodes available'}
                </option>
                {available.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {group.options
                      .filter(({ key }) => !fixtures[key])
                      .map(({ key, name, nodeId }) => (
                        <option value={key} key={key}>
                          {name}
                          {group.options.some(
                            (option) => option.name === name && option.key !== key
                          ) && ` · ${nodeId}`}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {Object.entries(fixtures).map(([key, { label, port, output }], index) => {
              const node = fixtureNodes.get(key)
              const ports = node?.descriptor.ports ?? []
              const fields = node?.descriptor.outputs ?? []
              const fieldsId = `${id}-fields-${index}`
              return (
                <fieldset className="wf-workflow-test-fixture" key={key} disabled={busy}>
                  <legend>{node?.label ?? label}</legend>
                  {!node && !loadingBodies && <p>This workflow node is unavailable.</p>}
                  <label className="wf-field">
                    Output port
                    <select
                      value={port ?? ''}
                      disabled={!node || !ports.length}
                      onChange={(event) => editFixture(key, { port: event.currentTarget.value })}
                    >
                      {!ports.length && <option value="">Terminal</option>}
                      {!!ports.length && !ports.some(({ id }) => id === port) && (
                        <option value={port ?? ''} disabled>
                          Choose a port…
                        </option>
                      )}
                      {ports.map(({ id, label }) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wf-field">
                    Sample output (JSON)
                    <textarea
                      aria-describedby={fields.length ? fieldsId : undefined}
                      rows={3}
                      value={output}
                      spellCheck={false}
                      onChange={(event) => editFixture(key, { output: event.currentTarget.value })}
                    />
                  </label>
                  {!!fields.length && (
                    <p id={fieldsId}>
                      {fields
                        .map(
                          ({ key, type, required }) =>
                            `${key} (${type}${required ? ', required' : ''})`
                        )
                        .join(', ')}
                    </p>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove fixture for ${node?.label ?? label}`}
                    onClick={() => removeFixture(key)}
                  >
                    Remove
                  </button>
                </fieldset>
              )
            })}
          </section>
          <button className="wf-primary" type="submit" disabled={busy || loadingBodies}>
            Run Test
          </button>
          {error && (
            <p className="wf-run-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <section className="wf-workflow-test-results" aria-label="Test results">
          {result ? (
            renderSteps(result)
          ) : (
            <p className="wf-run-empty">
              {busy ? 'Running test…' : 'Run a test to see its steps.'}
            </p>
          )}
        </section>
      </div>
    </dialog>
  )
}
