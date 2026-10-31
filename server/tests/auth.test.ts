import request from "supertest";
import { createApp } from "../src/app";
import { User } from "../src/models/user.model";
import { Workspace } from "../src/models/workspace.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Health, sign-up, sign-in and the demo button, end to end through the real HTTP API
// with a real (in-memory) MongoDB.

const app = createApp();

const validSignup = { name: "Asha Rao", workspaceName: "Rao Support", email: "asha@example.com", password: "a-good-password" };
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe("health", () => {
  it("answers without signing in", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("gives unknown API addresses a JSON 404", async () => {
    const res = await request(app).get("/api/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe("sign up", () => {
  it("creates a workspace with the new person as its owner", async () => {
    const res = await request(app).post("/api/auth/signup").send(validSignup);
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ name: "Asha Rao", email: "asha@example.com", role: "owner", workspaceName: "Rao Support" });
    expect(res.body.data.token).toEqual(expect.any(String));
    // The password hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const stored = await User.findOne({ email: "asha@example.com" }).select("+passwordHash").lean();
    expect(stored!.passwordHash).not.toBe(validSignup.password);
  });

  it("lets the new person use the token straight away", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ ...validSignup, email: "second@example.com" });
    const me = await request(app).get("/api/auth/me").set(authed(signup.body.data.token));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ email: "second@example.com", role: "owner", workspaceName: "Rao Support" });
  });

  it("refuses an email that already has an account, in any letter case", async () => {
    const res = await request(app).post("/api/auth/signup").send({ ...validSignup, email: "ASHA@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already an account/i);
    // The refused attempt must not leave an empty workspace behind.
    expect(await Workspace.countDocuments({ name: "Rao Support" })).toBe(2);
  });

  it("gives two teams with the same name separate workspaces", async () => {
    const res = await request(app).post("/api/auth/signup").send({ ...validSignup, email: "third@example.com" });
    expect(res.status).toBe(201);
    const workspaces = await Workspace.find({ name: "Rao Support" }).lean();
    expect(new Set(workspaces.map((workspace) => workspace.slug)).size).toBe(workspaces.length);
  });

  it.each(["demo@agentreplay.test", "DEMO@AgentReplay.Test", "anyone@agentreplay.test"])("refuses the reserved demo address %s", async (email) => {
    const workspacesBefore = await Workspace.countDocuments();
    const res = await request(app).post("/api/auth/signup").send({ ...validSignup, email });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("This email address can't be used. Please use your own email.");
    expect(await User.countDocuments({ email: email.toLowerCase() })).toBe(0);
    // The refused attempt must not leave a workspace behind either.
    expect(await Workspace.countDocuments()).toBe(workspacesBefore);
  });

  it.each([
    ["a short password", { password: "short" }],
    ["a bad email", { email: "not-an-email" }],
    ["no team name", { workspaceName: "  " }],
    ["no name", { name: "" }],
  ])("rejects %s with a friendly message", async (_label, change) => {
    const res = await request(app).post("/api/auth/signup").send({ ...validSignup, email: "x@example.com", ...change });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/missing or not valid/i);
  });
});

describe("sign in", () => {
  it("signs in with the right password", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "Asha@Example.com", password: validSignup.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("owner");
  });

  it("says the same thing for a wrong password and an unknown email", async () => {
    const wrongPassword = await request(app).post("/api/auth/login").send({ email: "asha@example.com", password: "nope-nope" });
    const unknownEmail = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "nope-nope" });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it("stops a turned-off person at sign-in and on their next request", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ ...validSignup, email: "off@example.com" });
    await User.updateOne({ email: "off@example.com" }, { active: false });

    const login = await request(app).post("/api/auth/login").send({ email: "off@example.com", password: validSignup.password });
    expect(login.status).toBe(401);
    expect(login.body.message).toMatch(/turned off/i);

    const me = await request(app).get("/api/auth/me").set(authed(signup.body.data.token));
    expect(me.status).toBe(401);
  });

  it("refuses requests with no token or a broken token", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(authed("not-a-token"))).status).toBe(401);
  });
});

describe("try the demo", () => {
  it("signs in as a developer in the demo workspace without a password", async () => {
    const res = await request(app).post("/api/auth/demo");
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ role: "developer", workspaceName: "Acme Support (demo)" });
    const workspace = await Workspace.findOne({ slug: "demo-acme-support" }).lean();
    expect(workspace!.isDemo).toBe(true);
  });

  it("reuses the same demo workspace and person every time, even for two clicks at once", async () => {
    await Promise.all([request(app).post("/api/auth/demo"), request(app).post("/api/auth/demo")]);
    expect(await Workspace.countDocuments({ slug: "demo-acme-support" })).toBe(1);
    expect(await User.countDocuments({ email: "demo@agentreplay.test" })).toBe(1);
  });

  it("cannot be used to sign in with a password", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "demo@agentreplay.test", password: "anything-at-all" });
    expect(res.status).toBe(401);
  });

  it("never signs anyone in as a user outside the demo workspace, even one with the demo email", async () => {
    // Worst case: the demo email already belongs to a real workspace (for example from before sign-up blocked it).
    await User.deleteOne({ email: "demo@agentreplay.test" });
    const outside = await Workspace.create({ name: "Not the demo", slug: "not-the-demo" });
    await User.create({
      workspaceId: outside._id,
      name: "Squatter",
      email: "demo@agentreplay.test",
      role: "owner",
      passwordHash: await hashPassword("a-good-password"),
    });

    const res = await request(app).post("/api/auth/demo");
    expect(res.status).toBe(503);
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/token|Squatter|Not the demo/);

    // Clean up so the demo works again for anything that runs after this test.
    await User.deleteOne({ email: "demo@agentreplay.test" });
    await Workspace.deleteOne({ _id: outside._id });
    const again = await request(app).post("/api/auth/demo");
    expect(again.status).toBe(200);
    expect(again.body.data.user.workspaceName).toBe("Acme Support (demo)");
  });
});
