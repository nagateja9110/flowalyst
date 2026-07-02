import type { AgentEvent, Dataset, DatasetSchema, QueryResult } from "../types";

export async function fetchConfig(): Promise<{ hasApiKey: boolean; provider: "anthropic" | "gemini" | null }> {
  return (await fetch("/api/config")).json();
}

export async function fetchDatasets(): Promise<Dataset[]> {
  return (await fetch("/api/datasets")).json();
}

export async function uploadDataset(file: File): Promise<Dataset> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/datasets", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
  return res.json();
}

export async function fetchSchema(id: string): Promise<DatasetSchema> {
  const res = await fetch(`/api/datasets/${id}/schema`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Schema failed");
  return res.json();
}

export async function runSql(id: string, sql: string): Promise<QueryResult & { rowCount: number }> {
  const res = await fetch(`/api/datasets/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Query failed");
  return body;
}

export interface Exchange {
  question: string;
  answer: string;
}

/** POST /api/ask and invoke onEvent for each SSE `data:` line. */
export async function ask(
  datasetId: string,
  question: string,
  history: Exchange[],
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId, question, history }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data: ")) {
        onEvent(JSON.parse(line.slice(6)) as AgentEvent);
      }
    }
  }
}
