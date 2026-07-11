#!/usr/bin/env tsx
/**
 * Build a panel-comparison.json (the aggregated input rater-reliability consumes)
 * from a panel directory: a truth.json plus one <model>.jsonl per rater. Computes
 * per-finding consensus and pairwise Cohen's kappa (the latter is used only as a
 * rater-redundancy signal. The panel-level agreement statistic is Fleiss' kappa /
 * Krippendorff's alpha, computed by rater-reliability and by `npm run replay`).
 *
 * The kappa math is the one shared, unit-tested implementation in src/kappa.ts.
 *
 * Usage:
 *   tsx scripts/build-panel-comparison.mts \
 *     [--dir=data/sample/panel] [--out=data/sample/panel-comparison.json]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { cohensKappa } from "../src/kappa.js";
import { LABELS, type Label } from "../src/types.js";

function arg(name: string, def: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

const dir = resolve(arg("dir", "data/sample/panel"));
const out = resolve(arg("out", "data/sample/panel-comparison.json"));

function loadLabels(path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { findingId?: string; label?: string };
      if (o.findingId && o.label) m.set(o.findingId, o.label);
    } catch {
      /* skip malformed line */
    }
  }
  return m;
}

const raterKeys = readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => basename(f, ".jsonl"))
  .sort();
const labels: Record<string, Map<string, string>> = {};
for (const k of raterKeys) labels[k] = loadLabels(resolve(dir, `${k}.jsonl`));

const raters: Record<string, { name: string }> = {};
for (const k of raterKeys) raters[k] = { name: k };

// Pairwise kappa (redundancy signal). Rater keys must not contain '_': the
// reliability tool splits the pair key on it.
const pairwiseKappa: Record<string, { kappa: number; observedAgreement: number }> = {};
for (let i = 0; i < raterKeys.length; i += 1) {
  for (let j = i + 1; j < raterKeys.length; j += 1) {
    const a = raterKeys[i]!;
    const b = raterKeys[j]!;
    const r = cohensKappa(labels[a]!, labels[b]!, LABELS as readonly Label[]);
    pairwiseKappa[`${a}_${b}`] = { kappa: r.kappa, observedAgreement: r.agreement };
  }
}

// Per-finding consensus across raters.
const allIds = new Set<string>();
for (const k of raterKeys) for (const id of labels[k]!.keys()) allIds.add(id);
const entries: Array<{
  findingId: string;
  labels: Record<string, string>;
  consensus: string;
  consensusLabel: string | null;
}> = [];
for (const id of [...allIds].sort()) {
  const l: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const k of raterKeys) {
    const lab = labels[k]!.get(id);
    if (lab) {
      l[k] = lab;
      counts[lab] = (counts[lab] ?? 0) + 1;
    }
  }
  const voters = Object.keys(l).length;
  let top: string | null = null;
  let topN = 0;
  for (const [lab, n] of Object.entries(counts)) {
    if (n > topN) {
      topN = n;
      top = lab;
    }
  }
  let consensus = "SPLIT";
  if (voters > 0 && topN === voters) consensus = "UNANIMOUS";
  else if (topN > voters / 2) consensus = "MAJORITY";
  entries.push({ findingId: id, labels: l, consensus, consensusLabel: consensus === "SPLIT" ? null : top });
}

writeFileSync(
  out,
  JSON.stringify({ generatedFrom: basename(dir), raters, pairwiseKappa, consensus: { entries } }, null, 2) + "\n",
  "utf8",
);
console.error(`[build-panel-comparison] wrote ${out} (${raterKeys.length} raters, ${entries.length} findings)`);
