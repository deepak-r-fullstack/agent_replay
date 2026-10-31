// The AgentReplay SDK. It has zero runtime dependencies on purpose: it runs inside
// other people's apps, so it must stay tiny and can never be a reason their app breaks.
//
//   import { init, startRun } from "@sritarak/agentreplay";
//   init();                                   // reads AGENTREPLAY_API_KEY
//   const run = startRun({ name: "Support chat" });
//   await run.trace("tool", "lookup_order", () => lookupOrder(id), { input: { id } });
//   run.end();
//
// A step can link to a record in another system, so a person can jump there from the replay:
//   run.step({ name: "issue_refund", externalRef: { system: "agentguard", id: actionId, url: actionUrl } });

export const SDK_VERSION = "0.2.0";

export { AgentReplay, init, startRun, flush } from "./client";
export { Run } from "./run";
export { wrapOpenAI, wrapAnthropic } from "./wrappers";
export { maskSecrets } from "./mask";
export type { ExternalRef } from "./externalRef";
export type {
  AgentReplayOptions,
  StartRunOptions,
  StepInput,
  StepType,
  TraceOptions,
  PriceOptions,
  WrapOptions,
  RunStatus,
} from "./types";
