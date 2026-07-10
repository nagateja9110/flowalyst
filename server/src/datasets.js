import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANIFEST_PATH, UPLOADS_DIR, SEED_DIR, DEFAULT_DOMAIN } from "./config.js";
import { describeDataset } from "./db.js";

/**
 * @typedef {Object} Dataset
 * @property {string} id
 * @property {string} name
 * @property {string} filename
 * @property {string} path
 * @property {string} domain Named workspace this dataset belongs to. Only
 *   datasets in the same domain are ever loaded together for a question —
 *   a hard boundary instead of a similarity score, so cross-domain name
 *   collisions (e.g. two unrelated "users" tables) can never be ambiguous.
 * @property {string} uploadedAt
 * @property {import("./db.js").DatasetSchema} [schema] Column/sample/row-count
 *   schema, computed once at upload and cached here so /api/ask doesn't
 *   re-introspect every CSV on every request.
 */

/** Seed CSVs that ship in the repo aren't self-describing about which domain
 *  they belong to, so filename -> domain (and optional display name override,
 *  for cases like two files both representing a table called "users") is
 *  mapped explicitly here. */
const SEED_DOMAINS = {
  "customers.csv": { domain: "E-commerce" },
  "orders.csv": { domain: "E-commerce" },
  "products.csv": { domain: "E-commerce" },
  "ecommerce_users.csv": { domain: "E-commerce", name: "users" },
  "movies.csv": { domain: "Movies" },
  "movies_users.csv": { domain: "Movies", name: "users" },
  "employees.csv": { domain: "HR" },
};

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return [];
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function writeManifest(datasets) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(datasets, null, 2));
}

export function listDatasets() {
  return readManifest();
}

/** Every domain name currently in use, sorted alphabetically. Derived from
 *  the datasets themselves rather than stored separately — a domain exists
 *  exactly as long as something is filed under it. */
export function listDomains() {
  return [...new Set(readManifest().map((d) => d.domain || DEFAULT_DOMAIN))].sort();
}

export function getDataset(id) {
  return readManifest().find((d) => d.id === id);
}

export function registerDataset(name, storedPath, domain) {
  const dataset = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    filename: path.basename(storedPath),
    path: storedPath,
    domain: domain || DEFAULT_DOMAIN,
    uploadedAt: new Date().toISOString(),
  };
  writeManifest([...readManifest(), dataset]);
  return dataset;
}

/** Remove a dataset from the manifest. Physically deletes the file only if it
 *  lives under the uploads dir — seed files are demo data and are left on disk
 *  (a deleted seed simply re-registers on the next restart). */
export function deleteDataset(id) {
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
export function saveDatasetSchema(id, schema) {
  const datasets = readManifest();
  const d = datasets.find((x) => x.id === id);
  if (!d) return;
  d.schema = schema;
  writeManifest(datasets);
}

/** Compute + cache the schema for any dataset that doesn't have one yet.
 *  Called at startup so seeds (and manifests from before this feature) are
 *  backfilled once instead of on every request. */
export async function ensureAllSchemas() {
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

/** Backfill `domain` on any manifest entry that predates the domain-folder
 *  feature (and drop the now-unused `embedding` field RAG left behind).
 *  Seed files get their real domain from SEED_DOMAINS by filename; anything
 *  else (a prior upload) falls into DEFAULT_DOMAIN. */
export function ensureAllDomains() {
  const datasets = readManifest();
  let changed = false;
  for (const d of datasets) {
    if ("embedding" in d) { delete d.embedding; changed = true; }
    if (!d.domain) {
      d.domain = SEED_DOMAINS[path.basename(d.path)]?.domain ?? DEFAULT_DOMAIN;
      changed = true;
    }
  }
  if (changed) writeManifest(datasets);
}

/** Register any CSVs in data/seed/ that aren't in the manifest yet. */
export function registerSeeds() {
  if (!fs.existsSync(SEED_DIR)) return;
  const existing = new Set(readManifest().map((d) => d.path));
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith(".csv")) continue;
    const full = path.join(SEED_DIR, file);
    if (!existing.has(full)) {
      const meta = SEED_DOMAINS[file] ?? {};
      registerDataset(meta.name ?? file.replace(/\.csv$/, ""), full, meta.domain);
    }
  }
}

export function ensureDirs() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
}
