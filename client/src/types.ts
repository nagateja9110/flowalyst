export interface Dataset {
  id: string;
  name: string;
  filename: string;
  uploadedAt: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface DatasetSchema {
  table: string;
  columns: ColumnInfo[];
  sampleRows: Record<string, unknown>[];
  rowCount: number;
}

export interface QueryResult {
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; sql: string }
  | { type: "tool_result"; ok: boolean; rowCount?: number; error?: string }
  | { type: "result"; sql: string | null; columns: string[]; rows: Record<string, unknown>[] }
  | { type: "error"; message: string }
  | { type: "done" };

export interface TraceStep {
  sql: string;
  ok?: boolean;
  rowCount?: number;
  error?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  trace: TraceStep[];
  result?: QueryResult;
  error?: string;
  pending?: boolean;
}
