/**
 * Cross-model judge harness (the live demo: `npm run eval`).
 *
 * Reads a JSONL fixture of {id, input, output, criteria, label?} cases, runs
 * each through the cross-model judge in parallel, aggregates by the quorum rule,
 * and writes:
 *
 *   out/<timestamp>/results.jsonl   one row per case
 *   out/<timestamp>/summary.json    aggregate stats
 *
 * Exits non-zero when judge ACCURACY falls below `--min-pass-rate` (default
 * 0.95). Accuracy means each case's verdict matched its `expectedPass`, i.e.
 * the judge was RIGHT, not that the panel passed. Cases with no `expectedPass`
 * fall back to the raw pass rate. That makes the harness a CI gate: wire it into
 * a workflow on a high-stakes surface and a regression fails the build like a
 * unit test.
 *
 * Usage:
 *   npm run eval                                  # default fixture
 *   npm run eval -- --fixture=path.jsonl
 *   npm run eval -- --threshold=0.7 --min-pass-rate=0.9 --required-count=2
 */
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pLimit from "p-limit";
import { aggregateJudgements, judgeOutput } from "./judge.js";
import { resolvePanel } from "./providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
dotenvConfig({ path: resolve(repoRoot, ".env"), quiet: true });

interface FixtureCase {
  id: string;
  label?: string;
  input: unknown;
  output: unknown;
  criteria: string;
  context?: string;
  /**
   * What the RIGHT verdict is for this case.
   *
   * Without it the gate scores "how many cases did the panel pass", which is
   * not a quality signal: this fixture deliberately contains an answer that
   * should fail, so the ceiling was 2 of 3 against a default 0.95 bar. It also
   * pointed the wrong way, since the panel starting to pass the hedging case
   * would have raised the rate and read as an improvement.
   */
  expectedPass?: boolean;
}

interface Args {
  fixturePath: string;
  outDir: string;
  concurrency: number;
  threshold: number;
  minPassRate: number;
  requiredCount: number;
}

function parseArgs(argv: string[]): Args {
  let fixturePath = resolve(repoRoot, "data/sample/cross-eval-cases.jsonl");
  let outDir = resolve(repoRoot, "out", new Date().toISOString().replace(/[:.]/g, "-"));
  let concurrency = 3;
  let threshold = 0.8;
  let minPassRate = 0.95;
  let requiredCount = 2;
  for (const arg of argv) {
    if (arg.startsWith("--fixture=")) fixturePath = resolve(arg.slice("--fixture=".length));
    else if (arg.startsWith("--out=")) outDir = resolve(arg.slice("--out=".length));
    else if (arg.startsWith("--concurrency=")) concurrency = Math.max(1, parseInt(arg.split("=")[1] ?? "3", 10));
    else if (arg.startsWith("--threshold=")) threshold = parseFloat(arg.split("=")[1] ?? "0.8");
    else if (arg.startsWith("--min-pass-rate=")) minPassRate = parseFloat(arg.split("=")[1] ?? "0.95");
    else if (arg.startsWith("--required-count=")) requiredCount = parseInt(arg.split("=")[1] ?? "2", 10);
  }
  return { fixturePath, outDir, concurrency, threshold, minPassRate, requiredCount };
}

async function loadFixture(path: string): Promise<FixtureCase[]> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("//"));
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`Fixture line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object") throw new Error(`Fixture line ${i + 1} is not an object`);
    const c = parsed as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) throw new Error(`Fixture line ${i + 1} missing string "id"`);
    if (typeof c.criteria !== "string" || !c.criteria) throw new Error(`Fixture line ${i + 1} missing string "criteria"`);
    return {
      id: c.id,
      input: c.input,
      output: c.output,
      criteria: c.criteria,
      ...(typeof c.label === "string" ? { label: c.label } : {}),
      ...(typeof c.expectedPass === "boolean" ? { expectedPass: c.expectedPass } : {}),
      ...(typeof c.context === "string" ? { context: c.context } : {}),
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const panel = resolvePanel();
  if (panel.length === 0) {
    console.error(
      "No judge models available. Copy .env.example to .env and set one key:\n" +
        "OPENROUTER_API_KEY (one key, whole panel), or ANTHROPIC_API_KEY /\n" +
        "OPENAI_API_KEY / GOOGLE_API_KEY. The zero-key demo is `npm run replay`.",
    );
    process.exit(1);
  }
  console.log(`cross-eval: panel = ${panel.map((m) => m.key).join(", ")}`);

  const cases = await loadFixture(args.fixturePath);
  if (cases.length === 0) {
    console.error("cross-eval: fixture is empty");
    process.exit(2);
  }

  console.log(
    `cross-eval: judging ${cases.length} case(s) at concurrency=${args.concurrency} ` +
      `threshold=${args.threshold} required=${args.requiredCount}`,
  );
  const startedAt = new Date().toISOString();
  const limit = pLimit(args.concurrency);

  const results = await Promise.all(
    cases.map((c) =>
      limit(async () => {
        const judgements = await judgeOutput({
          input: c.input,
          output: c.output,
          criteria: c.criteria,
          ...(c.context ? { context: c.context } : {}),
        });
        const agg = aggregateJudgements(judgements, args.threshold, args.requiredCount);
        console.log(
          `  [${agg.passed ? "PASS" : "FAIL"}] ${c.id}${c.label ? ` (${c.label})` : ""}  ` +
            `mean=${agg.meanScore?.toFixed(2) ?? "n/a"}  passing=${agg.passingCount}/${agg.requiredCount}` +
            (typeof c.expectedPass === "boolean"
              ? agg.passed === c.expectedPass
                ? "  correct"
                : `  WRONG (expected ${c.expectedPass ? "PASS" : "FAIL"})`
              : ""),
        );
        return {
          id: c.id,
          label: c.label,
          expectedPass: c.expectedPass,
          passed: agg.passed,
          meanScore: agg.meanScore,
          passingCount: agg.passingCount,
          requiredCount: agg.requiredCount,
          threshold: agg.threshold,
          judgements: judgements.map((j) => ({
            model: j.model,
            score: j.score,
            confidence: j.confidence,
            rationale: j.rationale,
            latencyMs: j.latencyMs,
            ...(j.error ? { error: j.error } : {}),
          })),
        };
      }),
    ),
  );

  const passedCount = results.filter((r) => r.passed).length;
  const passRate = passedCount / results.length;

  // Grade the judge, not the fixture. `passRate` answers "how many cases did the
  // panel pass", which is not a quality signal: this fixture deliberately
  // contains an answer that SHOULD fail, so the ceiling was 2/3 and the default
  // 0.95 bar could never be met. Worse, if the panel started passing the hedging
  // case the rate would rise and the gate would read that as an improvement.
  //
  // `expectedPass` says what the right verdict is. Accuracy against it is what
  // gets gated. Cases without it are not scored either way.
  const graded = results.filter((r) => typeof r.expectedPass === "boolean");
  const correctCount = graded.filter((r) => r.passed === r.expectedPass).length;
  const accuracy = graded.length > 0 ? correctCount / graded.length : null;

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    fixturePath: args.fixturePath,
    totalCases: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    passRate,
    gradedCount: graded.length,
    correctCount,
    accuracy,
    minPassRate: args.minPassRate,
    meetsBar: accuracy === null ? passRate >= args.minPassRate : accuracy >= args.minPassRate,
    threshold: args.threshold,
    requiredCount: args.requiredCount,
  };

  await mkdir(args.outDir, { recursive: true });
  await writeFile(resolve(args.outDir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  await writeFile(resolve(args.outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log("");
  console.log("cross-eval summary:");
  console.log(`  total:     ${summary.totalCases}`);
  console.log(`  passed:    ${summary.passedCount}`);
  console.log(`  failed:    ${summary.failedCount}`);
  console.log(`  pass rate: ${(summary.passRate * 100).toFixed(1)}%  (how many cases the panel passed)`);
  if (accuracy !== null) {
    console.log(
      `  accuracy:  ${(accuracy * 100).toFixed(1)}%  ` +
        `(${correctCount}/${graded.length} verdicts matched expectedPass)  <- gated on this`,
    );
  }
  console.log(`  min bar:   ${(summary.minPassRate * 100).toFixed(1)}%`);
  console.log(`  output:    ${args.outDir}`);

  if (!summary.meetsBar) {
    const measured = accuracy === null ? passRate : accuracy;
    const what = accuracy === null ? "pass rate" : "accuracy";
    console.error(
      `\ncross-eval: ${what} ${(measured * 100).toFixed(1)}% < min bar ` +
        `${(args.minPassRate * 100).toFixed(1)}%, failing build`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`cross-eval: ${(err as Error).message}`);
  process.exit(1);
});
