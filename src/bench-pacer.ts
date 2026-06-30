/**
 * Bench-loop pacing — three coordinated mechanisms that prevent the
 * provider-side TPM (tokens-per-minute) exhaustion pattern that drops PRs in a
 * large bench run when a per-account token budget gets drained by consecutive
 * large diffs (often clustered in one repo).
 *
 * The mechanisms are layered:
 *
 *   1. **Sliding-window TPM tracker** — records every PR's token usage.
 *      Before each new call, computes total tokens consumed in the last
 *      60s; if approaching the budget (TPM_BUDGET, default 80K), sleeps
 *      until the window has enough headroom. Predictive — prevents 429s
 *      before they happen instead of reacting after.
 *
 *   2. **Adaptive throttle** — base inter-PR throttle widens automatically
 *      when recent failure rate climbs. Looks at the last 10 PRs; if any
 *      errored on rate-limit / circuit-open, the throttle is held at 4×
 *      base (default 5s → 20s) for the next 5 minutes, then gradually
 *      relaxed back. Reactive backstop for whatever the TPM tracker missed.
 *
 *   3. **Inter-repo cool-down** — when the loop transitions from one repo
 *      to a different repo, sleeps an extra `interRepoCooldownMs` (default
 *      60s). Catches the "one repo with N consecutive big diffs blew the
 *      bucket, next repo's diffs land before recovery" pattern.
 *
 * The defaults assume a frontier model at roughly ~80K TPM account-wide with no
 * provisioned throughput. Tighten via env if you have less.
 *
 * All three are pure logic (no I/O beyond setTimeout) — easy to unit-test.
 */

const DEFAULT_TPM_BUDGET = 80_000;
const TPM_TARGET_UTILIZATION = 0.7; // back off when we'd push past 70% of budget
const TPM_WINDOW_MS = 60_000;
const RECENT_FAILURE_LOOKBACK = 10;
const PUNISH_DURATION_MS = 5 * 60_000;
const PUNISH_MULTIPLIER = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TokenSample {
  timestamp: number;
  tokens: number;
}

interface RecentResult {
  /** Was this PR's review call rate-limited / circuit-open? */
  errored: boolean;
}

export interface PacerConfig {
  baseThrottleMs: number;
  interRepoCooldownMs: number;
  tpmBudget: number;
  /** Set to false to disable sleep-based pacing (unit tests). */
  enableSleep?: boolean;
}

export class BenchPacer {
  private readonly config: PacerConfig;
  private readonly tokenSamples: TokenSample[] = [];
  private readonly recent: RecentResult[] = [];
  private punishUntil = 0;
  private lastRepo: string | null = null;
  private totalSleptMs = 0;

  constructor(config: PacerConfig) {
    this.config = config;
  }

  /**
   * Call BEFORE running the provider on a given PR. Returns the total ms
   * slept (for logging). Composes:
   *   - inter-repo cool-down if repo changed
   *   - adaptive throttle (base, possibly multiplied by punishment)
   *   - TPM-window wait if recent token usage is hot
   */
  async beforePr(repo: string, idx: number): Promise<number> {
    let toSleep = 0;

    // (3) Inter-repo cool-down (skip on first PR overall).
    if (this.lastRepo !== null && repo !== this.lastRepo) {
      toSleep += this.config.interRepoCooldownMs;
    }
    this.lastRepo = repo;

    // (2) Adaptive throttle. Base throttle skipped on PR 0.
    if (idx > 0) {
      const multiplier = this.isPunishing() ? PUNISH_MULTIPLIER : 1;
      toSleep += this.config.baseThrottleMs * multiplier;
    }

    // (1) TPM-window check. If recent tokens consumed would push us past
    // the target utilization on the next call, wait for the window to
    // age off enough samples.
    const tpmSleep = this.tpmWindowSleepMs();
    if (tpmSleep > 0) toSleep += tpmSleep;

    if (toSleep > 0 && this.config.enableSleep !== false) {
      await sleep(toSleep);
    }
    this.totalSleptMs += toSleep;
    return toSleep;
  }

  /**
   * Call AFTER the provider returns. Records token usage + result for the
   * adaptive throttle's failure-rate window.
   */
  recordResult(opts: {
    inputTokens: number;
    outputTokens: number;
    errored: boolean;
    errorMessage?: string;
  }): void {
    const totalTokens = opts.inputTokens + opts.outputTokens;
    if (totalTokens > 0) {
      this.tokenSamples.push({ timestamp: Date.now(), tokens: totalTokens });
      this.pruneTokenWindow();
    }

    const isRateLimitFailure =
      opts.errored &&
      typeof opts.errorMessage === 'string' &&
      /(429|too many tokens|throttl|circuit breaker|rate.?limit)/i.test(
        opts.errorMessage,
      );
    this.recent.push({ errored: isRateLimitFailure });
    if (this.recent.length > RECENT_FAILURE_LOOKBACK) this.recent.shift();

    // If any of the last N results was a rate-limit failure, enter punish
    // mode (or extend it). Starts the 5-minute window from now.
    if (this.recent.some((r) => r.errored)) {
      this.punishUntil = Date.now() + PUNISH_DURATION_MS;
    }
  }

  totalSlept(): number {
    return this.totalSleptMs;
  }

  /** Visible for tests / logging. */
  isPunishing(): boolean {
    return Date.now() < this.punishUntil;
  }

  private pruneTokenWindow(): void {
    const cutoff = Date.now() - TPM_WINDOW_MS;
    while (
      this.tokenSamples.length > 0 &&
      this.tokenSamples[0]!.timestamp < cutoff
    ) {
      this.tokenSamples.shift();
    }
  }

  private tpmWindowSleepMs(): number {
    this.pruneTokenWindow();
    const recentTokens = this.tokenSamples.reduce((s, x) => s + x.tokens, 0);
    const target = this.config.tpmBudget * TPM_TARGET_UTILIZATION;
    if (recentTokens < target) return 0;

    // We're hot. Find the oldest sample and wait until it ages out of the
    // 60s window. That's the minimum sleep that brings us back below target.
    if (this.tokenSamples.length === 0) return 0;
    const oldest = this.tokenSamples[0]!.timestamp;
    const ageOff = oldest + TPM_WINDOW_MS - Date.now();
    return Math.max(0, ageOff);
  }
}

export function createDefaultPacer(): BenchPacer {
  return new BenchPacer({
    baseThrottleMs: parseInt(process.env.BENCH_THROTTLE_MS ?? '5000', 10),
    interRepoCooldownMs: parseInt(
      process.env.BENCH_INTER_REPO_COOLDOWN_MS ?? '60000',
      10,
    ),
    tpmBudget: parseInt(
      process.env.BENCH_TPM_BUDGET ?? String(DEFAULT_TPM_BUDGET),
      10,
    ),
  });
}
