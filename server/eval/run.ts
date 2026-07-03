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
import { describeWorkspace, type TableSource } from "../src/db.js";
import { runGroqAgent } from "../src/agent-groq.js";
import { runGeminiAgent } from "../src/agent-gemini.js";
import type { AgentEvent } from "../src/agent-core.js";

interface GoldenCase {
  question: string;
  answer_regex: string;
  concept: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cases: GoldenCase[] = JSON.parse(fs.readFileSync(path.join(__dirname, "golden.json"), "utf8"));

const activeProvider = provider();
if (!activeProvider) {
  console.error("No API key set (GEMINI_API_KEY(S) or GROQ_API_KEY(S)) — cannot run evals.");
  process.exit(1);
}
const runAgent = activeProvider === "gemini" ? runGeminiAgent : runGroqAgent;

const seedCsv = path.join(SEED_DIR, "orders.csv");
const sources: TableSource[] = [
  { name: "orders", path: seedCsv },
  { name: "customers", path: path.join(SEED_DIR, "customers.csv") },
  { name: "products", path: path.join(SEED_DIR, "products.csv") },
];

interface CaseResult {
  pass: boolean;
  seconds: number;
  sqlCalls: number;
  answer: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Free-tier Gemini allows ~10 requests/min and each question costs 2-3 requests,
// so space the cases out; Groq's per-minute limits are looser.
const CASE_DELAY_MS = activeProvider === "gemini" ? 25_000 : 0;

async function runCase(c: GoldenCase): Promise<CaseResult> {
  const ws = await describeWorkspace(sources, seedCsv);
  let answer = "";
  let sqlCalls = 0;
  const start = Date.now();
  const emit = (e: AgentEvent) => {
    if (e.type === "text") answer += e.delta;
    if (e.type === "tool_call") sqlCalls++;
  };
  try {
    await runAgent(sources, seedCsv, ws, c.question, [], emit);
  } catch (err) {
    answer += ` [agent error: ${err instanceof Error ? err.message : err}]`;
  }
  return {
    pass: new RegExp(c.answer_regex, "i").test(answer),
    seconds: (Date.now() - start) / 1000,
    sqlCalls,
    answer,
  };
}

console.log(`Provider: ${activeProvider}\nDataset:  student_social_media (seed)\n`);

let passed = 0;
const failures: { c: GoldenCase; r: CaseResult }[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  if (i > 0 && CASE_DELAY_MS > 0) await sleep(CASE_DELAY_MS);
  let r = await runCase(c); // sequential — respects free-tier rate limits
  if (!r.pass && r.answer.includes('"code":429')) {
    console.log(`    rate-limited — waiting 60s and retrying case ${i + 1}...`);
    await sleep(60_000);
    r = await runCase(c);
  }
  if (r.pass) passed++;
  else failures.push({ c, r });
  const status = r.pass ? "PASS" : "FAIL";
  console.log(
    `${String(i + 1).padStart(2)}. [${status}] ${r.seconds.toFixed(1).padStart(5)}s  ${String(r.sqlCalls)} sql  ` +
    `(${c.concept}) ${c.question}`,
  );
}

console.log(`\n${passed}/${cases.length} passed (${Math.round((100 * passed) / cases.length)}%)`);
for (const { c, r } of failures) {
  console.log(`\nFAILED: ${c.question}\n  expected /${c.answer_regex}/i\n  answer: ${r.answer.slice(0, 300)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
