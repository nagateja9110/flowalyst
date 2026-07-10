import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_MODEL } from "./config.js";
import { geminiPool } from "./keypool.js";
import type { DatasetSchema } from "./db.js";

/**
 * Embeddings require Gemini specifically — Groq has no embedding endpoint.
 * Callers (retrieval.ts) treat any failure here as "retrieval unavailable"
 * and fall back to sending every table unfiltered, so a missing Gemini key
 * just disables retrieval — it never breaks the ability to answer.
 */

function isRateLimit(err: unknown): boolean {
  if ((err as { status?: number })?.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

/** embedContent through the key pool: a 429 benches the key and the call
 *  retries on the next one, mirroring the failover used for generation. */
export async function embedText(text: string): Promise<number[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, geminiPool.size()); attempt++) {
    const key = geminiPool.next();
    if (!key) break;
    try {
      const response = await new GoogleGenAI({ apiKey: key }).models.embedContent({
        model: EMBEDDING_MODEL,
        contents: [text],
      });
      const values = response.embeddings?.[0]?.values;
      if (!values) throw new Error("Embedding response contained no values");
      return values;
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      geminiPool.cooldown(key);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(
    `All Gemini keys are rate-limited; retry in ~${geminiPool.secondsUntilAvailable()}s`,
  );
}

/** Cosine similarity between two equal-length embedding vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * The text embedded per table: name, column names, and a few sample values —
 * built entirely from the schema already cached at upload, no extra LLM call
 * beyond the embedding itself.
 */
export function datasetDocument(name: string, schema: DatasetSchema): string {
  const columnNames = schema.columns.map((c) => c.name).join(", ");
  const sampleValues = schema.sampleRows
    .slice(0, 3)
    .flatMap((row) => Object.values(row))
    .map(String)
    .slice(0, 15)
    .join(", ");
  return `Table: ${name}\nColumns: ${columnNames}\nSample values: ${sampleValues}`;
}
