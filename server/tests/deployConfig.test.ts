import fs from "fs";
import path from "path";
import { z } from "zod";

// render.yaml and local.env.example must list every setting the server reads, so nobody has to hunt for one.
const root = path.resolve(__dirname, "../..");
const envSource = fs.readFileSync(path.join(root, "server/src/config/env.ts"), "utf8");
const settings = [...envSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*z\b/gm)].map((match) => match[1]);
const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
const example = fs.readFileSync(path.join(root, "server/env/local.env.example"), "utf8");

describe("deploy settings", () => {
  it("finds the settings in env.ts", () => {
    expect(settings).toEqual(expect.arrayContaining(["MONGO_URI", "JWT_SECRET", "LLM_PROVIDER", "LLM_ALLOWED_MODELS", "DEMO_AUTO_RESET"]));
  });

  it("lists every setting in render.yaml, except PORT which Render sets itself", () => {
    for (const name of settings.filter((item) => item !== "PORT")) expect(render).toContain(`key: ${name}\n`);
  });

  it("lists every setting in local.env.example", () => {
    for (const name of settings.filter((item) => item !== "NODE_ENV")) expect(example).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });

  it("uses the free scripted AI model, one free service in Singapore, and keeps secrets out of the file", () => {
    expect(render).toMatch(/key: LLM_PROVIDER\n\s+value: demo/);
    expect(render).toMatch(/plan: free/);
    expect(render).toMatch(/region: singapore/);
    for (const secret of ["MONGO_URI", "LLM_API_KEY"]) expect(render).toMatch(new RegExp(`key: ${secret}\\n\\s+sync: false`));
    expect(render).not.toMatch(/mongodb(\+srv)?:\/\//);
    expect(z.string().parse(render)).toBeTruthy();
  });
});
