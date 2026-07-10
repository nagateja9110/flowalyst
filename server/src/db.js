import { DuckDBInstance } from "@duckdb/node-api";
import { QUERY_TIMEOUT_MS } from "./config.js";

/**
 * @typedef {Object} QueryResult
 * @property {string[]} columns
 * @property {Record<string, unknown>[]} rows
 * @property {number} rowCount
 */

/**
 * @typedef {Object} TableSource
 * @property {string} name
 * @property {string} path
 * @property {DatasetSchema} [schema] Precomputed schema (from the manifest
 *   cache). If present, describeWorkspace uses it instead of re-introspecting
 *   the file.
 */

/** Dataset name → SQL identifier (lowercase, safe chars, no leading digit). */
export function tableNameFor(raw) {
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
 *
 * @param {TableSource[]} sources
 * @param {string} [primaryPath]
 */
async function connectWorkspace(sources, primaryPath) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const seen = new Set(["data"]);
  let primaryTable;
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
function readExpr(filePath) {
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

/**
 * @param {TableSource[]} sources
 * @param {string | undefined} primaryPath
 * @param {string} sql
 * @returns {Promise<QueryResult>}
 */
export async function queryWorkspace(sources, primaryPath, sql) {
  const conn = await connectWorkspace(sources, primaryPath);
  try {
    const result = await withTimeout(conn.runAndReadAll(sql), QUERY_TIMEOUT_MS, conn);
    const columns = result.columnNames();
    // getRowObjectsJson() converts DuckDB values (BigInt, DATE, ...) to JSON-safe ones.
    const rows = result.getRowObjectsJson();
    return { columns, rows, rowCount: rows.length };
  } finally {
    conn.closeSync();
  }
}

/** Single-dataset convenience: the CSV is queryable as `data`. */
export function queryDataset(csvPath, sql) {
  return queryWorkspace([], csvPath, sql);
}

/**
 * @typedef {Object} ColumnInfo
 * @property {string} name
 * @property {string} type
 */

/**
 * @typedef {Object} DatasetSchema
 * @property {string} table
 * @property {ColumnInfo[]} columns
 * @property {Record<string, unknown>[]} sampleRows
 * @property {number} rowCount
 */

/**
 * @typedef {DatasetSchema & {isPrimary: boolean}} TableSchema
 */

/**
 * @typedef {Object} WorkspaceSchema
 * @property {TableSchema[]} tables
 * @property {string} primaryTable
 */

/** @returns {Promise<DatasetSchema>} */
export async function describeDataset(csvPath) {
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

/** Schema for every dataset in the workspace (for the agent's system prompt).
 *  @param {TableSource[]} sources
 *  @param {string} primaryPath
 *  @returns {Promise<WorkspaceSchema>} */
export async function describeWorkspace(sources, primaryPath) {
  const tables = [];
  const seen = new Set(["data"]);
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

function withTimeout(p, ms, conn) {
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
