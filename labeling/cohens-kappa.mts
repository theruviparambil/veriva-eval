#!/usr/bin/env tsx
/**
 * Reconciles two labeling passes and computes Cohen's kappa (the same rater
 * across two sessions, intra-rater reliability). Cohen's kappa is the correct
 * statistic for two raters; the multi-rater panel uses Fleiss' kappa /
 * Krippendorff's alpha instead (see `npm run replay`).
 *
 * The kappa math comes from the one shared, unit-tested implementation in
 * `src/kappa.ts`. This script only reconciles the files and renders the report.
 *
 * Usage:
 *   tsx labeling/cohens-kappa.mts \
 *     --pass1=labels-pass1.json --pass2=labels-pass2.json --out=reconciled.json
 *
 * Outputs: confusion matrix, per-cell agreement, Cohen's kappa, and the list of
 * disagreements (sampleId + both labels + both reasons).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { cohensKappa } from "../src/kappa.js";
import { LABELS, type Label } from "../src/types.js";

interface LabelRecord {
  sampleId: string;
  label: string;
  reason?: string;
}

function parseArgs(argv: string[]): { pass1: string; pass2: string; out: string } {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (k && v !== undefined) out[k] = v;
    }
  }
  if (!out.pass1 || !out.pass2 || !out.out) {
    console.error(
      "usage: cohens-kappa.mts --pass1=labels-pass1.json --pass2=labels-pass2.json --out=reconciled.json",
    );
    process.exit(2);
  }
  return { pass1: out.pass1, pass2: out.pass2, out: out.out };
}

async function loadLabels(path: string): Promise<Map<string, LabelRecord>> {
  const data = JSON.parse(await readFile(path, "utf-8")) as unknown;
  const rows: LabelRecord[] = Array.isArray(data)
    ? (data as LabelRecord[])
    : data && typeof data === "object" && Array.isArray((data as { labels?: unknown }).labels)
      ? ((data as { labels: LabelRecord[] }).labels)
      : (() => {
          throw new Error(`unrecognized labels file shape: ${path}`);
        })();
  const out = new Map<string, LabelRecord>();
  for (const r of rows) out.set(r.sampleId, r);
  return out;
}

/** Build a confusion matrix (rows = pass1 label, cols = pass2 label) for display. */
function confusionMatrix(
  p1: Map<string, LabelRecord>,
  p2: Map<string, LabelRecord>,
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const a of LABELS) {
    matrix[a] = {};
    for (const b of LABELS) matrix[a][b] = 0;
  }
  for (const [sampleId, r1] of p1) {
    const r2 = p2.get(sampleId);
    if (!r2) continue;
    if (!LABELS.includes(r1.label as Label) || !LABELS.includes(r2.label as Label)) continue;
    matrix[r1.label]![r2.label]! += 1;
  }
  return matrix;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const p1 = await loadLabels(args.pass1);
  const p2 = await loadLabels(args.pass2);

  const onlyInP1 = [...p1.keys()].filter((k) => !p2.has(k));
  const onlyInP2 = [...p2.keys()].filter((k) => !p1.has(k));

  // Load-bearing kappa from the shared, tested implementation.
  const m1 = new Map([...p1].map(([id, r]) => [id, r.label] as const));
  const m2 = new Map([...p2].map(([id, r]) => [id, r.label] as const));
  const { n, agreement, kappa, interpretation } = cohensKappa(m1, m2, LABELS as readonly Label[]);

  const disagreements: Array<Record<string, string>> = [];
  for (const [sampleId, r1] of p1) {
    const r2 = p2.get(sampleId);
    if (!r2 || r1.label === r2.label) continue;
    disagreements.push({
      sampleId,
      pass1Label: r1.label,
      pass1Reason: r1.reason ?? "",
      pass2Label: r2.label,
      pass2Reason: r2.reason ?? "",
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    sources: { pass1: args.pass1, pass2: args.pass2 },
    n,
    onlyInPass1Count: onlyInP1.length,
    onlyInPass2Count: onlyInP2.length,
    confusionMatrix: confusionMatrix(p1, p2),
    agreementRate: agreement,
    cohensKappa: kappa,
    interpretation,
    disagreementCount: disagreements.length,
    disagreements,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(summary, null, 2), "utf-8");

  console.error(`[kappa] reconciled ${n} samples`);
  console.error(`[kappa] agreement rate: ${(agreement * 100).toFixed(1)}%`);
  console.error(`[kappa] Cohen's kappa: ${kappa.toFixed(3)} (${interpretation})`);
  console.error(`[kappa] disagreements: ${disagreements.length}/${n}`);
  if (onlyInP1.length || onlyInP2.length) {
    console.error(`[kappa] coverage gap: pass1-only=${onlyInP1.length}, pass2-only=${onlyInP2.length}`);
  }
  console.error(`[kappa] wrote reconciled output: ${args.out}`);
}

await main();
