/**
 * Zero-key replay (`npm run replay`).
 *
 * Recomputes per-model recall/precision and pairwise Cohen's kappa for a rater
 * panel — no API keys, runs in seconds. It reads a panel directory:
 *
 *   <dir>/truth.json        { "verdicts": [ { "findingId", "label" } ] }
 *   <dir>/<model>.jsonl     one {"findingId","label",...} per line, per rater
 *
 * The shipped panel under data/sample/panel/ is SYNTHETIC — hand-authored to
 * demonstrate the tooling. Real labeled panels are not published. Point the tool
 * at your own export with `npm run replay -- --dir=path/to/panel`.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { cohensKappa } from "./kappa.js";
import { LABELS, type Label } from "./types.js";

const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data/sample/panel");

function parseDir(argv: string[]): string {
  const arg = argv.find((a) => a.startsWith("--dir="));
  return arg ? resolve(arg.slice("--dir=".length)) : DEFAULT_DIR;
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

function reading(k: number): string {
  return k < 0.2 ? "poor" : k < 0.4 ? "fair" : k < 0.6 ? "moderate" : k < 0.8 ? "substantial" : "near perfect";
}

function main(): void {
  const dir = parseDir(process.argv.slice(2));
  if (!existsSync(resolve(dir, "truth.json"))) {
    console.error(`replay: no truth.json in ${dir}`);
    process.exit(1);
  }
  const truth = loadTruth(dir);
  const raters = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"))
    .sort();
  if (raters.length === 0) {
    console.error(`replay: no <model>.jsonl rater files in ${dir}`);
    process.exit(1);
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
    let rd = 0;
    let rn = 0;
    for (const id of truthTp) {
      if (labels.has(id)) {
        rd += 1;
        if (labels.get(id) === "TP") rn += 1;
      }
    }
    let pd = 0;
    let pn = 0;
    for (const [id, l] of labels) {
      if (l === "TP") {
        pd += 1;
        if (truth.get(id) === "TP") pn += 1;
      }
    }
    console.log(`${pad(r, 12)}${pad(pct(rn, rd), 26)}${pct(pn, pd)}`);
  }

  console.log("\n=== Pairwise inter-model agreement (Cohen's kappa) ===");
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
  console.log(`${pad("rater", 12)}${pad("mean pairwise kappa", 22)}reading`);
  let sum = 0;
  let count = 0;
  for (const r of raters) {
    const ks = kappaByRater.get(r)!;
    const mean = ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : 0;
    sum += mean;
    count += 1;
    console.log(`${pad(r, 12)}${pad(mean.toFixed(3), 22)}${reading(mean)}`);
  }
  const panelMean = count ? sum / count : 0;
  console.log(`\npanel mean pairwise kappa: ${panelMean.toFixed(3)} (${reading(panelMean)})`);
  console.log(
    "\nReading: low inter-model agreement is the finding, not a flaw. Independent\n" +
      "raters genuinely disagree on hard findings; that disagreement is the signal the\n" +
      "judge quorum and human adjudication exist to resolve. (This panel is SYNTHETIC\n" +
      "sample data — see docs/RESULTS.md for the methodology.)",
  );
}

main();
