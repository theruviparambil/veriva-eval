#!/usr/bin/env node
/**
 * Build a panel-comparison.json (the aggregated input that rater-reliability.mjs
 * consumes) from a panel directory: a truth.json plus one <model>.jsonl per
 * rater. Computes per-finding consensus and pairwise Cohen's kappa.
 *
 * Usage:
 *   node scripts/build-panel-comparison.mjs \
 *     [--dir=data/sample/panel] [--out=data/sample/panel-comparison.json]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const LABELS = ['TP', 'FP', 'NEEDS_INVESTIGATION', 'OUT_OF_SCOPE'];

function arg(name, def) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

const dir = resolve(arg('dir', 'data/sample/panel'));
const out = resolve(arg('out', 'data/sample/panel-comparison.json'));

function loadLabels(path) {
  const m = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.findingId && o.label) m.set(o.findingId, o.label);
    } catch {
      /* skip malformed line */
    }
  }
  return m;
}

function cohensKappa(a, b) {
  const mat = {};
  for (const x of LABELS) {
    mat[x] = {};
    for (const y of LABELS) mat[x][y] = 0;
  }
  let n = 0;
  for (const [id, la] of a) {
    const lb = b.get(id);
    if (lb === undefined) continue;
    if (!LABELS.includes(la) || !LABELS.includes(lb)) continue;
    mat[la][lb]++;
    n++;
  }
  if (n === 0) return { kappa: 0, observedAgreement: 0 };
  let agreed = 0;
  for (const x of LABELS) agreed += mat[x][x];
  const po = agreed / n;
  let pe = 0;
  for (const x of LABELS) {
    let row = 0;
    let col = 0;
    for (const y of LABELS) {
      row += mat[x][y];
      col += mat[y][x];
    }
    pe += (row / n) * (col / n);
  }
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, observedAgreement: po };
}

const raterKeys = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => basename(f, '.jsonl'))
  .sort();
const labels = {};
for (const k of raterKeys) labels[k] = loadLabels(resolve(dir, `${k}.jsonl`));

const raters = {};
for (const k of raterKeys) raters[k] = { name: k };

// Pairwise kappa. Rater keys must not contain '_' (reliability splits pairKey on it).
const pairwiseKappa = {};
for (let i = 0; i < raterKeys.length; i++) {
  for (let j = i + 1; j < raterKeys.length; j++) {
    const a = raterKeys[i];
    const b = raterKeys[j];
    pairwiseKappa[`${a}_${b}`] = cohensKappa(labels[a], labels[b]);
  }
}

// Per-finding consensus across raters.
const allIds = new Set();
for (const k of raterKeys) for (const id of labels[k].keys()) allIds.add(id);
const entries = [];
for (const id of [...allIds].sort()) {
  const l = {};
  const counts = {};
  for (const k of raterKeys) {
    const lab = labels[k].get(id);
    if (lab) {
      l[k] = lab;
      counts[lab] = (counts[lab] || 0) + 1;
    }
  }
  const voters = Object.keys(l).length;
  let top = null;
  let topN = 0;
  for (const [lab, n] of Object.entries(counts)) {
    if (n > topN) {
      topN = n;
      top = lab;
    }
  }
  let consensus = 'SPLIT';
  if (voters > 0 && topN === voters) consensus = 'UNANIMOUS';
  else if (topN > voters / 2) consensus = 'MAJORITY';
  entries.push({ findingId: id, labels: l, consensus, consensusLabel: consensus === 'SPLIT' ? null : top });
}

writeFileSync(out, JSON.stringify({ generatedFrom: basename(dir), raters, pairwiseKappa, consensus: { entries } }, null, 2) + '\n', 'utf8');
console.error(`[build-panel-comparison] wrote ${out} (${raterKeys.length} raters, ${entries.length} findings)`);
