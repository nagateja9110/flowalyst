# Flowalyst

**Ask your CSV anything.** Upload a dataset, ask a question in plain English, and get an answer backed by real SQL — with the agent's every query attempt streamed live to the screen, so the reasoning is visible, not claimed.

Built from scratch — no LangChain, no Flowise. Express + JavaScript server, React (JavaScript) + Vite client, LLM tool use with an embedded DuckDB engine.

**Live demo:** https://flowalyst.onrender.com — hosted on Render's free tier, so the first request after idle can take ~50s to wake the server.

## The problem

Most of the world's ad-hoc data lives in CSV files, and most of the people holding them can't write SQL. The existing ways out are all bad in a different direction:

- **Spreadsheets** break down the moment a question needs grouping, joining, or more than a few thousand rows.
- **Asking an analyst** turns a 30-second question into a day-long ticket.
- **Cloud "chat with your data" tools** require shipping your data to someone else's servers and trusting a black box — you see an answer, but not how it was produced.
- **Naive text-to-SQL** (one-shot LLM generation) fails silently: when the generated SQL is wrong, you either get a cryptic database error or, worse, a confidently wrong answer.

## The solution

Flowalyst is a **self-hosted AI data analyst** that treats the LLM as a junior analyst under supervision, not an oracle:

- The model gets exactly one tool — `run_sql` — and works in an **agentic loop**: write a query, watch it execute, read the result *or the error*, and self-correct until the answer is grounded in real query results.
- Every query passes through **guardrails** before touching the database, because LLM-generated SQL is untrusted input.
- Every answer arrives with **the SQL that produced it and the result table** — trust through auditability, not through faith.
- Your data **never leaves your machine**: DuckDB runs embedded in the server process and queries the CSV directly. No database server, no cloud, no import step.

## Architecture

![Architecture](docs/architecture.svg)

## How it works

**1. Upload.** A CSV lands in `server/data/uploads`; the server infers its schema with DuckDB (`DESCRIBE`, sample rows, row count). No import — DuckDB queries the file in place via `read_csv_auto`.

**2. Ask.** The client POSTs the question to `/api/ask` and holds an SSE stream open. The server builds the agent's context: fixed analyst rules plus the schema of every uploaded table (columns, types, 3 sample rows). The schema block is stable per workspace and marked for **prompt caching**, so repeat questions pay a fraction of the input cost.

**3. The agent loop** (bounded at 6 iterations — cost and halting control):

```
model writes SQL ──▶ guardrails validate ──▶ DuckDB executes
      ▲                                          │
      └────── rows (success) or error ◀──────────┘
              fed back as a tool result
```

The key design decision: **errors go back to the model as failed tool results**, verbatim. A wrong column name, a bad cast, a typo — the model reads the actual DuckDB error and rewrites its own query. Self-correction beats any server-side retry logic, because the model can see *why* it failed.

**4. Guardrails — the security core.** Every generated query is validated before execution:

| Check | Blocks |
|---|---|
| Single statement only (no internal `;`) | multi-statement injection |
| Comments stripped before validation | keywords hidden in `--` or `/* */` |
| Must start with `SELECT` / `WITH` | everything that isn't a read |
| Keyword deny-list (`drop`, `attach`, `copy`, `install`, …) | writes, filesystem access, extension loading |
| Query wrapped in `SELECT * FROM (…) LIMIT 1000` | unbounded results, regardless of the inner query |
| 10-second timeout | runaway queries |
| Fresh in-memory DuckDB per request, read-only views | any cross-request state, any persistent damage |

Fail-closed by design: a rare legitimate query being rejected is acceptable; a destructive one being allowed is not. And even a hypothetical bypass lands in a throwaway in-memory database whose only contents are views over CSV files.

**5. Stream.** Text deltas, each SQL attempt, and each result/error are pushed to the client as SSE events — the UI renders the self-correction live. The final answer ships with the last successful query's result set, rendered as a table and an auto-picked chart.

**Also in the box:**

- **Follow-up questions** — prior Q/A pairs (capped at 8) ride along with each ask; "now break that down by gender" just works.
- **Multi-table JOINs** — every uploaded dataset is a named view in the per-request DuckDB instance; the agent sees all schemas.
- **Provider-agnostic core** — Gemini and Groq agents emit the same event stream from shared core logic (`agent-core.js`); swapping providers is a config change, not a UI change. An API-key pool round-robins keys and benches any key that hits a rate limit, failing over mid-conversation.
- **Graceful degradation** — with no API key at all, the same chat box accepts raw SQL and still renders the table + chart.

## Impact

- **Removes the SQL barrier** — anyone who can phrase a question can interrogate a dataset, including grouping, filtering, and cross-file JOINs that are painful in spreadsheets.
- **Private by construction** — self-hosted, embedded database, no data leaves the machine. Usable on data you could never paste into a cloud tool.
- **Zero-cost to run** — works end-to-end on Gemini's free tier; zero infrastructure beyond Node.
- **Wrong SQL heals itself** — failed queries are corrected by the agent without user intervention, turning the most common text-to-SQL failure mode (silent wrong answers or cryptic errors) into a visible, self-resolving retry.
- **Measurable, not vibes** — a golden-set eval harness regression-tests answer accuracy, latency, and SQL-call count per question, so every prompt or guardrail change gets a before/after number.

## Quick start

```sh
npm install                      # root (concurrently)
npm install --prefix server
npm install --prefix client

# Provider (pick one) — put it in server/.env or export it:
#   GEMINI_API_KEY=...      free tier (aistudio.google.com)
#   GROQ_API_KEY=...        free tier (console.groq.com)
# Multiple keys with 429 failover: GEMINI_API_KEYS=k1,k2 / GROQ_API_KEYS=k1,k2
# With no key the app runs in manual SQL mode.
# If both are set, Gemini wins; force one with PROVIDER=gemini|groq.

npm run dev                      # server on :5002, client on :5173
```

Three seed datasets from one e-commerce domain register automatically — `customers`, `orders`, and `products`, linked by `customer_id`/`product_id` so JOIN questions work out of the box. Try:

> *"Which city generated the most revenue from delivered orders?"*
> *"Which product category has the highest return rate?"*

Without an API key, the same chat box accepts raw SQL (`data` aliases the selected table; all tables are JOINable by name):

```sql
SELECT c.city, SUM(o.quantity * p.price) AS revenue
FROM orders o
JOIN customers c USING (customer_id)
JOIN products  p USING (product_id)
WHERE o.status = 'delivered'
GROUP BY 1 ORDER BY 2 DESC
```

## API

| Route | Purpose |
|---|---|
| `POST /api/datasets` | Upload a CSV (multipart, field `file`) |
| `GET /api/datasets` | List datasets |
| `GET /api/datasets/:id/schema` | Columns, types, sample rows, row count |
| `POST /api/datasets/:id/query` | Raw SQL (guarded) — also the no-key fallback path |
| `POST /api/ask` | `{datasetId, question}` → SSE agent stream |
| `GET /api/config` | `{hasApiKey}` — client picks agent vs manual mode |

## Evals

"How do you know the SQL is right?" — measure it:

```sh
npm run eval --prefix server                       # golden questions vs the active provider
PROVIDER=groq npm run eval --prefix server         # compare providers
```

`server/eval/golden.json` holds questions with regex expectations (including an honesty case asking about a column that doesn't exist — the correct answer is "the data can't tell you"). Each case is scored **pass / fail / skip**, where `skip` = couldn't run because of a rate limit (infrastructure), so it never counts as a wrong answer. The runner prints latency and SQL-call count per question, self-paces on Gemini's free-tier rate limit, and exits non-zero only on real logic failures.

Latest run (e-commerce seed, 9 cases): **Gemini 9/9, Groq (llama-3.3-70b) 8/9**. The eval earned its keep — it caught a self-inflicted regression (forcing a first-turn tool call made Llama emit malformed tool-call syntax that Groq rejected; fixed by re-rolling on `tool_use_failed`), a semantic bug (a model ranking return *count* instead of *rate*; fixed with a general prompt rule), and a genuine capability gap (on "average delivery time" — a metric the data can't support — Gemini declines, while the weaker Llama fabricates it from unrelated date columns). That last one is left as-is: forcing a weaker model to pass it would be overfitting the metric.

## Project structure

```
server/src/
  index.js        routes + SSE plumbing
  agent-gemini.js Gemini function-calling loop (prompt-cached schema)
  agent-groq.js   Groq (Llama) tool-use loop (same event stream)
  agent-core.js   shared rules, tool description, guarded SQL execution
  guardrails.js   SELECT-only validation + LIMIT wrapping
  db.js           DuckDB per-request instances, schema inference
  keypool.js      round-robin API keys with 429 cooldown failover
  datasets.js     upload manifest + seed registration
  embeddings.js   Gemini embeddings + cosine similarity
  retrieval.js    RAG table selection for many-dataset workspaces
server/eval/
  golden.json     golden question set
  run.js          eval runner (accuracy / latency / SQL calls)
client/src/
  components/Chat.jsx         chat, live trace cards, SQL block
  components/ResultTable.jsx  result table
  components/ResultChart.jsx  auto bar/line chart heuristic
  lib/api.js                  fetch + SSE reader
```

## Example questions to try

The seed data is a small e-commerce domain — `customers`, `products`, and `orders` — built for JOINs. Try these in the chat, roughly in order of ambition:

1. **How many orders do we have, and how many were delivered vs cancelled?** — basic grounding: the answer comes from executed rows, not the model's memory.
2. **Show total revenue by product category.** — revenue isn't a column; the agent joins `orders` × `products` and computes `quantity * price`, then auto-renders a bar chart.
3. **Show the monthly revenue trend.** — time-series aggregation with a line chart, streamed step-by-step over SSE.
4. **Who are the top 5 customers by total spend, and which city is each from?** — a three-table join the agent plans on its own from the schema.
5. **Is there any relationship between customer age and how much they spend?** — the agent typically runs multiple queries (correlation + grouped breakdown) and synthesizes them.
6. **Which product category is most popular with customers under 30, and how does that compare to customers over 45?** — filter + join + group + compare.
7. **For each customer, what's the ratio of cancelled orders to delivered orders?** — division-by-zero bait: watch the agent observe the DB error and rewrite the query (or pre-correct it thanks to schema grounding).
8. **Delete all cancelled orders.** — goes nowhere: SQL from the model is treated as untrusted input, and the SELECT-only guardrail rejects DML before it ever reaches DuckDB.
