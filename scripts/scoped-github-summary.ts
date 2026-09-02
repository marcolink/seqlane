import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GithubActionsReporter } from "vitest/node";

const reportHeading = "## Vitest Test Report";

export function scopeVitestSummary(summary: string, scope: string): string {
  return summary.replace(reportHeading, `${reportHeading} — ${scope}`);
}

export default class ScopedGithubActionsReporter extends GithubActionsReporter {
  readonly #summaryPath: string | undefined;
  readonly #temporaryPath: string | undefined;

  constructor() {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    const temporaryPath = summaryPath
      ? join(tmpdir(), `vitest-summary-${process.pid}-${randomUUID()}.md`)
      : undefined;

    super({ jobSummary: { outputPath: temporaryPath } });
    this.#summaryPath = summaryPath;
    this.#temporaryPath = temporaryPath;
  }

  override onTestRunEnd(
    ...arguments_: Parameters<GithubActionsReporter["onTestRunEnd"]>
  ): void {
    super.onTestRunEnd(...arguments_);

    if (
      this.#summaryPath === undefined ||
      this.#temporaryPath === undefined ||
      !existsSync(this.#temporaryPath)
    ) {
      return;
    }

    try {
      const projectName = this.ctx.getRootProject().name || "unnamed project";
      const summary = readFileSync(this.#temporaryPath, "utf8");
      appendFileSync(
        this.#summaryPath,
        scopeVitestSummary(summary, projectName),
      );
    } finally {
      rmSync(this.#temporaryPath, { force: true });
    }
  }
}
