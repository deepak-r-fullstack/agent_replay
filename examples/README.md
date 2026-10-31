# Examples

## `record-a-run.js`

Records a 5-step run (a lookup, an AI answer, a tool call, a note, and one step that fails on purpose).
It needs no AI key.

```bash
npm install
npm run build -w sdk
AGENTREPLAY_API_KEY=ar_your_key AGENTREPLAY_URL=http://localhost:5050 node examples/record-a-run.js
```

Get the key from **Apps and keys** in AgentReplay (the key is shown once when you add the app).
