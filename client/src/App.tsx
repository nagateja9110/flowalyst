import { useEffect, useRef, useState } from "react";
import type { Dataset, DatasetSchema } from "./types";
import { fetchConfig, fetchDatasets, fetchSchema, uploadDataset, deleteDataset } from "./lib/api";
import { Chat } from "./components/Chat";

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [schema, setSchema] = useState<DatasetSchema | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchConfig().then((c) => {
      setHasApiKey(c.hasApiKey);
      setProvider(c.provider);
    });
    fetchDatasets().then((ds) => {
      setDatasets(ds);
      if (ds.length > 0) setSelected(ds[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setSchema(null);
    fetchSchema(selected).then(setSchema).catch(() => setSchema(null));
  }, [selected]);

  async function onDelete(id: string) {
    if (!confirm("Delete this dataset? This can't be undone.")) return;
    await deleteDataset(id);
    setDatasets((prev) => {
      const remaining = prev.filter((d) => d.id !== id);
      if (selected === id) setSelected(remaining[0]?.id ?? null);
      return remaining;
    });
  }

  async function onUpload(file: File) {
    setUploadError(null);
    try {
      const d = await uploadDataset(file);
      setDatasets((ds) => [...ds, d]);
      setSelected(d.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="" className="h-7 w-7 rounded-lg" />
          <h1 className="text-lg font-semibold tracking-tight">
            Flow<span className="text-emerald-400">alyst</span>
          </h1>
          <span className="hidden text-xs text-zinc-500 sm:inline">ask your CSV anything</span>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs ${
            hasApiKey
              ? "border-emerald-700 bg-emerald-950/60 text-emerald-300"
              : "border-amber-700 bg-amber-950/60 text-amber-300"
          }`}
        >
          {hasApiKey ? `agent mode · ${provider === "gemini" ? "Gemini" : "Groq"}` : "manual SQL mode"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
          <div className="border-b border-zinc-800 p-3">
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full rounded-lg border border-dashed border-zinc-700 py-2 text-sm text-zinc-400 hover:border-emerald-600 hover:text-emerald-300"
            >
              + Upload CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
            {uploadError && <div className="mt-2 text-xs text-rose-400">{uploadError}</div>}
          </div>

          <div className="p-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Datasets</div>
            {datasets.map((d) => (
              <div
                key={d.id}
                className={`group mb-1 flex items-center rounded-md text-sm ${
                  selected === d.id ? "bg-emerald-900/40 text-emerald-200" : "text-zinc-300 hover:bg-zinc-900"
                }`}
              >
                <button
                  onClick={() => setSelected(d.id)}
                  className="flex-1 truncate px-2 py-1.5 text-left"
                >
                  {d.name}
                </button>
                <button
                  onClick={() => onDelete(d.id)}
                  title="Delete dataset"
                  className="px-2 py-1.5 text-zinc-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}
            {datasets.length === 0 && <div className="text-xs text-zinc-600">No datasets yet</div>}
          </div>

          {schema && (
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-zinc-800 p-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Schema · {schema.rowCount.toLocaleString()} rows
              </div>
              {schema.columns.map((c) => (
                <div key={c.name} className="flex justify-between py-0.5 text-xs">
                  <span className="truncate font-mono text-zinc-300">{c.name}</span>
                  <span className="ml-2 shrink-0 text-zinc-600">{c.type.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="min-w-0 flex-1">
          {selected ? (
            <Chat key={selected} datasetId={selected} hasApiKey={hasApiKey} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Upload a CSV to get started
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
