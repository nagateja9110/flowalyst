import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, UPLOADS_DIR, hasApiKey, provider } from "./config.js";
import { ensureDirs, registerSeeds, listDatasets, getDataset, registerDataset } from "./datasets.js";
import { describeDataset, describeWorkspace, queryWorkspace, type TableSource } from "./db.js";
import { validateSql, withLimit, UnsafeSqlError } from "./guardrails.js";
import type { AgentEvent, Exchange } from "./agent-core.js";
import { runAnthropicAgent } from "./agent.js";
import { runGeminiAgent } from "./agent-gemini.js";

ensureDirs();
registerSeeds();

const app = express();
app.use(express.json());

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

app.post("/api/datasets", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });
  if (!req.file.originalname.toLowerCase().endsWith(".csv")) {
    return res.status(400).json({ error: "Only .csv files are supported" });
  }
  const name = (req.body.name as string) || req.file.originalname.replace(/\.csv$/i, "");
  const dataset = registerDataset(name, req.file.path);
  try {
    // Validate the CSV parses before accepting it.
    await describeDataset(dataset.path);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err instanceof Error ? err.message : err}` });
  }
  res.status(201).json(dataset);
});

app.get("/api/datasets/:id/schema", async (req, res) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  try {
    res.json(await describeDataset(dataset.path));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function allSources(): TableSource[] {
  return listDatasets().map((d) => ({ name: d.name, path: d.path }));
}

// Raw SQL endpoint — also the no-API-key fallback path. Every dataset is a
// named view; `data` aliases the dataset in the URL, so JOINs work here too.
app.post("/api/datasets/:id/query", async (req, res) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  const sql = String(req.body?.sql ?? "");
  try {
    const result = await queryWorkspace(allSources(), dataset.path, withLimit(validateSql(sql)));
    res.json({ sql, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof UnsafeSqlError ? 400 : 422).json({ error: message });
  }
});

// Natural-language question → agent loop, streamed over SSE.
app.post("/api/ask", async (req, res) => {
  const { datasetId, question, history } = req.body ?? {};
  const dataset = getDataset(String(datasetId));
  if (!dataset) return res.status(404).json({ error: "Dataset not found" });
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing question" });
  }

  // Prior Q/A pairs from the client → follow-up questions keep their context.
  // Capped at 8 exchanges to bound token growth.
  const exchanges: Exchange[] = (Array.isArray(history) ? history : [])
    .filter((h): h is Exchange => typeof h?.question === "string" && typeof h?.answer === "string")
    .slice(-8);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const emit = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  const activeProvider = provider();
  if (!activeProvider) {
    emit({
      type: "error",
      message:
        "No LLM API key is set (ANTHROPIC_API_KEY or GEMINI_API_KEY) — natural-language questions are unavailable. " +
        "Use manual SQL mode instead (the query box below).",
    });
    emit({ type: "done" });
    return res.end();
  }

  try {
    const sources = allSources();
    const ws = await describeWorkspace(sources, dataset.path);
    const runAgent = activeProvider === "gemini" ? runGeminiAgent : runAnthropicAgent;
    await runAgent(sources, dataset.path, ws, question, exchanges, emit);
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  emit({ type: "done" });
  res.end();
});

// Production: serve the built client from the same service (single deploy).
// Resolves to <repo>/client/dist from both src/ (tsx dev) and dist/ (compiled).
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Flowalyst server listening on http://localhost:${PORT} (agent: ${provider() ?? "off — manual SQL only"})`);
});
