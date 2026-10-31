import request from "supertest";
import { createApp } from "../src/app";
import { App } from "../src/models/app.model";
import { User } from "../src/models/user.model";
import { MAX_APPS_PER_WORKSPACE } from "../src/constants";
import { findAppByApiKey, hashApiKey, hashPassword } from "../src/services/auth/auth.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Apps and SDK keys: creating, showing the key once, roles, and teams staying separate.

const app = createApp();
const PASSWORD = "a-good-password";

const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const createApp_ = (token: string, name = "Support bot") => request(app).post("/api/apps").set(authed(token)).send({ name });

async function signUp(email: string, workspaceName: string) {
  const res = await request(app).post("/api/auth/signup").send({ name: "Test Person", workspaceName, email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.data.token as string;
}

// Adds a teammate with a given role to an existing person's workspace, then signs them in.
async function addTeammate(ownerToken: string, email: string, role: "developer" | "viewer") {
  const me = await request(app).get("/api/auth/me").set(authed(ownerToken));
  await User.create({ workspaceId: me.body.data.workspaceId, name: "Teammate", email, role, passwordHash: await hashPassword(PASSWORD) });
  const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  return login.body.data.token as string;
}

let ownerToken: string;
let otherTeamToken: string;

beforeAll(async () => {
  await startTestDb();
  ownerToken = await signUp("owner@a.test", "Team A");
  otherTeamToken = await signUp("owner@b.test", "Team B");
});

afterAll(async () => {
  await stopTestDb();
});

describe("creating an app", () => {
  it("returns the full key once, and stores only its hash", async () => {
    const res = await createApp_(ownerToken);
    expect(res.status).toBe(201);
    const { apiKey, id, apiKeyPreview } = res.body.data;
    expect(apiKey).toMatch(/^ar_[0-9a-f]{48}$/);
    expect(apiKeyPreview).toBe(`${apiKey.slice(0, 8)}…`);

    const stored = await App.findById(id).select("+apiKeyHash").lean();
    expect(stored!.apiKeyHash).toBe(hashApiKey(apiKey));
    expect(JSON.stringify(stored)).not.toContain(apiKey);
  });

  it("never shows the key again in the list", async () => {
    const list = await request(app).get("/api/apps").set(authed(ownerToken));
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toMatch(/ar_[0-9a-f]{48}|apiKeyHash|"apiKey"/);
  });

  it("makes a different key for every app", async () => {
    const a = await createApp_(ownerToken, "One");
    const b = await createApp_(ownerToken, "Two");
    expect(a.body.data.apiKey).not.toBe(b.body.data.apiKey);
  });

  it("rejects an empty name with a friendly message", async () => {
    const res = await createApp_(ownerToken, "   ");
    expect(res.status).toBe(400);
  });

  it("stops at the app limit so one team cannot fill the free database", async () => {
    const token = await signUp("many@c.test", "Team C");
    const me = await request(app).get("/api/auth/me").set(authed(token));
    await App.insertMany(
      Array.from({ length: MAX_APPS_PER_WORKSPACE }, (_, index) => ({
        workspaceId: me.body.data.workspaceId,
        name: `App ${index}`,
        apiKeyHash: `hash-${index}`,
        apiKeyPreview: "ar_xxxx…",
      }))
    );
    const res = await createApp_(token, "One too many");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/up to 20 apps/);
  });
});

describe("who may do what", () => {
  it("lets a developer create apps", async () => {
    const developer = await addTeammate(ownerToken, "dev@a.test", "developer");
    expect((await createApp_(developer, "Made by developer")).status).toBe(201);
  });

  it("lets a viewer look but not change anything", async () => {
    const viewer = await addTeammate(ownerToken, "view@a.test", "viewer");
    const created = await createApp_(ownerToken, "Look only");

    expect((await request(app).get("/api/apps").set(authed(viewer))).status).toBe(200);
    const blocked = await createApp_(viewer, "Not allowed");
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/can only look/i);
    expect((await request(app).post(`/api/apps/${created.body.data.id}/rotate-key`).set(authed(viewer))).status).toBe(403);
    expect((await request(app).post(`/api/apps/${created.body.data.id}/revoke-key`).set(authed(viewer))).status).toBe(403);
  });

  it("needs a signed-in person for every apps address", async () => {
    expect((await request(app).get("/api/apps")).status).toBe(401);
    expect((await request(app).post("/api/apps").send({ name: "x" })).status).toBe(401);
  });
});

describe("teams stay separate", () => {
  it("shows a team only its own apps", async () => {
    await createApp_(ownerToken, "Only team A sees this");
    const other = await request(app).get("/api/apps").set(authed(otherTeamToken));
    expect(other.body.data.map((item: { name: string }) => item.name)).not.toContain("Only team A sees this");
  });

  it("does not let another team revoke or rotate your key", async () => {
    const created = await createApp_(ownerToken, "Mine");
    const id = created.body.data.id;
    expect((await request(app).post(`/api/apps/${id}/revoke-key`).set(authed(otherTeamToken))).status).toBe(404);
    expect((await request(app).post(`/api/apps/${id}/rotate-key`).set(authed(otherTeamToken))).status).toBe(404);
    expect(await findAppByApiKey(created.body.data.apiKey)).not.toBeNull();
  });

  it("answers an id that is not valid with a friendly 404", async () => {
    const res = await request(app).post("/api/apps/not-an-id/revoke-key").set(authed(ownerToken));
    expect(res.status).toBe(404);
  });
});

describe("key life cycle", () => {
  it("finds an app by its key until the key is revoked", async () => {
    const created = await createApp_(ownerToken, "Short lived");
    const { apiKey, id } = created.body.data;
    expect((await findAppByApiKey(apiKey))?.name).toBe("Short lived");

    const revoked = await request(app).post(`/api/apps/${id}/revoke-key`).set(authed(ownerToken));
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.active).toBe(false);
    expect(await findAppByApiKey(apiKey)).toBeNull();
  });

  it("does not accept text that only looks like a key", async () => {
    expect(await findAppByApiKey("")).toBeNull();
    expect(await findAppByApiKey("sk_live_12345")).toBeNull();
    expect(await findAppByApiKey("ar_" + "0".repeat(48))).toBeNull();
  });

  it("rotating gives a new working key and kills the old one", async () => {
    const created = await createApp_(ownerToken, "Rotating");
    const oldKey = created.body.data.apiKey;
    const rotated = await request(app).post(`/api/apps/${created.body.data.id}/rotate-key`).set(authed(ownerToken));
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.apiKey).not.toBe(oldKey);
    expect(await findAppByApiKey(oldKey)).toBeNull();
    expect((await findAppByApiKey(rotated.body.data.apiKey))?.name).toBe("Rotating");
  });

  it("rotating a revoked app switches it back on", async () => {
    const created = await createApp_(ownerToken, "Back again");
    const id = created.body.data.id;
    await request(app).post(`/api/apps/${id}/revoke-key`).set(authed(ownerToken));
    const rotated = await request(app).post(`/api/apps/${id}/rotate-key`).set(authed(ownerToken));
    expect(rotated.body.data.active).toBe(true);
    expect(await findAppByApiKey(rotated.body.data.apiKey)).not.toBeNull();
  });
});
