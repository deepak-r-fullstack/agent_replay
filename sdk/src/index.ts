// The AgentReplay SDK. It has zero runtime dependencies on purpose: it runs inside
// other people's apps, so it must stay tiny and can never be a reason their app breaks.
//
//   import { init, startRun } from "@sritarak/agentreplay";
//   init();                                   // reads AGENTREPLAY_API_KEY
//   const run = startRun({ name: "Support chat" });
//   await run.trace("tool", "lookup_order", () => lookupOrder(id), { input: { id } });
//   run.end();

export const SDK_VERSION = "0.1.0";

export { AgentReplay, init, startRun, flush } from "./client";
export { Run } from "./run";
export { wrapOpenAI, wrapAnthropic } from "./wrappers";
export { maskSecrets } from "./mask";
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
