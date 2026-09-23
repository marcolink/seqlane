import type { PrivateClassifierConnection } from "@seqlane/runtime/runner";
import { z } from "zod";

export const classifierUrlEnvironment = "SEQLANE_RUNNER_CLASSIFIER_URL";
export const classifierModelEnvironment = "SEQLANE_RUNNER_CLASSIFIER_MODEL";
export const classifierApiKeyEnvironment = "SEQLANE_CLASSIFIER_API_KEY";

const classifierCliOptionsSchema = z
  .strictObject({
    url: z.string().optional(),
    model: z.string().optional(),
  })
  .superRefine(({ url, model }, context) => {
    if ((url === undefined) !== (model === undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "--classifier-url and --classifier-model must be used together",
      });
    }
    if (url !== undefined && url.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Classifier URL and model must be non-empty",
      });
    }
    if (model !== undefined && model.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Classifier URL and model must be non-empty",
      });
    }
  });

export type ClassifierCliOptions = z.output<typeof classifierCliOptionsSchema>;

export function parseClassifierCliOptions(
  url: string | undefined,
  model: string | undefined,
): ClassifierCliOptions {
  const parsed = classifierCliOptionsSchema.safeParse({ url, model });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Classifier options are invalid",
    );
  }
  return parsed.data;
}

/** Builds private child startup values without inheriting stale URL or model values. */
export function createClassifierStartupEnvironment(
  source: NodeJS.ProcessEnv,
  url: string | undefined,
  model: string | undefined,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  delete environment[classifierUrlEnvironment];
  delete environment[classifierModelEnvironment];
  if (url === undefined || model === undefined) return environment;
  return {
    ...environment,
    [classifierUrlEnvironment]: url,
    [classifierModelEnvironment]: model,
  };
}

/** Captures private runner values and removes them from the workflow process. */
export function captureClassifierConnectionEnvironment(
  environment: NodeJS.ProcessEnv,
): PrivateClassifierConnection | undefined {
  const url = environment[classifierUrlEnvironment];
  const model = environment[classifierModelEnvironment];
  const apiKey = environment[classifierApiKeyEnvironment];
  delete environment[classifierUrlEnvironment];
  delete environment[classifierModelEnvironment];
  delete environment[classifierApiKeyEnvironment];

  if (url === undefined || model === undefined) return undefined;
  return {
    url,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}
