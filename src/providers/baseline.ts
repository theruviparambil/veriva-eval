/**
 * Baseline provider — a single direct LLM call with a review prompt.
 *
 * This is the "home tool" column: one frontier model, one prompt, no
 * orchestration. Comparing it against a framework provider (e.g. qodo) on the
 * same corpus and the same base model isolates what the orchestration actually
 * buys you over a plain model call.
 *
 * Uses the first available model from the panel (see resolvePanel), or override
 * with BASELINE_MODEL_KEY. Cost isn't tracked here (the chat APIs vary in how
 * they report usage), so costCents is 0 and latency is the honest wall-clock.
 */
import { callModel, resolvePanel } from "../providers.js";
import type { Provider, ProviderFinding, ProviderInput, ProviderResult } from "./index.js";

const REVIEW_SYSTEM_PROMPT = `You are a precise code reviewer. Review the unified diff for real defects: security vulnerabilities, correctness bugs, and clear quality problems. Do not invent issues.

Return STRICT JSON and nothing else — an array of findings:
[
  {
    "ruleId": "<short stable id, e.g. SECURITY.SQL_INJECTION>",
    "title": "<one line>",
    "description": "<what's wrong and why, 1-3 sentences>",
    "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
    "category": "SECURITY" | "QUALITY" | "PRACTICES" | "DOCUMENTATION" | "SUPPLY_CHAIN",
    "filePath": "<path from the diff>",
    "startLine": <number>,
    "endLine": <number>
  }
]
Return [] if the diff has no real issues. No prose, no markdown fence.`;

const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const CATEGORIES = new Set(["SECURITY", "QUALITY", "PRACTICES", "DOCUMENTATION", "SUPPLY_CHAIN"]);

function parseFindings(text: string): ProviderFinding[] {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProviderFinding[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const severity = typeof f.severity === "string" && SEVERITIES.has(f.severity) ? f.severity : "INFO";
    const category = typeof f.category === "string" && CATEGORIES.has(f.category) ? f.category : "QUALITY";
    out.push({
      ruleId: typeof f.ruleId === "string" ? f.ruleId : "baseline:finding",
      title: typeof f.title === "string" ? f.title.slice(0, 200) : "(untitled)",
      description: typeof f.description === "string" ? f.description : "",
      severity,
      category,
      filePath: typeof f.filePath === "string" ? f.filePath : "",
      startLine: Number.isFinite(f.startLine) ? Number(f.startLine) : 0,
      endLine: Number.isFinite(f.endLine) ? Number(f.endLine) : 0,
    });
  }
  return out;
}

export function createBaselineProvider(): Provider {
  const panel = resolvePanel();
  const wantKey = process.env.BASELINE_MODEL_KEY?.trim();
  const spec = wantKey ? panel.find((m) => m.key === wantKey) ?? panel[0] : panel[0];

  return {
    id: "baseline",
    label: spec ? `Baseline (${spec.label})` : "Baseline (no model)",
    enabled: spec !== undefined,
    async run(input: ProviderInput): Promise<ProviderResult> {
      const t0 = Date.now();
      if (!spec) {
        return {
          providerId: "baseline",
          findings: [],
          usage: { latencyMs: 0, costCents: 0 },
          errored: true,
          errorMessage: "no model available — set an API key (see .env.example)",
        };
      }
      try {
        const text = await callModel(spec, {
          system: REVIEW_SYSTEM_PROMPT,
          user: `Repo: ${input.repo} (PR #${input.prNumber})\n\nUnified diff:\n${input.diff}`,
          maxTokens: 2000,
          timeoutMs: 120_000,
        });
        const findings = parseFindings(text);
        return {
          providerId: "baseline",
          findings,
          usage: { latencyMs: Date.now() - t0, costCents: 0, details: { model: spec.model, findingCount: findings.length } },
          errored: false,
        };
      } catch (err) {
        return {
          providerId: "baseline",
          findings: [],
          usage: { latencyMs: Date.now() - t0, costCents: 0 },
          errored: true,
          errorMessage: (err as Error).message?.slice(0, 500) ?? "unknown error",
        };
      }
    },
  };
}
