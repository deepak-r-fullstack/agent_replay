import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

// Load env/<NODE_ENV>.env when it exists (same convention as the NueAssist services).
// Values already set in the real environment always win, so production never reads a file.
const NODE_ENV = (process.env.NODE_ENV || "local").toLowerCase();
const envFile = path.join(process.cwd(), "env", `${NODE_ENV}.env`);
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
}

// "gpt-4.1-mini, gpt-4o-mini" -> ["gpt-4.1-mini", "gpt-4o-mini"]. Blank entries and repeats are dropped.
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(",").map((name) => name.trim()).filter(Boolean))];
}

const DEV_JWT_SECRET = "agentreplay-dev-only-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.string().default("local"),
  PORT: z.coerce.number().int().positive().default(5050),
  MONGO_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/agentreplay"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default("8h"),
  // Which AI model forks re-run through. "demo" is a free scripted model that needs no key, so the site works with none.
  LLM_PROVIDER: z.enum(["demo", "openai", "anthropic", "ollama"]).default("demo"),
  LLM_MODEL: z.string().optional().default(""),
  // The only models a fork may ask for (comma-separated). Any other model is replaced by LLM_MODEL.
  // Empty means only LLM_MODEL is allowed. Not used by the free demo model.
  LLM_ALLOWED_MODELS: z.string().optional().default("").transform(parseModelList),
  LLM_API_KEY: z.string().optional().default(""),
  // Only for ollama (local: http://127.0.0.1:11434) or an OpenAI-compatible gateway.
  LLM_BASE_URL: z.string().optional().default(""),
  // Demo mode turns on the "Try the demo" sign-in.
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot with a readable list instead of a confusing error later.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV.toLowerCase() === "production";
export const isTest = env.NODE_ENV.toLowerCase() === "test";

if (isProduction && env.JWT_SECRET === DEV_JWT_SECRET) {
  console.error("JWT_SECRET must be set in production.");
  process.exit(1);
}
