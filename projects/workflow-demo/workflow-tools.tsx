import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { isJsonObject } from '@ideawithai/workflow-express/schema'
import type { WorkflowImportResult } from './workflow-sharing.js'
import type { TriggerSettings, TriggerStatus } from './workflow-triggers.js'

type DemoRequest = (path: string, init?: RequestInit) => Promise<Response>

function EditDialog({
  title,
  busy,
  onClose,
  children
}: {
  title: string
  busy: boolean
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    const returnFocus = document.activeElement
    element?.showModal()
    return () => {
      element?.close()
      if (returnFocus instanceof HTMLElement) returnFocus.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialog}
      className="demo-dialog demo-tool-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={id}>{title}</h2>
      {children}
    </dialog>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach Workflow Lab.'
}

function jsonRequest(method: 'PUT' | 'POST', body: string): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body }
}

export function ImportWorkflowDialog({
  request,
  onImported,
  onClose
}: {
  request: DemoRequest
  onImported: (result: WorkflowImportResult) => void
  onClose: () => void
}): ReactElement {
  const [file, setFile] = useState<{ json: string; name: string; workflowCount: number }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function preview(input?: File): Promise<void> {
    setFile(undefined)
    setError('')
    if (!input) return
    if (input.size > 2 * 1024 * 1024) {
      setError('The file exceeds the 2 MB limit.')
      return
    }
    setBusy(true)
    try {
      const json = await input.text()
      const response = await request('/api/demo/import/preview', jsonRequest('POST', json))
      const data: { name: string; workflowCount: number } = await response.json()
      setFile({ json, ...data })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function submit(): Promise<void> {
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await request('/api/demo/import', jsonRequest('POST', file.json))
      const result: WorkflowImportResult = await response.json()
      onImported(result)
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }

  return (
    <EditDialog title="Import Workflow JSON" busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label>
          Workflow JSON file
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => void preview(event.currentTarget.files?.[0])}
          />
        </label>
        {file && (
          <p role="status">
            <strong>{file.name}</strong> · {file.workflowCount}{' '}
            {file.workflowCount === 1 ? 'workflow' : 'workflows'} ready to import.
          </p>
        )}
        {error && (
          <p className="demo-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="demo-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="demo-primary" disabled={busy || !file}>
            {busy ? 'Checking…' : 'Import'}
          </button>
        </div>
      </form>
    </EditDialog>
  )
}

export function WorkflowTriggersDialog({
  workflowId,
  name,
  request,
  onClose
}: {
  workflowId: string
  name: string
  request: DemoRequest
  onClose: () => void
}): ReactElement {
  const path = `/api/demo/workflows/${encodeURIComponent(workflowId)}`
  const [settings, setSettings] = useState<TriggerStatus>()
  const [interval, setIntervalSeconds] = useState('60')
  const [schedule, setSchedule] = useState(false)
  const [webhook, setWebhook] = useState(false)
  const [payload, setPayload] = useState('{}')
  const [pending, setPending] = useState<'save' | 'test'>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    request(`${path}/triggers`, { signal: controller.signal })
      .then(async (response) => {
        const data: TriggerStatus = await response.json()
        if (controller.signal.aborted) return
        setSettings(data)
        setSchedule(data.scheduleSeconds !== null)
        setIntervalSeconds(String(data.scheduleSeconds ?? 60))
        setWebhook(data.webhookEnabled)
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure))
      })
    return () => controller.abort()
  }, [path, request])

  useEffect(() => {
    if (!settings?.scheduleSeconds || pending) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      void request(`${path}/triggers`, { signal: controller.signal })
        .then(async (response) => {
          const next: TriggerStatus = await response.json()
          if (!controller.signal.aborted) setSettings(next)
        })
        .catch(() => undefined)
    }, 2000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [path, pending, request, settings?.scheduleSeconds])

  async function save(): Promise<void> {
    if (pending) return
    const configuration: TriggerSettings = {
      scheduleSeconds: schedule ? Number(interval) : null,
      webhookEnabled: webhook
    }
    setPending('save')
    setError('')
    setNotice('')
    try {
      const response = await request(
        `${path}/triggers`,
        jsonRequest('PUT', JSON.stringify(configuration))
      )
      setSettings(await response.json())
      setNotice('Triggers saved.')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  async function sendTest(): Promise<void> {
    if (pending) return
    setPending('test')
    setError('')
    setNotice('')
    try {
      let input: unknown
      try {
        input = JSON.parse(payload)
      } catch {
        throw new Error('Enter a valid JSON object for the test payload.')
      }
      if (!isJsonObject(input)) throw new Error('Enter a JSON object for the test payload.')
      const response = await request(`${path}/webhook`, {
        ...jsonRequest('POST', JSON.stringify(input)),
        headers: {
          'Content-Type': 'application/json',
          'X-Workflow-Event-Id': Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('')
        }
      })
      const run: { id: string; status: string } = await response.json()
      setNotice(`Test run ${run.status}. Open Trace Log to see it in run history.`)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <EditDialog title="Workflow Triggers" busy={!!pending} onClose={onClose}>
      <p className="demo-trigger-description">
        <strong>{name}</strong> · Triggers start a new run from the saved workflow.
      </p>
      {!settings && !error && <p role="status">Loading triggers…</p>}
      {settings && (
        <>
          <form
            className="demo-trigger-settings"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <label className="demo-trigger-check">
              <input
                type="checkbox"
                checked={schedule}
                disabled={!!pending}
                onChange={(event) => setSchedule(event.currentTarget.checked)}
              />
              Run on a schedule
            </label>
            {schedule && (
              <label>
                Interval in seconds
                <input
                  type="number"
                  value={interval}
                  min={1}
                  max={86400}
                  required
                  disabled={!!pending}
                  onChange={(event) => setIntervalSeconds(event.currentTarget.value)}
                />
              </label>
            )}
            {settings.scheduleSeconds !== null && settings.lastSchedule && (
              <p role={settings.lastSchedule.error ? 'alert' : 'status'}>
                Last scheduled run · {new Date(settings.lastSchedule.at).toLocaleTimeString()}
                {settings.lastSchedule.error ? ` · ${settings.lastSchedule.error}` : ''}
              </p>
            )}
            <label className="demo-trigger-check">
              <input
                type="checkbox"
                checked={webhook}
                disabled={!!pending}
                onChange={(event) => setWebhook(event.currentTarget.checked)}
              />
              Enable webhook
            </label>
            <button type="submit" className="demo-primary" disabled={!!pending}>
              {pending === 'save' ? 'Saving…' : 'Save triggers'}
            </button>
          </form>
          {settings.webhookEnabled && (
            <section className="demo-trigger-webhook" aria-label="Webhook">
              <label>
                Webhook URL
                <input
                  readOnly
                  value={new URL(`${path}/webhook`, window.location.origin).href}
                  onClick={(event) => event.currentTarget.select()}
                />
              </label>
              <p>
                Send a POST with a unique <code>X-Workflow-Event-Id</code> header and a JSON object.
              </p>
              <label>
                Test payload
                <textarea
                  rows={2}
                  value={payload}
                  disabled={!!pending}
                  onChange={(event) => setPayload(event.currentTarget.value)}
                />
              </label>
              <button type="button" disabled={!!pending} onClick={() => void sendTest()}>
                {pending === 'test' ? 'Sending…' : 'Send test event'}
              </button>
            </section>
          )}
        </>
      )}
      {error && (
        <p className="demo-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="demo-dialog-actions">
        <button type="button" disabled={!!pending} onClick={onClose}>
          Close
        </button>
      </div>
    </EditDialog>
  )
}
