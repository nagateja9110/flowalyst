import Groq from "groq-sdk";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import { GROQ_MODEL, MAX_AGENT_ITERATIONS } from "./config.js";
import type { TableSource, WorkspaceSchema } from "./db.js";
import {
  type AgentEvent,
  type AgentRunOptions,
  type Exchange,
  SYSTEM_RULES,
  RUN_SQL_DESCRIPTION,
  schemaText,
  executeRunSql,
  historyAnswer,
  ResultTracker,
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

/** Llama on Groq occasionally emits its tool call in a raw `<function=...>` text
 *  form that Groq's parser rejects with a 400 `tool_use_failed`. It's
 *  non-deterministic, so re-rolling the same request usually yields valid JSON.
 *  Forcing tool_choice:"required" (for grounding) makes this more frequent, so
 *  the retry is what keeps that guarantee from turning into hard failures. */
function isToolUseFailed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /tool_use_failed/i.test(msg);
}

const MAX_TOOL_RETRIES = 4;

type ChatParams = ChatCompletionCreateParamsNonStreaming;

/** chat.completions through the key pool: a 429 benches the key and moves to the
 *  next; a malformed-tool-call 400 re-rolls on the same key. Both are invisible
 *  to the caller. */
async function completeWithFailover(params: ChatParams) {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, groqPool.size()); attempt++) {
    const key = groqPool.next();
    if (!key) break;
    const client = new Groq({ apiKey: key });
    for (let toolRetry = 0; toolRetry <= MAX_TOOL_RETRIES; toolRetry++) {
      try {
        return await client.chat.completions.create(params);
      } catch (err) {
        if (isToolUseFailed(err)) { lastErr = err; continue; } // re-roll same key
        if (isRateLimit(err)) { groqPool.cooldown(key); lastErr = err; break; } // next key
        throw err;
      }
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
  opts: AgentRunOptions = {},
): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: `${SYSTEM_RULES}\n\n${schemaText(ws)}` },
    ...history.flatMap((h): ChatCompletionMessageParam[] => [
      { role: "user", content: h.question },
      { role: "assistant", content: historyAnswer(h) },
    ]),
    { role: "user", content: question },
  ];
  const tracker = new ResultTracker();

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    if (opts.isAborted?.()) return; // client gone — stop before the next paid call
    const response = await completeWithFailover({
      model: GROQ_MODEL,
      messages,
      tools: [RUN_SQL_TOOL],
      // Force a query on the first turn so answers are grounded in real data,
      // not guessed from the sample rows in the schema. After that, "auto".
      tool_choice: iteration === 0 ? "required" : "auto",
    });
    if (opts.isAborted?.()) return; // disconnected during the call — don't emit

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
      emit({ type: "result", ...tracker.display() });
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
      if (exec.ok && exec.data) tracker.record(sql, exec.data);
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
