# @sritarak/agentreplay

Record every step of an AI run and replay it in [AgentReplay](https://agentreplay.sritaraksolutions.in): see what your AI did and why, try a fix from any step, and turn a failure into a test.

```bash
npm install @sritarak/agentreplay
```

```ts
import { init, startRun } from "@sritarak/agentreplay";

init(); // reads AGENTREPLAY_API_KEY (and AGENTREPLAY_URL, if you host AgentReplay yourself)

const run = startRun({ name: "Support chat", userRef: "customer-1042" });

// Time any step and record its result. Your function's result and errors come back unchanged.
const order = await run.trace("retrieval", "find_order", () => findOrder(id), { input: { id } });

// Or record a step that already happened.
run.step({ type: "llm", name: "draft_answer", input: prompt, output: answer, model: "gpt-4o-mini", tokens: 180 });

run.end(); // "failed" if any step failed, otherwise "ok"
```

Get your key from **Apps and keys** in AgentReplay. Set it as `AGENTREPLAY_API_KEY`.

## Record OpenAI or Anthropic calls without changing your code

```ts
import { wrapOpenAI, wrapAnthropic } from "@sritarak/agentreplay";

const ai = wrapOpenAI(new OpenAI(), run, { price: { inputPerMillion: 0.15, outputPerMillion: 0.6 } });
const answer = await ai.chat.completions.create({ model: "gpt-4o-mini", messages }); // recorded as an AI step
```

The wrapped client returns the very same result, and throws the very same errors, as the original.
Streaming calls pass through and are not recorded in this version. `price` is optional; without it the cost shows as 0.

## Link a step to a record in another system

A step can point to a record somewhere else, for example the [AgentGuard](https://github.com/deepak-r-fullstack/agentguard) action the step caused. In AgentReplay the person replaying the run then gets a button to open it (and, for AgentGuard, a list of actions to undo there).

```ts
run.step({
  name: "issue_refund",
  externalRef: { system: "agentguard", id: action.id, url: `https://your-agentguard.example.com/activity/${action.id}` },
});

await run.trace("tool", "issue_refund", () => refund(order), {
  externalRef: { system: "agentguard", id: action.id, url: action.url },
});
```

- `system` is a lowercase name (`agentguard`, `stripe`, ...). `id` is that system's id for the record.
- `url` must be an `https://` link, at most 500 characters, with no password or key inside it. `http://localhost` links are accepted while `NODE_ENV` is not `production`.
- A link that breaks these rules is left out, and the step is still recorded. Nothing is thrown.

## It never gets in your way

- **Nothing waits for the network.** Steps go into a small queue and are sent in the background in batches.
- **Short timeouts, no retries storms.** A send gives up after 3 seconds. After 3 failures in a row it pauses for 30 seconds and drops what arrives meanwhile, so memory cannot pile up.
- **Failures are silent.** If AgentReplay is down or your key is wrong, your app carries on and recording quietly stops. Nothing is thrown and nothing is printed (unless you pass `debug: true`).
- **It never keeps your program alive.** Timers do not hold the process open. Before a short script or a serverless function ends, call `await flush()` to send what is waiting.
- **Zero dependencies.**

## Secrets are hidden before anything leaves your app

API keys, bearer tokens, passwords, emails and card numbers are replaced with `[secret hidden]`, `[email hidden]` and `[card hidden]`. The AgentReplay server hides them again. Every piece of text is cut at 32 KB, and a run keeps at most 1,000 steps.

## Options

```ts
init({
  apiKey: "ar_...",          // default: AGENTREPLAY_API_KEY
  baseUrl: "https://...",    // default: AGENTREPLAY_URL, then the hosted site
  enabled: true,             // false turns recording off without removing code
  flushIntervalMs: 2000,     // how often the background send runs
  timeoutMs: 3000,           // how long one send may take
  maxQueuedSteps: 5000,      // most steps kept in memory
  debug: false,              // print short problems (never your data)
});
```

Without a valid key, every call is a harmless no-op.

## License

MIT
