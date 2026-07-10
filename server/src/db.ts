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
  /** Precomputed schema (from the manifest cache). If present, describeWorkspace
   *  uses it instead of re-introspecting the file. */
  schema?: DatasetSchema;
  /** Precomputed embedding vector (from the manifest cache), used by
   *  retrieval.ts to rank table relevance without re-embedding on every
   *  request — only the question itself is embedded per request. */
  embedding?: number[];
}

/** Dataset name → SQL identifier (lowercase, safe chars, no leading digit). */
export function tableNameFor(raw: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name || /^\d/.test(name)) name = `t_${name}`;
  return name;
}

/**
 * Fresh in-memory DuckDB per request: every dataset is materialised into a real
 * table named after it, and `data` is a view aliasing the selected dataset.
 *
 * Security: each CSV is read once via read_csv_auto during load (CREATE TABLE
 * AS), then `enable_external_access` is turned OFF before the untrusted
 * LLM-generated query runs. After that the query physically cannot open a file
 * (read_csv/read_parquet/etc. all fail) — the guardrail moves from a regex
 * blocklist into the database engine's own capability model. Nothing persists
 * between requests, so a query can never observe another request.
 */
async function connectWorkspace(sources: TableSource[], primaryPath?: string): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const seen = new Set<string>(["data"]);
  let primaryTable: string | undefined;
  for (const s of sources) {
    let table = tableNameFor(s.name);
    while (seen.has(table)) table += "_2";
    seen.add(table);
    await conn.run(`CREATE TABLE ${table} AS ${readExpr(s.path)}`);
    if (s.path === primaryPath && primaryTable === undefined) primaryTable = table;
  }
  if (primaryPath) {
    // `data` aliases the selected dataset. If it was already materialised as a
    // named table (multi-dataset workspace), point at that; otherwise (single
    // dataset / eval path) materialise it directly. Either way `data` is backed
    // by an in-memory table, so it survives the file-access lockdown below.
    if (primaryTable) {
      await conn.run(`CREATE VIEW data AS SELECT * FROM ${primaryTable}`);
    } else {
      await conn.run(`CREATE TABLE data AS ${readExpr(primaryPath)}`);
    }
  }
  // Data is loaded; the untrusted query runs with no file access.
  await conn.run("SET enable_external_access = false");
  return conn;
}

/** DuckDB reader for a file, picked by extension. All of these read the file at
 *  load time (CREATE TABLE AS), before external access is locked down. */
function readExpr(filePath: string): string {
  const p = filePath.replace(/'/g, "''");
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "parquet":
      return `SELECT * FROM read_parquet('${p}')`;
    case "json":
    case "ndjson":
      return `SELECT * FROM read_json_auto('${p}')`;
    case "tsv":
      return `SELECT * FROM read_csv_auto('${p}', delim='\t')`;
    default: // csv and anything else → CSV sniffer
      return `SELECT * FROM read_csv_auto('${p}')`;
  }
}

/** Accepted upload extensions. CSV-only by product choice; readExpr can still
 *  parse other formats, so widening this later is a one-line change. */
export const SUPPORTED_EXTENSIONS = [".csv"];

export async function queryWorkspace(
  sources: TableSource[],
  primaryPath: string | undefined,
  sql: string,
): Promise<QueryResult> {
  const conn = await connectWorkspace(sources, primaryPath);
  try {
    const result = await withTimeout(conn.runAndReadAll(sql), QUERY_TIMEOUT_MS, conn);
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
    const schema = s.schema ?? await describeDataset(s.path); // cached when available
    const isPrimary = s.path === primaryPath;
    if (isPrimary) primaryTable = table;
    tables.push({ ...schema, table, isPrimary });
  }
  return { tables, primaryTable };
}

function withTimeout<T>(p: Promise<T>, ms: number, conn?: DuckDBConnection): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      // Actually stop the running query in the engine, not just reject the
      // promise — otherwise DuckDB keeps computing until the instance is freed.
      conn?.interrupt();
      reject(new Error(`Query exceeded ${ms}ms timeout`));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
