/**
 * Qodo PR-Agent provider.
 *
 * Shells out to PR-Agent's CLI (https://github.com/qodo-ai/pr-agent) and
 * normalizes its markdown review into ProviderFinding shape so a third-party
 * review tool can be compared head-to-head against the baseline provider.
 *
 * Hold the base model constant: PR-Agent is pointed at the SAME model as the
 * baseline (via `QODO_MODEL`, any litellm-supported id), so the benchmark
 * isolates the variable that matters — the orchestration framework — rather
 * than confounding it with a model swap.
 *
 * Runtime requirements:
 *   - `uvx` (https://docs.astral.sh/uv/) — launches pr-agent in an ephemeral
 *     isolated env. First call cold-starts; later calls reuse the uv cache.
 *   - `gh` authenticated against github.com — pr-agent fetches PR context via
 *     the GitHub API, using the token from `gh auth token` (or GITHUB_TOKEN).
 *   - Whatever credentials your `QODO_MODEL` needs, read by litellm from env
 *     (e.g. ANTHROPIC_API_KEY for an `anthropic/...` id).
 *
 * Finding normalization: pr-agent's `review` emits markdown with sections like
 * "Possible Issues" and "Security Concerns". Each bullet becomes a finding;
 * severity/category are inferred from headings (best-effort — pr-agent doesn't
 * emit structured severity). The parser is intentionally tolerant: on format
 * drift it captures as INFO/QUALITY rather than crashing.
 *
 * Cost accounting: pr-agent doesn't expose token counts in stdout, so cost is
 * a coarse per-review estimate. Wall-clock latency is the honest UX number.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Provider,
  ProviderFinding,
  ProviderInput,
  ProviderResult,
} from './index.js';

const execFileAsync = promisify(execFile);

// pr-agent version for the bench. Defaults to the latest published package; for
// a reproducible run, pin a specific release or git ref via the env var, e.g.
// PR_AGENT_VERSION="pr-agent==0.30". Whatever is used is recorded in the output.
const PR_AGENT_VERSION = process.env.PR_AGENT_VERSION?.trim() || 'pr-agent';

// The model pr-agent runs, in litellm id format (e.g. "anthropic/claude-...",
// "openai/gpt-...", "bedrock/..."). Set QODO_MODEL to match the baseline
// provider's model so the comparison isolates the framework, not the model.
const QODO_MODEL = process.env.QODO_MODEL?.trim() || 'anthropic/claude-sonnet-4-6';

/**
 * Coarse cost-per-review estimate in cents, used because pr-agent doesn't emit
 * token counts on stdout. Deliberately rounded up so the comparison column
 * doesn't make the tool look unrealistically cheap. Override with QODO_COST_CENTS.
 */
const ESTIMATED_COST_CENTS_PER_REVIEW = Number(process.env.QODO_COST_CENTS ?? 6);

interface FetchGithubTokenResult {
  token: string;
  source: 'gh-cli' | 'env';
}

async function getGithubToken(): Promise<FetchGithubTokenResult> {
  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, source: 'env' };
  }
  // gh auth token works as long as the user is logged in via `gh auth login`.
  // We don't fall back to anonymous fetches — pr-agent needs the API quota.
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  return { token: stdout.trim(), source: 'gh-cli' };
}

/**
 * Heuristic markdown → ProviderFinding parser for pr-agent's review output.
 *
 * pr-agent emits sections like:
 *   ## PR Reviewer Guide
 *   ### General suggestions
 *   - **Suggestion**: text...
 *   ### Possible Issues
 *   - file.ts [line 12]: Some issue
 *
 * We split by `### ` headings, classify category from the heading text,
 * and split each section into bullet-level findings. File / line are
 * extracted via regex when present; otherwise fall back to a placeholder
 * so the finding still appears in the comparison row.
 *
 * This is intentionally lossy — pr-agent's format is not stable across
 * versions, so we capture what we can without crashing on drift.
 */
export function parsePrAgentReview(
  markdown: string,
  prRepo: string,
  prNumber: number,
): ProviderFinding[] {
  const findings: ProviderFinding[] = [];

  // Split on `### ` headings (any depth). Skip the first chunk before
  // the first heading — usually preamble.
  const sections = markdown.split(/^###\s+/m);
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i] ?? '';
    const firstLineEnd = section.indexOf('\n');
    if (firstLineEnd < 0) continue;
    const heading = section.slice(0, firstLineEnd).trim();
    const body = section.slice(firstLineEnd + 1);

    const category = inferCategory(heading);
    const severity = inferSeverity(heading);

    // Split body into bullet items. pr-agent uses `- ` or `* ` at line start.
    const bullets = body
      .split(/\n(?=\s*[-*]\s)/)
      .map((s) => s.replace(/^\s*[-*]\s+/, '').trim())
      .filter((s) => s.length > 0 && !/^[-=]{3,}$/.test(s));

    for (const bullet of bullets) {
      const { filePath, startLine } = extractFileLine(bullet) ?? {
        filePath: `${prRepo}#${prNumber}`,
        startLine: 0,
      };
      findings.push({
        ruleId: `qodo:${category.toLowerCase()}`,
        title: bullet.split('\n')[0]!.slice(0, 200),
        description: bullet,
        severity,
        category,
        filePath,
        startLine,
        endLine: startLine,
      });
    }
  }
  return findings;
}

function inferCategory(heading: string): string {
  const h = heading.toLowerCase();
  if (/security|cve|vuln|injection|xss|auth/.test(h)) return 'SECURITY';
  if (/test|coverage/.test(h)) return 'PRACTICES';
  if (/depend|supply|package/.test(h)) return 'SUPPLY_CHAIN';
  if (/doc|readme|comment/.test(h)) return 'DOCUMENTATION';
  return 'QUALITY';
}

function inferSeverity(heading: string): string {
  const h = heading.toLowerCase();
  if (/critical|severe|blocker/.test(h)) return 'CRITICAL';
  if (/security|issue|bug|error/.test(h)) return 'HIGH';
  if (/possible issue|concern|suggestion/.test(h)) return 'MEDIUM';
  if (/improvement|enhancement|optional/.test(h)) return 'LOW';
  return 'INFO';
}

function extractFileLine(
  bullet: string,
): { filePath: string; startLine: number } | null {
  // Common pr-agent patterns:
  //   `path/to/file.ts [line 42]: ...`
  //   `**File:** path/to/file.ts:42`
  //   ``path/to/file.ts:42``
  const patterns = [
    /([\w./-]+\.[a-z]+)\s*\[line\s+(\d+)\]/i,
    /([\w./-]+\.[a-z]+):(\d+)/,
    /\*\*File:\*\*\s+([\w./-]+\.[a-z]+):?(\d+)?/i,
  ];
  for (const pattern of patterns) {
    const m = bullet.match(pattern);
    if (m && m[1]) {
      return {
        filePath: m[1],
        startLine: m[2] ? parseInt(m[2], 10) : 0,
      };
    }
  }
  return null;
}

interface RunPrAgentOptions {
  repo: string;
  prNumber: number;
  signal?: AbortSignal;
}

async function runPrAgentReview(opts: RunPrAgentOptions): Promise<string> {
  const githubToken = await getGithubToken();
  const prUrl = `https://github.com/${opts.repo}/pull/${opts.prNumber}`;

  // pr-agent reads config from env via the CONFIG__ prefix convention or
  // a config file. We thread everything through env so we don't need to
  // write a TOML to disk per call.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB__USER_TOKEN: githubToken.token,
    CONFIG__MODEL: QODO_MODEL,
    CONFIG__MODEL_TURBO: QODO_MODEL,
    CONFIG__FALLBACK_MODELS: QODO_MODEL,
    CONFIG__PUBLISH_OUTPUT: 'false', // don't post a comment to GitHub
    CONFIG__PUBLISH_OUTPUT_PROGRESS: 'false',
    CONFIG__VERBOSITY_LEVEL: '0',
  };

  // 5min timeout per PR — enough for pr-agent's longest reviews on big
  // diffs while the bench's outer pacer keeps overall throughput sane.
  const { stdout } = await execFileAsync(
    'uvx',
    ['--from', PR_AGENT_VERSION, 'pr-agent', '--pr_url', prUrl, 'review'],
    {
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5 * 60_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  return stdout;
}

export function createQodoProvider(): Provider {
  return {
    id: 'qodo',
    label: 'Qodo (PR-Agent)',
    enabled: true,
    async run(input: ProviderInput): Promise<ProviderResult> {
      const t0 = Date.now();
      try {
        const stdout = await runPrAgentReview({
          repo: input.repo,
          prNumber: input.prNumber,
        });
        const findings = parsePrAgentReview(stdout, input.repo, input.prNumber);
        return {
          providerId: 'qodo',
          findings,
          usage: {
            latencyMs: Date.now() - t0,
            costCents: ESTIMATED_COST_CENTS_PER_REVIEW,
            details: {
              model: QODO_MODEL,
              prAgentVersion: PR_AGENT_VERSION,
              stdoutChars: stdout.length,
              findingCount: findings.length,
            },
          },
          errored: false,
        };
      } catch (err) {
        return {
          providerId: 'qodo',
          findings: [],
          usage: { latencyMs: Date.now() - t0, costCents: 0 },
          errored: true,
          errorMessage:
            (err as Error).message?.slice(0, 500) ?? 'unknown error',
        };
      }
    },
  };
}
