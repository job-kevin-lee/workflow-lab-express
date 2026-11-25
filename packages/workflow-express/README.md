# Workflow Express

Mount the router in an Express 5 project running Node.js 22 or later, or in Bun. Node definitions supply the editor's fields, data inputs, outputs, and connection ports. Node handlers implement the business action.

```ts
import express from 'express'
import {
  builtinWorkflowNodes,
  createMemoryWorkflowStore,
  createWorkflowRouter,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'

const greet: WorkflowNodeRegistration = {
  descriptor: {
    type: 'example:greet',
    version: 1,
    label: 'Greet',
    fields: [{ key: 'name', label: 'Name', type: 'string', required: true }],
    ports: []
  },
  execute: ({ config }) => ({ port: null, output: { message: `Hello, ${config.name}` } })
}

const app = express()
app.use(
  '/api/workflow',
  createWorkflowRouter({
    nodes: [...builtinWorkflowNodes, greet],
    store: createMemoryWorkflowStore()
  })
)
```

Start with `builtinWorkflowNodes` or import individual registrations to control the available palette. Register `createHttpRequestNode` separately with an origin configured by the host. Register each node type and version once. Use a new version when changing the meaning or shape of a node. Return a declared port to follow its connection. A terminal node declares zero ports and returns `null`. A required data input must bind to a compatible required output on a node that runs on every path to the consumer. A binding can include a JSON property path as an array of keys and indices, such as `{ nodeId: 'fetch', field: 'body', path: ['items', '0', 'quantity'] }`. The engine validates the resolved value against the input type before invoking the handler. Custom node settings and execution payloads use JSON.

For existing definitions that use `workflow:condition`, keep registering `conditionNode` alongside the preset.

### Bind outputs from exclusive branches

Connect the success paths of two or more exclusive branches to one downstream node. Bind its input to the output from each branch. The engine checks that exactly one candidate runs on every path that reaches the consumer and that each candidate declares a compatible required output. The value from that source goes to the downstream handler, including `null` for JSON inputs. A missing nested field fails the run at that input.

```ts
import type { WorkflowInputBinding } from '@ideawithai/workflow-express/schema'

const quote: WorkflowInputBinding = {
  branches: [
    { nodeId: 'primary', field: 'body' },
    { nodeId: 'backup', field: 'body' }
  ]
}
```

Set the consumer's `bindings.value` to this binding. Direct bindings retain their existing JSON shape. TypeScript callers that inspect a binding can use `'branches' in binding` to distinguish the two shapes. To open a definition with branch bindings, use matching versions of the Express and React packages that support them.

The application owns its route mount, authorization, and database. Provide a `WorkflowStore` with atomic compare-and-write for workflow revisions and atomic creation by run ID. Revision zero means the document does not yet exist. The memory adapter is intended for local testing. See the SQLite adapter in [the demo](../../projects/workflow-demo/server.ts).

| Method | Relative path         | Request                                          |
| ------ | --------------------- | ------------------------------------------------ |
| GET    | `/node-types`         | Fetch serializable node definitions              |
| GET    | `/workflows`          | List saved documents                             |
| GET    | `/workflows/:id`      | Fetch the current document                       |
| PUT    | `/workflows/:id`      | `{ definition, expectedRevision }`               |
| DELETE | `/workflows/:id`      | `{ expectedRevision }`                           |
| POST   | `/workflows/:id/runs` | `{ revision, input, runId }`                     |
| GET    | `/workflows/:id/runs` | Optional `status`, `limit`, and `offset` filters |
| GET    | `/runs/:id`           | Fetch the run and its results                    |

Save stores the current definition directly, including incomplete graphs. Run validates the saved revision and records a snapshot before it calls a handler. A stale revision returns HTTP 409. Invalid graphs return HTTP 422 with structured issues. Submit a stable run ID to query or repeat the same request without starting the same run twice. Duplicate starts return the existing record, which may still be running.

A host that configures triggers can check a saved definition with `validateWorkflow(definition, catalog)` before enabling them. Then call `loadWorkflowBodies(definition.nodes, catalog, getWorkflow, workflowId)` to check referenced bodies using the same rules as Run.

Implement optional `WorkflowStore.listRuns` to enable run history. This endpoint returns run summaries, newest first, with a default page size of 20 and maximum of 100. Detailed traces fetched by run ID include bound inputs and the active execution duration. A suspended step's duration excludes time spent waiting for a person or callback.

Use `PUT` with revision `0` and a new ID to create a workflow. `createEmptyWorkflow(name)` produces an empty definition. `DELETE` returns HTTP 204 and retains existing run snapshots. A missing workflow returns HTTP 404. A stale revision or a saved Iteration/Loop reference blocks deletion with HTTP 409. Adapters that implement optional `remove` must atomically compare the revision, evaluate the reference predicate against other saved documents, and retire the ID. In the same transaction boundary, `write` must verify that the provided body workflow IDs exist before it writes. This prevents a concurrent save from linking to a deleted workflow.

Each active execution segment uses the router's `runTimeoutMs` budget (30 seconds by default), including any timed Wait in that segment. Node handlers receive an `AbortSignal` and should pass it to dependencies. The timeout is cooperative.

Entering **Wait for Call** stores the waiting node and completed steps and returns HTTP 202. This pause does not consume the active execution budget. Send `POST /runs/:id/waits/:waitId/release` relative to the router mount. Use `waiting.id ?? waiting.nodeId` as the path key. The router requires no callback token or body. The release advances the saved graph from the waiting node and exposes the JSON object body as its `payload` output, or `{}` if the body is omitted. A release for an inactive wait returns HTTP 409. If the continuation reaches another wait, it returns HTTP 202 again.

For a persistent store, implement optional `claimWaitingRun(next, waitId)` as an atomic comparison of the stored `waiting` status and `waiting.id ?? waiting.nodeId`, followed by replacement with `next`. The in-memory store and demo SQLite adapter support this operation. Preserve waiting runs across reboot and reconcile abandoned `running` records separately. Runtime effects from an interrupted active segment require host reconciliation.

Browser code can import the JSON contract and validation from `@ideawithai/workflow-express/schema`.

## Reusable HTTP nodes

Register `createHttpRequestNode({ origin, request })` to reuse the same node for different HTTP actions. Each instance configures a method, headers, optional JSON body, and an optional boolean success field in the response. Supply a URL or relative path in the Inspector, or bind the `url` input to an upstream string. A bound URL takes precedence. The Inspector also allows bindings for `query` and `body`. A query object replaces the named parameters on the resolved URL, with arrays repeating the parameter and `null` removing it. For example, `{ sku: 'A-01', include: ['stock', 'location'] }` sends both `include` values and preserves other configured parameters.

The node returns HTTP status and response body. Run steps record the resolved URL, method, and headers set by the node, with credential header values masked. The configured origins limit the targets and redirects are rejected. Supply a server-side fetch wrapper for application credentials.

Use `logicNode` (If / Else) to compare fields of a bound JSON value with typed operators and AND/OR conditions. Chain If / Else nodes for additional branches. `humanInputNode` pauses for a text, number, or boolean value. Send `{ "value": ... }` to the same release URL used by Wait for Call. The submitted object becomes `payload`. Bind its optional `prompt` input to compose a message from upstream data. Invalid input leaves the run waiting.

`iterationNode` runs a saved body workflow for each item in an array, up to 100 items, with `item` and zero-based `index` in its input. It returns the terminal outputs in input order. `loopNode` provides the zero-based `index` and `previous` terminal output (`null` on the first pass). It evaluates all stop conditions against the latest terminal output after each pass. It follows **Limit reached** when the configured maximum is exhausted with unmet conditions. With an empty condition list it runs exactly the configured count and follows **Done**.

Bodies use `inputNode` to read input values. Loop bodies can suspend at a Human Input or Wait for Call node. A checkpoint keeps the current pass, prior result, and the captured body revision. Each wait has its own callback ID. Releasing it grants a fresh active execution time budget. Iteration bodies complete in the active segment, and both container types use a single level of body workflows. Completed passes are stored in `bodyRuns`, and the current paused pass is stored in `loopCheckpoint`. A custom node that can pause declares `pausesRun: true` in its descriptor.

The `waitNode` handles a fixed delay, `waitForCallNode` creates a resumable checkpoint, and `resultNode` displays a final message and optional bound data. The [workflow lab](../../projects/workflow-demo/README.md) demonstrates these nodes.

A node test uses the registered handler with the submitted settings and sample inputs. It returns the output and duration without advancing the graph or creating a workflow run. A test executes real external calls and uses the router's timeout. A waiting result previews the wait message without creating a callback URL.

For automated tests, mount your node registrations with `createMemoryWorkflowStore()` on a test app. Inject a fixture response into the HTTP registration so you can exercise the same graph with predictable data.

```ts
const inventory = createHttpRequestNode({
  origin: 'https://inventory.example',
  request: async (url) => {
    if (url.pathname !== '/items/A-01') return new Response(null, { status: 404 })
    return Response.json({ sku: 'A-01', quantity: 7 })
  }
})
```

Register `inventory` in place of the live HTTP node when building the test router. You can assert the final result and inspect `run.steps` to verify the branch, request path, and bound inputs.

An input can declare a `description` and an `example`. Use the description for domain-specific details such as the properties of an object. The example is the value for that input key and must match the declared field type. The node catalog publishes both values so the editor can show the hint and prefill a test payload.

## Data transformation

Register `templateNode` to interpolate bound JSON into text with `{{name}}` or `{{items[0].sku}}`. Register `mapJsonNode` to build an object using an output-key-to-path mapping, for example `{"sku":"items[0].sku"}`. Both accept `.` for the entire input, preserve JSON scalar types when mapping, and report missing paths as node failures. Result accepts an optional upstream `message` string.

Node handlers can throw `WorkflowNodeError(code, message)` to record a user-facing failure reason in the trace and node test. Use a message appropriate for the workflow operator.

## Test a workflow with fixtures

Set `enableWorkflowTests: true` on `createWorkflowRouter` to expose `POST /workflows/:id/test`. Send the draft `definition`, a JSON object `input`, and a `fixtures` array. The route validates the draft and referenced saved bodies, then uses the normal engine to execute the selected path. It accepts an unsaved workflow ID. The response is a `WorkflowRun` with revision `0` and `fixture: true` on substituted steps. Tests do not save the draft, create run history, or expose a callback.

```ts
import type { WorkflowTestFixture } from '@ideawithai/workflow-express/schema'

const fixtures: WorkflowTestFixture[] = [
  {
    nodeId: 'fetch',
    port: 'ok',
    output: { status: 200, body: { sku: 'A-01', quantity: 7 } }
  }
]
```

Use a declared port for each fixture, or `null` for a terminal node. The object must meet the node's declared output fields. Omit `workflowId` for a node in the draft. Set it to a saved body workflow ID to apply that fixture on every pass through the body.

Logic, input, transformation, and result nodes can execute directly during a test, as can Loop and Iteration. HTTP Request, Wait, Wait for Call, Human Input, and custom nodes require a fixture when reached unless their registration explicitly sets `testSafe: true`. Use this setting for deterministic handlers with no external effects. For a Human Input fixture, use the `submitted` port and an output such as `{ payload: { value: false } }`.

Structural request errors return HTTP 400, and invalid graphs or fixtures return 422. A valid test request returns 200 with the test's `status`. Check `run.error` and `run.bodyRuns` for failures. A step that needs a fixture reports `test_fixture_required`.
