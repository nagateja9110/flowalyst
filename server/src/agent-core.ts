import { queryWorkspace, type TableSource, type WorkspaceSchema, type QueryResult } from "./db.js";
import { validateSql, withLimit, UnsafeSqlError } from "./guardrails.js";

/** Events forwarded to the client over SSE — one per agent step, so the UI can
 *  render the self-correction loop live instead of only the final answer.
 *  Both providers (Gemini, Groq) emit exactly this shape. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; sql: string }
  | { type: "tool_result"; ok: boolean; rowCount?: number; error?: string }
  | { type: "result"; sql: string | null; columns: string[]; rows: Record<string, unknown>[] }
  | { type: "error"; message: string }
  | { type: "done" };

/** A prior exchange, provider-agnostic. Each agent rebuilds its own message
 *  format from this plain transcript — that's what makes follow-up questions
 *  ("now break that down by gender") work across providers. `sql` is the query
 *  behind that answer, replayed so a follow-up can build on it instead of
 *  re-deriving the joins/filters from scratch. */
export interface Exchange {
  question: string;
  answer: string;
  sql?: string;
}

/** Renders a prior exchange into the answer text sent back to the model, with
 *  the SQL appended as a hint when available. */
export function historyAnswer(h: Exchange): string {
  return h.sql ? `${h.answer}\n[SQL used for that answer: ${h.sql}]` : h.answer;
}

/** Chooses which query result to display with the final answer. Prefers the
 *  last query that returned rows, so a trailing 0-row verification query can't
 *  blank out the table/chart the answer is actually about. */
export class ResultTracker {
  private any: { sql: string; data: QueryResult } | null = null;
  private nonEmpty: { sql: string; data: QueryResult } | null = null;

  record(sql: string, data: QueryResult): void {
    this.any = { sql, data };
    if (data.rowCount > 0) this.nonEmpty = { sql, data };
  }

  display(): { sql: string | null; columns: string[]; rows: Record<string, unknown>[] } {
    const r = this.nonEmpty ?? this.any;
    return { sql: r?.sql ?? null, columns: r?.data.columns ?? [], rows: r?.data.rows ?? [] };
  }
}

/** Cross-cutting knobs both provider loops honour. */
export interface AgentRunOptions {
  /** Returns true if the client has disconnected — the loop stops calling the
   *  LLM instead of burning quota into a dead socket. */
  isAborted?: () => boolean;
}

/** Signature shared by every provider's agent loop, so the dispatch in index.ts
 *  stays typed regardless of which provider is selected. */
export type RunAgent = (
  sources: TableSource[],
  primaryPath: string,
  ws: WorkspaceSchema,
  question: string,
  history: Exchange[],
  emit: (e: AgentEvent) => void,
  opts?: AgentRunOptions,
) => Promise<void>;

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

export function schemaText(ws: WorkspaceSchema): string {
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

export interface SqlExecution {
  ok: boolean;
  data?: QueryResult;
  rowCount?: number;
  error?: string;
  /** What goes back to the model as the tool result. */
  modelPayload: string;
}

/** Shared tool execution: guardrails → DuckDB workspace → model-facing payload. */
export async function executeRunSql(
  sources: TableSource[],
  primaryPath: string,
  sql: string,
): Promise<SqlExecution> {
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
