import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { WorkflowDocument } from '@ideawithai/workflow-express/schema'

export type WorkflowGroup = { label: string; items: readonly { id: string; label: string }[] }

export function WorkflowLibrary({
  workflow,
  groups,
  onSelect
}: {
  workflow?: string
  groups: WorkflowGroup[]
  onSelect: (id: string) => void
}): ReactElement {
  const library = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  function choose(id: string): void {
    library.current?.hidePopover()
    trigger.current?.focus()
    onSelect(id)
  }

  return (
    <>
      <button
        type="button"
        className="demo-library-trigger"
        popoverTarget="demo-workflow-library"
        ref={trigger}
      >
        Workflows
        <span className="demo-chevron" aria-hidden="true" />
      </button>
      <nav
        id="demo-workflow-library"
        className="demo-library"
        aria-label="Workflow library"
        popover="auto"
        ref={library}
      >
        {groups.map(
          ({ label, items }) =>
            items.length > 0 && (
              <section className="demo-library-group" key={label} aria-label={label}>
                <h2>{label}</h2>
                {items.map(({ id, label }) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={workflow === id ? 'true' : undefined}
                    onClick={() => choose(id)}
                  >
                    <span>{label}</span>
                    {workflow === id && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </section>
            )
        )}
      </nav>
    </>
  )
}

export type WorkflowDialogAction =
  { type: 'create'; id: string } | { type: 'delete'; document: WorkflowDocument }

export function WorkflowDialog({
  action,
  onConfirm,
  onClose
}: {
  action: WorkflowDialogAction
  onConfirm: (name: string) => Promise<void>
  onClose: () => void
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const focus = useRef<HTMLElement | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const creating = action.type === 'create'

  useEffect(() => {
    const element = dialog.current
    const returnFocus = document.activeElement
    element?.showModal()
    focus.current?.focus()
    return () => {
      element?.close()
      if (returnFocus instanceof HTMLElement) returnFocus.focus()
    }
  }, [])

  async function confirm(): Promise<void> {
    if (busy || (creating && !name.trim())) return
    setBusy(true)
    setError('')
    try {
      await onConfirm(name.trim())
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The workflow could not be changed.')
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="demo-dialog"
      aria-labelledby="demo-workflow-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void confirm()
        }}
      >
        <h2 id="demo-workflow-dialog-title">{creating ? 'New Workflow' : 'Delete Workflow'}</h2>
        {creating ? (
          <label>
            Name
            <input
              ref={(element) => {
                focus.current = element
              }}
              value={name}
              maxLength={160}
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : (
          <p>
            Delete <strong>{action.document.definition.name}</strong>? Existing runs keep their
            saved snapshots.
          </p>
        )}
        {error && (
          <p className="demo-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="demo-dialog-actions">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            ref={
              creating
                ? undefined
                : (element) => {
                    focus.current = element
                  }
            }
          >
            Cancel
          </button>
          <button
            type="submit"
            className={creating ? 'demo-primary' : 'demo-destructive'}
            disabled={busy || (creating && !name.trim())}
          >
            {creating ? (busy ? 'Creating…' : 'Create') : busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
