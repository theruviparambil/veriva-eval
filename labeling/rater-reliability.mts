#!/usr/bin/env tsx
/**
 * Per-rater reliability report for the multi-vendor panel.
 *
 * Consumes a panel-comparison.json (raters + pairwiseKappa + consensus.entries)
 * and answers: *which raters can we trust, and which add noise?*, so we can fix
 * the panel composition before spending compute on a fresh run.
 *
 * Two different agreement questions, two different statistics:
 *   - **Panel agreement** = Fleiss' kappa + Krippendorff's alpha over all raters.
 *     This is the headline "do the raters agree beyond chance" number (the same
 *     statistics `npm run replay` reports). Low is the finding, not a flaw.
 *   - **Rater redundancy** = pairwise Cohen's kappa between two raters. HIGH
 *     pairwise agreement means a pair is near-identical and one is enough; it is
 *     NOT the panel-agreement statistic. (Low pairwise kappa means a rater is
 *     independent, which a diverse panel wants.)
 *
 * All kappa math is the one shared, unit-tested implementation in src/kappa.ts.
 *
 * For each rater it also computes: label distribution + abstention (NI%),
 * agreement with the panel "truth" (adjudicated if --truth is given, else the
 * consensus label), its vote on the SPLIT findings, and a KEEP / DROP call.
 *
 * Usage:
 *   tsx labeling/rater-reliability.mts \
 *     --in=data/sample/panel-comparison.json \
 *     [--truth=data/sample/panel/truth.json] [--out=out/report.md] [--redundant-kappa=0.85]
 *   (or: npm run reliability)
 */
import { readFile, writeFile } from "node:fs/promises";
import { fleissKappa, krippendorffAlpha } from "../src/kappa.js";
import { LABELS, type Label } from "../src/types.js";

interface Args {
  in?: string;
  out?: string;
  truth?: string;
  redundantKappa: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { redundantKappa: 0.85 };
  for (const a of argv) {
    if (a.startsWith("--in=")) out.in = a.slice(5);
    else if (a.startsWith("--out=")) out.out = a.slice(6);
    else if (a.startsWith("--truth=")) out.truth = a.slice(8);
    else if (a.startsWith("--redundant-kappa=")) {
      const n = parseFloat(a.slice(18));
      if (Number.isFinite(n)) out.redundantKappa = n;
    } else if (a === "--help" || a === "-h") {
      console.error("usage: rater-reliability.mts --in=<comparison.json> [--out=<report.md>] [--truth=<adjudicated.json>] [--redundant-kappa=0.85]");
      process.exit(0);
    }
  }
  if (!out.in) {
    console.error("error: --in=<comparison.json> is required");
    process.exit(2);
  }
  return out;
}

async function loadTruth(path: string | undefined): Promise<Map<string, string> | null> {
  if (!path) return null;
  const data = JSON.parse(await readFile(path, "utf-8")) as unknown;
  const map = new Map<string, string>();
  const rows = Array.isArray(data)
    ? (data as Array<Record<string, string>>)
    : ((data as { verdicts?: unknown; labels?: unknown }).verdicts ?? (data as { labels?: unknown }).labels ?? []) as Array<Record<string, string>>;
  for (const r of rows) {
    const label = r.label ?? r.canonicalLabel;
    if (r.findingId && LABELS.includes(label as Label)) map.set(r.findingId, label!);
  }
  return map;
}

const pct = (num: number, den: number): number => (den > 0 ? (num / den) * 100 : 0);

interface Entry {
  findingId: string;
  labels: Record<string, string>;
  consensus: string;
  consensusLabel: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dump = JSON.parse(await readFile(args.in!, "utf-8")) as {
    raters?: Record<string, { name?: string }>;
    pairwiseKappa?: Record<string, { kappa?: number; observedAgreement?: number }>;
    consensus?: { entries?: Entry[] };
  };
  const truth = await loadTruth(args.truth);

  const raterKeys = Object.keys(dump.raters ?? {}).sort();
  const entries = dump.consensus?.entries ?? [];
  const pairwise = dump.pairwiseKappa ?? {};

  // Reconstruct each rater's label map so we can compute the panel-level
  // statistics from the same source the pairwise table came from.
  const raterMaps = new Map<string, Map<string, string>>();
  for (const k of raterKeys) raterMaps.set(k, new Map());
  for (const e of entries) {
    for (const k of raterKeys) {
      const l = e.labels?.[k];
      if (l && LABELS.includes(l as Label)) raterMaps.get(k)!.set(e.findingId, l);
    }
  }
  const panel = raterKeys.map((k) => raterMaps.get(k)!);
  const fk = fleissKappa(panel, LABELS as readonly Label[]);
  const ka = krippendorffAlpha(panel, LABELS as readonly Label[]);

  // ── Per-rater tallies ──────────────────────────────────────────────
  interface Stat {
    key: string;
    name: string;
    labeled: number;
    dist: Record<string, number>;
    truthEval: number;
    truthAgree: number;
    onSplit: Record<string, number> & { total: number };
    meanRedundancy?: number;
    maxRedundancy?: number;
    maxRedundancyOther?: string;
    abstention?: number;
    agree?: number | null;
    flags?: string[];
    recommendation?: string;
  }
  const stats: Record<string, Stat> = {};
  for (const k of raterKeys) {
    stats[k] = {
      key: k,
      name: dump.raters?.[k]?.name ?? k,
      labeled: 0,
      dist: { TP: 0, FP: 0, NEEDS_INVESTIGATION: 0, OUT_OF_SCOPE: 0 },
      truthEval: 0,
      truthAgree: 0,
      onSplit: { TP: 0, FP: 0, NEEDS_INVESTIGATION: 0, OUT_OF_SCOPE: 0, total: 0 },
    };
  }

  let splitCount = 0;
  for (const e of entries) {
    const labels = e.labels ?? {};
    let truthLabel: string | null = null;
    if (truth && truth.has(e.findingId)) truthLabel = truth.get(e.findingId)!;
    else if (e.consensus === "UNANIMOUS" || e.consensus === "MAJORITY") truthLabel = e.consensusLabel;
    if (e.consensus === "SPLIT") splitCount += 1;

    for (const k of raterKeys) {
      const l = labels[k];
      if (!l || !LABELS.includes(l as Label)) continue;
      const s = stats[k]!;
      s.labeled += 1;
      s.dist[l] = (s.dist[l] ?? 0) + 1;
      if (truthLabel) {
        s.truthEval += 1;
        if (l === truthLabel) s.truthAgree += 1;
      }
      if (e.consensus === "SPLIT") {
        s.onSplit[l] = (s.onSplit[l] ?? 0) + 1;
        s.onSplit.total += 1;
      }
    }
  }

  // ── Pairwise Cohen's kappa → REDUNDANCY signal (not panel agreement) ──
  const redundancyByRater: Record<string, Array<{ other: string; kappa: number }>> = {};
  for (const k of raterKeys) redundancyByRater[k] = [];
  const redundantPairs: Array<{ a: string; b: string; kappa: number; agreement: number | null }> = [];
  for (const [pairKey, rep] of Object.entries(pairwise)) {
    const [a, b] = pairKey.split("_");
    const kappa = rep?.kappa ?? 0;
    if (a && redundancyByRater[a]) redundancyByRater[a]!.push({ other: b!, kappa });
    if (b && redundancyByRater[b]) redundancyByRater[b]!.push({ other: a!, kappa });
    if (kappa >= args.redundantKappa) redundantPairs.push({ a: a!, b: b!, kappa, agreement: rep?.observedAgreement ?? null });
  }
  for (const k of raterKeys) {
    const ks = redundancyByRater[k]!.map((x) => x.kappa);
    const mean = ks.length ? ks.reduce((p, c) => p + c, 0) / ks.length : 0;
    const max = ks.length ? Math.max(...ks) : 0;
    stats[k]!.meanRedundancy = mean;
    stats[k]!.maxRedundancy = max;
    stats[k]!.maxRedundancyOther = redundancyByRater[k]!.find((x) => x.kappa === max)?.other ?? "-";
  }

  // ── Recommendation per rater ───────────────────────────────────────
  const redundantSet = new Map<string, string>();
  for (const p of redundantPairs) {
    if (!redundantSet.has(p.a)) redundantSet.set(p.a, p.b);
    if (!redundantSet.has(p.b)) redundantSet.set(p.b, p.a);
  }
  for (const k of raterKeys) {
    const s = stats[k]!;
    const abstention = pct(s.dist.NEEDS_INVESTIGATION ?? 0, s.labeled) / 100;
    const agree = s.truthEval ? s.truthAgree / s.truthEval : null;
    const flags: string[] = [];
    const maxCount = Math.max(...LABELS.map((l) => s.dist[l] ?? 0));
    const maxLabel = LABELS.find((l) => (s.dist[l] ?? 0) === maxCount);
    const maxShare = s.labeled ? maxCount / s.labeled : 0;
    if (maxShare > 0.8)
      flags.push(`SKEWED (${(maxShare * 100).toFixed(0)}% ${maxLabel}): low discriminating power; likely rubber-stamping the description`);
    if (abstention > 0.4)
      flags.push(`ABSTAINS (${(abstention * 100).toFixed(0)}% NI): its NI votes carry no TP/FP signal; treat NI as abstention, or drop`);
    if (agree !== null && agree < 0.6)
      flags.push(`LOW ACCURACY (${(agree * 100).toFixed(0)}% vs ${truth ? "adjudicated truth" : "majority"}): diverges from the truth basis; down-weight`);
    if (redundantSet.has(k))
      flags.push(`REDUNDANT with ${redundantSet.get(k)} (pairwise kappa ≥ ${args.redundantKappa}): near-identical; one of the pair is enough`);
    s.abstention = abstention;
    s.agree = agree;
    s.flags = flags;
    s.recommendation = flags.length === 0 ? "KEEP" : flags.length >= 2 ? "DROP / DOWN-WEIGHT" : "REVIEW";
  }

  // ── Render markdown ────────────────────────────────────────────────
  const L: string[] = [];
  L.push("# Per-rater reliability report");
  L.push("");
  L.push(`Source: \`${args.in}\``);
  L.push(`Truth basis: ${truth ? `adjudicated (\`${args.truth}\`)` : "MAJORITY consensus (no adjudicated truth supplied)"}`);
  L.push(`Findings: ${entries.length} total · ${splitCount} SPLIT · redundancy threshold pairwise kappa ≥ ${args.redundantKappa}`);
  L.push("");
  L.push("## Panel agreement (all raters)");
  L.push("");
  L.push(`- **Fleiss' kappa: ${fk.value.toFixed(3)} (${fk.interpretation})** over ${fk.n} findings, ${fk.raters} raters`);
  L.push(`- **Krippendorff's alpha: ${ka.value.toFixed(3)} (${ka.interpretation})**`);
  L.push("");
  L.push("Low panel agreement is the finding, not a flaw: independent raters genuinely split on hard findings. The per-rater pairwise kappa below is a *redundancy* signal, not this panel statistic.");
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| Rater | Labeled | TP | FP | NI | OOS | NI%(abstain) | Accuracy* | mean redundancy | max redundancy | Recommendation |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const k of raterKeys) {
    const s = stats[k]!;
    L.push(
      `| ${k} | ${s.labeled} | ${s.dist.TP} | ${s.dist.FP} | ${s.dist.NEEDS_INVESTIGATION} | ${s.dist.OUT_OF_SCOPE} | ${pct(s.dist.NEEDS_INVESTIGATION ?? 0, s.labeled).toFixed(0)}% | ${s.agree !== null && s.agree !== undefined ? (s.agree * 100).toFixed(0) + "%" : "n/a"} | ${(s.meanRedundancy ?? 0).toFixed(2)} | ${(s.maxRedundancy ?? 0).toFixed(2)} (${s.maxRedundancyOther}) | ${s.recommendation} |`,
    );
  }
  L.push("");
  L.push("\\* Accuracy = % of this rater's labels matching the truth basis where a truth label exists. It is panel cohesion, not accuracy, unless --truth supplies adjudicated labels. *Redundancy = mean/max pairwise Cohen's kappa with other raters; HIGH means near-identical (redundant), not 'better'.*");
  L.push("");

  L.push("## Lenient ↔ strict on SPLIT findings");
  L.push("");
  L.push("How each rater voted on the contested findings: the TP-threshold signal.");
  L.push("");
  L.push("| Rater | TP | FP | NI | OOS | leaning |");
  L.push("|---|---|---|---|---|---|");
  for (const k of raterKeys) {
    const o = stats[k]!.onSplit;
    let leaning = "balanced";
    if (o.total > 0) {
      const tpShare = o.TP / o.total;
      const strictShare = (o.FP + o.NEEDS_INVESTIGATION) / o.total;
      if (tpShare >= 0.7) leaning = "LENIENT (over-calls TP)";
      else if (strictShare >= 0.7) leaning = "STRICT (FP/NI)";
    }
    L.push(`| ${k} | ${o.TP} | ${o.FP} | ${o.NEEDS_INVESTIGATION} | ${o.OUT_OF_SCOPE} | ${leaning} |`);
  }
  L.push("");

  if (redundantPairs.length) {
    L.push("## Redundant rater pairs");
    L.push("");
    L.push(`Pairs with pairwise kappa ≥ ${args.redundantKappa} produce near-identical labels. They do not add independent signal. Keep one per pair.`);
    L.push("");
    L.push("| Pair | pairwise kappa | observed agreement |");
    L.push("|---|---|---|");
    for (const p of redundantPairs.sort((x, y) => y.kappa - x.kappa)) {
      L.push(`| ${p.a} ↔ ${p.b} | ${p.kappa.toFixed(3)} | ${p.agreement !== null ? (p.agreement * 100).toFixed(1) + "%" : "-"} |`);
    }
    L.push("");
  }

  L.push("## Per-rater detail + recommendation");
  L.push("");
  for (const k of raterKeys) {
    const s = stats[k]!;
    L.push(`### ${k}: ${s.name}`);
    L.push("");
    L.push(`- **Recommendation: ${s.recommendation}**`);
    if (s.flags && s.flags.length) for (const f of s.flags) L.push(`  - ${f}`);
    else L.push("  - No reliability flags: independent, agrees with the truth basis, not redundant.");
    L.push("");
  }

  const md = L.join("\n");
  if (args.out) {
    await writeFile(args.out, md, "utf-8");
    console.error(`[reliability] wrote ${args.out}`);
  } else {
    process.stdout.write(md + "\n");
  }
  console.error(`[reliability] panel Fleiss' kappa=${fk.value.toFixed(3)}, Krippendorff's alpha=${ka.value.toFixed(3)}`);
  for (const k of raterKeys) console.error(`  ${k}: ${stats[k]!.recommendation}`);
}

await main();
