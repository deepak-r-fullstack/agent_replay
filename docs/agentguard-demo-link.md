# Linking the AgentReplay demo to AgentGuard's demo

In AgentReplay's demo, the wrong refund step has a link: **Open in AgentGuard to undo**. It opens

```
https://agentguard.sritaraksolutions.in/activity?action=65a11e0000000000000b1041
```

AgentGuard already understands `/activity?action=<id>` (and sends people back to it after sign-in), but its demo
seed does not create any action and wipes them when it resets. So the link has no target yet.

## What AgentGuard needs to add (one small change)

Every time AgentGuard seeds or resets its demo, it should create one action record with this exact `_id`:

| Field | Value |
| --- | --- |
| `_id` | `65a11e0000000000000b1041` |
| workspace | the demo workspace ("Acme Travels") |
| action | `booking.cancel` (any action that has Undo in the demo will do) |
| status | `done` |
| amount | ₹1,800 |
| `beforeSnapshot` | filled in, so the **Undo** button works |
| `idempotencyKey` | any unique text |

The ids must match in both products. In AgentReplay the id is `AGENTGUARD_DEMO_ACTION_ID` in
`server/src/constants/index.ts`; the base address is the `AGENTGUARD_DEMO_URL` setting.

Wording differs a little between the two demos (AgentReplay tells a refund story, AgentGuard's demo is a travel
company). That is fine: the link only needs the id to exist.

## Until then

The link still opens AgentGuard's demo, and AgentGuard shows its normal "not found" message. Nothing breaks in
AgentReplay, which never calls AgentGuard itself.
