import { z } from "zod";

export const readContextInputSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  paths: z.array(z.string().trim().min(1).max(4_096)).max(64).optional(),
  scope: z.array(z.string().trim().min(1).max(4_096)).max(32).optional(),
  maxFiles: z.number().int().positive().max(20).optional(),
  maxBytes: z.number().int().positive().max(1_000_000).optional(),
  noZvec: z.boolean().optional(),
  noRipwire: z.boolean().optional(),
});

const excludedPathSchema = z
  .object({
    path: z.string().max(4_096),
    reason: z.string().max(1_000),
  })
  .strict();

export const ReadContextSchema = z
  .object({
    answer: z.string().max(16_000),
    evidence: z
      .array(
        z
          .object({
            path: z.string().max(4_096),
            symbol: z.string().max(1_000).optional(),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
            relevance: z.string().max(2_000),
          })
          .strict(),
      )
      .max(20),
    relationships: z
      .array(
        z
          .object({
            from: z.string().max(1_000),
            to: z.string().max(1_000),
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
            path: z.string().max(4_096),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            reason: z.string().max(2_000),
          })
          .strict(),
      )
      .max(8),
    uncertainties: z.array(z.string().max(2_000)).max(12),
    retrieval: z
      .object({
        selectedPaths: z.array(z.string().max(4_096)).max(20),
        selectedRanges: z
          .array(
            z.strictObject({
              path: z.string().max(4_096),
              startLine: z.number().int().positive(),
              endLine: z.number().int().positive(),
            }),
          )
          .max(100),
        excludedPaths: z.array(excludedPathSchema).max(100),
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
    question: z.string().max(4_000),
    corpus: z.string().max(32_000),
    selectedPaths: z.array(z.string().max(4_096)).max(20),
    selectedRanges: z
      .array(
        z.strictObject({
          path: z.string().max(4_096),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
        }),
      )
      .max(100),
    excludedPaths: z.array(excludedPathSchema).max(100),
    usedExactSearch: z.boolean(),
    usedZvecGrep: z.boolean(),
    usedRipwire: z.boolean(),
    uncertainties: z.array(z.string().max(2_000)).max(12),
  })
  .strict();

export type ReadContextRetrieval = z.infer<typeof readContextRetrievalSchema>;

export type ReadContextRequest = ReadContextInput;
