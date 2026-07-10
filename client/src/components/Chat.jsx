import { useEffect, useRef, useState } from "react";
import { ask, runSql } from "../lib/api";
import { ResultTable } from "./ResultTable";
import { ResultChart } from "./ResultChart";
import { Sql } from "./Sql";

// Conversations survive reloads: persisted per dataset in localStorage,
// capped so big result tables can't blow the ~5MB storage quota.
const STORAGE_PREFIX = "flowalyst-chat-";
const MAX_STORED_MESSAGES = 30;
const MAX_STORED_ROWS = 200;

function loadMessages(datasetId) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + datasetId);
    if (!raw) return [];
    // A reload can never resurrect an in-flight request.
    return JSON.parse(raw).map((m) => ({ ...m, pending: false }));
  } catch {
    return [];
  }
}

function saveMessages(datasetId, messages) {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + datasetId);
      return;
    }
    const slim = messages.slice(-MAX_STORED_MESSAGES).map((m) =>
      m.result && m.result.rows.length > MAX_STORED_ROWS
        ? { ...m, result: { ...m.result, rows: m.result.rows.slice(0, MAX_STORED_ROWS) } }
        : m,
    );
    localStorage.setItem(STORAGE_PREFIX + datasetId, JSON.stringify(slim));
  } catch {
    /* storage full or unavailable — the chat just won't survive a reload */
  }
}

function TraceCard({ step, index }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-zinc-400">
        <span className="font-mono">query #{index + 1}</span>
        {step.ok === undefined ? (
          <span className="text-amber-400 animate-pulse">running…</span>
        ) : step.ok ? (
          <span className="text-emerald-400">✓ {step.rowCount} rows</span>
        ) : (
          <span className="text-rose-400">✗ failed — retrying</span>
        )}
      </div>
      <div className="mt-1">
        <Sql code={step.sql} />
      </div>
      {step.error && <div className="mt-1 text-rose-400/90">{step.error}</div>}
    </div>
  );
}

// A narration line ("writing a query…", "that failed — correcting…") for the
// gap before each LLM call, when there's otherwise nothing to show — the
// completion APIs are single blocking round-trips, not token streams.
function StatusLine({ text, active }) {
  return (
    <div className={`flex items-center gap-2 px-1 text-xs text-zinc-500 ${active ? "animate-pulse" : ""}`}>
      <span className="text-zinc-600">›</span>
      <span>{text}</span>
    </div>
  );
}

function SqlBlock({ sql }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button onClick={() => setOpen(!open)} className="text-zinc-500 hover:text-zinc-300">
        {open ? "▾" : "▸"} SQL used
      </button>
      {open && (
        <div className="mt-1 flex items-start gap-2">
          <div className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 p-2">
            <Sql code={sql} />
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(sql)}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:text-zinc-200"
            title="Copy SQL"
          >
            copy
          </button>
        </div>
      )}
    </div>
  );
}

function Message({ m }) {
  if (m.role === "user") {
    return (
      <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-700/30 border border-emerald-700/40 px-4 py-2 text-sm">
        {m.text}
      </div>
    );
  }
  let queryIndex = -1;
  return (
    <div className="max-w-[95%] space-y-2">
      {m.trace.map((s, i) => {
        const isLast = i === m.trace.length - 1;
        if (s.kind === "status") return <StatusLine key={i} text={s.message} active={m.pending && isLast} />;
        queryIndex += 1;
        return <TraceCard key={i} step={s} index={queryIndex} />;
      })}
      {m.text && <div className="whitespace-pre-wrap text-sm text-zinc-200">{m.text}</div>}
      {m.pending && !m.text && m.trace.length === 0 && (
        <div className="text-sm text-zinc-500 animate-pulse">thinking…</div>
      )}
      {m.error && (
        <div className="rounded-md border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">{m.error}</div>
      )}
      {m.result && m.result.rows.length > 0 && (
        <div className="space-y-2">
          <ResultChart columns={m.result.columns} rows={m.result.rows} />
          <ResultTable columns={m.result.columns} rows={m.result.rows} />
          {m.result.sql && <SqlBlock sql={m.result.sql} />}
        </div>
      )}
    </div>
  );
}

export function Chat({ datasetId, hasApiKey }) {
  const [messages, setMessages] = useState(() => loadMessages(datasetId));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    // Skip mid-stream saves (a write per token delta); the final state is
    // saved when the last message settles to pending: false.
    if (messages[messages.length - 1]?.pending) return;
    saveMessages(datasetId, messages);
  }, [datasetId, messages]);

  function clearChat() {
    setMessages([]); // the save effect removes the stored copy
  }

  const scroll = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  const patchLast = (fn) =>
    setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function submit() {
    const question = input.trim();
    if (!question || busy) return;
    // Prior Q/A pairs → the agent sees the conversation, so follow-ups like
    // "now break that down by gender" resolve against earlier answers.
    const history = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const u = messages[i];
      const a = messages[i + 1];
      if (u.role === "user" && a.role === "assistant" && a.text && !a.error) {
        history.push({ question: u.text, answer: a.text, sql: a.result?.sql ?? undefined });
      }
    }
    setInput("");
    setBusy(true);
    setMessages((ms) => [
      ...ms,
      { role: "user", text: question, trace: [] },
      { role: "assistant", text: "", trace: [], pending: true },
    ]);
    scroll();

    try {
      if (hasApiKey) {
        await ask(datasetId, question, history, (e) => {
          patchLast((m) => {
            switch (e.type) {
              case "status":
                return { ...m, trace: [...m.trace, { kind: "status", message: e.message }] };
              case "text":
                return { ...m, text: m.text + e.delta };
              case "tool_call":
                return { ...m, trace: [...m.trace, { kind: "query", sql: e.sql }] };
              case "tool_result": {
                const trace = [...m.trace];
                const last = trace[trace.length - 1];
                if (last) trace[trace.length - 1] = { ...last, ok: e.ok, rowCount: e.rowCount, error: e.error };
                return { ...m, trace };
              }
              case "result":
                return { ...m, result: { sql: e.sql, columns: e.columns, rows: e.rows } };
              case "error":
                return { ...m, error: e.message };
              case "done":
                return { ...m, pending: false };
              default:
                return m;
            }
          });
          scroll();
        });
      } else {
        // Manual mode: the input is raw SQL, executed directly.
        const r = await runSql(datasetId, question);
        patchLast((m) => ({
          ...m,
          pending: false,
          text: `${r.rowCount} row${r.rowCount === 1 ? "" : "s"}`,
          result: { sql: r.sql, columns: r.columns, rows: r.rows },
        }));
      }
    } catch (err) {
      patchLast((m) => ({ ...m, pending: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setBusy(false);
      scroll();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mt-16 text-center text-sm text-zinc-500">
            {hasApiKey ? (
              <>Ask a question about this dataset, e.g.<br />
                <span className="text-zinc-400">“Which city generated the most revenue from delivered orders?”</span></>
            ) : (
              <>Manual SQL mode (no GEMINI or GROQ API key set).<br />
                Try: <span className="font-mono text-zinc-400">SELECT * FROM data LIMIT 10</span></>
            )}
          </div>
        )}
        {messages.map((m, i) => <Message key={i} m={m} />)}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-800 p-3">
        <div className="flex gap-2">
          {messages.length > 0 && !busy && (
            <button
              onClick={clearChat}
              title="Clear conversation"
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
            >
              clear
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={hasApiKey ? "Ask a question in plain English…" : "Write a SELECT query…"}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
          <button
            onClick={submit}
            disabled={busy || !input.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-emerald-500"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}
