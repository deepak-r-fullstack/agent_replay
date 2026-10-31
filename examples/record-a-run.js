// Records one made-up "support agent" run with 5 steps, so you can see it arrive in AgentReplay.
// No AI key is needed: the steps are simulated.
//
//   1. npm run build -w sdk
//   2. In AgentReplay, open "Apps and keys", add an app, and copy its key.
//   3. AGENTREPLAY_API_KEY=ar_... AGENTREPLAY_URL=http://localhost:5050 node examples/record-a-run.js

const { init, startRun, flush } = require("@sritarak/agentreplay");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  init(); // reads AGENTREPLAY_API_KEY and AGENTREPLAY_URL

  const run = startRun({ name: "Customer asks for a refund", userRef: "customer-1042", tags: ["example", "refund"] });

  // 1. Look the order up (a retrieval step).
  const order = await run.trace(
    "retrieval",
    "find_order",
    async () => {
      await wait(40);
      return { orderId: "1042", item: "Blue kettle", paid: 2400 };
    },
    { input: { customer: "customer-1042" } }
  );

  // 2. Ask the AI what to say (an AI step, recorded by hand with its tokens and cost).
  run.step({
    type: "llm",
    name: "draft_answer",
    model: "example-model",
    input: `The customer asks for a refund for order ${order.orderId}. What do we say?`,
    output: `Your refund of ₹${order.paid} is on its way.`,
    tokens: 180,
    costUsd: 0.0004,
    durationMs: 650,
  });

  // 3. Pay the refund (a tool step).
  await run.trace("tool", "issue_refund", async () => {
    await wait(60);
    return { status: "refunded", amount: order.paid };
  }, { input: { orderId: order.orderId, amount: order.paid } });

  // 4. Write down what happened (a custom step).
  run.step({ type: "custom", name: "log_outcome", output: "Refund paid, customer told." });

  // 5. Email the customer. This one fails on purpose, so you can see a red step in the replay.
  await run
    .trace("tool", "send_email", async () => {
      await wait(30);
      throw new Error("Mail server did not answer");
    }, { input: { to: "customer@example.com" } })
    .catch(() => console.log("The email step failed (on purpose)."));

  run.end();
  await flush(); // sends everything now, so this short script does not exit first
  console.log("Done. Open AgentReplay to see the run:", run.id);
}

main();
