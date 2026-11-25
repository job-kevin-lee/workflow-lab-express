# Workflow Lab demo

Follow [Run the demo](../../README.md#run-the-demo) from the repository root. Use the app header to select a workflow, rename it, export the saved JSON, or delete it. Use **Import JSON…** to preview and create a copy from a saved bundle. Save graph changes from the function bar.

| Example                   | Expected behavior                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Ready data                | Wait three seconds, read local JSON, evaluate two conditions, and wait for a callback.          |
| Unmatched data            | Read a different local response and take the Else branch.                                       |
| Live GitHub data          | Fetch public Express repository metadata and check its name and archived flag.                  |
| Human input               | Enter a stock count and inspect the submitted number in Trace Log.                              |
| Iteration                 | Fetch three sample inventory items and run a reusable body for each item.                       |
| Loop                      | Repeat a reusable body until the third pass. Lower the maximum to see the Limit reached branch. |
| Map JSON and Template     | Rename fields from a local HTTP response and render an inventory note.                          |
| Stock check (custom node) | Fetch inventory and compare quantities with a configurable minimum.                             |
| Look up an inventory item | Enter a SKU and map it to the HTTP Request query. Try `B-07` or an unknown SKU.                 |
| Read a supplier quote     | Choose the primary or backup supplier. Both paths feed the same Template node.                  |

The **Reusable workflows** group contains the saved bodies used by Iteration and Loop. A run keeps the workflow revision it started with. **Trace Log** shows the steps, inputs, outputs, durations, requests, and callback URLs for the chosen run. **Guess a number** uses one reusable body containing a dynamic Human Input and a check. The active pass survives a reload or server restart.

## Games

Choose a game under **Workflows → Games**, then click **Run**. The three new games use only built-in workflow nodes.

| Game             | How to play                                                                                                                                                                                                                | What to inspect in Trace Log                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guess a number   | Enter a number from 1 to 100. Follow the higher or lower hint for up to ten attempts.                                                                                                                                      | The Loop pass records the prompt, guess, and result.                                                                                                        |
| Lantern Crossing | Enter `bridge` or `tunnel`, then choose **Yes** to relight your lantern. Replay with an unmarked route or choose **No** to see the alternate endings.                                                                      | Text and boolean inputs, OR branching, a nested boolean binding, and a one-second Wait on the winning route.                                                |
| Beacon Relay     | Paste `{"frequency":42,"locked":true}` into **Callback payload**, then click **Send callback**. Try a mismatch first or send three mismatches to reach the limit. You can also POST directly to that round’s callback URL. | Each pass waits on a separate callback. The Loop ends on the first match or after three signals.                                                            |
| Comet Cargo      | Run an automatic inspection of four cargo pods. A pod must be sealed and weigh at most 12 kg to launch.                                                                                                                    | The HTTP request, renamed JSON fields, the ordered Iteration results, and the Template summary. Lumen and Halley clear inspection. Orbit and Nova are held. |

## Test a custom node

Open **Stock check (custom node)** and select **Stock Check**. The Inspector explains the `items` input and includes an editable JSON example. Run the example first to collect the inventory response. With **Stock Check** selected, click **Use last run values** to fill the sample from the bound HTTP response. At minimum quantity `3`, **Test Node** displays **Low stock** for `B-07`. At `2`, the same input takes **In stock**.

## Test a workflow with fixtures

Open **Read a supplier quote**, then click **Test Workflow…**. Add these two fixtures.

| Node              | Output port | Sample output                                                                       |
| ----------------- | ----------- | ----------------------------------------------------------------------------------- |
| Choose a supplier | Submitted   | `{"payload":{"value":false}}`                                                       |
| Backup quote      | Success     | `{"status":200,"body":{"supplier":"Fixture supplier","price":42,"currency":"USD"}}` |

Click **Run Test**. The trace shows the two fixture steps and the shared Template returns “Fixture supplier quotes 42 USD.” Change the sample price and test again. The dialog shows the latest test trace.

To test a saved body, open **Beacon Relay**. In the fixture picker, choose **Receive a beacon signal** under **Beacon Relay · One signal**. Select **Call received** and enter `{"payload":{"frequency":42,"locked":true}}` to finish after one pass. Change the frequency to `41` to exercise all three passes and the limit branch.

## Release a waiting workflow

Click **Send callback** in the editor, or copy the **Callback URL · POST** from the editor or Trace Log and send a POST.

```sh
curl -X POST '<callback-url>' -H 'Content-Type: application/json' -d '{"ready":true}'
```

The callback payload becomes available to the next step. A callback with no body submits an empty object. A Human Input step expects its configured value in `{"value": ...}`.

## Schedule and webhook

Trigger setup checks the saved workflow and any Iteration or Loop body before enabling it. If a later edit makes one of those definitions invalid, the trigger rejects the run with the usual workflow validation error.

Open **Triggers…** for the saved workflow. Enable **Run on a schedule**, enter an interval in seconds, and click **Save triggers**. The demo starts new runs at that interval while it is running. Schedule settings persist beside the SQLite database. Disabling the schedule stops future ticks. Intervals missed while the server is offline are skipped.

Enable **Webhook** in the same dialog, then copy the URL or use the test controls. Send a JSON object as the workflow input and provide an event ID. Resending the same event ID and payload retrieves the original run. A changed payload with the same event ID produces a conflict.

```sh
curl -X POST '<webhook-url>' -H 'Content-Type: application/json' -H 'X-Workflow-Event-Id: stock-2026-11-25' -d '{"sku":"A-01"}'
```

Use **Trace Log → Run history** to find triggered runs. The callback URL for a waiting run resumes that run. The webhook URL starts a separate run through the saved Start.
