/**
 * Multi-tool review benchmark (`npm run bench`).
 *
 * Runs each enabled provider over the same corpus of real PRs and writes a
 * normalized, head-to-head comparison: every provider reports findings in the
 * same ProviderFinding shape, so tools are compared on equal footing.
 *
 * Hold the base model constant across providers (BASELINE_MODEL_KEY / QODO_MODEL)
 * and the only variable left is the orchestration framework, which is the
 * question the benchmark exists to answer.
 *
 * Requirements: `gh` authenticated (to fetch PR diffs). Providers need their own
 * keys (baseline → an LLM key; qodo → `uvx` + a QODO_MODEL credential).
 *
 * Usage:
 *   npm run bench                                          # baseline, sample corpus
 *   PROVIDERS_ENABLED=baseline,qodo npm run bench
 *   npm run bench -- path/to/corpus.json --concurrency=2 --ground-truth=gt.json
 *
 * Output (out/<timestamp>/bench/):
 *   findings.csv        : one row per (pr, provider, finding)
 *   provider-stats.csv  : one row per (pr, provider) with cost / latency / count
 *   summary.json        : per-provider aggregate (+ ground-truth buckets if given)
 */
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pLimit from "p-limit";
import { loadCorpus } from "./corpus.js";
import { fetchPrDiff, GhFetchError } from "./github.js";
import { resolveEnabledProviders } from "./providers/registry.js";
import { createDefaultPacer } from "./bench-pacer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
dotenvConfig({ path: resolve(repoRoot, ".env"), quiet: true });

interface Args {
  corpusPath: string;
  concurrency: number;
  outDir: string;
  groundTruthPath: string | null;
}

function parseArgs(argv: string[]): Args {
  let corpusPath = resolve(repoRoot, "data/sample/corpus-sample.json");
  let groundTruthPath: string | null = null;
  let concurrency = 1;
  for (const arg of argv) {
    if (arg.startsWith("--concurrency=")) concurrency = Math.max(1, parseInt(arg.split("=")[1] ?? "1", 10));
    else if (arg.startsWith("--ground-truth=")) groundTruthPath = resolve(arg.split("=")[1] ?? "");
    else if (!arg.startsWith("--")) corpusPath = resolve(arg);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return { corpusPath, concurrency, outDir: resolve(repoRoot, `out/${ts}/bench`), groundTruthPath };
}

interface BenchRow {
  prId: string;
  prUrl: string;
  providerId: string;
  ruleId: string;
  title: string;
  severity: string;
  category: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

interface ProviderStatRow {
  prId: string;
  providerId: string;
  findingCount: number;
  errored: boolean;
  errorMessage: string;
  latencyMs: number;
  costCents: number;
}

const FINDING_HEADERS = ["prId", "prUrl", "providerId", "ruleId", "title", "severity", "category", "filePath", "startLine", "endLine"] as const;
const STAT_HEADERS = ["prId", "providerId", "findingCount", "errored", "errorMessage", "latencyMs", "costCents"] as const;

function csvEscape(s: string | number | boolean): string {
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function writeCsv(path: string, headers: readonly string[], rows: readonly Record<string, unknown>[]): Promise<void> {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape((row[h] ?? "") as string | number | boolean)).join(","));
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
}

interface GroundTruthFile {
  results: Record<string, { hasAnySignal: boolean }>;
}

async function maybeLoadGroundTruth(path: string | null): Promise<GroundTruthFile | null> {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as GroundTruthFile;
  } catch (err) {
    console.warn(`[bench] could not load ground-truth file ${path}: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providers = resolveEnabledProviders(process.env.PROVIDERS_ENABLED);
  console.log(`[bench] corpus:      ${args.corpusPath}`);
  console.log(`[bench] concurrency: ${args.concurrency}`);
  console.log(`[bench] providers:   ${providers.map((p) => p.id).join(", ")}`);
  if (args.groundTruthPath) console.log(`[bench] ground-truth: ${args.groundTruthPath}`);

  // Fail fast if any enabled provider is a stub: a missing column should be
  // an explicit choice, not a silent gap.
  const stubs = providers.filter((p) => !p.enabled);
  if (stubs.length > 0) {
    console.error(`[bench] ERROR: enabled providers with no usable config: ${stubs.map((p) => p.id).join(", ")}`);
    console.error(`[bench] check API keys / runtime requirements, or drop them from PROVIDERS_ENABLED`);
    process.exit(1);
  }

  await mkdir(args.outDir, { recursive: true });
  const corpus = await loadCorpus(args.corpusPath);
  const groundTruth = await maybeLoadGroundTruth(args.groundTruthPath);
  console.log(`[bench] loaded corpus ${corpus.version} (${corpus.items.length} items)\n`);

  const limit = pLimit(args.concurrency);
  const findingRows: BenchRow[] = [];
  const statRows: ProviderStatRow[] = [];
  // The pacer encapsulates a sliding-window TPM tracker, an adaptive throttle
  // that widens after a rate-limit failure, and an inter-repo cool-down. Env
  // knobs: BENCH_THROTTLE_MS, BENCH_INTER_REPO_COOLDOWN_MS, BENCH_TPM_BUDGET.
  const pacer = createDefaultPacer();

  await Promise.all(
    corpus.items.map((item, idx) =>
      limit(async () => {
        const sleptMs = await pacer.beforePr(item.repo, idx);
        const tag = `[${idx + 1}/${corpus.items.length}] ${item.id}`;
        if (sleptMs > 0) console.log(`${tag} paced (slept ${sleptMs}ms${pacer.isPunishing() ? ", adaptive throttle on" : ""})`);

        let diffText: string;
        try {
          diffText = await fetchPrDiff(item.repo, item.prNumber);
        } catch (err) {
          const msg = err instanceof GhFetchError ? err.message : (err as Error).message;
          console.error(`${tag} ✗ diff fetch failed: ${msg}`);
          for (const provider of providers) {
            statRows.push({ prId: item.id, providerId: provider.id, findingCount: 0, errored: true, errorMessage: `gh fetch failed: ${msg}`, latencyMs: 0, costCents: 0 });
          }
          return;
        }

        for (const provider of providers) {
          const result = await provider.run({ diff: diffText, repo: item.repo, prNumber: item.prNumber });
          statRows.push({
            prId: item.id,
            providerId: provider.id,
            findingCount: result.findings.length,
            errored: result.errored,
            errorMessage: result.errorMessage ?? "",
            latencyMs: result.usage.latencyMs,
            costCents: result.usage.costCents,
          });
          pacer.recordResult({
            inputTokens: Number(result.usage.details?.inputTokens ?? 0),
            outputTokens: Number(result.usage.details?.outputTokens ?? 0),
            errored: result.errored,
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          });
          for (const f of result.findings) {
            findingRows.push({
              prId: item.id,
              prUrl: item.url,
              providerId: provider.id,
              ruleId: f.ruleId,
              title: f.title,
              severity: f.severity,
              category: f.category,
              filePath: f.filePath,
              startLine: f.startLine,
              endLine: f.endLine,
            });
          }
          console.log(
            `${tag} ${provider.id} ${result.errored ? "✗" : "✓"} findings=${result.findings.length} ` +
              `cost=${result.usage.costCents}¢ latency=${result.usage.latencyMs}ms` +
              (result.errorMessage ? ` err="${result.errorMessage}"` : ""),
          );
        }
      }),
    ),
  );

  // Stable ordering by corpus position then provider id for deterministic diffs.
  const order = new Map(corpus.items.map((item, i) => [item.id, i] as const));
  const sortRows = <T extends { prId: string; providerId: string }>(rows: T[]) =>
    rows.sort((a, b) => (order.get(a.prId) ?? 0) - (order.get(b.prId) ?? 0) || a.providerId.localeCompare(b.providerId));
  sortRows(findingRows);
  sortRows(statRows);

  await writeCsv(resolve(args.outDir, "findings.csv"), FINDING_HEADERS, findingRows as unknown as Record<string, unknown>[]);
  await writeCsv(resolve(args.outDir, "provider-stats.csv"), STAT_HEADERS, statRows as unknown as Record<string, unknown>[]);

  // Per-provider aggregate. With ground truth, also count findings raised on PRs
  // that carry any ground-truth signal vs those that don't, a coarse "did the
  // tool flag the suspicious PRs at all" signal, not a true TP rate (which needs
  // file/line correlation handled in triage).
  type Agg = { findings: number; cost: number; latency: number; erroredRuns: number; totalRuns: number; onSignaled: number; onUnsignaled: number };
  const agg = new Map<string, Agg>();
  for (const p of providers) agg.set(p.id, { findings: 0, cost: 0, latency: 0, erroredRuns: 0, totalRuns: 0, onSignaled: 0, onUnsignaled: 0 });
  for (const row of statRows) {
    const a = agg.get(row.providerId);
    if (!a) continue;
    a.totalRuns += 1;
    a.findings += row.findingCount;
    a.cost += row.costCents;
    a.latency += row.latencyMs;
    if (row.errored) a.erroredRuns += 1;
    if (groundTruth && row.findingCount > 0) {
      if (groundTruth.results[row.prId]?.hasAnySignal) a.onSignaled += 1;
      else a.onUnsignaled += 1;
    }
  }

  const summary = {
    corpusVersion: corpus.version,
    corpusSize: corpus.items.length,
    generatedAt: new Date().toISOString(),
    groundTruthLoaded: groundTruth !== null,
    providers: [...agg.entries()].map(([id, a]) => ({
      id,
      totalRuns: a.totalRuns,
      erroredRuns: a.erroredRuns,
      totalFindings: a.findings,
      avgFindingsPerPr: a.totalRuns > 0 ? a.findings / a.totalRuns : 0,
      totalCostCents: a.cost,
      avgLatencyMsPerPr: a.totalRuns > 0 ? Math.round(a.latency / a.totalRuns) : 0,
      ...(groundTruth ? { findingsOnSignaledPrs: a.onSignaled, findingsOnUnsignaledPrs: a.onUnsignaled } : {}),
    })),
  };
  await writeFile(resolve(args.outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log(`\n[bench] done`);
  for (const p of summary.providers) {
    console.log(`[bench] ${p.id}: ${p.totalFindings} findings, ${p.totalCostCents}¢, ${p.erroredRuns}/${p.totalRuns} errored`);
  }
  console.log(`[bench] outdir: ${args.outDir}`);
}

main().catch((err) => {
  console.error("[bench] fatal:", err);
  process.exit(1);
});
