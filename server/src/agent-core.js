import { queryWorkspace } from "./db.js";
import { validateSql, withLimit, UnsafeSqlError } from "./guardrails.js";

/**
 * Events forwarded to the client over SSE — one per agent step, so the UI can
 * render the self-correction loop live instead of only the final answer.
 * Both providers (Gemini, Groq) emit exactly this shape:
 *
 *   { type: "status", message: string }
 *   { type: "text", delta: string }
 *   { type: "tool_call", sql: string }
 *   { type: "tool_result", ok: boolean, rowCount?: number, error?: string }
 *   { type: "result", sql: string | null, columns: string[], rows: object[] }
 *   { type: "error", message: string }
 *   { type: "done" }
 *
 * `status` narrates what's about to happen before each LLM call — the only
 * points in the loop with no other visible signal, since both providers'
 * completion calls are single blocking round-trips (no token streaming).
 * Without it the client sees nothing between submit and the first tool call.
 *
 * @typedef {Object} AgentEvent
 */

/** What to tell the client is happening right before the next LLM call.
 *  @param {number} iteration
 *  @param {boolean} lastFailed Whether the most recent tool call (if any) errored.
 *  @returns {string} */
export function statusMessage(iteration, lastFailed) {
  if (iteration === 0) return "Reading the question and writing a SQL query…";
  if (lastFailed) return "That query failed — writing a corrected query…";
  return "Reviewing the results — deciding on a follow-up query…";
}

/**
 * A prior exchange, provider-agnostic. Each agent rebuilds its own message
 * format from this plain transcript — that's what makes follow-up questions
 * ("now break that down by gender") work across providers. `sql` is the query
 * behind that answer, replayed so a follow-up can build on it instead of
 * re-deriving the joins/filters from scratch.
 *
 * @typedef {Object} Exchange
 * @property {string} question
 * @property {string} answer
 * @property {string} [sql]
 */

/** Renders a prior exchange into the answer text sent back to the model, with
 *  the SQL appended as a hint when available.
 *  @param {Exchange} h */
export function historyAnswer(h) {
  return h.sql ? `${h.answer}\n[SQL used for that answer: ${h.sql}]` : h.answer;
}

/** Chooses which query result to display with the final answer. Prefers the
 *  last query that returned rows, so a trailing 0-row verification query can't
 *  blank out the table/chart the answer is actually about. */
export class ResultTracker {
  any = null;
  nonEmpty = null;

  record(sql, data) {
    this.any = { sql, data };
    if (data.rowCount > 0) this.nonEmpty = { sql, data };
  }

  display() {
    const r = this.nonEmpty ?? this.any;
    return { sql: r?.sql ?? null, columns: r?.data.columns ?? [], rows: r?.data.rows ?? [] };
  }
}

/**
 * Cross-cutting knobs both provider loops honour.
 * @typedef {Object} AgentRunOptions
 * @property {() => boolean} [isAborted] Returns true if the client has
 *   disconnected — the loop stops calling the LLM instead of burning quota
 *   into a dead socket.
 */

/**
 * Signature shared by every provider's agent loop:
 *   (sources, primaryPath, ws, question, history, emit, opts?) => Promise<void>
 * @typedef {(
 *   sources: import("./db.js").TableSource[],
 *   primaryPath: string,
 *   ws: import("./db.js").WorkspaceSchema,
 *   question: string,
 *   history: Exchange[],
 *   emit: (e: AgentEvent) => void,
 *   opts?: AgentRunOptions,
 * ) => Promise<void>} RunAgent
 */

export const SYSTEM_RULES =
  "You are Flowalyst, a data analyst agent. You answer questions about the user's datasets by writing " +
  "and running SQL via the run_sql tool, then explaining the result in plain language.\n" +
  "Rules:\n" +
  "- Always ground answers in query results; never invent numbers.\n" +
  "- The dialect is DuckDB. Query only the tables listed in the schema; you may JOIN across them.\n" +
  "- `data` is an alias for the currently selected table.\n" +
  "- A 'rate', 'ratio', 'proportion', or 'percentage' is a computed fraction " +
  "(matching rows / total rows), NOT a raw count. Rank by the fraction, not the count.\n" +
  "- Before computing a metric, check that the columns it needs exist in the schema. If a required " +
  "field is missing (e.g. there is no delivery/ship date to measure delivery time), state that the " +
  "data cannot answer the question — do not substitute a different column or fabricate a value.\n" +
  "- Keep the final answer concise: the key numbers and a one-sentence takeaway.\n" +
  "- If the question cannot be answered from these datasets, say so.";

export const RUN_SQL_DESCRIPTION =
  "Execute a read-only DuckDB SQL query against the datasets listed in the schema (JOINs across tables are allowed). " +
  "Call this whenever answering requires looking at the data — do not guess values. " +
  "Only a single SELECT (or WITH ... SELECT) statement is allowed. Results are capped at 1000 rows. " +
  "If the query errors, fix the query and try again.";

export function schemaText(ws) {
  const sections = ws.tables.map((t) => {
    const header = t.isPrimary
      ? `### ${t.table} (${t.rowCount} rows) — currently selected; also aliased as \`data\``
      : `### ${t.table} (${t.rowCount} rows)`;
    return (
      `${header}\nColumns:\n` +
      t.columns.map((c) => `- ${c.name} (${c.type})`).join("\n") +
      `\nSample rows:\n${JSON.stringify(t.sampleRows.slice(0, 3))}`
    );
  });
  return `## Available tables\n\n${sections.join("\n\n")}`;
}

/**
 * @typedef {Object} SqlExecution
 * @property {boolean} ok
 * @property {import("./db.js").QueryResult} [data]
 * @property {number} [rowCount]
 * @property {string} [error]
 * @property {string} modelPayload What goes back to the model as the tool result.
 */

/** Shared tool execution: guardrails → DuckDB workspace → model-facing payload.
 *  @returns {Promise<SqlExecution>} */
export async function executeRunSql(sources, primaryPath, sql) {
  try {
    const data = await queryWorkspace(sources, primaryPath, withLimit(validateSql(sql)));
    return {
      ok: true,
      data,
      rowCount: data.rowCount,
      modelPayload: JSON.stringify({ columns: data.columns, rows: data.rows.slice(0, 50), rowCount: data.rowCount }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      modelPayload: err instanceof UnsafeSqlError ? `Rejected by guardrails: ${message}` : `Query failed: ${message}`,
    };
  }
}
