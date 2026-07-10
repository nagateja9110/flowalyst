import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, UPLOADS_DIR, hasApiKey, provider } from "./config.js";
import {
  ensureDirs, registerSeeds, listDatasets, listDomains, getDataset, registerDataset, deleteDataset,
  saveDatasetSchema, ensureAllSchemas, ensureAllDomains,
} from "./datasets.js";
import { describeDataset, describeWorkspace, queryWorkspace, SUPPORTED_EXTENSIONS } from "./db.js";
import { validateSql, withLimit, UnsafeSqlError } from "./guardrails.js";
import { rateLimit } from "./rate-limit.js";
import { geminiPool, groqPool } from "./keypool.js";
import { runGroqAgent } from "./agent-groq.js";
import { runGeminiAgent } from "./agent-gemini.js";

/** Providers to try, in order, for one /api/ask request. If PROVIDER is
 *  forced via env, that's an explicit pin — respected with no fallback.
 *  Otherwise: every provider with at least one configured key is a candidate,
 *  Gemini preferred first, so a fully rate-limited Gemini pool falls through
 *  to Groq instead of just failing the request. */
function providerOrder() {
  const forced = process.env.PROVIDER;
  if (forced === "gemini" || forced === "groq") return [forced];
  const order = [];
  if (geminiPool.size() > 0) order.push("gemini");
  if (groqPool.size() > 0) order.push("groq");
  return order;
}

const AGENT_BY_PROVIDER = { gemini: runGeminiAgent, groq: runGroqAgent };
const POOL_BY_PROVIDER = { gemini: geminiPool, groq: groqPool };

/** Whether a provider's key pool has zero keys available right now (every key
 *  on cooldown). Checked against the pool's own state — via the non-mutating
 *  secondsUntilAvailable() — rather than by pattern-matching the error that
 *  just surfaced: when only the *last* key in a pool fails, the failover loop
 *  in each agent-*.js throws that key's own raw error, not the synthetic "all
 *  keys are rate-limited" wrapper, so message-matching would miss exactly the
 *  case this exists to catch. Any failure while the pool is provably empty is
 *  worth trying the next provider for. */
function isPoolExhausted(providerName) {
  const pool = POOL_BY_PROVIDER[providerName];
  return pool.size() > 0 && pool.secondsUntilAvailable() > 0;
}

ensureDirs();
registerSeeds();
ensureAllDomains();       // backfill domain on pre-domain-folder manifest entries
await ensureAllSchemas(); // compute + cache schemas once, so /api/ask never re-introspects

const app = express();
app.set("trust proxy", 1); // behind Render's proxy: req.ip reflects X-Forwarded-For
app.use(express.json());

// LLM endpoint is expensive (paid quota) → tight bucket. Local SQL is cheap → looser.
const askLimiter = rateLimit({ capacity: 5, refillPerSec: 1 / 6, name: "/api/ask" }); // ~10/min sustained, burst 5
const queryLimiter = rateLimit({ capacity: 30, refillPerSec: 2, name: "/api/query" });
const uploadLimiter = rateLimit({ capacity: 10, refillPerSec: 1 / 6, name: "/api/datasets" });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^\w.-]/g, "_");
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ hasApiKey: hasApiKey(), provider: provider() }));

app.get("/api/datasets", (_req, res) => res.json(listDatasets()));
app.get("/api/domains", (_req, res) => res.json(listDomains()));

app.post("/api/datasets", uploadLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });
  const lower = req.file.originalname.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return res.status(400).json({ error: `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}` });
  }
  const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/, "");
  const domain = req.body.domain || undefined;
  const dataset = registerDataset(name, req.file.path, domain);
  try {
    // Validate the CSV parses, and cache the schema in the same pass.
    const schema = await describeDataset(dataset.path);
    saveDatasetSchema(dataset.id, schema);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err instanceof Error ? err.message : err}` });
  }
  res.status(201).json(dataset);
});

app.get("/api/datasets/:id/schema", async (req, res) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  try {
    res.json(dataset.schema ?? await describeDataset(dataset.path));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/datasets/:id", (req, res) => {
  const ok = deleteDataset(String(req.params.id));
  if (!ok) return res.status(404).json({ error: "Dataset not found" });
  res.status(204).end();
});

// Only datasets filed under the same domain as `domain` are ever returned —
// a hard boundary, so two same-named tables in different domains (e.g. two
// "users" tables) can never be ambiguous or cross-contaminate a workspace.
function sourcesInDomain(domain) {
  return listDatasets()
    .filter((d) => d.domain === domain)
    .map((d) => ({ name: d.name, path: d.path, schema: d.schema }));
}

// Raw SQL endpoint — also the no-API-key fallback path. Every dataset in the
// same domain is a named view; `data` aliases the dataset in the URL, so
// JOINs work here too (scoped to that domain only).
app.post("/api/datasets/:id/query", queryLimiter, async (req, res) => {
  const dataset = getDataset(String(req.params.id));
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  const sql = String(req.body?.sql ?? "");
  try {
    const result = await queryWorkspace(sourcesInDomain(dataset.domain), dataset.path, withLimit(validateSql(sql)));
    res.json({ sql, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof UnsafeSqlError ? 400 : 422).json({ error: message });
  }
});

// Natural-language question → agent loop, streamed over SSE.
app.post("/api/ask", askLimiter, async (req, res) => {
  const { datasetId, question, history } = req.body ?? {};
  const dataset = getDataset(String(datasetId));
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing question" });
  }

  // Prior Q/A pairs from the client → follow-up questions keep their context.
  // Capped at 8 exchanges to bound token growth.
  const exchanges = (Array.isArray(history) ? history : [])
    .filter((h) => typeof h?.question === "string" && typeof h?.answer === "string")
    .slice(-8);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // If the client closes the tab/connection mid-answer, stop the agent loop so
  // we don't keep making paid LLM calls into a socket nobody is reading.
  let aborted = false;
  res.on("close", () => { aborted = true; });

  // Track whether anything has reached the client yet — failover between
  // providers is only safe before the first byte, so a mid-answer switch can
  // never mix partial output from two different models in one response.
  let emittedAny = false;
  const emit = (e) => {
    if (aborted) return;
    emittedAny = true;
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  const providers = providerOrder();
  if (providers.length === 0) {
    emit({
      type: "error",
      message:
        "No LLM API key is set (GEMINI_API_KEY/GEMINI_API_KEYS or GROQ_API_KEY/GROQ_API_KEYS) — natural-language questions are unavailable. " +
        "Use manual SQL mode instead (the query box below).",
    });
    emit({ type: "done" });
    return res.end();
  }

  try {
    // Scoped to the selected dataset's domain — every table in that domain
    // goes to the agent, nothing outside it ever does.
    const sources = sourcesInDomain(dataset.domain);
    const ws = await describeWorkspace(sources, dataset.path);

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const runAgent = AGENT_BY_PROVIDER[p];
      const isLastProvider = i === providers.length - 1;
      try {
        await runAgent(sources, dataset.path, ws, question, exchanges, emit, { isAborted: () => aborted });
        break; // this provider handled the request (success or its own {type:"error"})
      } catch (err) {
        if (isPoolExhausted(p) && !emittedAny && !isLastProvider) {
          console.warn(`[failover] ${p}'s key pool is exhausted with no output sent yet — falling back to ${providers[i + 1]}`);
          continue; // nothing shown to the client yet, safe to retry on the next provider
        }
        throw err; // a real error, or exhaustion with no fallback left — surface it
      }
    }
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  if (!aborted) {
    emit({ type: "done" });
    res.end();
  }
});

// Production: serve the built client from the same service (single deploy).
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Flowalyst server listening on http://localhost:${PORT} (agent: ${provider() ?? "off — manual SQL only"})`);
});
