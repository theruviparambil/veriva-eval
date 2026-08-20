/**
 * Cohen's kappa: chance-corrected agreement between two raters.
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

/**
 * A coefficient computed over no comparable items. Not a band: it marks the
 * absence of a measurement, so a degenerate panel does not read as "poor"
 * (which sounds like a finding).
 */
export const UNDEFINED = "undefined (no comparable items)";

/**
 * The other degenerate case, and a different one: plenty of items, but every
 * rating in a single category, so chance agreement is total and the
 * coefficient is 0/0. Kept distinct because the two call for different fixes:
 * one is a coverage problem, the other is a panel of raters that never
 * discriminated.
 */
export const UNDEFINED_NO_VARIANCE = "undefined (all ratings in one category)";

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
  // No shared items. Not "poor" agreement, which reads as a finding; the two
  // raters were never compared.
  if (n === 0) return { n: 0, agreement: 0, kappa: 0, interpretation: UNDEFINED };

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

  // pE === 1 means every rating fell in one category, so chance agreement is
  // total and kappa is 0/0. Reporting 1 "near perfect" is the single worst
  // thing this module can do: two raters who both say TP to everything are the
  // textbook case kappa exists to catch, and 1.0 clears any --fail-under.
  // No variance is not perfect agreement.
  if (pE >= 1) return { n, agreement: pO, kappa: 0, interpretation: UNDEFINED_NO_VARIANCE };
  const kappa = (pO - pE) / (1 - pE);
  return { n, agreement: pO, kappa, interpretation: interpretKappa(kappa) };
}

/** Agreement across a whole panel of raters (more than two). */
export interface MultiRaterResult {
  /** Items with at least two ratings, the ones agreement is defined over. */
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
    // "poor" reads as a finding. Nothing was comparable, which is the absence
    // of one. This is exactly what the UNDEFINED constant exists for.
    return { n: 0, raters: raters.length, value: 0, interpretation: UNDEFINED };
  }
  const pBar = pBarSum / usedItems;
  let pE = 0;
  for (let j = 0; j < labels.length; j += 1) {
    const pj = categoryTotals[j]! / totalAssignments;
    pE += pj * pj;
  }
  // As in cohensKappa: one category everywhere means 0/0, not 1. A panel of
  // rubber stamps scored "near perfect" and cleared --fail-under 0.9.
  if (pE >= 1) {
    return { n: usedItems, raters: raters.length, value: 0, interpretation: UNDEFINED_NO_VARIANCE };
  }
  const value = (pBar - pE) / (1 - pE);
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
    // Nothing comparable. Alpha's own algebra does tend to 1 here, but Fleiss
    // reports 0 on the identical input and 1.0 clears any --fail-under, so a
    // panel with nothing in it passed the gate on one coefficient while the
    // other called it "poor". Three functions must not give three answers to
    // one question, and the one that says "near perfect" is the one that
    // clears gates. Neither number is a measurement; saying so is better.
    return { n: usedItems, raters: raters.length, value: 0, interpretation: UNDEFINED };
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
  // Expected disagreement is zero because only one category appears. The
  // reference `krippendorff` package raises here ("There has to be more than
  // one value in the domain") rather than returning 1, which is the same
  // judgement reached a different way.
  if (deSum === 0) {
    return { n: usedItems, raters: raters.length, value: 0, interpretation: UNDEFINED_NO_VARIANCE };
  }
  const value = 1 - (n - 1) * (doSum / deSum);
  return { n: usedItems, raters: raters.length, value, interpretation: interpretKappa(value) };
}
