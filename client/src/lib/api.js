export async function fetchConfig() {
  return (await fetch("/api/config")).json();
}

export async function fetchDatasets() {
  return (await fetch("/api/datasets")).json();
}

export async function uploadDataset(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/datasets", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
  return res.json();
}

export async function fetchSchema(id) {
  const res = await fetch(`/api/datasets/${id}/schema`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Schema failed");
  return res.json();
}

export async function deleteDataset(id) {
  const res = await fetch(`/api/datasets/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error("Delete failed");
}

export async function runSql(id, sql) {
  const res = await fetch(`/api/datasets/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Query failed");
  return body;
}

/**
 * A prior exchange sent back to the agent so follow-up questions have context:
 * { question: string, answer: string, sql?: string }
 */

/** POST /api/ask and invoke onEvent for each SSE `data:` line. */
export async function ask(datasetId, question, history, onEvent) {
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
        onEvent(JSON.parse(line.slice(6)));
      }
    }
  }
}
