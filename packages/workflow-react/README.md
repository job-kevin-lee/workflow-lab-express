# Workflow React

Mount the editor with your Workflow Express route and a workflow ID. It loads the workflow and node catalog, manages the canvas, saves edits, and runs the saved workflow.

```tsx
import { WorkflowEditor } from '@ideawithai/workflow-react'
import '@ideawithai/workflow-react/styles.css'

export function OrderWorkflow() {
  return <WorkflowEditor apiBase="/api/workflow" workflowId="orders" />
}
```

The editor starts with an empty graph when the ID has no saved document. Add nodes from the palette, connect their handles, select a node to edit its configuration or bind its inputs, and save. Run becomes available after a valid graph has been saved. A conflicting save preserves the local changes.

Optionally pass `request` to use an existing fetch wrapper, `onLoaded` and `onSaved` to receive the document shown in the editor, or `renderConfig` to render a custom settings panel for a node. The editor defaults to a macOS-style light appearance. Theme it with the `--wf-*` CSS variables, or set `--wf-color-scheme: light dark` on its container to follow the system appearance.

Run status and messages appear in the editor toolbar. Pass a `documentTarget` DOM element to place the editable workflow name and save state in your app header. Pass `null` while the header ref is mounting. Omit the prop to keep those controls in the editor toolbar.

Open **Trace Log** next to **Run** in the toolbar. Select a step in the dialog to inspect its branch, output, HTTP request and response, or callback URL. Close the dialog with **Close** or Escape to return to the canvas.

When a run reaches Wait for Call, the editor shows the POST URL and accepts a JSON object from the operator. It also polls for releases submitted by another client and restores the latest run in the same browser tab after reload. Logic configuration shows condition rows and the AND/OR selector.

The palette groups built-in If / Else, Human Input, Iteration and Loop under **Logic** when the service registers them. Hosts can group custom nodes using a descriptor's `category`. Select a previously saved body workflow in the inspector for Iteration or Loop. **Workflow Input** reads that body's `item`, `index`, or `previous`. In **Trace Log**, select the Iteration or Loop step and expand **Body passes** to inspect each body's steps. When Human Input pauses, the editor renders the configured field and submits a typed value to the waiting run.

Select any node and click **Test Node** in its inspector. When the node accepts upstream data, the inspector lists the JSON keys, types, and required fields. **Sample inputs (JSON)** starts with the examples supplied by the node, where available. Edit the payload or click **Reset example** to restore it. A test uses the current editor settings and leaves the workflow document and run history alone. HTTP tests show the response status, body, and elapsed time.
