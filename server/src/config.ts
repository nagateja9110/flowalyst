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

// Seeds ship in the repo (read-only). Uploads + the manifest are mutable state:
// point DATA_DIR at a mounted disk in production so they survive redeploys;
// locally it defaults to the repo's data/ dir.
const REPO_DATA = path.resolve(__dirname, "../data");
const STATE_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : REPO_DATA;
export const DATA_DIR = STATE_DIR;
export const UPLOADS_DIR = path.join(STATE_DIR, "uploads");
export const MANIFEST_PATH = path.join(STATE_DIR, "datasets.json");
export const SEED_DIR = path.join(REPO_DATA, "seed");

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
export const MAX_AGENT_ITERATIONS = 6;
export const QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_ROW_LIMIT = 1000;

// Retrieval-augmented table selection (see retrieval.ts). Below this many
// datasets, every schema goes into the prompt unfiltered — there's nothing
// worth filtering with only a handful of tables. Above it, only the top
// RETRIEVAL_TOP_K tables by embedding similarity to the question are sent.
export const RETRIEVAL_TABLE_THRESHOLD = 4;
export const RETRIEVAL_TOP_K = 3;

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
