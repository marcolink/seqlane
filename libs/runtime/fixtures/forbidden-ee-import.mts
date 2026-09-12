// This fixture must remain rejected by the Community-only import guard.
import { enterpriseOnly } from "@mastra/core/ee/auth";

export const forbiddenImport = enterpriseOnly;
