import { spawn } from "bun";
import { parseCodexJsonStream } from "./utils/codex-events";

export type LlmProvider = "codex-cli" | "openai-compatible";

export interface LlmCallOptions {
  resumeSessionId?: string | null;
}

export interface LlmCallResult {
  response: string;
  sessionId: string | null;
}

const LLM_LOG_VERBOSE = (process.env.LLM_LOG_VERBOSE || "").toLowerCase() === "true";
const PROVIDER_ENV = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
const OPENAI_COMPAT_BASE_URL = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
const OPENAI_COMPAT_MODEL = (process.env.LLM_MODEL || process.env.OPENAI_MODEL || "").trim();
const OPENAI_COMPAT_API_KEY = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();

const CODEX_PATH = process.env.CODEX_PATH || process.env.CLAUDE_PATH || "codex";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "low";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_FULL_ACCESS =
  (process.env.CODEX_FULL_ACCESS || "true").toLowerCase() === "true";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "danger-full-access";

export function getLlmProvider(): LlmProvider {
  if (PROVIDER_ENV === "openai-compatible" || PROVIDER_ENV === "openai") {
    return "openai-compatible";
  }
  if (PROVIDER_ENV === "codex-cli" || PROVIDER_ENV === "codex") {
    return "codex-cli";
  }
  if (OPENAI_COMPAT_BASE_URL && OPENAI_COMPAT_MODEL) {
    return "openai-compatible";
  }
  return "codex-cli";
}

export function getLlmLogConfig(): string {
  const provider = getLlmProvider();
  if (provider === "openai-compatible") {
    return `provider=openai-compatible baseUrl=${OPENAI_COMPAT_BASE_URL || "(missing)"} model=${OPENAI_COMPAT_MODEL || "(missing)"} apiKey=${OPENAI_COMPAT_API_KEY ? "set" : "not-set"} verbose=${isVerboseLoggingEnabled()}`;
  }

  return `provider=codex-cli path=${CODEX_PATH} model=${CODEX_MODEL || "(default)"} reasoning=${CODEX_REASONING_EFFORT} verbose=${isVerboseLoggingEnabled()}`;
}

export async function callLlm(
  prompt: string,
  options?: LlmCallOptions,
): Promise<LlmCallResult> {
  const provider = getLlmProvider();
  if (provider === "openai-compatible") {
    return callOpenAiCompatible(prompt);
  }
  return callCodexCli(prompt, options);
}

async function callCodexCli(
  prompt: string,
  options?: LlmCallOptions,
): Promise<LlmCallResult> {
  const args = buildCodexCommand(prompt, options);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
    },
  });

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr || `Codex exited with code ${exitCode}`);
  }

  const parsed = parseCodexOutput(output);
  return {
    response: parsed.response || "No response from Codex.",
    sessionId: parsed.sessionId,
  };
}

function buildCodexCommand(
  prompt: string,
  options?: LlmCallOptions,
): string[] {
  const args = [CODEX_PATH];

  if (CODEX_FULL_ACCESS) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", CODEX_SANDBOX);
  }

  args.push(
    "exec",
    "--json",
    "-c",
    `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
  );

  if (CODEX_MODEL) {
    args.push("--model", CODEX_MODEL);
  }

  if (options?.resumeSessionId) {
    args.push("resume", options.resumeSessionId, prompt);
  } else {
    args.push(prompt);
  }

  return args;
}

function parseCodexOutput(output: string): {
  response: string;
  sessionId: string | null;
} {
  const { messages, sessionId } = parseCodexJsonStream(output, {
    includePlainText: true,
  });

  return {
    response: messages.join("\n\n").trim(),
    sessionId,
  };
}

async function callOpenAiCompatible(prompt: string): Promise<LlmCallResult> {
  if (!OPENAI_COMPAT_BASE_URL) {
    throw new Error(
      "LLM_BASE_URL (or OPENAI_BASE_URL) is required for openai-compatible provider.",
    );
  }
  if (!OPENAI_COMPAT_MODEL) {
    throw new Error(
      "LLM_MODEL (or OPENAI_MODEL) is required for openai-compatible provider.",
    );
  }

  const url = buildChatCompletionsUrl(OPENAI_COMPAT_BASE_URL);
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (OPENAI_COMPAT_API_KEY) {
    headers.Authorization = `Bearer ${OPENAI_COMPAT_API_KEY}`;
  }

  if (isVerboseLoggingEnabled()) {
    console.log(`[llm] openai-compatible request start model=${OPENAI_COMPAT_MODEL} url=${url}`);
    console.log(`[llm] prompt chars=${prompt.length} preview=${toSingleLinePreview(prompt, 240)}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: OPENAI_COMPAT_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (isVerboseLoggingEnabled()) {
      console.error(
        `[llm] openai-compatible request failed status=${response.status} durationMs=${Date.now() - startedAt} body=${toSingleLinePreview(
          body,
          600,
        )}`,
      );
    }
    throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    id?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const first = data.choices?.[0]?.message?.content;
  const content =
    typeof first === "string"
      ? first
      : Array.isArray(first)
        ? first
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        : "";

  if (isVerboseLoggingEnabled()) {
    const usage = data.usage
      ? `prompt=${data.usage.prompt_tokens ?? "?"} completion=${data.usage.completion_tokens ?? "?"} total=${data.usage.total_tokens ?? "?"}`
      : "usage=unavailable";
    console.log(
      `[llm] openai-compatible request success durationMs=${Date.now() - startedAt} responseId=${data.id || "n/a"} ${usage}`,
    );
    console.log(`[llm] completion chars=${content.trim().length} preview=${toSingleLinePreview(content, 320)}`);
  }

  return {
    response: content.trim() || "No response from model.",
    sessionId: null,
  };
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const needsVersion = !/\/v\d+$/i.test(trimmed);
  const root = needsVersion ? `${trimmed}/v1` : trimmed;
  return `${root}/chat/completions`;
}

function isVerboseLoggingEnabled(): boolean {
  if (LLM_LOG_VERBOSE) return true;
  return getLlmProvider() === "openai-compatible";
}

function toSingleLinePreview(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}
