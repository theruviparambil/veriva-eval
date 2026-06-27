/**
 * Provider-agnostic model dispatch.
 *
 * The original judge primitive called models through an AWS Bedrock client with
 * a circuit-breaker / region-failover wrapper. This standalone version talks to
 * provider HTTP APIs directly with the built-in `fetch` (Node >= 20) — no SDKs,
 * no cloud account required — so a stranger can run it with whatever key they
 * already have.
 *
 * Two transports cover the field:
 *   - `anthropic`        the Anthropic Messages API
 *   - `openai`           any OpenAI-compatible Chat Completions endpoint
 *                        (OpenAI, OpenRouter, Google's OpenAI-compat layer,
 *                        DeepSeek, Together, Groq, a local server, ...)
 *
 * The default panel is resolved from whichever API keys are present in the
 * environment, so the judge degrades gracefully: one key → a working panel.
 */

export type Transport = "anthropic" | "openai";

export interface ModelSpec {
  /** Stable key used in reports and as a Judgement identifier. */
  key: string;
  /** Human-readable label. */
  label: string;
  transport: Transport;
  /** Provider model id. */
  model: string;
  /** Env var holding the API key for this model. */
  apiKeyEnv: string;
  /** Base URL for the `openai` transport (ignored for `anthropic`). */
  baseUrl?: string;
}

export interface CallOptions {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

/**
 * Build the default 3-model panel.
 *
 * If `OPENROUTER_API_KEY` is set, run a cross-family panel through OpenRouter
 * (one key, three vendors). Otherwise assemble from the native keys that exist.
 * Model ids are overridable via env because vendor ids churn faster than code.
 */
export function resolvePanel(): ModelSpec[] {
  if (env("OPENROUTER_API_KEY")) {
    const base = "https://openrouter.ai/api/v1";
    return [
      { key: "claude", label: "Claude (Anthropic)", transport: "openai", model: env("JUDGE_MODEL_CLAUDE") ?? "anthropic/claude-sonnet-4.6", apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: base },
      { key: "gpt", label: "GPT (OpenAI)", transport: "openai", model: env("JUDGE_MODEL_OPENAI") ?? "openai/gpt-5.1", apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: base },
      { key: "gemini", label: "Gemini (Google)", transport: "openai", model: env("JUDGE_MODEL_GEMINI") ?? "google/gemini-2.5-pro", apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: base },
    ];
  }

  const panel: ModelSpec[] = [];
  if (env("ANTHROPIC_API_KEY")) {
    panel.push({ key: "claude", label: "Claude (Anthropic)", transport: "anthropic", model: env("JUDGE_MODEL_CLAUDE") ?? "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY" });
  }
  if (env("OPENAI_API_KEY")) {
    panel.push({ key: "gpt", label: "GPT (OpenAI)", transport: "openai", model: env("JUDGE_MODEL_OPENAI") ?? "gpt-5.1", apiKeyEnv: "OPENAI_API_KEY", baseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1" });
  }
  if (env("GOOGLE_API_KEY")) {
    panel.push({ key: "gemini", label: "Gemini (Google)", transport: "openai", model: env("JUDGE_MODEL_GEMINI") ?? "gemini-2.5-pro", apiKeyEnv: "GOOGLE_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
  }
  return panel;
}

/**
 * Dispatch a single (system, user) prompt to one model and return its raw text.
 * Throws on transport error, non-2xx, timeout, or an unparseable body — the
 * caller decides how a failed model affects the quorum.
 */
export async function callModel(spec: ModelSpec, opts: CallOptions): Promise<string> {
  const apiKey = env(spec.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`missing ${spec.apiKeyEnv} for model "${spec.key}"`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return spec.transport === "anthropic"
      ? await callAnthropic(spec, apiKey, opts, controller.signal)
      : await callOpenAiCompatible(spec, apiKey, opts, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(
  spec: ModelSpec,
  apiKey: string,
  opts: CallOptions,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: spec.model,
      max_tokens: opts.maxTokens,
      temperature: 0,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function callOpenAiCompatible(
  spec: ModelSpec,
  apiKey: string,
  opts: CallOptions,
  signal: AbortSignal,
): Promise<string> {
  const base = (spec.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: spec.model,
      temperature: 0,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`openai-compat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}
