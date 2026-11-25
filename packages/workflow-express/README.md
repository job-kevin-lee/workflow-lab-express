# Workflow Express

Mount the router in an Express 5 project and register the project's nodes. Node definitions supply the editor's fields, data inputs, outputs, and connection ports. Node handlers implement the business action.

```ts
import express from 'express'
import {
  createMemoryWorkflowStore,
  createWorkflowRouter,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'

const nodes: WorkflowNodeRegistration[] = [
  {
    descriptor: {
      type: 'example:greet',
      version: 1,
      label: 'Greet',
      fields: [{ key: 'name', label: 'Name', type: 'string', required: true }],
      ports: []
    },
    execute: ({ config }) => ({ port: null, output: { message: `Hello, ${config.name}` } })
  }
]

const app = express()
app.use('/api/workflow', createWorkflowRouter({ nodes, store: createMemoryWorkflowStore() }))
```

Register each node type and version once. Use a new version when changing the meaning or shape of a node. Return a declared port to follow its connection. A terminal node declares zero ports and returns `null`. A required data input must bind to a required output of the same type on a node that runs on every path to the consumer. The initial field types are string, number and boolean. Custom node settings and execution payloads use JSON.

The application owns its route mount, authorization, and database. Provide a `WorkflowStore` with atomic compare-and-write for workflow revisions and atomic creation by run ID. Revision zero means the document does not yet exist. The memory adapter is intended for local testing. See the SQLite adapter in [the demo](../../projects/workflow-demo/server.ts).

| Method | Relative path         | Request                             |
| ------ | --------------------- | ----------------------------------- |
| GET    | `/node-types`         | Fetch serializable node definitions |
| GET    | `/workflows`          | List saved documents                |
| GET    | `/workflows/:id`      | Fetch the current document          |
| PUT    | `/workflows/:id`      | `{ definition, expectedRevision }`  |
| DELETE | `/workflows/:id`      | `{ expectedRevision }`              |
| POST   | `/workflows/:id/runs` | `{ revision, input, runId }`        |
| GET    | `/runs/:id`           | Fetch the run and its results       |

Save stores the current definition directly, including incomplete graphs. Run validates the saved revision and records a snapshot before it calls a handler. A stale revision returns HTTP 409. Invalid graphs return HTTP 422 with structured issues. Submit a stable run ID to query or repeat the same request without starting the same run twice. Duplicate starts return the existing record, which may still be running.

Use `PUT` with revision `0` and a new ID to create a workflow. `createEmptyWorkflow(name)` produces an empty definition. `DELETE` returns HTTP 204 and retains existing run snapshots. A missing workflow returns HTTP 404. A stale revision or a saved Iteration/Loop reference blocks deletion with HTTP 409. Adapters that implement optional `remove` must atomically compare the revision, evaluate the reference predicate against other saved documents, and retire the ID. In the same transaction boundary, `write` must verify that the provided body workflow IDs exist before it writes. This prevents a concurrent save from linking to a deleted workflow.

Each active execution segment uses the router's `runTimeoutMs` budget (30 seconds by default), including any timed Wait in that segment. Node handlers receive an `AbortSignal` and should pass it to dependencies. The timeout is cooperative.

Entering **Wait for Call** stores the waiting node and completed steps and returns HTTP 202. This pause does not consume the active execution budget. Send `POST /runs/:id/waits/:nodeId/release` relative to the router mount. The router requires no callback token or body. The release advances the saved graph from the waiting node and exposes the JSON object body as its `payload` output, or `{}` if the body is omitted. A release for an inactive wait returns HTTP 409. If the continuation reaches another wait, it returns HTTP 202 again.

For a persistent store, implement optional `claimWaitingRun(next, nodeId)` as an atomic comparison of the stored `waiting` status and waiting node, followed by replacement with `next`. The in-memory store and demo SQLite adapter support this operation. Preserve waiting runs across reboot and reconcile abandoned `running` records separately. Runtime effects from an interrupted active segment require host reconciliation.

Browser code can import the JSON contract and validation from `@ideawithai/workflow-express/schema`.

## Reusable HTTP nodes

Register `createHttpRequestNode({ origin, request })` to reuse the same node for different HTTP actions. Each instance configures a method, URL or path, headers, optional JSON body, and an optional boolean success field in the response. It returns HTTP status and response body. Run steps also record the resolved URL, method, and headers set by the node, with credential header values masked. The configured origin limits the targets and redirects are rejected. Supply a server-side fetch wrapper for application credentials.

Use `logicNode` (If / Else) to compare fields of a bound JSON value with typed operators and AND/OR conditions. Chain If / Else nodes for additional branches. `humanInputNode` pauses for a text, number, or boolean value. Send `{ "value": ... }` to the same release URL used by Wait for Call. The submitted object becomes `payload`. Invalid input leaves the run waiting.

`iterationNode` runs a saved body workflow for each item in an array, up to 100 items, with `item` and zero-based `index` in its input. It returns the terminal outputs in input order. `loopNode` provides the zero-based `index` and `previous` terminal output (`null` on the first pass). It evaluates all stop conditions against the latest terminal output after each pass. It follows **Limit reached** when the configured maximum is exhausted with unmet conditions. With an empty condition list it runs exactly the configured count and follows **Done**.

Bodies use `inputNode` to read input values. They can branch and use timed waits. They must finish within the parent's active execution segment, with a shared timeout across all passes. Nested Iteration/Loop and callback or human pauses inside bodies are unsupported. A body failure stops the parent node. Body revisions are captured when the parent starts and retained across parent pauses. Runs store each pass's steps and errors under `bodyRuns`. A custom node that can asynchronously pause should declare `pausesRun: true` in its descriptor.

The `waitNode` handles a fixed delay, `waitForCallNode` creates a resumable checkpoint, and `resultNode` displays a final message and optional bound data. The [workflow lab](../../projects/workflow-demo/README.md) demonstrates these nodes.

A node test uses the registered handler with the submitted settings and sample inputs. It returns the output and duration without advancing the graph or creating a workflow run. A test executes real external calls and uses the router's timeout. A waiting result previews the wait message without creating a callback URL.

An input can declare a `description` and an `example`. Use the description for domain-specific details such as the properties of an object. The example is the value for that input key and must match the declared field type. The node catalog publishes both values so the editor can show the hint and prefill a test payload.
