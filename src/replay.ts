/**
 * Zero-key replay (`npm run replay`).
 *
 * Recomputes per-model recall/precision and panel agreement (Fleiss' kappa and
 * Krippendorff's alpha) for a rater panel, no API keys, in seconds. It reads a
 * panel directory:
 *
 *   <dir>/truth.json        { "verdicts": [ { "findingId", "label" } ] }
 *   <dir>/<model>.jsonl     one {"findingId","label",...} per line, per rater
 *
 * Two panels ship: data/sample/panel/ (synthetic, the zero-key default) and
 * data/panel-real/ (a redacted real 7-model run over public-OSS PRs, via
 * `npm run replay:real`). Point it at your own export with `--dir=path/to/panel`.
 *
 * Usage:
 *
 *   tsx src/replay.ts [--dir=path/to/panel] [--fail-under=0.6]
 *
 * `--fail-under` turns the replay into a CI check: it exits 1 unless BOTH
 * Fleiss' kappa and Krippendorff's alpha reach the threshold. Requiring both
 * matters because a panel can clear one coefficient and miss the other, and
 * that disagreement is the borderline case worth stopping for.
 *
 * Exit codes: 0 ok, 1 the gate was requested and the panel fell short,
 * 2 usage or input error. Keeping those apart lets CI tell "this panel does not
 * agree enough" from "you pointed me at the wrong directory".
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { cohensKappa, fleissKappa, krippendorffAlpha, interpretKappa } from "./kappa.js";
import { LABELS, type Label } from "./types.js";

const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data/sample/panel");

interface Args {
  dir: string;
  failUnder?: number;
}

function parseArgs(argv: string[]): Args {
  const dirArg = argv.find((a) => a.startsWith("--dir="));
  const out: Args = { dir: dirArg ? resolve(dirArg.slice("--dir=".length)) : DEFAULT_DIR };

  const gateArg = argv.find((a) => a.startsWith("--fail-under="));
  if (gateArg) {
    const raw = gateArg.slice("--fail-under=".length);
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) {
      console.error(`replay: --fail-under=${raw} is not a number`);
      process.exit(2);
    }
    if (value < -1 || value > 1) {
      console.error(`replay: --fail-under=${raw} is outside the range of a kappa coefficient (-1 to 1)`);
      process.exit(2);
    }
    out.failUnder = value;
  }
  return out;
}

interface Verdict {
  findingId: string;
  label: string;
}

function loadLabels(path: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<Verdict>;
      if (o.findingId && o.label) map.set(o.findingId, o.label);
    } catch {
      /* skip malformed line */
    }
  }
  return map;
}

function loadTruth(dir: string): Map<string, string> {
  const adj = JSON.parse(readFileSync(resolve(dir, "truth.json"), "utf8")) as { verdicts: Verdict[] };
  const map = new Map<string, string>();
  for (const v of adj.verdicts) if (v.findingId && v.label) map.set(v.findingId, v.label);
  return map;
}

function pct(num: number, den: number): string {
  return den > 0 ? `${((100 * num) / den).toFixed(0)}% (${num}/${den})` : "n/a";
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function main(): void {
  const { dir, failUnder } = parseArgs(process.argv.slice(2));
  if (!existsSync(resolve(dir, "truth.json"))) {
    console.error(`replay: no truth.json in ${dir}`);
    // 2, not 1: an unreadable panel is a usage error, and 1 now means the gate failed.
    process.exit(2);
  }
  const truth = loadTruth(dir);
  const note = (JSON.parse(readFileSync(resolve(dir, "truth.json"), "utf8")) as { note?: string }).note ?? "";
  const raters = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"))
    .sort();
  if (raters.length === 0) {
    console.error(`replay: no <model>.jsonl rater files in ${dir}`);
    process.exit(2);
  }
  const labelsByRater = new Map<string, Map<string, string>>();
  for (const r of raters) labelsByRater.set(r, loadLabels(resolve(dir, `${r}.jsonl`)));

  const truthTp = [...truth.entries()].filter(([, l]) => l === "TP").map(([id]) => id);
  console.log("=== Cross-model panel: recall + precision vs adjudicated truth ===");
  console.log(`panel dir: ${dir}`);
  console.log(`findings: ${truth.size}  ·  adjudicated TP: ${truthTp.length}\n`);
  console.log(`${pad("rater", 12)}${pad("recall (caught real TP)", 26)}precision (TP calls correct)`);
  for (const r of raters) {
    const labels = labelsByRater.get(r)!;
    // recall: of all adjudicated-TP findings, how many did this rater call TP?
    // A truth-TP the rater skipped or labeled non-TP both count as a miss.
    let caught = 0;
    for (const id of truthTp) if (labels.get(id) === "TP") caught += 1;
    // precision: of this rater's TP calls, how many are truly TP?
    let pd = 0;
    let pn = 0;
    for (const [id, l] of labels) {
      if (l === "TP") {
        pd += 1;
        if (truth.get(id) === "TP") pn += 1;
      }
    }
    console.log(`${pad(r, 12)}${pad(pct(caught, truthTp.length), 26)}${pct(pn, pd)}`);
  }

  // Panel-level agreement: Fleiss' kappa + Krippendorff's alpha, the recognized
  // statistics for more than two raters (averaging pairwise Cohen's kappa is not).
  const panel = raters.map((r) => labelsByRater.get(r)!);
  const fk = fleissKappa(panel, LABELS as readonly Label[]);
  const ka = krippendorffAlpha(panel, LABELS as readonly Label[]);
  console.log("\n=== Panel agreement (all raters) ===");
  console.log(`Fleiss' kappa:        ${fk.value.toFixed(3)} (${fk.interpretation})  ·  ${fk.n} findings, ${fk.raters} raters`);
  console.log(`Krippendorff's alpha: ${ka.value.toFixed(3)} (${ka.interpretation})`);

  // Per-rater redundancy: mean pairwise Cohen's kappa is not a panel statistic,
  // but it's a useful "agrees with everyone" view. A high value flags a rater
  // that adds little independent signal.
  console.log("\n=== Rater redundancy (mean pairwise Cohen's kappa) ===");
  const kappaByRater = new Map<string, number[]>();
  for (const r of raters) kappaByRater.set(r, []);
  for (let i = 0; i < raters.length; i += 1) {
    for (let j = i + 1; j < raters.length; j += 1) {
      const a = raters[i]!;
      const b = raters[j]!;
      const k = cohensKappa(labelsByRater.get(a)!, labelsByRater.get(b)!, LABELS as readonly Label[]);
      kappaByRater.get(a)!.push(k.kappa);
      kappaByRater.get(b)!.push(k.kappa);
    }
  }
  for (const r of raters) {
    const ks = kappaByRater.get(r)!;
    const mean = ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : 0;
    console.log(`${pad(r, 12)}${mean.toFixed(3)} (${interpretKappa(mean)})`);
  }

  console.log(
    "\nReading: low panel agreement is the finding, not a flaw. Independent frontier\n" +
      "models genuinely disagree on hard findings; that disagreement is the signal the\n" +
      "judge quorum and human adjudication exist to resolve.",
  );
  if (note) console.log(`\n${note}`);

  // Gate last, so a failing run still prints everything needed to diagnose it.
  if (failUnder !== undefined) {
    const short: string[] = [];
    // Check the interpretation, not just the value. Both degenerate branches in
    // kappa.ts return 0, which is the right value and is not a measurement, so a
    // gate reading only `.value` passed `--fail-under=0` on a panel the report
    // itself calls undefined. An undefined coefficient meets no threshold.
    const undefinedCoefficient =
      fk.interpretation.startsWith("undefined") || ka.interpretation.startsWith("undefined");
    if (undefinedCoefficient) {
      short.push(
        "agreement is undefined (no comparable items, or every rating in one category), " +
          "so no threshold can be met",
      );
    } else {
      if (fk.value < failUnder) short.push(`Fleiss' kappa ${fk.value.toFixed(3)} < ${failUnder.toFixed(3)}`);
      if (ka.value < failUnder) short.push(`Krippendorff's alpha ${ka.value.toFixed(3)} < ${failUnder.toFixed(3)}`);
    }
    console.log("\n=== Gate ===");
    if (short.length === 0) {
      console.log(`PASS  both coefficients are at or above ${failUnder.toFixed(3)}`);
    } else {
      for (const line of short) console.log(`FAIL  ${line}`);
      // exitCode, not exit(): let stdout flush first.
      process.exitCode = 1;
    }
  }
}

main();
