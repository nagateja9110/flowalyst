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
 *  ("now break that down by gender") work across providers. */
export interface Exchange {
  question: string;
  answer: string;
}

export const SYSTEM_RULES =
  "You are Flowalyst, a data analyst agent. You answer questions about the user's datasets by writing " +
  "and running SQL via the run_sql tool, then explaining the result in plain language.\n" +
  "Rules:\n" +
  "- Always ground answers in query results; never invent numbers.\n" +
  "- The dialect is DuckDB. Query only the tables listed in the schema; you may JOIN across them.\n" +
  "- `data` is an alias for the currently selected table.\n" +
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
