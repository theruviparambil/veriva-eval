/**
 * Provider interface for the multi-tool review benchmark.
 *
 * Each provider runs against the same PR diff and returns normalized findings
 * plus cost/latency metadata, so different review tools can be compared
 * head-to-head on the same corpus and ground truth.
 *
 * Bundled providers:
 *   - baseline : one direct LLM call with a review prompt (./baseline.ts)
 *   - qodo     : shells out to qodo-ai/pr-agent (./qodo.ts)
 *
 * Add your own by implementing `Provider` and registering it in registry.ts.
 * Set `PROVIDERS_ENABLED=baseline,qodo` to choose which columns to run.
 */

export interface ProviderFinding {
  /** Provider's own rule identifier (vendor-specific format). */
  ruleId: string;
  title: string;
  description: string;
  /** Normalized to CRITICAL / HIGH / MEDIUM / LOW / INFO */
  severity: string;
  /** Normalized to SECURITY / QUALITY / PRACTICES / DOCUMENTATION / SUPPLY_CHAIN */
  category: string;
  filePath: string;
  startLine: number;
  endLine: number;
  codeSnippet?: string;
  suggestedFix?: string;
}

export interface ProviderUsage {
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Cost in USD cents. Set to 0 for free providers. */
  costCents: number;
  /** Provider-specific token / credit accounting. Optional. */
  details?: Record<string, number | string>;
}

export interface ProviderResult {
  providerId: string;
  findings: ProviderFinding[];
  usage: ProviderUsage;
  /** True if the provider failed entirely (timeout, auth, rate limit). */
  errored: boolean;
  errorMessage?: string;
}

export interface ProviderInput {
  /** Unified diff text. */
  diff: string;
  /** Repo identifier (owner/name), providers may use this for context. */
  repo: string;
  /** PR number, providers may use this to pull additional context. */
  prNumber: number;
}

export interface Provider {
  /** Stable identifier, appears in benchmark output column headers. */
  id: string;
  /** Human-readable label for reports. */
  label: string;
  /** True if the provider is wired and ready to call. False = stub. */
  enabled: boolean;
  run(input: ProviderInput): Promise<ProviderResult>;
}
