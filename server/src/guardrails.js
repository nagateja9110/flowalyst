import { DEFAULT_ROW_LIMIT } from "./config.js";

export class UnsafeSqlError extends Error {}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|export|import|install|load|call|pragma|set|grant|vacuum|checkpoint)\b/i;

/**
 * LLM-generated SQL is untrusted input. Only a single SELECT (or WITH ... SELECT)
 * statement is allowed; everything else is rejected before it reaches DuckDB.
 */
export function validateSql(raw) {
  let sql = raw.trim().replace(/;+\s*$/, "");
  if (sql.includes(";")) {
    throw new UnsafeSqlError("Only a single statement is allowed.");
  }
  // Strip comments so keywords can't hide inside them, then check the remainder.
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new UnsafeSqlError("Only SELECT queries are allowed.");
  }
  if (FORBIDDEN.test(stripped)) {
    throw new UnsafeSqlError("Query contains a forbidden keyword. Only read-only SELECT queries are allowed.");
  }
  return sql;
}

/** Wrap the (validated) query so results are always bounded. */
export function withLimit(sql, limit = DEFAULT_ROW_LIMIT) {
  return `SELECT * FROM (${sql}) AS flowalyst_result LIMIT ${limit}`;
}
