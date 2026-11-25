# Workflow Lab demo

Follow the [quick start](../../README.md#quick-start) from the repository root. Use the app header to select a workflow, rename it, export the saved JSON, or delete it. Save graph changes from the function bar.

| Example                   | Expected behavior                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Guess a number            | Enter a guess from 1 to 100. Follow the higher or lower hint, with up to ten attempts.          |
| Ready data                | Wait three seconds, read local JSON, evaluate two conditions, and wait for a callback.          |
| Unmatched data            | Read a different local response and take the Else branch.                                       |
| Live GitHub data          | Fetch public Express repository metadata and check its name and archived flag.                  |
| Human input               | Enter a stock count and inspect the submitted number in Trace Log.                              |
| Iteration                 | Fetch three sample inventory items and run a reusable body for each item.                       |
| Loop                      | Repeat a reusable body until the third pass. Lower the maximum to see the Limit reached branch. |
| Stock check (custom node) | Fetch inventory and compare quantities with a configurable minimum.                             |

The **Reusable workflows** group contains the saved bodies used by Iteration and Loop. A run keeps the workflow revision it started with. **Trace Log** shows the steps, outputs, requests, and callback URLs for the latest run in the tab.

## Test a custom node

Open **Stock check (custom node)** and select **Stock Check**. The Inspector explains the `items` input and includes an editable JSON example. With **Minimum quantity** set to `3`, click **Test Node** to see **Low stock** for `B-07`. With the minimum set to `2`, the same input takes **In stock**.

## Release a waiting workflow

Click **Send callback** in the editor, or copy the **Callback URL · POST** from the editor or Trace Log and send a POST.

```sh
curl -X POST '<callback-url>' -H 'Content-Type: application/json' -d '{"ready":true}'
```

The callback payload becomes available to the next step. A callback with no body submits an empty object. A Human Input step expects its configured value in `{"value": ...}`.
