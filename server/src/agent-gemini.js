import { GoogleGenAI, Type, FunctionCallingConfigMode } from "@google/genai";
import { GEMINI_MODEL, MAX_AGENT_ITERATIONS } from "./config.js";
import {
  SYSTEM_RULES,
  RUN_SQL_DESCRIPTION,
  schemaText,
  executeRunSql,
  historyAnswer,
  ResultTracker,
} from "./agent-core.js";
import { geminiPool } from "./keypool.js";

function isRateLimit(err) {
  if (err?.status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

/** generateContent through the key pool: a 429 benches the key and the call
 *  retries on the next one, so quota failover is invisible to the caller. */
async function generateWithFailover(params) {
  let lastErr = null;
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

/** Same agent loop as agent-groq.js, on Gemini's function-calling API. Emits the
 *  identical AgentEvent stream, so the client can't tell providers apart.
 *  (Free tier: ~1,500 req/day on gemini-2.5-flash — plenty for demos.) */

const RUN_SQL_DECL = {
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

/** @type {import("./agent-core.js").RunAgent} */
export async function runGeminiAgent(sources, primaryPath, ws, question, history, emit, opts = {}) {
  const contents = [
    ...history.flatMap((h) => [
      { role: "user", parts: [{ text: h.question }] },
      { role: "model", parts: [{ text: historyAnswer(h) }] },
    ]),
    { role: "user", parts: [{ text: question }] },
  ];
  const tracker = new ResultTracker();

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    if (opts.isAborted?.()) return; // client gone — stop before the next paid call
    const response = await generateWithFailover({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: `${SYSTEM_RULES}\n\n${schemaText(ws)}`,
        tools: [{ functionDeclarations: [RUN_SQL_DECL] }],
        // Force a query on the first turn so answers are grounded in real data,
        // not guessed from the sample rows in the schema. After that, let the
        // model decide (it may need 0 or more follow-up queries).
        toolConfig: {
          functionCallingConfig: {
            mode: iteration === 0 ? FunctionCallingConfigMode.ANY : FunctionCallingConfigMode.AUTO,
            allowedFunctionNames: iteration === 0 ? ["run_sql"] : undefined,
          },
        },
      },
    });
    if (opts.isAborted?.()) return; // disconnected during the call — don't emit

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const text = (modelContent?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    if (text) emit({ type: "text", delta: text });

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      emit({ type: "result", ...tracker.display() });
      return;
    }

    const parts = [];
    for (const call of calls) {
      const sql = String(call.args?.query ?? "");
      emit({ type: "tool_call", sql });

      const exec = await executeRunSql(sources, primaryPath, sql);
      if (exec.ok && exec.data) tracker.record(sql, exec.data);
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
