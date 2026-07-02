import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { QUERY_TIMEOUT_MS } from "./config.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface TableSource {
  name: string;
  path: string;
}

/** Dataset name → SQL identifier (lowercase, safe chars, no leading digit). */
export function tableNameFor(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name || /^\d/.test(name)) name = `t_${name}`;
  return name;
}

/**
 * Fresh in-memory DuckDB per request: every dataset is exposed as a view named
 * after it, and `data` is an alias for the currently selected dataset. Nothing
 * persists between queries, so a query can never observe another request.
 */
async function connectWorkspace(sources: TableSource[], primaryPath?: string): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const seen = new Set<string>(primaryPath ? ["data"] : []);
  for (const s of sources) {
    let table = tableNameFor(s.name);
    while (seen.has(table)) table += "_2";
    seen.add(table);
    const p = s.path.replace(/'/g, "''");
    await conn.run(`CREATE VIEW ${table} AS SELECT * FROM read_csv_auto('${p}')`);
  }
  if (primaryPath) {
    const p = primaryPath.replace(/'/g, "''");
    await conn.run(`CREATE VIEW data AS SELECT * FROM read_csv_auto('${p}')`);
  }
  return conn;
}

export async function queryWorkspace(
  sources: TableSource[],
  primaryPath: string | undefined,
  sql: string,
): Promise<QueryResult> {
  const conn = await connectWorkspace(sources, primaryPath);
  try {
    const result = await withTimeout(conn.runAndReadAll(sql), QUERY_TIMEOUT_MS);
    const columns = result.columnNames();
    // getRowObjectsJson() converts DuckDB values (BigInt, DATE, ...) to JSON-safe ones.
    const rows = result.getRowObjectsJson() as Record<string, unknown>[];
    return { columns, rows, rowCount: rows.length };
  } finally {
    conn.closeSync();
  }
}

/** Single-dataset convenience: the CSV is queryable as `data`. */
export function queryDataset(csvPath: string, sql: string): Promise<QueryResult> {
  return queryWorkspace([], csvPath, sql);
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

export interface TableSchema extends DatasetSchema {
  isPrimary: boolean;
}

export interface WorkspaceSchema {
  tables: TableSchema[];
  primaryTable: string;
}

export async function describeDataset(csvPath: string): Promise<DatasetSchema> {
  const describe = await queryDataset(csvPath, "DESCRIBE SELECT * FROM data");
  const sample = await queryDataset(csvPath, "SELECT * FROM data LIMIT 5");
  const count = await queryDataset(csvPath, "SELECT COUNT(*) AS n FROM data");
  return {
    table: "data",
    columns: describe.rows.map((r) => ({
      name: String(r["column_name"]),
      type: String(r["column_type"]),
    })),
    sampleRows: sample.rows,
    rowCount: Number(count.rows[0]?.["n"] ?? 0),
  };
}

/** Schema for every dataset in the workspace (for the agent's system prompt). */
export async function describeWorkspace(sources: TableSource[], primaryPath: string): Promise<WorkspaceSchema> {
  const tables: TableSchema[] = [];
  const seen = new Set<string>(["data"]);
  let primaryTable = "data";
  for (const s of sources) {
    let table = tableNameFor(s.name);
    while (seen.has(table)) table += "_2";
    seen.add(table);
    const schema = await describeDataset(s.path);
    const isPrimary = s.path === primaryPath;
    if (isPrimary) primaryTable = table;
    tables.push({ ...schema, table, isPrimary });
  }
  return { tables, primaryTable };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Query exceeded ${ms}ms timeout`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
