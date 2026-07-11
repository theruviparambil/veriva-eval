import { z } from "zod";

// ─── Label space ───────────────────────────────────────────────────────────
// The four-way verdict every rater (human or model) assigns to a finding.
//   TP                   : true positive: a real defect the tool correctly flagged
//   FP                   : false positive: the tool was wrong
//   NEEDS_INVESTIGATION  : abstention: not confidently decidable from the evidence
//   OUT_OF_SCOPE         : valid observation, but outside what we grade

export const LABELS = ["TP", "FP", "NEEDS_INVESTIGATION", "OUT_OF_SCOPE"] as const;
export type Label = (typeof LABELS)[number];

// ─── Corpus shape (a set of real PRs to replay a reviewer against) ──────────

export const CorpusItemSchema = z.object({
  id: z.string(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/name"),
  prNumber: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  language: z.string(),
  sizeClass: z.enum(["small", "medium", "large"]),
  category: z.string(),
  additions: z.number().int().nonnegative().nullish(),
  deletions: z.number().int().nonnegative().nullish(),
  notes: z.string().optional(),
});

export const CorpusSchema = z.object({
  version: z.string(),
  createdAt: z.string(),
  description: z.string().optional(),
  items: z.array(CorpusItemSchema).min(1),
  changelog: z
    .array(
      z.object({
        version: z.string(),
        date: z.string(),
        change: z.string(),
      }),
    )
    .optional(),
});

export type CorpusItem = z.infer<typeof CorpusItemSchema>;
export type Corpus = z.infer<typeof CorpusSchema>;
