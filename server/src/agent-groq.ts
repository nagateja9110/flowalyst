import Groq from "groq-sdk";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import { GROQ_MODEL, MAX_AGENT_ITERATIONS } from "./config.js";
import type { TableSource, WorkspaceSchema, QueryResult } from "./db.js";
import {
  type AgentEvent,
  type Exchange,
  SYSTEM_RULES,
  RUN_SQL_DESCRIPTION,
  schemaText,
  executeRunSql,
} from "./agent-core.js";
import { groqPool } from "./keypool.js";

/** Same agent loop as agent-gemini.ts, on Groq's OpenAI-style tool calling.
 *  Emits the identical AgentEvent stream, so the client can't tell providers
 *  apart. (Free tier is per key/day — the pool spreads load across keys.) */

const RUN_SQL_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_sql",
    description: RUN_SQL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The DuckDB SQL query to run." },
      },
      required: ["query"],
    },
  },
};

function isRateLimit(err: unknown): boolean {
  if ((err as { status?: number })?.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|quota/i.test(msg);
}

type ChatParams = ChatCompletionCreateParamsNonStreaming;

/** chat.completions through the key pool: a 429 benches the key and the call
 *  retries on the next one, so quota failover is invisible to the caller. */
async function completeWithFailover(params: ChatParams) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, groqPool.size()); attempt++) {
    const key = groqPool.next();
    if (!key) break;
    try {
      return await new Groq({ apiKey: key }).chat.completions.create(params);
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      groqPool.cooldown(key);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(
    `All Groq keys are rate-limited; retry in ~${groqPool.secondsUntilAvailable()}s`,
  );
}

export async function runGroqAgent(
  sources: TableSource[],
  primaryPath: string,
  ws: WorkspaceSchema,
  question: string,
  history: Exchange[],
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: `${SYSTEM_RULES}\n\n${schemaText(ws)}` },
    ...history.flatMap((h): ChatCompletionMessageParam[] => [
      { role: "user", content: h.question },
      { role: "assistant", content: h.answer },
    ]),
    { role: "user", content: question },
  ];
  let lastResult: { sql: string; data: QueryResult } | null = null;

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const response = await completeWithFailover({
      model: GROQ_MODEL,
      messages,
      tools: [RUN_SQL_TOOL],
    });

    const msg = response.choices[0]?.message;
    if (!msg) break;
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });
    if (msg.content) emit({ type: "text", delta: msg.content });

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      emit({
        type: "result",
        sql: lastResult?.sql ?? null,
        columns: lastResult?.data.columns ?? [],
        rows: lastResult?.data.rows ?? [],
      });
      return;
    }

    for (const call of calls) {
      let sql = "";
      try {
        sql = String((JSON.parse(call.function.arguments || "{}") as { query?: unknown }).query ?? "");
      } catch {
        sql = "";
      }
      emit({ type: "tool_call", sql });

      const exec = await executeRunSql(sources, primaryPath, sql);
      if (exec.ok && exec.data) lastResult = { sql, data: exec.data };
      emit({ type: "tool_result", ok: exec.ok, rowCount: exec.rowCount, error: exec.error });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(exec.ok ? { result: exec.modelPayload } : { error: exec.modelPayload }),
      });
    }
  }

  emit({ type: "error", message: `Agent stopped after ${MAX_AGENT_ITERATIONS} iterations without a final answer.` });
}
