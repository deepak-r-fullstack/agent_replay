import { FilterQuery, Types } from "mongoose";
import { AGENTGUARD_DEMO_APP_NAME, DEMO_WORKSPACE_SLUG, LINKED_DEMO_RUN_KEEP_MS } from "../../constants";
import { env } from "../../config/env";
import { App } from "../../models/app.model";
import { RunDoc } from "../../models/run.model";
import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";
import { isDuplicateKeyError } from "../../utils/mongoErrors";
import { hashApiKey } from "../auth/auth.service";

// The app AgentGuard's guided demo records into. Optional: it only exists while AGENTGUARD_DEMO_SDK_KEY is set.
//  - it lives in the shared demo workspace, so a visitor who presses "Try the demo" can open their own recording
//  - it is "seeded", so visitors cannot switch its key off or replace it
//  - its recordings from the last day survive the hourly reset (forks of them do not)
//  - AgentGuard holds the same key server-side; this side only ever stores its hash

/** Runs the hourly reset keeps: recordings from AgentGuard's guided demo, from the last day. Forks have no externalId, so they go. */
export function keptLinkedRunsFilter(linkedAppIds: Types.ObjectId[], now = new Date()): FilterQuery<RunDoc> {
  return {
    appId: { $in: linkedAppIds },
    externalId: { $type: "string" },
    startedAt: { $gte: new Date(now.getTime() - LINKED_DEMO_RUN_KEEP_MS) },
  };
}

/**
 * Makes sure the linked app matches the setting: present with the configured key, or switched off when no key is set.
 * Safe to call from several servers at once and at every reset. Never throws.
 */
export async function ensureAgentGuardDemoApp(workspaceId?: Types.ObjectId) {
  if (!env.DEMO_MODE) return null;
  try {
    const demoWorkspaceId = workspaceId ?? (await Workspace.findOne({ slug: DEMO_WORKSPACE_SLUG, isDemo: true }).select("_id").lean())?._id;
    if (!demoWorkspaceId) return null; // made by the first reset, which calls this again

    const apiKey = env.AGENTGUARD_DEMO_SDK_KEY;
    if (!apiKey) {
      // The setting was removed: the old key must stop working. The app and its runs stay visible until they age out.
      await App.updateMany({ workspaceId: demoWorkspaceId, linkedDemo: true }, { $set: { active: false } });
      return null;
    }

    return await App.findOneAndUpdate(
      { workspaceId: demoWorkspaceId, linkedDemo: true },
      {
        $set: { name: AGENTGUARD_DEMO_APP_NAME, apiKeyHash: hashApiKey(apiKey), apiKeyPreview: `${apiKey.slice(0, 8)}…`, active: true, seeded: true },
        $setOnInsert: { workspaceId: demoWorkspaceId, linkedDemo: true },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    // Two servers creating it at the same instant: the unique key hash lets only one in, and that one is enough.
    // (The same error appears when the key already belongs to another app; it is logged so the owner can pick a new key.)
    if (isDuplicateKeyError(err)) logger.warn("agentguard demo app key is already in use", {});
    else logger.error("agentguard demo app could not be prepared", serializeError(err));
    return null;
  }
}
