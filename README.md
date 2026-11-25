# Workflow Lab Express

Embed a visual workflow editor and a workflow runtime in your own app. Mount the Express router, render the React editor, and register your project's nodes. A node descriptor defines its Inspector fields, input types, outputs, and branches. The runtime validates and executes the saved JSON workflow.

## Use the packages in your project

| Package                                                 | Provides                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Workflow Express](packages/workflow-express/README.md) | Router, workflow validation and execution, and the store and node contracts |
| [Workflow React](packages/workflow-react/README.md)     | Canvas, inspector, single-node testing, and Trace Log                       |

The Express package runs on Node.js 22 or later with Express 5. The editor uses React 19 and `react-dom` 19. To install the packages in another project, clone and pack them with Bun 1.4 or later.

```sh
git clone https://github.com/job-kevin-lee/workflow-lab-express.git
cd workflow-lab-express
bun run pack:packages
```

The pack command installs locked dependencies and builds in a temporary workspace, then writes the versioned tarballs to `.packs/`. Install the runtime in your Express project. Replace the example paths with your clone's location.

```sh
npm install /path/to/workflow-lab-express/.packs/ideawithai-workflow-express-0.1.0.tgz express@5
```

Install both tarballs together in the React project so the editor can resolve the browser-safe workflow schema from the matching Express package.

```sh
npm install /path/to/workflow-lab-express/.packs/ideawithai-workflow-express-0.1.0.tgz /path/to/workflow-lab-express/.packs/ideawithai-workflow-react-0.1.0.tgz react@19 react-dom@19
```

Mount the API in your Express app.

```ts
import express from 'express'
import {
  builtinWorkflowNodes,
  createMemoryWorkflowStore,
  createWorkflowRouter
} from '@ideawithai/workflow-express'

const app = express()

app.use(
  '/api/workflow',
  createWorkflowRouter({
    store: createMemoryWorkflowStore(),
    nodes: builtinWorkflowNodes
  })
)

app.listen(3000, '127.0.0.1')
```

Use the same API path from your React app. Serve the API on the same origin or configure your frontend dev server to proxy that path.

```tsx
import { WorkflowEditor } from '@ideawithai/workflow-react'
import '@ideawithai/workflow-react/styles.css'

export function App() {
  return <WorkflowEditor apiBase="/api/workflow" workflowId="hello" />
}
```

Add a **Result** node, enter its message, then click **Save** and **Run**. The memory store is useful for a first integration. For persistence, implement the [WorkflowStore contract](packages/workflow-express/README.md) against your host database. The [demo server](projects/workflow-demo/server.ts) includes a SQLite adapter. The host application owns access control when it exposes the API.

### Add a custom node

Create a `WorkflowNodeRegistration` with a `descriptor` and an `execute` function. Mount the router with `nodes: [...builtinWorkflowNodes, customNode]`. The editor uses the descriptor to render fields, data bindings, branches, and sample inputs. Start with the [minimal custom node](packages/workflow-express/README.md) or see the [Stock Check implementation](projects/workflow-demo/stock-check-node.ts) for a node with typed inputs and two branches.

## Run the demo

Install [Bun](https://bun.com/) 1.4 or later and run:

```sh
git clone https://github.com/job-kevin-lee/workflow-lab-express.git
cd workflow-lab-express
bun install --frozen-lockfile
bun run build
bun run start
```

Open [http://127.0.0.1:4175](http://127.0.0.1:4175). The demo creates a local SQLite database and seeds its example workflows on first start. Set `PORT` to use a different port or `WORKFLOW_DEMO_DB` to choose a different database file.

### Play Guess a number

1. Open **Workflows → Games → Guess a number** and click **Run**.
2. Enter a guess from 1 to 100, then click **Submit input**.
3. Follow the higher or lower hint in the function bar. A correct guess wins, including on attempt ten. Ten misses reveal the answer and end the run.
4. Open **Trace Log** and choose the Loop step to inspect each completed pass. The active guess resumes at the same pass after a reload.

The **Games** group also includes **Lantern Crossing** for player decisions, **Beacon Relay** for callback-driven rounds, and **Comet Cargo** for inspecting a cargo manifest. [See how to play each game](projects/workflow-demo/README.md#games).

### Build a workflow

1. Click **New Workflow** and enter a name.
2. Add nodes from the library. The first node becomes Start. You can select a different root and click **Set as start**.
3. Select a node to configure it in the Inspector. Connect each output port to its next step and use the binding picker to choose a compatible upstream field or JSON path.
4. Click **Auto Arrange** to organize the canvas. Select a connection to insert a node between its existing endpoints. Both edits support **Undo**.
5. **Save** and **Run** the workflow once, then select a bound node and click **Use last run values** to try its settings against real data in **Test Node**.
6. Open **Trace Log** to select or filter earlier runs and inspect the input, output, and active execution time for a step.

Try **Examples → Read a supplier quote** to see primary and backup HTTP branches feed the same Template node. Select **Use branch outputs** on a downstream input to configure this in your own graph.

Use **Test Workflow…** in the demo to run the current draft with sample node outputs. The test trace identifies fixture steps. [Try a supplier test](projects/workflow-demo/README.md#test-a-workflow-with-fixtures) or [enable workflow tests in your app](packages/workflow-express/README.md#test-a-workflow-with-fixtures).

Use **Export JSON** to download a portable bundle of the saved workflow and any referenced bodies. **Import JSON** previews missing node registrations and saves a new copy with fresh IDs. The importer also accepts standalone definition JSON.

Open **Triggers** to enable an interval schedule or copy a webhook URL. Each trigger starts a run from the same saved Start. [See the demo examples and trigger commands](projects/workflow-demo/README.md).

## Checks

The package smoke test uses Node.js 22.12 or later, npm, and Bun. It installs the runtime and editor in separate npm projects, runs a custom node on Express, and builds the React editor with its CSS.

```sh
bun run build
bun run typecheck
bun run test
bun run smoke:packages
```

Pass the two tarball paths to `bun run smoke:packages` to test existing archives. This validates the exact files you plan to distribute, including the source and declaration maps that support Go to Definition in TypeScript editors.
