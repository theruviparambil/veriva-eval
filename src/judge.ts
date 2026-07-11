/**
 * Cross-model LLM-judge primitive.
 *
 * Takes `(input, output, criteria)` and dispatches it in parallel to a panel of
 * frontier models. Each model returns a 0.0–1.0 score, a short rationale, and a
 * confidence band as strict JSON. `aggregateJudgements()` then applies a quorum
 * rule (by default: pass when >= 2 of 3 models score >= 0.8).
 *
 * Why a panel instead of one judge: any single model has blind spots and
 * leans toward outputs that resemble its own. A quorum of independent models
 * (ideally from different families) is far harder to fool and mitigates the
 * self-enhancement bias an LLM judge shows toward its own kind.
 *
 * A model that times out or returns junk surfaces as a Judgement with
 * `score: null` and `error` set, so a flaky model degrades the panel gracefully
 * instead of failing the run.
 */
import { callModel, resolvePanel, type ModelSpec } from "./providers.js";

const DEFAULT_PER_MODEL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 600;

const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluator. Score the OUTPUT against the CRITERIA on a 0.0–1.0 scale.

Return strict JSON with this exact shape and nothing else. No preamble, no markdown fence, no trailing text:

{
  "score": <number between 0.0 and 1.0 inclusive>,
  "rationale": "<2–3 sentences explaining the score; cite what worked and what didn't>",
  "confidence": "high" | "medium" | "low"
}

Rules:
- 0.0 means the output completely fails the criteria. 1.0 means it meets them flawlessly. Use the full range: don't bunch around 0.7-0.8 unless that's honestly where things land.
- Be specific in rationale. Generic "looks good" is not a useful rating.
- "confidence" reflects your certainty in the score, not the quality of the output.
- If the input/output is malformed or impossible to score, return score 0.0 and explain in rationale.`;

export interface JudgeInput {
  /** The original prompt / input the evaluated system received. */
  input: unknown;
  /** The output the evaluated system produced. */
  output: unknown;
  /** Natural-language criteria the judge should grade against. */
  criteria: string;
  /** Optional surrounding context (upstream conversation, related findings). */
  context?: string;
}

export interface Judgement {
  /** Panel model key (see resolvePanel). */
  model: string;
  modelId: string;
  /** 0.0–1.0 score, or null if the judge couldn't form one. */
  score: number | null;
  rationale: string;
  confidence: "high" | "medium" | "low" | null;
  latencyMs: number;
  /** Set only on transport / parse failure. */
  error?: string;
}

export interface JudgeOptions {
  /** Override the panel. Default: resolvePanel() from available API keys. */
  panel?: ModelSpec[];
  /** Per-model wall-time budget. Default: 30 s. */
  perModelTimeoutMs?: number;
  /** Max tokens the judge can spend on its reply. Default: 600. */
  maxTokens?: number;
}

/**
 * Dispatch the judge prompt to every model in the panel in parallel.
 */
export async function judgeOutput(
  input: JudgeInput,
  options: JudgeOptions = {},
): Promise<Judgement[]> {
  const panel = options.panel ?? resolvePanel();
  if (panel.length === 0) {
    throw new Error(
      "no judge models available: set OPENROUTER_API_KEY, or ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY (see .env.example)",
    );
  }
  const perModelTimeoutMs = options.perModelTimeoutMs ?? DEFAULT_PER_MODEL_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const userPrompt = formatPrompt(input);
  return Promise.all(
    panel.map((spec) => runOne(spec, userPrompt, perModelTimeoutMs, maxTokens)),
  );
}

async function runOne(
  spec: ModelSpec,
  userPrompt: string,
  perModelTimeoutMs: number,
  maxTokens: number,
): Promise<Judgement> {
  const started = Date.now();
  try {
    const content = await callModel(spec, {
      system: JUDGE_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens,
      timeoutMs: perModelTimeoutMs,
    });
    const parsed = parseJudgement(content);
    return {
      model: spec.key,
      modelId: spec.model,
      score: parsed.score,
      rationale: parsed.rationale,
      confidence: parsed.confidence,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      model: spec.key,
      modelId: spec.model,
      score: null,
      rationale: "",
      confidence: null,
      latencyMs: Date.now() - started,
      error: message,
    };
  }
}

function formatPrompt(input: JudgeInput): string {
  const parts = [
    `## CRITERIA\n${input.criteria.trim()}`,
    `## INPUT\n${stringifyForPrompt(input.input)}`,
    `## OUTPUT\n${stringifyForPrompt(input.output)}`,
  ];
  if (input.context && input.context.trim()) {
    parts.push(`## CONTEXT\n${input.context.trim()}`);
  }
  return parts.join("\n\n");
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Parse a model reply into a score/rationale/confidence, tolerant of fences. */
export function parseJudgement(text: string): {
  score: number | null;
  rationale: string;
  confidence: "high" | "medium" | "low" | null;
} {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!cleaned) return { score: null, rationale: "", confidence: null };
  try {
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    const rawScore = json.score;
    const score =
      typeof rawScore === "number" && rawScore >= 0 && rawScore <= 1 ? rawScore : null;
    const rationale = typeof json.rationale === "string" ? json.rationale.trim() : "";
    const rawConf = typeof json.confidence === "string" ? json.confidence.toLowerCase() : "";
    const confidence: "high" | "medium" | "low" | null =
      rawConf === "high" || rawConf === "medium" || rawConf === "low" ? rawConf : null;
    return { score, rationale, confidence };
  } catch {
    // Judge ignored the strict-JSON instruction. Keep the raw text as rationale
    // so the failure is visible downstream.
    return { score: null, rationale: text.slice(0, 500), confidence: null };
  }
}

export interface JudgementAggregate {
  passed: boolean;
  meanScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  scores: Array<{ model: string; score: number | null }>;
  threshold: number;
  passingCount: number;
  requiredCount: number;
}

/**
 * Aggregate `Judgement[]` by quorum: at least `requiredCount` models must score
 * >= `threshold`. Null scores (failed calls) don't count toward passing, so a
 * quorum requires real scores from real models.
 */
export function aggregateJudgements(
  judgements: Judgement[],
  threshold = 0.8,
  requiredCount = 2,
): JudgementAggregate {
  const scores = judgements.map((j) => ({ model: j.model, score: j.score }));
  const valid = scores.map((s) => s.score).filter((s): s is number => typeof s === "number");
  const passingCount = valid.filter((s) => s >= threshold).length;
  const meanScore = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  return {
    passed: passingCount >= requiredCount,
    meanScore,
    minScore: valid.length ? Math.min(...valid) : null,
    maxScore: valid.length ? Math.max(...valid) : null,
    scores,
    threshold,
    passingCount,
    requiredCount,
  };
}
