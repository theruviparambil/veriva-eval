#!/usr/bin/env node
/**
 * Reconciles two labeling passes and computes Cohen's κ inter-rater
 * agreement (here: same rater across two sessions).
 *
 * Usage:
 *   node labeling/cohens-kappa.mjs \
 *     --pass1=labels-pass1.json --pass2=labels-pass2.json \
 *     --out=reconciled.json
 *
 * Outputs:
 *   - confusion matrix (rows=pass1, cols=pass2)
 *   - per-cell agreement
 *   - Cohen's κ
 *   - list of disagreements (sampleId + label1 + label2 + reasons)
 *
 * Cohen's κ formula:
 *   κ = (p_o − p_e) / (1 − p_e)
 *   where p_o = observed agreement, p_e = expected by chance
 *
 * Interpretation:
 *   κ < 0.2  poor
 *   0.2-0.4  fair
 *   0.4-0.6  moderate
 *   0.6-0.8  substantial
 *   0.8-1.0  near perfect
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LABELS = ['TP', 'FP', 'NEEDS_INVESTIGATION', 'OUT_OF_SCOPE'];

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v;
    }
  }
  if (!out.pass1 || !out.pass2 || !out.out) {
    console.error(
      'usage: cohens-kappa.mjs --pass1=labels-pass1.json --pass2=labels-pass2.json --out=reconciled.json',
    );
    process.exit(2);
  }
  return out;
}

async function loadLabels(path) {
  const text = await readFile(path, 'utf-8');
  const data = JSON.parse(text);
  // Normalize: support both [{sampleId, label, reason}, ...] and
  // { sampleId: { label, reason } } shapes.
  if (Array.isArray(data)) {
    const out = new Map();
    for (const r of data) out.set(r.sampleId, r);
    return out;
  }
  if (data && typeof data === 'object' && data.labels) {
    const out = new Map();
    for (const r of data.labels) out.set(r.sampleId, r);
    return out;
  }
  throw new Error(`unrecognized labels file shape: ${path}`);
}

function computeKappa(p1Labels, p2Labels) {
  const matrix = {};
  for (const a of LABELS) {
    matrix[a] = {};
    for (const b of LABELS) matrix[a][b] = 0;
  }
  let n = 0;
  for (const [sampleId, r1] of p1Labels) {
    const r2 = p2Labels.get(sampleId);
    if (!r2) continue;
    if (!LABELS.includes(r1.label) || !LABELS.includes(r2.label)) continue;
    matrix[r1.label][r2.label]++;
    n++;
  }
  if (n === 0) return { matrix, n: 0, agreementRate: 0, kappa: 0 };

  let agreed = 0;
  for (const a of LABELS) agreed += matrix[a][a];
  const p_o = agreed / n;

  // Expected agreement: p_e = sum over labels of (row_total/n) × (col_total/n)
  let p_e = 0;
  for (const a of LABELS) {
    let row = 0;
    let col = 0;
    for (const b of LABELS) {
      row += matrix[a][b];
      col += matrix[b][a];
    }
    p_e += (row / n) * (col / n);
  }
  const kappa = p_e === 1 ? 1 : (p_o - p_e) / (1 - p_e);
  return { matrix, n, agreementRate: p_o, kappa };
}

function interpretKappa(k) {
  if (k < 0.2) return 'poor';
  if (k < 0.4) return 'fair';
  if (k < 0.6) return 'moderate';
  if (k < 0.8) return 'substantial';
  return 'near perfect';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const p1 = await loadLabels(args.pass1);
  const p2 = await loadLabels(args.pass2);

  const onlyInP1 = [...p1.keys()].filter((k) => !p2.has(k));
  const onlyInP2 = [...p2.keys()].filter((k) => !p1.has(k));

  const { matrix, n, agreementRate, kappa } = computeKappa(p1, p2);

  const disagreements = [];
  for (const [sampleId, r1] of p1) {
    const r2 = p2.get(sampleId);
    if (!r2) continue;
    if (r1.label !== r2.label) {
      disagreements.push({
        sampleId,
        pass1Label: r1.label,
        pass1Reason: r1.reason ?? '',
        pass2Label: r2.label,
        pass2Reason: r2.reason ?? '',
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    sources: { pass1: args.pass1, pass2: args.pass2 },
    n,
    onlyInPass1Count: onlyInP1.length,
    onlyInPass2Count: onlyInP2.length,
    confusionMatrix: matrix,
    agreementRate,
    cohensKappa: kappa,
    interpretation: interpretKappa(kappa),
    disagreementCount: disagreements.length,
    disagreements,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(summary, null, 2), 'utf-8');

  console.error(`[kappa] reconciled ${n} samples`);
  console.error(`[kappa] agreement rate: ${(agreementRate * 100).toFixed(1)}%`);
  console.error(
    `[kappa] Cohen's κ: ${kappa.toFixed(3)} (${interpretKappa(kappa)})`,
  );
  console.error(`[kappa] disagreements: ${disagreements.length}/${n}`);
  if (onlyInP1.length || onlyInP2.length) {
    console.error(
      `[kappa] coverage gap: pass1-only=${onlyInP1.length}, pass2-only=${onlyInP2.length}`,
    );
  }
  console.error(`[kappa] wrote reconciled output: ${args.out}`);
}

await main();
