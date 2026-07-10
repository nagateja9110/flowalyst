/**
 * Eval harness: runs each golden question through the active provider's agent
 * and regex-checks the natural-language answer. Answers accuracy questions
 * with numbers instead of vibes:
 *
 *   npm run eval --prefix server            # uses PROVIDER / available keys
 *   PROVIDER=groq npm run eval ...          # compare providers
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_DIR, provider } from "../src/config.js";
import { describeWorkspace } from "../src/db.js";
import { runGroqAgent } from "../src/agent-groq.js";
import { runGeminiAgent } from "../src/agent-gemini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "golden.json"), "utf8"));

const activeProvider = provider();
if (!activeProvider) {
  console.error("No API key set (GEMINI_API_KEY(S) or GROQ_API_KEY(S)) — cannot run evals.");
  process.exit(1);
}
const runAgent = activeProvider === "gemini" ? runGeminiAgent : runGroqAgent;

const seedCsv = path.join(SEED_DIR, "orders.csv");
const sources = [
  { name: "orders", path: seedCsv },
  { name: "customers", path: path.join(SEED_DIR, "customers.csv") },
  { name: "products", path: path.join(SEED_DIR, "products.csv") },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Free-tier Gemini allows ~10 requests/min and each question costs 2-3 requests,
// so space the cases out; Groq's per-minute limits are looser.
const CASE_DELAY_MS = activeProvider === "gemini" ? 25_000 : 0;

/** A rate-limit, quota, or transient network error is an infrastructure
 *  problem, not a wrong answer — distinguished from logic failures so the
 *  pass-rate reflects correctness, not how hard the test suite has been
 *  hammering the free tier. "fetch failed" is Node's generic error for a
 *  dropped connection/DNS hiccup, which shows up right alongside real 429s
 *  when a key pool is fully exhausted (the failure happens before the
 *  response body — with a status code — ever comes back). */
const isRateLimited = (answer) =>
  /\b429\b|RESOURCE_EXHAUSTED|quota|rate-?limited|fetch failed/i.test(answer);

/** status: "pass" | "fail" | "skip" (skip = couldn't run / rate-limited, not a wrong answer) */
async function runCase(c) {
  const ws = await describeWorkspace(sources, seedCsv);
  let answer = "";
  let sqlCalls = 0;
  const start = Date.now();
  const emit = (e) => {
    if (e.type === "text") answer += e.delta;
    if (e.type === "tool_call") sqlCalls++;
  };
  try {
    await runAgent(sources, seedCsv, ws, c.question, [], emit);
  } catch (err) {
    answer += ` [agent error: ${err instanceof Error ? err.message : err}]`;
  }
  const seconds = (Date.now() - start) / 1000;
  if (new RegExp(c.answer_regex, "i").test(answer)) return { status: "pass", seconds, sqlCalls, answer };
  if (isRateLimited(answer)) return { status: "skip", seconds, sqlCalls, answer };
  return { status: "fail", seconds, sqlCalls, answer };
}

console.log(`Provider: ${activeProvider}\nDataset:  ${sources.map((s) => s.name).join(", ")} (seed)\n`);

let passed = 0;
let skipped = 0;
const failures = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  if (i > 0 && CASE_DELAY_MS > 0) await sleep(CASE_DELAY_MS);
  let r = await runCase(c); // sequential — respects free-tier rate limits
  if (r.status === "skip") {
    console.log(`    rate-limited — waiting 60s and retrying case ${i + 1}...`);
    await sleep(60_000);
    r = await runCase(c);
  }
  if (r.status === "pass") passed++;
  else if (r.status === "skip") skipped++;
  else failures.push({ c, r });
  const status = r.status.toUpperCase();
  console.log(
    `${String(i + 1).padStart(2)}. [${status}] ${r.seconds.toFixed(1).padStart(5)}s  ${String(r.sqlCalls)} sql  ` +
    `(${c.concept}) ${c.question}`,
  );
}

const ran = cases.length - skipped;
console.log(
  `\n${passed}/${ran} answered correctly` +
  `${skipped ? ` (${skipped} skipped — rate-limited, not run)` : ""}` +
  `${ran ? ` — ${Math.round((100 * passed) / ran)}%` : ""}`,
);
for (const { c, r } of failures) {
  console.log(`\nFAILED: ${c.question}\n  expected /${c.answer_regex}/i\n  answer: ${r.answer.slice(0, 300)}`);
}
// Exit non-zero only on real logic failures; rate-limit skips don't fail CI.
process.exit(failures.length === 0 ? 0 : 1);
