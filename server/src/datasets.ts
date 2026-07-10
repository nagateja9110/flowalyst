import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANIFEST_PATH, UPLOADS_DIR, SEED_DIR } from "./config.js";
import { describeDataset, type DatasetSchema } from "./db.js";
import { embedText, datasetDocument } from "./embeddings.js";

export interface Dataset {
  id: string;
  name: string;
  filename: string;
  path: string;
  uploadedAt: string;
  /** Column/sample/row-count schema, computed once at upload and cached here so
   *  /api/ask doesn't re-introspect every CSV on every request. */
  schema?: DatasetSchema;
  /** Embedding of the table's name/columns/sample values, computed once and
   *  cached here so RAG table retrieval (see retrieval.ts) only has to embed
   *  the incoming question, not every dataset, on each request. */
  embedding?: number[];
}

function readManifest(): Dataset[] {
  if (!fs.existsSync(MANIFEST_PATH)) return [];
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Dataset[];
}

function writeManifest(datasets: Dataset[]) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(datasets, null, 2));
}

export function listDatasets(): Dataset[] {
  return readManifest();
}

export function getDataset(id: string): Dataset | undefined {
  return readManifest().find((d) => d.id === id);
}

export function registerDataset(name: string, storedPath: string): Dataset {
  const dataset: Dataset = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    filename: path.basename(storedPath),
    path: storedPath,
    uploadedAt: new Date().toISOString(),
  };
  writeManifest([...readManifest(), dataset]);
  return dataset;
}

/** Remove a dataset from the manifest. Physically deletes the file only if it
 *  lives under the uploads dir — seed files are demo data and are left on disk
 *  (a deleted seed simply re-registers on the next restart). */
export function deleteDataset(id: string): boolean {
  const datasets = readManifest();
  const target = datasets.find((d) => d.id === id);
  if (!target) return false;
  writeManifest(datasets.filter((d) => d.id !== id));
  const resolved = path.resolve(target.path);
  if (resolved.startsWith(path.resolve(UPLOADS_DIR) + path.sep) && fs.existsSync(resolved)) {
    try { fs.unlinkSync(resolved); } catch { /* best effort */ }
  }
  return true;
}

/** Persist a computed schema onto a dataset in the manifest. */
export function saveDatasetSchema(id: string, schema: DatasetSchema): void {
  const datasets = readManifest();
  const d = datasets.find((x) => x.id === id);
  if (!d) return;
  d.schema = schema;
  writeManifest(datasets);
}

/** Compute + cache the schema for any dataset that doesn't have one yet.
 *  Called at startup so seeds (and manifests from before this feature) are
 *  backfilled once instead of on every request. */
export async function ensureAllSchemas(): Promise<void> {
  // Snapshot only the ids/paths to backfill, then persist each via
  // saveDatasetSchema (an atomic re-read + write). Holding one snapshot across
  // the awaits below and writing it back at the end would clobber any dataset
  // registered concurrently — this avoids that lost-update entirely.
  const pending = readManifest().filter((d) => !d.schema).map((d) => ({ id: d.id, path: d.path }));
  for (const d of pending) {
    try {
      const schema = await describeDataset(d.path);
      saveDatasetSchema(d.id, schema);
    } catch {
      /* unreadable file — leave uncached; describeWorkspace will surface it */
    }
  }
}

/** Persist a computed embedding onto a dataset in the manifest. */
export function saveDatasetEmbedding(id: string, embedding: number[]): void {
  const datasets = readManifest();
  const d = datasets.find((x) => x.id === id);
  if (!d) return;
  d.embedding = embedding;
  writeManifest(datasets);
}

/** Compute + cache an embedding for any dataset that has a schema but no
 *  embedding yet. Requires Gemini (no Groq equivalent) — if it's unavailable
 *  for any dataset, that dataset is simply left uncached; retrieval.ts treats
 *  an unranked table as "include it" rather than "exclude it". */
export async function ensureAllEmbeddings(): Promise<void> {
  const pending = readManifest()
    .filter((d) => d.schema && !d.embedding)
    .map((d) => ({ id: d.id, name: d.name, schema: d.schema! }));
  for (const d of pending) {
    try {
      const embedding = await embedText(datasetDocument(d.name, d.schema));
      saveDatasetEmbedding(d.id, embedding);
    } catch (err) {
      // No Gemini key / embedding unavailable — dataset stays unranked, not
      // excluded (see retrieval.ts). Logged because a silent failure here
      // (e.g. a stale model name) would otherwise be invisible.
      console.warn(`[embeddings] could not embed "${d.name}":`, err instanceof Error ? err.message : err);
    }
  }
}

/** Register any CSVs in data/seed/ that aren't in the manifest yet. */
export function registerSeeds() {
  if (!fs.existsSync(SEED_DIR)) return;
  const existing = new Set(readManifest().map((d) => d.path));
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith(".csv")) continue;
    const full = path.join(SEED_DIR, file);
    if (!existing.has(full)) {
      registerDataset(file.replace(/\.csv$/, ""), full);
    }
  }
}

export function ensureDirs() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
}
