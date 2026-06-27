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
