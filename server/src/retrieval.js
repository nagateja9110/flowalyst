import { RETRIEVAL_TABLE_THRESHOLD, RETRIEVAL_TOP_K } from "./config.js";
import { embedText, cosineSimilarity } from "./embeddings.js";

/**
 * Retrieval-augmented table selection. Below the threshold, every dataset's
 * schema goes into the prompt — today's behavior, unchanged; there's nothing
 * to gain from filtering a handful of tables. Above it, the question is
 * embedded once and compared against each table's embedding (computed once
 * at upload, cached in the manifest) via cosine similarity — only the top-K
 * most relevant tables are sent to the agent instead of every schema.
 *
 * Embeddings, not keyword matching: business questions ("total revenue")
 * rarely share literal tokens with technical column names ("quantity",
 * "price") — the classic vocabulary-mismatch problem — and a keyword scorer
 * can be actively misled by an unrelated table that happens to have a
 * literally-named matching column (e.g. a movies table with a `revenue`
 * column, when the real answer needs `quantity * price` from two other
 * tables). Embeddings capture the semantic relationship that keyword overlap
 * cannot.
 *
 * Fails open: any embedding error (no Gemini key, network issue) falls back
 * to sending every table unfiltered — a retrieval outage degrades to the
 * pre-retrieval behavior, it never blocks an answer.
 *
 * @param {string} question
 * @param {import("./db.js").TableSource[]} allSources
 * @param {string} primaryPath
 * @returns {Promise<import("./db.js").TableSource[]>}
 */
export async function selectRelevantTables(question, allSources, primaryPath) {
  if (allSources.length <= RETRIEVAL_TABLE_THRESHOLD) return allSources;

  try {
    const questionVec = await embedText(question);

    const scored = allSources
      .filter((s) => s.embedding)
      .map((s) => ({ source: s, score: cosineSimilarity(questionVec, s.embedding) }))
      .sort((a, b) => b.score - a.score);

    let selected = scored.slice(0, RETRIEVAL_TOP_K).map((s) => s.source);

    // Tables with no cached embedding yet (e.g. uploaded moments ago, before
    // the backfill ran) can't be ranked — include them rather than silently
    // drop something the model might need.
    const unranked = allSources.filter((s) => !s.embedding);
    selected = [...selected, ...unranked];

    // Never silently drop the dataset the user explicitly selected in the UI.
    if (!selected.some((s) => s.path === primaryPath)) {
      const primary = allSources.find((s) => s.path === primaryPath);
      if (primary) selected.push(primary);
    }

    // Pull in join partners pure semantic similarity can miss: a table that
    // shares a foreign-key-shaped column (e.g. `product_id`) with a table
    // already selected is very likely needed alongside it (observed case:
    // "which customer spent the most money" selected orders+customers but not
    // products, which holds the price column needed to compute spend — orders
    // and products both have `product_id`, a strong join signal embeddings
    // alone didn't surface). One pass only (not transitive), so this can't
    // cascade into pulling in the whole workspace.
    const selectedIdColumns = new Set(
      selected.flatMap((s) => (s.schema?.columns ?? [])
        .map((c) => c.name.toLowerCase())
        .filter((n) => n.endsWith("_id"))),
    );
    for (const s of allSources) {
      if (selected.includes(s)) continue;
      const sharesIdColumn = (s.schema?.columns ?? []).some((c) => selectedIdColumns.has(c.name.toLowerCase()));
      if (sharesIdColumn) selected.push(s);
    }

    console.log(
      `[retrieval] "${question.slice(0, 60)}" -> ${selected.map((s) => s.name).join(", ")} ` +
      `(${selected.length} of ${allSources.length} tables)`,
    );
    return selected;
  } catch (err) {
    console.warn(
      `[retrieval] failed, falling back to all ${allSources.length} tables:`,
      err instanceof Error ? err.message : err,
    );
    return allSources;
  }
}
