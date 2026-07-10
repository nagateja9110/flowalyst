import { useEffect, useRef, useState } from "react";
import { fetchConfig, fetchDatasets, fetchDomains, fetchSchema, uploadDataset, deleteDataset } from "./lib/api";
import { Chat } from "./components/Chat";

const NEW_DOMAIN = "__new__";

export default function App() {
  const [datasets, setDatasets] = useState([]);
  const [domains, setDomains] = useState([]);
  const [selected, setSelected] = useState(null);
  const [schema, setSchema] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [provider, setProvider] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [domainChoice, setDomainChoice] = useState("");
  const [newDomainName, setNewDomainName] = useState("");
  const [collapsedDomains, setCollapsedDomains] = useState(() => new Set());
  const fileRef = useRef(null);

  function toggleDomain(domain) {
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  useEffect(() => {
    fetchConfig().then((c) => {
      setHasApiKey(c.hasApiKey);
      setProvider(c.provider);
    });
    fetchDatasets().then((ds) => {
      setDatasets(ds);
      if (ds.length > 0) setSelected(ds[0].id);
    });
    fetchDomains().then(setDomains);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setSchema(null);
    fetchSchema(selected).then(setSchema).catch(() => setSchema(null));
  }, [selected]);

  async function onDelete(id) {
    if (!confirm("Delete this dataset? This can't be undone.")) return;
    await deleteDataset(id);
    setDatasets((prev) => {
      const remaining = prev.filter((d) => d.id !== id);
      if (selected === id) setSelected(remaining[0]?.id ?? null);
      return remaining;
    });
    fetchDomains().then(setDomains); // a domain can disappear once its last dataset is gone
  }

  function pickFile(file) {
    setUploadError(null);
    setPendingFile(file);
    setDomainChoice(domains[0] ?? NEW_DOMAIN);
    setNewDomainName("");
  }

  function cancelUpload() {
    setPendingFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function confirmUpload() {
    const domain = domainChoice === NEW_DOMAIN ? newDomainName.trim() : domainChoice;
    if (!domain) {
      setUploadError("Pick or name a domain first.");
      return;
    }
    setUploadError(null);
    try {
      const d = await uploadDataset(pendingFile, domain);
      setDatasets((ds) => [...ds, d]);
      setSelected(d.id);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = "";
      fetchDomains().then(setDomains);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }

  const groups = new Map();
  for (const d of datasets) {
    const domain = d.domain || "General";
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(d);
  }

  // The folder (domain) currently being queried is just the selected
  // dataset's domain — picking a different folder jumps to its first table.
  const currentDataset = datasets.find((d) => d.id === selected);
  const currentDomain = currentDataset?.domain ?? "";

  function onFolderChange(domain) {
    const first = groups.get(domain)?.[0];
    if (first) setSelected(first.id);
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      next.delete(domain); // jumping into a folder should reveal its tables
      return next;
    });
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
              onChange={(e) => e.target.files?.[0] && pickFile(e.target.files[0])}
            />

            {pendingFile && (
              <div className="mt-2 space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
                <div className="truncate text-xs text-zinc-400">{pendingFile.name}</div>
                <select
                  value={domainChoice}
                  onChange={(e) => setDomainChoice(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-600"
                >
                  {domains.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                  <option value={NEW_DOMAIN}>+ New domain…</option>
                </select>
                {domainChoice === NEW_DOMAIN && (
                  <input
                    value={newDomainName}
                    onChange={(e) => setNewDomainName(e.target.value)}
                    placeholder="Domain name"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-600"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    onClick={confirmUpload}
                    className="flex-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium hover:bg-emerald-500"
                  >
                    Upload
                  </button>
                  <button
                    onClick={cancelUpload}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {uploadError && <div className="mt-2 text-xs text-rose-400">{uploadError}</div>}
          </div>

          {domains.length > 0 && (
            <div className="border-b border-zinc-800 p-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Folder to query</div>
              <select
                value={currentDomain}
                onChange={(e) => onFolderChange(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-emerald-600"
              >
                {domains.map((d) => (
                  <option key={d} value={d}>{d} ({groups.get(d)?.length ?? 0})</option>
                ))}
              </select>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {[...groups.entries()].map(([domain, ds]) => {
              // The active folder (whatever's currently being queried) always
              // shows its tables — collapsing only applies to the others.
              const collapsed = collapsedDomains.has(domain) && domain !== currentDomain;
              return (
                <div key={domain} className="mb-3">
                  <button
                    onClick={() => toggleDomain(domain)}
                    className="mb-1 flex w-full items-center gap-1 text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
                  >
                    <span className="inline-block w-3">{collapsed ? "▸" : "▾"}</span>
                    {domain}
                    <span className="text-zinc-600">({ds.length})</span>
                  </button>
                  {!collapsed && ds.map((d) => (
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
                </div>
              );
            })}
            {datasets.length === 0 && <div className="text-xs text-zinc-600">No datasets yet</div>}
          </div>

          {schema && (
            <div className="max-h-64 min-h-0 shrink-0 overflow-y-auto border-t border-zinc-800 p-3">
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
