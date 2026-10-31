import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { UNFINISHED_AFTER_MS } from "../src/constants";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { User } from "../src/models/user.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The Runs and Run replay screens' data, end to end through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();
const PASSWORD = "a-good-password";
const MINUTE = 60 * 1000;

interface Team {
  token: string;
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function makeTeam(label: string, appName = "Support bot"): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@runs.test.example`, password: PASSWORD });
  const token = signup.body.data.token as string;
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: appName });
  return { token, workspaceId: signup.body.data.user.workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

const ingest = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);
const listRuns = (team: Team, query = "") => request(app).get(`/api/runs${query}`).set(authed(team.token));
const names = (res: request.Response) => res.body.data.runs.map((run: { name: string }) => run.name);

// A run written straight into the database, for tests that need exact times.
let counter = 0;
async function makeRun(team: Team, fields: Record<string, unknown> = {}) {
  counter += 1;
  return Run.create({
    workspaceId: team.workspaceId,
    appId: team.appId,
    externalId: `direct-${counter}`,
    name: `Run ${counter}`,
    ...fields,
  });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe("who may look", () => {
  it("needs a signed-in person for every address", async () => {
    const team = await makeTeam("auth");
    const run = await makeRun(team);
    expect((await request(app).get("/api/runs")).status).toBe(401);
    expect((await request(app).get(`/api/runs/${run._id}`)).status).toBe(401);
    expect((await request(app).get(`/api/runs/${run._id}/steps/0`)).status).toBe(401);
  });

  it("does not accept an SDK key in place of a person's sign-in", async () => {
    const team = await makeTeam("sdk-key");
    expect((await request(app).get("/api/runs").set("x-api-key", team.apiKey)).status).toBe(401);
    expect((await request(app).get("/api/runs").set(authed(team.apiKey))).status).toBe(401);
  });

  it("lets a viewer look at runs, steps and details", async () => {
    const team = await makeTeam("viewer");
    const run = await makeRun(team);
    await Step.create({ runId: run._id, index: 0, type: "tool", name: "look" });
    await User.create({ workspaceId: team.workspaceId, name: "Viewer", email: "look-only@runs.test.example", role: "viewer", passwordHash: await hashPassword(PASSWORD) });
    const login = await request(app).post("/api/auth/login").send({ email: "look-only@runs.test.example", password: PASSWORD });
    const viewer = { ...team, token: login.body.data.token as string };
    expect((await listRuns(viewer)).status).toBe(200);
    expect((await request(app).get(`/api/runs/${run._id}`).set(authed(viewer.token))).status).toBe(200);
    expect((await request(app).get(`/api/runs/${run._id}/steps/0`).set(authed(viewer.token))).status).toBe(200);
  });
});

describe("the runs list", () => {
  it("is empty, not an error, for a team with no runs", async () => {
    const team = await makeTeam("empty");
    const res = await listRuns(team);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: [], total: 0, page: 1, pageSize: 20 });
  });

  it("shows the newest run first, with everything the table needs and nothing internal", async () => {
    const team = await makeTeam("order", "Refund bot");
    await ingest(team, {
      runs: [
        { id: "old", name: "Old run", startedAt: minutesAgo(30).toISOString(), status: "ok", durationMs: 900 },
        { id: "new", name: "New run", userRef: "customer-7", startedAt: minutesAgo(5).toISOString(), status: "failed", durationMs: 400, tags: ["refund"] },
      ],
      steps: [{ runId: "new", index: 0, type: "llm", name: "answer", model: "gpt-4o-mini", tokens: 120, costUsd: 0.0004, durationMs: 300 }],
    });
    const res = await listRuns(team);
    expect(names(res)).toEqual(["New run", "Old run"]);
    expect(res.body.data.runs[0]).toMatchObject({
      name: "New run",
      status: "failed",
      displayStatus: "failed",
      userRef: "customer-7",
      model: "gpt-4o-mini",
      totalTokens: 120,
      durationMs: 400,
      stepCount: 1,
      tags: ["refund"],
      appName: "Refund bot",
      parentRunId: null,
    });
    expect(res.body.data.runs[0].costUsd).toBeCloseTo(0.0004, 8);
    expect(JSON.stringify(res.body)).not.toMatch(/reportedDurationMs|externalId|workspaceId|apiKey/);
  });

  it("pages through runs, 20 at a time unless asked otherwise", async () => {
    const team = await makeTeam("paging");
    await Run.insertMany(Array.from({ length: 25 }, (_, index) => ({ workspaceId: team.workspaceId, appId: team.appId, name: `Run ${String(index).padStart(2, "0")}`, startedAt: minutesAgo(index) })));
    const first = await listRuns(team);
    expect(first.body.data).toMatchObject({ total: 25, page: 1, pageSize: 20 });
    expect(first.body.data.runs).toHaveLength(20);
    expect(names(first)[0]).toBe("Run 00");
    const second = await listRuns(team, "?page=2");
    expect(second.body.data.runs).toHaveLength(5);
    expect(names(second)[4]).toBe("Run 24");
    expect((await listRuns(team, "?page=3")).body.data.runs).toEqual([]);
    const small = await listRuns(team, "?pageSize=10&page=3");
    expect(small.body.data.runs).toHaveLength(5);
    // No run appears on two pages.
    const seen = new Set([...names(first), ...names(second)]);
    expect(seen.size).toBe(25);
  });

  it.each(["?page=0", "?pageSize=0", "?pageSize=51", "?page=abc", "?status=great", "?appId=not-an-app", "?from=yesterday", "?from=2026-11-02&to=2026-11-01"])(
    "rejects %s with a friendly 400",
    async (query) => {
      const team = await makeTeam(`bad-${query.replace(/\W/g, "")}`);
      const res = await listRuns(team, query);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
  );

  it("ignores filters that are left empty", async () => {
    const team = await makeTeam("blank-filters");
    await makeRun(team);
    const res = await listRuns(team, "?status=&q=&appId=&from=&to=");
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it("filters by status", async () => {
    const team = await makeTeam("by-status");
    await makeRun(team, { name: "Good", status: "ok" });
    await makeRun(team, { name: "Bad", status: "failed" });
    await makeRun(team, { name: "Busy", status: "running" });
    expect(names(await listRuns(team, "?status=ok"))).toEqual(["Good"]);
    expect(names(await listRuns(team, "?status=failed"))).toEqual(["Bad"]);
    expect(names(await listRuns(team, "?status=running"))).toEqual(["Busy"]);
    expect(await listRuns(team, "?status=ok").then((res) => res.body.data.total)).toBe(1);
  });

  it("filters by app", async () => {
    const team = await makeTeam("by-app", "First app");
    const second = await request(app).post("/api/apps").set(authed(team.token)).send({ name: "Second app" });
    await makeRun(team, { name: "From first" });
    await makeRun(team, { name: "From second", appId: second.body.data.id });
    expect(names(await listRuns(team, `?appId=${second.body.data.id}`))).toEqual(["From second"]);
    expect(names(await listRuns(team, `?appId=${team.appId}`))).toEqual(["From first"]);
  });

  it("searches names and the person a run was for, ignoring capital letters", async () => {
    const team = await makeTeam("search");
    await makeRun(team, { name: "Refund for order 1042", userRef: "customer-1" });
    await makeRun(team, { name: "Password reset", userRef: "ANITA" });
    await makeRun(team, { name: "Something else", userRef: "customer-2" });
    expect(names(await listRuns(team, "?q=REFUND"))).toEqual(["Refund for order 1042"]);
    expect(names(await listRuns(team, "?q=anita"))).toEqual(["Password reset"]);
    expect((await listRuns(team, "?q=customer")).body.data.total).toBe(2);
    expect((await listRuns(team, "?q=nothing-like-this")).body.data.runs).toEqual([]);
  });

  it("searches typed text as plain letters, never as a pattern", async () => {
    const team = await makeTeam("search-plain");
    await makeRun(team, { name: "abc" });
    await makeRun(team, { name: "a.c" });
    await makeRun(team, { name: "cost (rs) [high]" });
    expect(names(await listRuns(team, "?q=a.c"))).toEqual(["a.c"]);
    expect(names(await listRuns(team, `?q=${encodeURIComponent(".*")}`))).toEqual([]);
    expect(names(await listRuns(team, `?q=${encodeURIComponent("(rs) [high]")}`))).toEqual(["cost (rs) [high]"]);
    expect((await listRuns(team, `?q=${encodeURIComponent("(((")}`)).status).toBe(200);
  });

  it("filters by date, including the first and last moment of the chosen days", async () => {
    const team = await makeTeam("dates");
    await makeRun(team, { name: "Before", startedAt: new Date("2026-10-30T23:59:59.999Z") });
    await makeRun(team, { name: "Start of day", startedAt: new Date("2026-10-31T00:00:00.000Z") });
    await makeRun(team, { name: "End of day", startedAt: new Date("2026-11-01T23:59:59.999Z") });
    await makeRun(team, { name: "After", startedAt: new Date("2026-11-02T00:00:00.000Z") });
    expect(names(await listRuns(team, "?from=2026-10-31&to=2026-11-01")).sort()).toEqual(["End of day", "Start of day"]);
    expect(names(await listRuns(team, "?from=2026-11-02"))).toEqual(["After"]);
    expect(names(await listRuns(team, "?to=2026-10-30"))).toEqual(["Before"]);
  });

  it("combines filters", async () => {
    const team = await makeTeam("combined");
    await makeRun(team, { name: "Refund A", status: "failed" });
    await makeRun(team, { name: "Refund B", status: "ok" });
    await makeRun(team, { name: "Other", status: "failed" });
    expect(names(await listRuns(team, "?status=failed&q=refund"))).toEqual(["Refund A"]);
  });

  it("shows a team only its own runs, whatever it asks for", async () => {
    const [a, b] = await Promise.all([makeTeam("iso-a"), makeTeam("iso-b")]);
    await makeRun(a, { name: "A's run" });
    await makeRun(b, { name: "B's run" });
    expect(names(await listRuns(a))).toEqual(["A's run"]);
    expect(names(await listRuns(b))).toEqual(["B's run"]);
    expect((await listRuns(a, `?appId=${b.appId}`)).body.data.runs).toEqual([]);
    expect((await listRuns(a, "?q=B's")).body.data.runs).toEqual([]);
  });
});

describe("Unfinished runs", () => {
  const displayOf = async (team: Team, name: string) => {
    const res = await listRuns(team, `?q=${encodeURIComponent(name)}`);
    return res.body.data.runs[0]?.displayStatus;
  };

  it("shows a run that is still running with no update for an hour as unfinished, and a newer one as running", async () => {
    const team = await makeTeam("unfinished");
    await makeRun(team, { name: "Quiet 61", status: "running", lastActivityAt: minutesAgo(61) });
    await makeRun(team, { name: "Quiet 59", status: "running", lastActivityAt: minutesAgo(59) });
    await makeRun(team, { name: "Quiet 1 day", status: "running", lastActivityAt: minutesAgo(24 * 60) });
    expect(await displayOf(team, "Quiet 61")).toBe("unfinished");
    expect(await displayOf(team, "Quiet 59")).toBe("running");
    expect(await displayOf(team, "Quiet 1 day")).toBe("unfinished");
  });

  it("switches at exactly one hour", async () => {
    const team = await makeTeam("boundary");
    const run = await makeRun(team, { name: "Boundary", status: "running" });
    const { displayStatusOf } = await import("../src/services/runs/runs.service");
    const lastActivityAt = new Date("2026-10-31T10:00:00.000Z");
    const base = { status: "running", lastActivityAt, startedAt: lastActivityAt };
    expect(displayStatusOf(base, new Date(lastActivityAt.getTime() + UNFINISHED_AFTER_MS - 1))).toBe("running");
    expect(displayStatusOf(base, new Date(lastActivityAt.getTime() + UNFINISHED_AFTER_MS))).toBe("unfinished");
    expect(run.status).toBe("running");
  });

  it("never marks a finished run as unfinished, however old", async () => {
    const team = await makeTeam("finished-old");
    await makeRun(team, { name: "Old ok", status: "ok", lastActivityAt: minutesAgo(5000) });
    await makeRun(team, { name: "Old failed", status: "failed", lastActivityAt: minutesAgo(5000) });
    expect(await displayOf(team, "Old ok")).toBe("ok");
    expect(await displayOf(team, "Old failed")).toBe("failed");
  });

  it("filters for unfinished and for running, and the two never overlap", async () => {
    const team = await makeTeam("unfinished-filter");
    await makeRun(team, { name: "Alive", status: "running", lastActivityAt: minutesAgo(5) });
    await makeRun(team, { name: "Gone", status: "running", lastActivityAt: minutesAgo(120) });
    await makeRun(team, { name: "Done", status: "ok", lastActivityAt: minutesAgo(120) });
    expect(names(await listRuns(team, "?status=unfinished"))).toEqual(["Gone"]);
    expect(names(await listRuns(team, "?status=running"))).toEqual(["Alive"]);
    expect((await listRuns(team, "?status=unfinished")).body.data.total).toBe(1);
    expect((await listRuns(team)).body.data.total).toBe(3);
  });

  it("falls back to the start time for runs saved before activity was tracked", async () => {
    const team = await makeTeam("legacy");
    const base = { workspaceId: new Types.ObjectId(team.workspaceId), appId: new Types.ObjectId(team.appId), status: "running", stepCount: 0 };
    // Written without lastActivityAt on purpose.
    await Run.collection.insertOne({ ...base, name: "Legacy old", startedAt: minutesAgo(300) });
    await Run.collection.insertOne({ ...base, name: "Legacy new", startedAt: minutesAgo(3) });
    expect(await displayOf(team, "Legacy old")).toBe("unfinished");
    expect(await displayOf(team, "Legacy new")).toBe("running");
    expect(names(await listRuns(team, "?status=unfinished"))).toEqual(["Legacy old"]);
    expect(names(await listRuns(team, "?status=running"))).toEqual(["Legacy new"]);
  });

  it("changes only what is shown, never the saved run", async () => {
    const team = await makeTeam("display-only");
    const run = await makeRun(team, { name: "Stays running", status: "running", lastActivityAt: minutesAgo(200) });
    await listRuns(team);
    await request(app).get(`/api/runs/${run._id}`).set(authed(team.token));
    expect(await Run.findById(run._id).lean()).toMatchObject({ status: "running" });
  });

  it("shows the real status again when the run finishes later, or a new update arrives", async () => {
    const team = await makeTeam("comes-back");
    await ingest(team, { runs: [{ id: "late", name: "Late finisher" }], steps: [{ runId: "late", index: 0, type: "tool", name: "a" }] });
    await Run.updateOne({ appId: team.appId, externalId: "late" }, { $set: { lastActivityAt: minutesAgo(180) } });
    expect(await displayOf(team, "Late finisher")).toBe("unfinished");

    await ingest(team, { steps: [{ runId: "late", index: 1, type: "tool", name: "b" }] });
    expect(await displayOf(team, "Late finisher")).toBe("running");

    await Run.updateOne({ appId: team.appId, externalId: "late" }, { $set: { lastActivityAt: minutesAgo(180) } });
    await ingest(team, { runs: [{ id: "late", status: "ok", durationMs: 50 }] });
    expect(await displayOf(team, "Late finisher")).toBe("ok");
  });

  it("counts a batch sent a second time as activity, and never moves activity backwards", async () => {
    const team = await makeTeam("activity");
    const batch = { runs: [{ id: "act", name: "Activity" }], steps: [{ runId: "act", index: 0, type: "tool", name: "a" }] };
    await ingest(team, batch);
    const first = (await Run.findOne({ appId: team.appId, externalId: "act" }).lean())!.lastActivityAt;
    expect(Date.now() - first.getTime()).toBeLessThan(10_000);

    await Run.updateOne({ appId: team.appId, externalId: "act" }, { $set: { lastActivityAt: minutesAgo(90) } });
    await ingest(team, batch); // nothing new in it, but the app is clearly still alive
    const second = (await Run.findOne({ appId: team.appId, externalId: "act" }).lean())!.lastActivityAt;
    expect(Date.now() - second.getTime()).toBeLessThan(10_000);
  });
});

describe("a run's replay", () => {
  it("returns the run and an outline of its steps in order, without the step text", async () => {
    const team = await makeTeam("replay", "Refund bot");
    await ingest(team, {
      runs: [{ id: "r", name: "Refund chat", userRef: "customer-1", status: "failed", durationMs: 2000 }],
      steps: [
        { runId: "r", index: 2, type: "tool", name: "send_email", input: "SECRET-INPUT-TEXT", error: "Mail server down", durationMs: 30 },
        { runId: "r", index: 0, type: "retrieval", name: "find_order", output: "SECRET-OUTPUT-TEXT", durationMs: 20 },
        { runId: "r", index: 1, type: "llm", name: "answer", model: "gpt-4o-mini", tokens: 90, costUsd: 0.0003, durationMs: 50 },
      ],
    });
    const run = await Run.findOne({ appId: team.appId, externalId: "r" });
    const res = await request(app).get(`/api/runs/${run!._id}`).set(authed(team.token));
    expect(res.status).toBe(200);
    expect(res.body.data.run).toMatchObject({ name: "Refund chat", appName: "Refund bot", displayStatus: "failed", stepCount: 3, parentRunName: null });
    expect(res.body.data.steps.map((step: { index: number; name: string; failed: boolean }) => [step.index, step.name, step.failed])).toEqual([
      [0, "find_order", false],
      [1, "answer", false],
      [2, "send_email", true],
    ]);
    expect(res.body.data.steps[1]).toMatchObject({ type: "llm", model: "gpt-4o-mini", tokens: 90, durationMs: 50 });
    // Text and error messages are only sent when one step is opened.
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-INPUT-TEXT|SECRET-OUTPUT-TEXT|Mail server down/);
  });

  it("keeps the outline small even when the steps are big", async () => {
    const team = await makeTeam("big");
    const run = await makeRun(team, { name: "Big run" });
    await Step.insertMany(Array.from({ length: 50 }, (_, index) => ({ runId: run._id, index, type: "llm", name: `step ${index}`, input: "x".repeat(30_000), output: "y".repeat(30_000) })));
    const res = await request(app).get(`/api/runs/${run._id}`).set(authed(team.token));
    expect(res.body.data.steps).toHaveLength(50);
    expect(JSON.stringify(res.body).length).toBeLessThan(30_000);
  });

  it("names the run a fork came from", async () => {
    const team = await makeTeam("fork");
    const parent = await makeRun(team, { name: "The original" });
    const fork = await makeRun(team, { name: "The fork", parentRunId: parent._id });
    const res = await request(app).get(`/api/runs/${fork._id}`).set(authed(team.token));
    expect(res.body.data.run).toMatchObject({ parentRunId: String(parent._id), parentRunName: "The original" });
  });

  it("answers 404 for a run that does not exist, an id that is not valid, or another team's run", async () => {
    const [a, b] = await Promise.all([makeTeam("replay-a"), makeTeam("replay-b")]);
    const run = await makeRun(a, { name: "A's private run" });
    await Step.create({ runId: run._id, index: 0, type: "tool", name: "private" });
    expect((await request(app).get(`/api/runs/${new Types.ObjectId()}`).set(authed(a.token))).status).toBe(404);
    expect((await request(app).get("/api/runs/not-an-id").set(authed(a.token))).status).toBe(404);
    const stolen = await request(app).get(`/api/runs/${run._id}`).set(authed(b.token));
    expect(stolen.status).toBe(404);
    expect(stolen.body.message).toBe("That run was not found.");
    expect((await request(app).get(`/api/runs/${run._id}/steps/0`).set(authed(b.token))).status).toBe(404);
  });

  it("does not show another team's parent run name", async () => {
    const [a, b] = await Promise.all([makeTeam("parent-a"), makeTeam("parent-b")]);
    const foreign = await makeRun(b, { name: "B's secret run" });
    const odd = await makeRun(a, { name: "Odd fork", parentRunId: foreign._id });
    const res = await request(app).get(`/api/runs/${odd._id}`).set(authed(a.token));
    expect(res.body.data.run.parentRunName).toBeNull();
  });
});

describe("one step", () => {
  let team: Team;
  let runId: string;
  beforeAll(async () => {
    team = await makeTeam("step");
    await ingest(team, {
      runs: [{ id: "s", name: "Step run" }],
      steps: [
        { runId: "s", index: 0, type: "llm", name: "answer", input: "Refund for order 1042?", output: "Your refund is ₹2,400.", model: "gpt-4o-mini", tokens: 90, costUsd: 0.0003, durationMs: 50 },
        { runId: "s", index: 1, type: "tool", name: "send_email", input: "to a customer", error: "Error: Mail server down" },
      ],
    });
    runId = String((await Run.findOne({ appId: team.appId, externalId: "s" }))!._id);
  });

  it("returns the whole step, with its text", async () => {
    const res = await request(app).get(`/api/runs/${runId}/steps/0`).set(authed(team.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ index: 0, type: "llm", name: "answer", input: "Refund for order 1042?", output: "Your refund is ₹2,400.", model: "gpt-4o-mini", tokens: 90, durationMs: 50, error: "" });
    const failed = await request(app).get(`/api/runs/${runId}/steps/1`).set(authed(team.token));
    expect(failed.body.data.error).toBe("Error: Mail server down");
  });

  it.each(["2", "-1", "abc", "1.5", "99999"])("answers 404 for step %s", async (index) => {
    const res = await request(app).get(`/api/runs/${runId}/steps/${index}`).set(authed(team.token));
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/);
  });
});
