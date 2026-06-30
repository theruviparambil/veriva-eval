/**
 * Cohen's kappa — chance-corrected agreement between two raters.
 *
 *   kappa = (p_o - p_e) / (1 - p_e)
 *     p_o = observed agreement
 *     p_e = agreement expected by chance, from each rater's label marginals
 *
 * Why kappa and not accuracy: on an imbalanced label set, a rater that always
 * picks the majority class scores high "accuracy" while adding zero signal.
 * Kappa subtracts out the agreement you'd get by chance, so a rubber-stamp
 * rater lands near 0. This is the correct way to validate an LLM judge.
 */

export interface KappaResult {
  /** Number of items both raters labeled with an in-set label. */
  n: number;
  /** Observed raw agreement, 0–1. */
  agreement: number;
  /** Cohen's kappa, -1..1. */
  kappa: number;
  interpretation: string;
}

export function interpretKappa(k: number): string {
  if (k < 0.2) return "poor";
  if (k < 0.4) return "fair";
  if (k < 0.6) return "moderate";
  if (k < 0.8) return "substantial";
  return "near perfect";
}

/**
 * Compute Cohen's kappa over the items present in BOTH maps (keyed by item id),
 * restricted to labels in `labels`.
 */
export function cohensKappa(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
  labels: readonly string[],
): KappaResult {
  const matrix = new Map<string, Map<string, number>>();
  for (const la of labels) {
    const row = new Map<string, number>();
    for (const lb of labels) row.set(lb, 0);
    matrix.set(la, row);
  }

  let n = 0;
  for (const [id, la] of a) {
    const lb = b.get(id);
    if (lb === undefined) continue;
    if (!labels.includes(la) || !labels.includes(lb)) continue;
    matrix.get(la)!.set(lb, matrix.get(la)!.get(lb)! + 1);
    n += 1;
  }
  if (n === 0) return { n: 0, agreement: 0, kappa: 0, interpretation: interpretKappa(0) };

  let agreed = 0;
  for (const l of labels) agreed += matrix.get(l)!.get(l)!;
  const pO = agreed / n;

  let pE = 0;
  for (const l of labels) {
    let rowTotal = 0;
    let colTotal = 0;
    for (const m of labels) {
      rowTotal += matrix.get(l)!.get(m)!;
      colTotal += matrix.get(m)!.get(l)!;
    }
    pE += (rowTotal / n) * (colTotal / n);
  }

  const kappa = pE === 1 ? 1 : (pO - pE) / (1 - pE);
  return { n, agreement: pO, kappa, interpretation: interpretKappa(kappa) };
}

/** Agreement across a whole panel of raters (more than two). */
export interface MultiRaterResult {
  /** Items with at least two ratings — the ones agreement is defined over. */
  n: number;
  /** Number of raters in the panel. */
  raters: number;
  /** The coefficient (Fleiss' kappa or Krippendorff's alpha), roughly -1..1. */
  value: number;
  interpretation: string;
}

/**
 * Fleiss' kappa for a panel labeling the same items. This is the recognized
 * statistic for more than two raters; averaging pairwise Cohen's kappa is not a
 * defined coefficient. Generalized to tolerate abstention: each item is scored
 * over however many raters actually labeled it, and items with fewer than two
 * ratings are skipped.
 */
export function fleissKappa(
  raters: ReadonlyArray<ReadonlyMap<string, string>>,
  labels: readonly string[],
): MultiRaterResult {
  const labelIndex = new Map(labels.map((l, i) => [l, i] as const));
  const items = new Set<string>();
  for (const r of raters) for (const id of r.keys()) items.add(id);

  const categoryTotals = new Array<number>(labels.length).fill(0);
  let totalAssignments = 0;
  let pBarSum = 0;
  let usedItems = 0;

  for (const id of items) {
    const counts = new Array<number>(labels.length).fill(0);
    let nI = 0;
    for (const r of raters) {
      const l = r.get(id);
      if (l === undefined) continue;
      const idx = labelIndex.get(l);
      if (idx === undefined) continue;
      counts[idx]! += 1;
      nI += 1;
    }
    if (nI < 2) continue;
    let sumSq = 0;
    for (let j = 0; j < counts.length; j += 1) {
      sumSq += counts[j]! * counts[j]!;
      categoryTotals[j]! += counts[j]!;
    }
    totalAssignments += nI;
    pBarSum += (sumSq - nI) / (nI * (nI - 1));
    usedItems += 1;
  }

  if (usedItems === 0 || totalAssignments === 0) {
    return { n: 0, raters: raters.length, value: 0, interpretation: interpretKappa(0) };
  }
  const pBar = pBarSum / usedItems;
  let pE = 0;
  for (let j = 0; j < labels.length; j += 1) {
    const pj = categoryTotals[j]! / totalAssignments;
    pE += pj * pj;
  }
  const value = pE >= 1 ? 1 : (pBar - pE) / (1 - pE);
  return { n: usedItems, raters: raters.length, value, interpretation: interpretKappa(value) };
}

/**
 * Krippendorff's alpha (nominal metric). Like Fleiss it scores the whole panel,
 * but it handles missing data correctly (raters that skip items), so it's the
 * safer choice when coverage is uneven. alpha = 1 - Do/De, computed from the
 * coincidence matrix of every rating pair within each item.
 */
export function krippendorffAlpha(
  raters: ReadonlyArray<ReadonlyMap<string, string>>,
  labels: readonly string[],
): MultiRaterResult {
  const K = labels.length;
  const labelIndex = new Map(labels.map((l, i) => [l, i] as const));
  const o: number[][] = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  const items = new Set<string>();
  for (const r of raters) for (const id of r.keys()) items.add(id);

  let usedItems = 0;
  for (const id of items) {
    const vals: number[] = [];
    for (const r of raters) {
      const l = r.get(id);
      if (l === undefined) continue;
      const idx = labelIndex.get(l);
      if (idx === undefined) continue;
      vals.push(idx);
    }
    const mu = vals.length;
    if (mu < 2) continue;
    usedItems += 1;
    for (let a = 0; a < mu; a += 1) {
      for (let b = 0; b < mu; b += 1) {
        if (a === b) continue;
        o[vals[a]!]![vals[b]!]! += 1 / (mu - 1);
      }
    }
  }

  const nC = new Array<number>(K).fill(0);
  let n = 0;
  for (let c = 0; c < K; c += 1) {
    for (let k = 0; k < K; k += 1) nC[c]! += o[c]![k]!;
    n += nC[c]!;
  }
  if (usedItems === 0 || n <= 1) {
    return { n: usedItems, raters: raters.length, value: 1, interpretation: interpretKappa(1) };
  }
  let doSum = 0;
  let deSum = 0;
  for (let c = 0; c < K; c += 1) {
    for (let k = 0; k < K; k += 1) {
      if (c === k) continue;
      doSum += o[c]![k]!;
      deSum += nC[c]! * nC[k]!;
    }
  }
  const value = deSum === 0 ? 1 : 1 - (n - 1) * (doSum / deSum);
  return { n: usedItems, raters: raters.length, value, interpretation: interpretKappa(value) };
}
