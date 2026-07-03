import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env if present (Node 20.12+ built-in; no dotenv dependency).
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
} catch {
  /* no .env file — env vars come from the shell */
}

export const PORT = Number(process.env.PORT ?? 5002);
export const DATA_DIR = path.resolve(__dirname, "../data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const SEED_DIR = path.join(DATA_DIR, "seed");
export const MANIFEST_PATH = path.join(DATA_DIR, "datasets.json");

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
export const MAX_AGENT_ITERATIONS = 6;
export const QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_ROW_LIMIT = 1000;

export type Provider = "gemini" | "groq";

/** Which LLM powers the agent. PROVIDER env forces one; otherwise Gemini wins
 *  if its keys are set (live-verified path), Groq is the fallback provider,
 *  and null means manual-SQL-only mode. Both providers read key POOLS
 *  (GEMINI_API_KEYS / GROQ_API_KEYS, comma-separated) with 429 failover. */
export function provider(): Provider | null {
  const forced = process.env.PROVIDER;
  if (forced === "gemini" || forced === "groq") return forced;
  if (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS) return "gemini";
  if (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS) return "groq";
  return null;
}

export const hasApiKey = () => provider() !== null;
