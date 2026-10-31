# AgentReplay

Record every step of an AI run, replay it on a timeline, fork any step with a changed prompt or model, and save a failed run as a test in one click.

> Work in progress, built in six small milestones. Sister project of [AgentGuard](https://github.com/deepak-r-fullstack/agentguard).

| Milestone | What | Status |
| --- | --- | --- |
| 1 | Foundation: sign-up, sign-in, apps and SDK keys, CI | done |
| 2 | SDK and ingest | in review |
| 3 | Runs list and replay screens | next |
| 4 | Fork and re-run | |
| 5 | Tests and suites | |
| 6 | Demo data, docs, deploy | |

## Milestone 3 checklist (runs list and replay screens)

- Runs list with filters and paging; replay timeline with step details; failed steps in red.
- **Show "Unfinished" for stuck runs.** A run that is still "running" but has had no update for 1 hour is shown as "Unfinished" (a plain-words badge with a tooltip: "This run never reported that it finished. The app may have stopped."), in the list, the filters and the replay header. It is worked out when the page is shown; nothing in the database changes. If the run finishes later, it simply shows its real status again.

## Milestone 6 checklist (demo, docs, deploy)

- Seed data that tells the refund story (wrong amount, fork at step 3, fixed, save as test).
- README screenshots and the 3-minute demo script, `render.yaml`, SDK ready to publish.
- **Protect the shared demo workspace.** Every demo visitor shares one workspace, so one visitor can change what the next one sees. Plan a regular demo reset, or protect the seeded items: seeded apps cannot be revoked or rotated, and some app slots stay free so visitors can always add one.
- **Reset the demo's storage counters with its clean-up.** The demo workspace's all-time storage counter (`storage_usage`, day `total`) only goes up. When old demo runs are deleted, lower or reset that counter too, or the demo will stop accepting new steps after about 20 days of full use.

## What is in the repo

```
sdk/      the "agentreplay" npm package (no runtime dependencies)
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

The run is saved on the server now; the screens that show it arrive in milestone 3. See [`sdk/README.md`](sdk/README.md) for how to use the SDK in your own app.

## Checks

```bash
npm run typecheck   # SDK, server and client
npm test            # server tests use an in-memory MongoDB (downloaded on first run)
npm run build
```

## License

MIT
