#!/usr/bin/env node
/**
 * Per-rater reliability report for the inter-vendor κ panel.
 *
 * Consumes a `compare-raters.mts` JSON dump (raters + pairwiseKappa +
 * consensus.entries) and answers: *which raters can we trust, and which
 * are adding noise?* — so we can fix the panel composition BEFORE spending
 * compute on a fresh max-effort run.
 *
 * For each rater it computes:
 *   - label distribution (TP/FP/NI/OOS) + abstention rate (NI%)
 *   - agreement with the panel "truth" (adjudicated labels if --truth is
 *     given, else the UNANIMOUS+MAJORITY consensus label)
 *   - how it voted on the SPLIT findings (the lenient-vs-strict signal)
 *   - mean / min pairwise Cohen's κ against the other raters
 *   - a recommendation: KEEP / DOWN-WEIGHT / DROP, with the reason
 *
 * It also flags REDUNDANT rater pairs (κ ≥ --redundant-kappa, default
 * 0.85) — near-identical judges that don't add independent signal.
 *
 * Notes:
 *   - "agreement with consensus" is vs the MAJORITY, not ground truth,
 *     unless --truth supplies adjudicated labels. It is a panel-cohesion
 *     signal, not an accuracy score — labelled as such in the output.
 *   - NEEDS_INVESTIGATION is treated as an *abstention*: a rater that NI's
 *     a finding casts no TP/FP vote. High abstention => low signal.
 *
 * Usage:
 *   node labeling/rater-reliability.mjs \
 *     --in=data/sample/panel-comparison.json \
 *     [--truth=data/sample/panel/truth.json] \
 *     [--out=out/rater-reliability.md] \
 *     [--redundant-kappa=0.85]
 *   (or just: npm run reliability)
 */
import { readFile, writeFile } from 'node:fs/promises';

const LABELS = ['TP', 'FP', 'NEEDS_INVESTIGATION', 'OUT_OF_SCOPE'];

function parseArgs(argv) {
  const out = { redundantKappa: 0.85 };
  for (const a of argv) {
    if (a.startsWith('--in=')) out.in = a.slice(5);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--truth=')) out.truth = a.slice(8);
    else if (a.startsWith('--redundant-kappa=')) {
      const n = parseFloat(a.slice(18));
      if (Number.isFinite(n)) out.redundantKappa = n;
    } else if (a === '--help' || a === '-h') {
      console.error(
        'usage: rater-reliability.mjs --in=<comparison.json> [--out=<report.md>] [--truth=<adjudicated.json>] [--redundant-kappa=0.85]',
      );
      process.exit(0);
    }
  }
  if (!out.in) {
    console.error('error: --in=<comparison.json> is required');
    process.exit(2);
  }
  return out;
}

/** Load optional adjudicated truth: { findingId: label } or [{findingId,label}]. */
async function loadTruth(path) {
  if (!path) return null;
  const data = JSON.parse(await readFile(path, 'utf-8'));
  const map = new Map();
  const rows = Array.isArray(data) ? data : (data.verdicts ?? data.labels ?? []);
  for (const r of rows) {
    const label = r.label ?? r.canonicalLabel;
    if (r.findingId && LABELS.includes(label)) map.set(r.findingId, label);
  }
  return map;
}

function pct(num, den) {
  return den > 0 ? (num / den) * 100 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dump = JSON.parse(await readFile(args.in, 'utf-8'));
  const truth = await loadTruth(args.truth);

  const raterKeys = Object.keys(dump.raters ?? {}).sort();
  const entries = dump.consensus?.entries ?? [];
  const pairwise = dump.pairwiseKappa ?? {};

  // ── Per-rater tallies ──────────────────────────────────────────────
  const stats = {};
  for (const k of raterKeys) {
    stats[k] = {
      key: k,
      name: dump.raters[k]?.name ?? k,
      labeled: 0,
      dist: { TP: 0, FP: 0, NEEDS_INVESTIGATION: 0, OUT_OF_SCOPE: 0 },
      // agreement vs panel truth (majority or adjudicated)
      truthEval: 0, // findings with a truth label that this rater also labeled
      truthAgree: 0,
      // how this rater voted on SPLIT findings
      onSplit: { TP: 0, FP: 0, NEEDS_INVESTIGATION: 0, OUT_OF_SCOPE: 0, total: 0 },
    };
  }

  let splitCount = 0;
  for (const e of entries) {
    const labels = e.labels ?? {};
    // Determine this finding's truth label.
    let truthLabel = null;
    if (truth && truth.has(e.findingId)) truthLabel = truth.get(e.findingId);
    else if (e.consensus === 'UNANIMOUS' || e.consensus === 'MAJORITY')
      truthLabel = e.consensusLabel;
    if (e.consensus === 'SPLIT') splitCount++;

    for (const k of raterKeys) {
      const l = labels[k];
      if (!l || !LABELS.includes(l)) continue;
      const s = stats[k];
      s.labeled++;
      s.dist[l]++;
      if (truthLabel) {
        s.truthEval++;
        if (l === truthLabel) s.truthAgree++;
      }
      if (e.consensus === 'SPLIT') {
        s.onSplit[l]++;
        s.onSplit.total++;
      }
    }
  }

  // ── Pairwise κ per rater (mean / min vs others) ────────────────────
  const kappaByRater = {};
  for (const k of raterKeys) kappaByRater[k] = [];
  const redundantPairs = [];
  for (const [pairKey, rep] of Object.entries(pairwise)) {
    const [a, b] = pairKey.split('_');
    const kappa = rep?.kappa ?? 0;
    if (kappaByRater[a]) kappaByRater[a].push({ other: b, kappa });
    if (kappaByRater[b]) kappaByRater[b].push({ other: a, kappa });
    if (kappa >= args.redundantKappa) {
      redundantPairs.push({ a, b, kappa, agreement: rep?.observedAgreement ?? null });
    }
  }
  for (const k of raterKeys) {
    const ks = kappaByRater[k].map((x) => x.kappa);
    const mean = ks.length ? ks.reduce((p, c) => p + c, 0) / ks.length : 0;
    const min = ks.length ? Math.min(...ks) : 0;
    const minOther = kappaByRater[k].find((x) => x.kappa === min)?.other ?? '-';
    stats[k].meanKappa = mean;
    stats[k].minKappa = min;
    stats[k].minKappaOther = minOther;
  }

  // ── Recommendation per rater ───────────────────────────────────────
  const redundantSet = new Map(); // key -> partner it's redundant with
  for (const p of redundantPairs) {
    if (!redundantSet.has(p.a)) redundantSet.set(p.a, p.b);
    if (!redundantSet.has(p.b)) redundantSet.set(p.b, p.a);
  }
  for (const k of raterKeys) {
    const s = stats[k];
    const abstention = pct(s.dist.NEEDS_INVESTIGATION, s.labeled) / 100;
    const agree = s.truthEval ? s.truthAgree / s.truthEval : null;
    const flags = [];
    // Label skew: a rater that emits one label >80% of the time has low
    // discriminating power (rubber-stamping). This catches lenient raters
    // even when they agree with an equally-lenient majority.
    const maxCount = Math.max(...LABELS.map((l) => s.dist[l]));
    const maxLabel = LABELS.find((l) => s.dist[l] === maxCount);
    const maxShare = s.labeled ? maxCount / s.labeled : 0;
    if (maxShare > 0.8)
      flags.push(
        `SKEWED (${(maxShare * 100).toFixed(0)}% ${maxLabel}) — low discriminating power; likely rubber-stamping the description`,
      );
    if (abstention > 0.4)
      flags.push(
        `ABSTAINS (${(abstention * 100).toFixed(0)}% NI) — its NI votes carry no TP/FP signal; treat NI as abstention in κ, or drop`,
      );
    if (agree !== null && agree < 0.6)
      flags.push(
        `LOW PANEL AGREEMENT (${(agree * 100).toFixed(0)}% vs ${truth ? 'adjudicated truth' : 'majority'}) — diverges from the panel; down-weight`,
      );
    if (s.meanKappa < 0.3)
      flags.push(`LOW κ (mean ${s.meanKappa.toFixed(2)}) — weak agreement with all others`);
    if (redundantSet.has(k))
      flags.push(
        `REDUNDANT with ${redundantSet.get(k)} (κ ≥ ${args.redundantKappa}) — one of the pair is sufficient`,
      );
    s.abstention = abstention;
    s.agree = agree;
    s.flags = flags;
    s.recommendation = flags.length === 0 ? 'KEEP' : flags.length >= 2 ? 'DROP / DOWN-WEIGHT' : 'REVIEW';
  }

  // ── Render markdown ────────────────────────────────────────────────
  const L = [];
  L.push('# Per-rater reliability report');
  L.push('');
  L.push(`Source: \`${args.in}\``);
  L.push(`Truth basis: ${truth ? `adjudicated (\`${args.truth}\`)` : 'MAJORITY consensus (no adjudicated truth supplied)'}`);
  L.push(`Findings: ${entries.length} total · ${splitCount} SPLIT · redundancy threshold κ ≥ ${args.redundantKappa}`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Rater | Labeled | TP | FP | NI | OOS | NI%(abstain) | Panel-agree* | mean κ | min κ | Recommendation |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of raterKeys) {
    const s = stats[k];
    L.push(
      `| ${k} | ${s.labeled} | ${s.dist.TP} | ${s.dist.FP} | ${s.dist.NEEDS_INVESTIGATION} | ${s.dist.OUT_OF_SCOPE} | ${pct(s.dist.NEEDS_INVESTIGATION, s.labeled).toFixed(0)}% | ${s.agree !== null ? (s.agree * 100).toFixed(0) + '%' : 'n/a'} | ${s.meanKappa.toFixed(2)} | ${s.minKappa.toFixed(2)} (${s.minKappaOther}) | ${s.recommendation} |`,
    );
  }
  L.push('');
  L.push('\\* Panel-agree = % of this rater\'s labels matching the truth basis on findings where a truth label exists. It is panel cohesion, not accuracy, unless --truth supplies adjudicated labels.');
  L.push('');

  L.push('## Lenient ↔ strict on SPLIT findings');
  L.push('');
  L.push('How each rater voted on the contested findings — the TP-threshold signal.');
  L.push('');
  L.push('| Rater | TP | FP | NI | OOS | leaning |');
  L.push('|---|---|---|---|---|---|');
  for (const k of raterKeys) {
    const o = stats[k].onSplit;
    let leaning = 'balanced';
    if (o.total > 0) {
      const tpShare = o.TP / o.total;
      const strictShare = (o.FP + o.NEEDS_INVESTIGATION) / o.total;
      if (tpShare >= 0.7) leaning = 'LENIENT (over-calls TP)';
      else if (strictShare >= 0.7) leaning = 'STRICT (FP/NI)';
    }
    L.push(`| ${k} | ${o.TP} | ${o.FP} | ${o.NEEDS_INVESTIGATION} | ${o.OUT_OF_SCOPE} | ${leaning} |`);
  }
  L.push('');

  if (redundantPairs.length) {
    L.push('## Redundant rater pairs');
    L.push('');
    L.push(`Pairs with κ ≥ ${args.redundantKappa} produce near-identical labels — they do not add independent signal. Keep one per pair.`);
    L.push('');
    L.push('| Pair | κ | observed agreement |');
    L.push('|---|---|---|');
    for (const p of redundantPairs.sort((x, y) => y.kappa - x.kappa)) {
      L.push(`| ${p.a} ↔ ${p.b} | ${p.kappa.toFixed(3)} | ${p.agreement !== null ? (p.agreement * 100).toFixed(1) + '%' : '-'} |`);
    }
    L.push('');
  }

  L.push('## Per-rater detail + recommendation');
  L.push('');
  for (const k of raterKeys) {
    const s = stats[k];
    L.push(`### ${k} — ${s.name}`);
    L.push('');
    L.push(`- **Recommendation: ${s.recommendation}**`);
    if (s.flags.length) for (const f of s.flags) L.push(`  - ${f}`);
    else L.push('  - No reliability flags — independent, agrees with the panel, not redundant.');
    L.push('');
  }

  const md = L.join('\n');
  if (args.out) {
    await writeFile(args.out, md, 'utf-8');
    console.error(`[reliability] wrote ${args.out}`);
  } else {
    process.stdout.write(md + '\n');
  }
  // Also echo the headline recommendations to stderr.
  console.error('[reliability] recommendations:');
  for (const k of raterKeys) console.error(`  ${k}: ${stats[k].recommendation}`);
}

await main();
