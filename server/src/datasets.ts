import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANIFEST_PATH, UPLOADS_DIR, SEED_DIR } from "./config.js";

export interface Dataset {
  id: string;
  name: string;
  filename: string;
  path: string;
  uploadedAt: string;
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
