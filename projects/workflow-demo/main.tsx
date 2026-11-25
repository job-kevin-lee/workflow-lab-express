import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkflowEditor } from '@ideawithai/workflow-react'
import { createEmptyWorkflow, type WorkflowDocument } from '@ideawithai/workflow-express/schema'
import '@ideawithai/workflow-react/styles.css'
import { bodyExampleNames, exampleNames, examples } from './examples.js'
import {
  WorkflowDialog,
  WorkflowLibrary,
  type WorkflowDialogAction,
  type WorkflowGroup
} from './workflow-library.js'
import './demo.css'

const workflowGroups = [
  { label: 'Examples', items: exampleNames },
  { label: 'Reusable workflows', items: bodyExampleNames }
]
const workflowsUrl = '/api/workflow/workflows'
const selectionKey = 'workflow-demo:open'

class WorkflowRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    const messages: Record<string, string> = {
      revision_conflict: 'This workflow changed in another session. Refresh before trying again.',
      workflow_in_use: 'Another saved workflow uses this workflow as its Iteration or Loop body.',
      invalid_definition: 'Enter a workflow name of up to 160 characters.'
    }
    super(messages[code] ?? 'The workflow could not be changed. Try again.')
  }
}

async function workflowRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new Error('Could not reach Workflow Lab. Try again.')
  }
  if (!response.ok) {
    const data: { error?: string } = await response.json().catch(() => ({}))
    throw new WorkflowRequestError(response.status, data.error ?? '')
  }
  return response
}

function writeRequest(method: 'PUT' | 'DELETE', body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function workflowId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function libraryGroups(documents: WorkflowDocument[]): WorkflowGroup[] {
  const docs = new Map(documents.map((doc) => [doc.id, doc]))
  return [
    {
      label: 'My Workflows',
      items: documents
        .filter(({ id }) => !Object.hasOwn(examples, id))
        .map(({ id, definition }) => ({ id, label: definition.name }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    },
    ...workflowGroups.map(({ label, items }) => ({
      label,
      items: items.flatMap((item) => {
        const name = docs.get(item.id)?.definition.name
        if (!name) return []
        return [{ id: item.id, label: name === examples[item.id].name ? item.label : name }]
      })
    }))
  ]
}

function exportWorkflow({ definition }: WorkflowDocument): void {
  const file = URL.createObjectURL(
    new Blob([`${JSON.stringify(definition, null, 2)}\n`], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = file
  link.download = `${
    definition.name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/^[. ]+|[. ]+$/g, '') || 'workflow'
  }.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(file), 0)
}

function App(): ReactElement {
  const [workflow, setWorkflow] = useState<string>()
  const [documentTarget, setDocumentTarget] = useState<HTMLDivElement | null>(null)
  const [documents, setDocuments] = useState<WorkflowDocument[]>([])
  const [activeDocument, setActiveDocument] = useState<WorkflowDocument>()
  const [loading, setLoading] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [dialog, setDialog] = useState<WorkflowDialogAction>()
  const [dirty, setDirty] = useState(false)
  const [nextExample, setNextExample] = useState<string>()
  const current = activeDocument?.id === workflow ? activeDocument : undefined

  useEffect(() => {
    const controller = new AbortController()
    workflowRequest(workflowsUrl, { signal: controller.signal })
      .then(async (response) => {
        const list: WorkflowDocument[] = await response.json()
        if (controller.signal.aborted) return
        setDocuments(list)
        const previous = sessionStorage.getItem(selectionKey)
        setWorkflow(
          list.find(({ id }) => id === previous)?.id ??
            list.find(({ id }) => id === exampleNames[0].id)?.id ??
            list[0]?.id
        )
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setLibraryError('Could not load workflows.')
        setLoading(false)
      })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    if (workflow) sessionStorage.setItem(selectionKey, workflow)
  }, [workflow])

  const rememberDocument = useCallback((document: WorkflowDocument): void => {
    setDocuments((list) => [...list.filter(({ id }) => id !== document.id), document])
  }, [])

  const onLoaded = useCallback(
    (document: WorkflowDocument): void => {
      if (document.revision === 0) {
        setDocuments((list) => list.filter(({ id }) => id !== document.id))
        setWorkflow((id) => (id === document.id ? undefined : id))
        setLibraryError('This workflow has been deleted.')
        return
      }
      rememberDocument(document)
      setActiveDocument(document)
    },
    [rememberDocument]
  )

  const onSaved = useCallback(
    (document: WorkflowDocument): void => {
      rememberDocument(document)
      setActiveDocument((active) => (active?.id === document.id ? document : active))
    },
    [rememberDocument]
  )

  function selectWorkflow(id: string): void {
    if (id === workflow) return
    window.scrollTo({ top: 0 })
    if (dirty) setNextExample(id)
    else openWorkflow(id)
  }

  function openWorkflow(id: string | undefined): void {
    setDirty(false)
    setNextExample(undefined)
    setLibraryError('')
    setActiveDocument(undefined)
    setWorkflow(id)
    if (!id) sessionStorage.removeItem(selectionKey)
  }

  async function confirmWorkflowAction(name: string): Promise<void> {
    if (!dialog) return
    if (dialog.type === 'create') {
      const path = `${workflowsUrl}/${encodeURIComponent(dialog.id)}`
      let created: WorkflowDocument
      try {
        const response = await workflowRequest(
          path,
          writeRequest('PUT', { definition: createEmptyWorkflow(name), expectedRevision: 0 })
        )
        created = await response.json()
      } catch (error) {
        if (!(error instanceof WorkflowRequestError) || error.status !== 409) throw error
        const response = await workflowRequest(path)
        const existing: WorkflowDocument = await response.json()
        if (
          existing.revision !== 1 ||
          existing.definition.name !== name ||
          existing.definition.nodes.length
        )
          throw error
        created = existing
      }
      rememberDocument(created)
      selectWorkflow(created.id)
      return
    }

    const { id, revision } = dialog.document
    try {
      await workflowRequest(
        `${workflowsUrl}/${encodeURIComponent(id)}`,
        writeRequest('DELETE', { expectedRevision: revision })
      )
    } catch (error) {
      if (!(error instanceof WorkflowRequestError) || error.status !== 404) throw error
    }
    const remaining = documents.filter((doc) => doc.id !== id)
    setDocuments(remaining)
    openWorkflow(remaining.find((doc) => doc.id === exampleNames[0].id)?.id ?? remaining[0]?.id)
  }

  return (
    <main className="demo">
      <header className="demo-heading">
        <div className="demo-navigation">
          <h1>Workflow Lab</h1>
          <WorkflowLibrary
            workflow={workflow}
            groups={libraryGroups(documents)}
            onSelect={selectWorkflow}
          />
        </div>
        <div className="demo-workflow-document" ref={setDocumentTarget} />
        <div className="demo-document-actions" role="group" aria-label="Workflow actions">
          <button
            className="demo-primary"
            type="button"
            disabled={loading}
            onClick={() => setDialog({ type: 'create', id: workflowId() })}
          >
            New Workflow…
          </button>
          <button
            type="button"
            disabled={!current}
            onClick={() => current && exportWorkflow(current)}
          >
            {dirty ? 'Export Saved JSON' : 'Export JSON'}
          </button>
          <button
            className="demo-destructive"
            type="button"
            disabled={!current || dirty}
            title={dirty ? 'Save or undo your edits to delete this workflow.' : undefined}
            onClick={() => current && setDialog({ type: 'delete', document: current })}
          >
            Delete Workflow…
          </button>
        </div>
      </header>

      {nextExample && dirty && (
        <section className="demo-switch-warning" aria-label="Unsaved changes">
          <div role="alert">
            <strong>Unsaved changes</strong>
            <p>Save this workflow or discard your local edits before switching workflows.</p>
          </div>
          <button type="button" onClick={() => setNextExample(undefined)}>
            Stay here
          </button>
          <button type="button" onClick={() => openWorkflow(nextExample)}>
            Discard edits and switch
          </button>
        </section>
      )}
      {workflow ? (
        <WorkflowEditor
          apiBase="/api/workflow"
          workflowId={workflow}
          documentTarget={documentTarget}
          runInput={bodyExampleNames.find(({ id }) => id === workflow)?.input}
          onLoaded={onLoaded}
          onSaved={onSaved}
          onDirtyChange={setDirty}
        />
      ) : (
        <section className="demo-empty">
          <p role={libraryError ? 'alert' : 'status'}>
            {libraryError || (loading ? 'Loading workflows…' : 'No workflow open.')}
          </p>
          {libraryError && (
            <button
              type="button"
              onClick={() => {
                setLibraryError('')
                setLoading(true)
                setAttempt(attempt + 1)
              }}
            >
              Reload Workflows
            </button>
          )}
        </section>
      )}
      {dialog && (
        <WorkflowDialog
          action={dialog}
          onConfirm={confirmWorkflowAction}
          onClose={() => setDialog(undefined)}
        />
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
