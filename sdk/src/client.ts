import { Run } from "./run";
import { Transport } from "./transport";
import { AgentReplayOptions, StartRunOptions } from "./types";

// When the host has nothing left to do, send what is still waiting. One shared listener serves every client
// (so creating many clients cannot trigger Node's "too many listeners" warning), and clients are held weakly
// (so a client created per request can still be cleaned up).
const watchedClients = new Set<WeakRef<AgentReplay>>();
let exitHookAdded = false;

function watchForExit(client: AgentReplay) {
  try {
    if (typeof WeakRef !== "function" || typeof process === "undefined" || typeof process.once !== "function") return;
    if (watchedClients.size >= 100) {
      for (const reference of watchedClients) if (!reference.deref()) watchedClients.delete(reference);
    }
    if (watchedClients.size < 100) watchedClients.add(new WeakRef(client));
    if (exitHookAdded) return;
    exitHookAdded = true;
    process.on("beforeExit", () => {
      for (const reference of watchedClients) void reference.deref()?.flush();
    });
  } catch {
    // Not being able to hook the exit is fine; flush() still works.
  }
}

// The object you create once and keep. It owns the background sender.
export class AgentReplay {
  private readonly transport: Transport;

  constructor(options: AgentReplayOptions = {}) {
    this.transport = new Transport(options);
    if (this.transport.enabled) watchForExit(this);
  }

  get enabled() {
    return this.transport.enabled;
  }

  /** Starts recording a run. Always returns a run object, even when recording is off. */
  startRun(options: StartRunOptions = {}): Run {
    return new Run(this.transport, options);
  }

  /** Sends everything waiting right now. Resolves even if AgentReplay cannot be reached. */
  async flush(): Promise<void> {
    try {
      await this.transport.flush();
    } catch {
      // Never rejects.
    }
  }

  /** Same as flush(); call it before a short script or a serverless function ends. */
  shutdown(): Promise<void> {
    return this.flush();
  }

}

let defaultClient: AgentReplay | null = null;

/** Sets up recording once. With no options it reads AGENTREPLAY_API_KEY (and AGENTREPLAY_URL) from the environment. */
export function init(options: AgentReplayOptions = {}): AgentReplay {
  defaultClient = new AgentReplay(options);
  return defaultClient;
}

function getDefaultClient() {
  return defaultClient ?? init();
}

export function startRun(options: StartRunOptions = {}): Run {
  return getDefaultClient().startRun(options);
}

export function flush(): Promise<void> {
  return getDefaultClient().flush();
}
