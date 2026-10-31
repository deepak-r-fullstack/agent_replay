# AgentReplay

Record every step of an AI run, replay it on a timeline, fork any step with a changed prompt or model, and save a failed run as a test in one click.

Live demo: https://agentreplay.sritaraksolutions.in (press **Try the demo**, no sign-up). Sister project of [AgentGuard](https://github.com/deepak-r-fullstack/agentguard), which keeps AI agents on a leash and lets you undo what they did.

![The runs list in the demo](docs/screenshots/runs.png)

## The story the demo tells

A support bot is asked for a refund for order 1042 (₹2,400). It looks up the wrong order (1041, ₹1,800), refunds that, and emails the customer. Nothing crashed, so nothing looked wrong.

1. **Replay** shows each step. The lookup returned order 1041, so every step after it is wrong.
2. **Fork** that step with the right order data. Only the AI step is asked again. Tools are simulated, so nothing real happens.
3. **Compare** the original and the fork side by side. The wrong amount is marked.
4. **Save as test** keeps the fixed answer as a check ("must mention ₹2,400, must not mention ₹1,800").
5. **Undo** the wrong refund in [AgentGuard](https://agentguard.sritaraksolutions.in). AgentReplay never undoes anything itself; it only links to the matching action.

![Replaying the wrong refund step](docs/screenshots/replay-wrong-refund.png)
![The original and the fork, side by side](docs/screenshots/fork-compare.png)
![Saved tests, all passing](docs/screenshots/tests.png)

> These screenshots are the real website screens filled with the demo story's data. They were taken on a computer with no database, so a stand-in answered the website's requests. Retake them on the live site when you like.

## A 3-minute demo script

| Time | Say | Do |
| --- | --- | --- |
| 0:00 | "AI agents make quiet mistakes. Here is one." | Open the site, press **Try the demo**. Point at the blue note: the demo resets every hour. |
| 0:25 | "Every job the bot did is recorded." | On **Runs**, open **Refund request, order 1042**. |
| 0:50 | "Step 1 looked up order 1041, but the customer asked about 1042." | Click step 1 (**find_order**), then step 2 (**draft_answer**). Show the question the AI was given. |
| 1:20 | "I can fix that one step and try again, safely." | Click **Fork from this step**, change the order data to 1042 and ₹2,400, press **Start the fork**. |
| 1:50 | "Only the AI was asked again. The refund tool did not run." | On the compare screen, show the green "Tools are simulated" note and the marked words (1,800 turned into 2,400). |
| 2:15 | "And I never want this to break again." | Press **Save as test**, choose the two suggested checks, save. |
| 2:35 | "Now I can run every test whenever I change the model." | Open **Tests**, press **Run all tests**. Then pick the model **demo-fast** and run again: one test turns red ("Got worse"). |
| 2:50 | "The wrong refund itself is undone in AgentGuard." | On the compare screen press **Open in AgentGuard to undo**. |

## How this compares

AgentReplay is small on purpose. Other tools cover a lot more (tracing at large scale, evaluation datasets, scoring, dashboards, prompt management), and you may well need them. This is what AgentReplay does differently:

| | AgentReplay | Tracing and evaluation platforms |
| --- | --- | --- |
| Who it is for | People who are not engineers: plain words, one hint per screen | Mostly engineering teams |
| Forking a run | A fork re-asks only AI steps; tools and lookups **never** run | Re-running a step usually means re-running your own code or a playground |
| Undoing what an agent did | Links to the matching action in AgentGuard; never undoes by itself | Not their job |
| Trying it | A free demo that needs no AI key (a scripted model) | Usually a sign-up and keys |
| Cost to run | One free web service and a free database; hard storage and AI-use limits | Hosted plans, or a bigger system to run yourself |

Compare it with [LangSmith](https://www.langchain.com/langsmith), [Langfuse](https://langfuse.com), [Braintrust](https://www.braintrust.dev) and Retrace. Their features change often, so check their own sites rather than trusting this table for them.

## Works with AgentGuard

[AgentGuard](https://github.com/deepak-r-fullstack/agentguard) decides what an AI agent is allowed to do and keeps a record that can be undone. AgentReplay shows how the agent got there. When an agent's tool call goes through AgentGuard, pass its action id to AgentReplay with the SDK's `externalRef`:

```js
run.step({
  name: "issue_refund",
  input: { orderId: "1041" },
  externalRef: { system: "agentguard", id: action.id, url: `https://your-agentguard.example.com/activity?action=${action.id}` },
});
```

The compare screen then lists these steps under **Undo the original actions**, each with a button that opens the action in AgentGuard in a new tab. AgentReplay never calls AgentGuard's undo, so only someone with permission there can approve it.

The demo's wrong refund links to a fixed action id in AgentGuard's demo. AgentGuard's demo needs one small addition for that link to open something: see [`docs/agentguard-demo-link.md`](docs/agentguard-demo-link.md).

## What is in the repo

```
sdk/      the "@sritarak/agentreplay" npm package (no runtime dependencies)
examples/ small scripts that use the SDK
server/   Node 22 + Express + MongoDB API
client/   React + Vite + Tailwind website
```

## Run it on your computer

You need Node 22 and a MongoDB (a free Atlas cluster, or one running locally).

```bash
npm install
cp server/env/local.env.example server/env/local.env   # then set MONGO_URI and JWT_SECRET
npm run dev
```

Open http://localhost:5173. Click **Try the demo**, or **Create account**.

## Record your first run

1. In AgentReplay, open **Apps and keys**, add an app and copy its key (it is shown once).
2. Build the SDK and run the example (it needs no AI key):

```bash
npm run build -w sdk
AGENTREPLAY_API_KEY=ar_your_key AGENTREPLAY_URL=http://localhost:5050 node examples/record-a-run.js
```

Open **Runs** in AgentReplay to see it: click the run to replay it step by step. See [`sdk/README.md`](sdk/README.md) for how to use the SDK in your own app.

## Put it on the internet (free)

The whole site is one free Render web service plus a free Atlas database. `render.yaml` describes the service.

1. **Atlas database user.** In MongoDB Atlas (cluster in Mumbai), open **Database Access** > **Add New Database User**. Choose a username and a long password, and give it **Read and write to any database**. Under **Network Access**, allow `0.0.0.0/0` (Render's free service has no fixed address). Open **Connect** > **Drivers** and copy the connection string. Put the database name `agentreplay` before the `?`, for example `mongodb+srv://USER:PASSWORD@cluster.mongodb.net/agentreplay?retryWrites=true&w=majority`.
2. **Render Blueprint.** In Render choose **New +** > **Blueprint**, pick this repository, and press **Apply**. When asked for `MONGO_URI`, paste the connection string from step 1. Leave `LLM_API_KEY` empty. The other settings are already filled in: `LLM_PROVIDER=demo` means the whole site works with no paid AI key.
3. **Check it.** When the deploy finishes, open the `onrender.com` address Render shows. Press **Try the demo**. You should see six runs and two tests. The free service sleeps when nobody visits, so the first visit after a while takes about a minute.
4. **Your own address (Hostinger).** In Render open the service > **Settings** > **Custom Domains** > **Add Custom Domain** and type `agentreplay.sritaraksolutions.in`. Render shows a target such as `agentreplay.onrender.com`. In Hostinger open **Domains** > `sritaraksolutions.in` > **DNS / Nameservers** and add a record: type `CNAME`, name `agentreplay`, target the address Render showed, TTL as offered. Back in Render press **Verify**. The padlock (HTTPS) appears by itself after a few minutes.
5. **The npm package** `@sritarak/agentreplay` is already published; nothing to do there unless you change `sdk/`.

Good to know:

- The demo workspace starts again from its story every hour. On a sleeping free service the reset also happens when the first visitor arrives after an hour.
- Storage is limited: 20 MB a day and 100 MB in total per workspace (5 MB a day for the demo) and **250 MB across everyone**, because the free Atlas cluster is shared with AgentGuard. Each run counts 1 KB on top of its steps. Counted bytes are a little less than what Atlas really uses (indexes and overhead), so the limits keep a safe margin. A daily clean-up works out each total again from the real data.
- Using a paid AI model later is optional: set `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` and `LLM_ALLOWED_MODELS` in Render. The demo workspace always keeps using the free scripted model.

## Checks

```bash
npm run typecheck   # SDK, server and client
npm test            # server tests use an in-memory MongoDB (downloaded on first run)
npm run build
```

## License

MIT
