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
import { LABELS, type Label, DECIDED_LABELS } from "./types.js";

const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data/sample/panel");

interface Args {
  dir: string;
  failUnder?: number;
}

function parseArgs(argv: string[]): Args {
  const dirArg = argv.find((a) => a.startsWith("--dir="));
  const out: Args = { dir: dirArg ? resolve(dirArg.slice("--dir=".length)) : DEFAULT_DIR };

  // Reject anything unrecognized. `--failunder=0.9` (no hyphen) used to be
  // silently ignored, so the gate never ran, nothing printed, and CI went
  // green. A tool whose headline feature is a CI gate must not let a typo turn
  // it off. Same for `--dir path` with a space, which quietly gated the sample
  // panel instead of the one you named.
  const KNOWN = ["--dir=", "--fail-under="];
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    if (!KNOWN.some((k) => arg.startsWith(k))) {
      console.error(
        `replay: unknown option ${arg}. Expected ${KNOWN.map((k) => k + "...").join(" or ")}.`,
      );
      process.exit(2);
    }
  }

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

/**
 * Read `truth.json`, validating its shape rather than casting to it.
 *
 * The cast was load-bearing and wrong: `{}` threw a TypeError on
 * `adj.verdicts`, and unparseable JSON threw a SyntaxError, both escaping as
 * exit 1. That is the code the exit table reserves for "the panel fell short",
 * so CI could not tell a broken export from a real agreement failure, which is
 * the entire reason 1 and 2 are separate codes. `corpus.ts` validates with Zod;
 * this had nothing.
 */
/** Input the tool cannot read. Exits 2, never 1. */
class UsageError extends Error {}

function loadTruth(dir: string): Map<string, string> {
  const path = resolve(dir, "truth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
    throw new UsageError(`${path} must be an object with a "verdicts" array.`);
  }
  const map = new Map<string, string>();
  for (const v of (parsed as { verdicts: Verdict[] }).verdicts) {
    if (v && typeof v === "object" && v.findingId && v.label) map.set(v.findingId, v.label);
  }
  if (map.size === 0) {
    throw new UsageError(`${path} yielded no usable verdicts.`);
  }
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
  // Precision is only defined over findings the adjudicator actually decided.
  // NEEDS_INVESTIGATION is an abstention by the adjudicator, not a negative, and
  // scoring a rater's TP call against it charged the rater for deciding
  // something the truth basis declined to. On this panel that turned gemini's
  // 15/15 into 15/18 and read as "over-calls", when gemini never once called TP
  // on anything adjudicated FP.
  const decided = [...truth.entries()]
    .filter(([, l]) => l === "TP" || l === "FP")
    .map(([id]) => id);
  const decidedSet = new Set(decided);
  const negatives = decided.length - truthTp.length;

  console.log("=== Cross-model panel: recall + precision vs adjudicated truth ===");
  console.log(`panel dir: ${dir}`);
  console.log(
    `findings: ${truth.size}  ·  adjudicated TP: ${truthTp.length}  ·  ` +
      `decided (TP or FP): ${decided.length}\n`,
  );
  console.log(`${pad("rater", 12)}${pad("recall (caught real TP)", 26)}precision (on decided)`);
  for (const r of raters) {
    const labels = labelsByRater.get(r)!;
    // recall: of all adjudicated-TP findings, how many did this rater call TP?
    // A truth-TP the rater skipped or labeled non-TP both count as a miss.
    let caught = 0;
    for (const id of truthTp) if (labels.get(id) === "TP") caught += 1;
    // precision: of this rater's TP calls ON DECIDED FINDINGS, how many are TP?
    let pd = 0;
    let pn = 0;
    for (const [id, l] of labels) {
      if (l === "TP" && decidedSet.has(id)) {
        pd += 1;
        if (truth.get(id) === "TP") pn += 1;
      }
    }
    console.log(`${pad(r, 12)}${pad(pct(caught, truthTp.length), 26)}${pct(pn, pd)}`);
  }
  if (negatives < 5) {
    console.log(
      `\nPrecision here rests on ${negatives} adjudicated ` +
        `${negatives === 1 ? "negative" : "negatives"}. It is reported for completeness and ` +
        "estimates almost nothing: a rater\n" +
        "that called TP on everything decided would still score " +
        `${((100 * truthTp.length) / decided.length).toFixed(0)}%. Read the recall column.`,
    );
  }

  // Panel-level agreement: Fleiss' kappa + Krippendorff's alpha, the recognized
  // statistics for more than two raters (averaging pairwise Cohen's kappa is not).
  const panel = raters.map((r) => labelsByRater.get(r)!);
  const fk = fleissKappa(panel, DECIDED_LABELS as readonly Label[]);
  const ka = krippendorffAlpha(panel, DECIDED_LABELS as readonly Label[]);
  console.log("\n=== Panel agreement (all raters) ===");
  console.log(
    `Krippendorff's alpha: ${ka.value.toFixed(3)} (${ka.interpretation})  ·  ` +
      `${ka.n} findings, ${ka.raters} raters`,
  );
  console.log(`Fleiss' kappa:        ${fk.value.toFixed(3)} (${fk.interpretation})`);
  console.log(
    "\nNEEDS_INVESTIGATION is treated as an abstention, not a category, so two\n" +
      "raters who both decline to decide are not scored as agreeing. Alpha leads\n" +
      "because it is built for missing data; Fleiss is reported for continuity and\n" +
      "is not designed for uneven coverage.",
  );

  // The same panel with NI counted as a label, which is what earlier versions
  // published. Printed because the difference IS the finding: most of the
  // apparent agreement was mutual uncertainty, not agreement about whether a
  // finding is real.
  const withNi = raters.map((r) => labelsByRater.get(r)!);
  const fkCat = fleissKappa(withNi, LABELS as readonly Label[]);
  const kaCat = krippendorffAlpha(withNi, LABELS as readonly Label[]);
  let agreeingPairs = 0;
  let niPairs = 0;
  for (let i = 0; i < raters.length; i += 1) {
    for (let j = i + 1; j < raters.length; j += 1) {
      const la = labelsByRater.get(raters[i]!)!;
      const lb = labelsByRater.get(raters[j]!)!;
      for (const [id, a] of la) {
        const b = lb.get(id);
        if (b !== undefined && a === b) {
          agreeingPairs += 1;
          if (a === "NEEDS_INVESTIGATION") niPairs += 1;
        }
      }
    }
  }
  const niShare = agreeingPairs > 0 ? (100 * niPairs) / agreeingPairs : 0;
  console.log(
    `\nCounting NI as a label instead: Fleiss ${fkCat.value.toFixed(3)}, ` +
      `alpha ${kaCat.value.toFixed(3)} over ${fkCat.n} findings.\n` +
      `That is the higher number, and ${niShare.toFixed(1)}% of the agreeing rater-pairs ` +
      `behind it (${niPairs} of ${agreeingPairs})\nare both raters saying "I cannot tell". ` +
      "On the question the panel exists to answer, agreement is at or below chance.",
  );

  // Per-rater redundancy: mean pairwise Cohen's kappa is not a panel statistic,
  // but it's a useful "agrees with everyone" view. A high value flags a rater
  // that adds little independent signal.
  // Once NI is an abstention, a pair is only comparable on the findings BOTH
  // raters actually decided, and that count varies a lot. grok abstains on 20
  // of 23, so grok/deepseek shares 2 decided findings and they happen to match:
  // a kappa of 1.000 that means nothing. Pairs below the floor are excluded
  // from the mean and reported separately rather than silently averaged in.
  const MIN_PAIR_FINDINGS = 8;
  console.log("\n=== Rater redundancy (mean pairwise Cohen's kappa, decided findings) ===");
  const kappaByRater = new Map<string, number[]>();
  const coverageByRater = new Map<string, number[]>();
  const thin: string[] = [];
  for (const r of raters) {
    kappaByRater.set(r, []);
    coverageByRater.set(r, []);
  }
  for (let i = 0; i < raters.length; i += 1) {
    for (let j = i + 1; j < raters.length; j += 1) {
      const a = raters[i]!;
      const b = raters[j]!;
      const k = cohensKappa(
        labelsByRater.get(a)!,
        labelsByRater.get(b)!,
        DECIDED_LABELS as readonly Label[],
      );
      if (k.n < MIN_PAIR_FINDINGS) {
        thin.push(`${a}/${b} (${k.n})`);
        continue;
      }
      kappaByRater.get(a)!.push(k.kappa);
      kappaByRater.get(b)!.push(k.kappa);
      coverageByRater.get(a)!.push(k.n);
      coverageByRater.get(b)!.push(k.n);
    }
  }
  for (const r of raters) {
    const ks = kappaByRater.get(r)!;
    const ns = coverageByRater.get(r)!;
    if (ks.length === 0) {
      console.log(`${pad(r, 12)}n/a  (no pair shares ${MIN_PAIR_FINDINGS}+ decided findings)`);
      continue;
    }
    const mean = ks.reduce((a, b) => a + b, 0) / ks.length;
    const meanN = Math.round(ns.reduce((a, b) => a + b, 0) / ns.length);
    console.log(
      `${pad(r, 12)}${mean.toFixed(3)} (${interpretKappa(mean)})  ·  ` +
        `${ks.length} comparable ${ks.length === 1 ? "pair" : "pairs"}, ~${meanN} findings each`,
    );
  }
  if (thin.length > 0) {
    console.log(
      `\nExcluded, fewer than ${MIN_PAIR_FINDINGS} decided findings in common: ` +
        `${thin.join(", ")}.\nA coefficient from two or three items is not a measurement; ` +
        "the count is the reason,\nnot the value.",
    );
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
    // A coefficient computed over a handful of items is not a measurement you
    // can gate on. Without this, a panel of 7 raters agreeing on 2 findings
    // printed "PASS both coefficients are at or above 0.900": any panel could
    // be made to pass by shrinking it. `fk.n` was computed and printed and
    // never read.
    const MIN_ITEMS = 5;
    if (fk.n < MIN_ITEMS) {
      short.push(
        `only ${fk.n} comparable ${fk.n === 1 ? "finding" : "findings"}, ` +
          `below the ${MIN_ITEMS} needed for a coefficient worth gating on`,
      );
    }
    const undefinedCoefficient =
      fk.interpretation.startsWith("undefined") || ka.interpretation.startsWith("undefined");
    if (fk.n < MIN_ITEMS) {
      // already reported above; do not also report a threshold miss
    } else if (undefinedCoefficient) {
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

try {
  main();
} catch (err) {
  // UsageError means we could not read what we were pointed at. That is exit 2,
  // not 1: CI must be able to tell a broken export from a real agreement
  // failure, which is why the two codes were split apart.
  if (err instanceof UsageError) {
    console.error(`replay: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
