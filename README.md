# Workflow Lab

Build and run workflows in a visual editor. Workflow Lab includes an Express workflow engine, a React canvas, and a SQLite-backed demo. Create a workflow with one Start, connect nodes, configure inputs and branches, and inspect each step in Trace Log.

## Quick start

Install [Bun](https://bun.com/) 1.4 or later and run:

```sh
git clone https://github.com/job-kevin-lee/workflow-lab.git
cd workflow-lab
bun install --frozen-lockfile
bun run build
bun run start
```

Open [http://127.0.0.1:4175](http://127.0.0.1:4175). The demo creates a local SQLite database and seeds its example workflows on first start. Set `PORT` to use a different port or `WORKFLOW_DEMO_DB` to choose a different database file.

### Play Guess a number

1. Open **Workflows → Examples → Guess a number** and click **Run**.
2. Enter a guess from 1 to 100, then click **Submit input**.
3. Follow the higher or lower hint in the function bar. A correct guess wins, including on attempt ten. Ten misses reveal the answer and end the run.
4. Open **Trace Log** to inspect the inputs and results. Reloading the page in the same tab restores the latest run.

### Build a workflow

1. Click **New Workflow** and enter a name.
2. Add nodes from the library. The first node becomes Start. You can select a different root and click **Set as start**.
3. Select a node to configure it in the Inspector. Connect each output port to its next step. Bind data from earlier steps where needed.
4. Click **Test Node** to try one node with sample inputs, or **Save** and **Run** to execute the whole workflow.
5. Use **Export JSON** to download the saved graph. A destination project needs the matching registrations for any custom node types in the graph.

Other examples cover HTTP requests, callback waits, human input, iteration, loops, and a custom Stock Check. [See the demo examples](projects/workflow-demo/README.md).

## Use the packages in your project

| Package                                                 | Provides                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Workflow Express](packages/workflow-express/README.md) | Router, workflow validation and execution, and the store and node contracts |
| [Workflow React](packages/workflow-react/README.md)     | Canvas, inspector, single-node testing, and Trace Log                       |

The packages are built from this source repository. To install them into a separate project, build and pack both workspaces from the repository root.

```sh
bun run build
mkdir -p .packs
(cd packages/workflow-express && bun pm pack --destination ../../.packs)
(cd packages/workflow-react && bun pm pack --destination ../../.packs)
```

In your npm project, install both tarballs in the same command. Replace the example path with your clone's location.

```sh
npm install /path/to/workflow-lab/.packs/ideawithai-workflow-express-0.1.0.tgz /path/to/workflow-lab/.packs/ideawithai-workflow-react-0.1.0.tgz express@5 react@19 react-dom@19
```

Mount the API in your Express app.

```ts
import express from 'express'
import {
  createMemoryWorkflowStore,
  createWorkflowRouter,
  resultNode
} from '@ideawithai/workflow-express'

const app = express()

app.use(
  '/api/workflow',
  createWorkflowRouter({
    store: createMemoryWorkflowStore(),
    nodes: [resultNode]
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

Add a **Result** node, enter its message, then click **Save** and **Run**. The memory store is useful for a first integration. The [demo server](projects/workflow-demo/server.ts) shows a persistent SQLite adapter. The demo binds to localhost by default. The host application owns access control when it exposes the API.

### Add a custom node

Create a `WorkflowNodeRegistration` with a `descriptor` and an `execute` function, then add it to the router's `nodes` array. The editor uses the descriptor to render fields, data bindings, branches, and sample inputs. See the [Stock Check implementation](projects/workflow-demo/stock-check-node.ts) and [its registration](projects/workflow-demo/nodes.ts).

## Checks

```sh
bun run build
bun run typecheck
bun run test
```
