import { Fragment } from "react";
import { format } from "sql-formatter";

/** Pretty-print the query (clause-per-line, indented). Falls back to the raw
 *  string if the SQL is partial/unparseable. */
function prettyPrint(code) {
  try {
    return format(code, { language: "postgresql" }); // DuckDB is Postgres-like
  } catch {
    return code;
  }
}

// Minimal SQL highlighter — no dependency. Tokenizes the query into
// keywords / strings / numbers / functions / comments / punctuation and colors
// each, IDE-style. One regex with named alternatives; each match becomes a
// colored span, gaps stay plain.
const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "join", "inner",
  "left", "right", "outer", "full", "on", "as", "and", "or", "not", "in", "is",
  "null", "like", "between", "limit", "offset", "distinct", "case", "when",
  "then", "else", "end", "asc", "desc", "with", "union", "all", "over",
  "partition", "cast", "using",
]);

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b\w+\b)|(\s+)|([(),.*=<>!+\-/|]+)/g;

const COLORS = {
  keyword: "#7dd3fc",  // sky
  string: "#fca5a5",   // rose
  number: "#fcd34d",   // amber
  func: "#c4b5fd",     // violet
  comment: "#6b7280",  // gray
  punct: "#a1a1aa",    // zinc
  ident: "#e4e4e7",    // default
};

export function Sql({ code }) {
  const pretty = prettyPrint(code);
  const parts = [];
  let m;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(pretty)) !== null) {
    const [text, comment, str, num, word, ws, punct] = m;
    let color = COLORS.ident;
    if (comment) color = COLORS.comment;
    else if (str) color = COLORS.string;
    else if (num) color = COLORS.number;
    else if (ws) { parts.push(<Fragment key={i++}>{text}</Fragment>); continue; }
    else if (punct) color = COLORS.punct;
    else if (word) {
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) color = COLORS.keyword;
      // a word immediately followed by "(" is a function call
      else if (pretty[m.index + word.length] === "(") color = COLORS.func;
      else color = COLORS.ident;
    }
    parts.push(<span key={i++} style={{ color }}>{text}</span>);
  }
  return (
    <pre className="overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed">
      {parts}
    </pre>
  );
}
