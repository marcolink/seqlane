import { z } from "zod";

export const readContextInputSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  paths: z.array(z.string().trim().min(1).max(4_096)).max(64).optional(),
  scope: z.array(z.string().trim().min(1).max(4_096)).max(32).optional(),
});

const excludedPathSchema = z
  .object({
    path: z.string(),
    reason: z.string(),
  })
  .strict();

export const ReadContextSchema = z
  .object({
    answer: z.string(),
    evidence: z
      .array(
        z
          .object({
            path: z.string(),
            symbol: z.string().optional(),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
            relevance: z.string(),
          })
          .strict(),
      )
      .max(20),
    relationships: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            kind: z.enum([
              "calls",
              "imports",
              "exports",
              "implements",
              "extends",
              "persists",
              "configures",
              "depends_on",
              "other",
            ]),
          })
          .strict(),
      )
      .max(30),
    followUpReads: z
      .array(
        z
          .object({
            path: z.string(),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            reason: z.string(),
          })
          .strict(),
      )
      .max(8),
    uncertainties: z.array(z.string()).max(12),
    retrieval: z
      .object({
        selectedPaths: z.array(z.string()),
        excludedPaths: z.array(excludedPathSchema),
        usedExactSearch: z.boolean(),
        usedZvecGrep: z.boolean(),
        usedRipwire: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ReadContextInput = z.infer<typeof readContextInputSchema>;
export type ReadContextResult = z.infer<typeof ReadContextSchema>;
export type ReadContextExcludedPath = z.infer<typeof excludedPathSchema>;

export const readContextRetrievalSchema = z
  .object({
    question: z.string(),
    corpus: z.string(),
    selectedPaths: z.array(z.string()),
    excludedPaths: z.array(excludedPathSchema),
    usedExactSearch: z.boolean(),
    usedZvecGrep: z.boolean(),
    usedRipwire: z.boolean(),
    uncertainties: z.array(z.string()),
  })
  .strict();

export type ReadContextRetrieval = z.infer<typeof readContextRetrievalSchema>;

export interface ReadContextRequest extends ReadContextInput {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly noZvec?: boolean;
  readonly noRipwire?: boolean;
}
