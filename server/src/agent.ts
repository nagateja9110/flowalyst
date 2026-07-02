import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_MODEL, MAX_AGENT_ITERATIONS } from "./config.js";
import type { TableSource, WorkspaceSchema, QueryResult } from "./db.js";
import {
  type AgentEvent,
  type Exchange,
  SYSTEM_RULES,
  RUN_SQL_DESCRIPTION,
  schemaText,
  executeRunSql,
} from "./agent-core.js";

const RUN_SQL_TOOL: Anthropic.Tool = {
  name: "run_sql",
  description: RUN_SQL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The DuckDB SQL query to run." },
    },
    required: ["query"],
  },
};

function buildSystem(ws: WorkspaceSchema): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: SYSTEM_RULES },
    {
      type: "text",
      // Stable per workspace → cached across questions and follow-up turns
      // (prefix caching): repeat requests pay ~10% for this block.
      text: schemaText(ws),
      cache_control: { type: "ephemeral" },
    },
  ];
}

export async function runAnthropicAgent(
  sources: TableSource[],
  primaryPath: string,
  ws: WorkspaceSchema,
  question: string,
  history: Exchange[],
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    ...history.flatMap((h): Anthropic.MessageParam[] => [
      { role: "user", content: h.question },
      { role: "assistant", content: h.answer },
    ]),
    { role: "user", content: question },
  ];
  let lastResult: { sql: string; data: QueryResult } | null = null;

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const stream = client.messages.stream({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: buildSystem(ws),
      tools: [RUN_SQL_TOOL],
      messages,
    });

    stream.on("text", (delta) => emit({ type: "text", delta }));
    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason !== "tool_use") {
      emit({
        type: "result",
        sql: lastResult?.sql ?? null,
        columns: lastResult?.data.columns ?? [],
        rows: lastResult?.data.rows ?? [],
      });
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const sql = String((block.input as { query?: unknown }).query ?? "");
      emit({ type: "tool_call", sql });

      const exec = await executeRunSql(sources, primaryPath, sql);
      if (exec.ok && exec.data) lastResult = { sql, data: exec.data };
      emit({ type: "tool_result", ok: exec.ok, rowCount: exec.rowCount, error: exec.error });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: exec.modelPayload,
        is_error: !exec.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  emit({ type: "error", message: `Agent stopped after ${MAX_AGENT_ITERATIONS} iterations without a final answer.` });
}
