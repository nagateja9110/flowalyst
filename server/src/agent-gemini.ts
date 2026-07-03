import { GoogleGenAI, Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { GEMINI_MODEL, MAX_AGENT_ITERATIONS } from "./config.js";
import type { TableSource, WorkspaceSchema, QueryResult } from "./db.js";
import {
  type AgentEvent,
  type Exchange,
  SYSTEM_RULES,
  RUN_SQL_DESCRIPTION,
  schemaText,
  executeRunSql,
} from "./agent-core.js";
import { geminiPool } from "./keypool.js";

function isRateLimit(err: unknown): boolean {
  if ((err as { status?: number })?.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

type GenerateParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

/** generateContent through the key pool: a 429 benches the key and the call
 *  retries on the next one, so quota failover is invisible to the caller. */
async function generateWithFailover(params: GenerateParams) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, geminiPool.size()); attempt++) {
    const key = geminiPool.next();
    if (!key) break;
    try {
      return await new GoogleGenAI({ apiKey: key }).models.generateContent(params);
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      geminiPool.cooldown(key);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(
    `All Gemini keys are rate-limited; retry in ~${geminiPool.secondsUntilAvailable()}s`,
  );
}

/** Same agent loop as agent.ts, on Gemini's function-calling API. Emits the
 *  identical AgentEvent stream, so the client can't tell providers apart.
 *  (Free tier: ~1,500 req/day on gemini-2.5-flash — plenty for demos.) */

const RUN_SQL_DECL: FunctionDeclaration = {
  name: "run_sql",
  description: RUN_SQL_DESCRIPTION,
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "The DuckDB SQL query to run." },
    },
    required: ["query"],
  },
};

export async function runGeminiAgent(
  sources: TableSource[],
  primaryPath: string,
  ws: WorkspaceSchema,
  question: string,
  history: Exchange[],
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const contents: Content[] = [
    ...history.flatMap((h): Content[] => [
      { role: "user", parts: [{ text: h.question }] },
      { role: "model", parts: [{ text: h.answer }] },
    ]),
    { role: "user", parts: [{ text: question }] },
  ];
  let lastResult: { sql: string; data: QueryResult } | null = null;

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const response = await generateWithFailover({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: `${SYSTEM_RULES}\n\n${schemaText(ws)}`,
        tools: [{ functionDeclarations: [RUN_SQL_DECL] }],
      },
    });

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const text = (modelContent?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    if (text) emit({ type: "text", delta: text });

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      emit({
        type: "result",
        sql: lastResult?.sql ?? null,
        columns: lastResult?.data.columns ?? [],
        rows: lastResult?.data.rows ?? [],
      });
      return;
    }

    const parts: Part[] = [];
    for (const call of calls) {
      const sql = String((call.args as { query?: unknown } | undefined)?.query ?? "");
      emit({ type: "tool_call", sql });

      const exec = await executeRunSql(sources, primaryPath, sql);
      if (exec.ok && exec.data) lastResult = { sql, data: exec.data };
      emit({ type: "tool_result", ok: exec.ok, rowCount: exec.rowCount, error: exec.error });
      parts.push({
        functionResponse: {
          name: call.name ?? "run_sql",
          response: exec.ok ? { result: exec.modelPayload } : { error: exec.modelPayload },
        },
      });
    }
    contents.push({ role: "user", parts });
  }

  emit({ type: "error", message: `Agent stopped after ${MAX_AGENT_ITERATIONS} iterations without a final answer.` });
}
