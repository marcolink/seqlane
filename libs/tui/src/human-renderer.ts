import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import {
  createRunViewModel,
  reduceRunViewModel,
  type RunViewModel,
} from "./run-view-model.js";
import type {
  ExecutionRenderer,
  OutputCapabilities,
  RendererFailure,
} from "./renderer-contract.js";
import type { HumanAppProps, MountedHumanApp } from "./human/app.js";

/** Adapts CLI events to React props; Ink owns rendering and terminal lifecycle. */
export class HumanTTYRenderer implements ExecutionRenderer {
  readonly mode = "human" as const;
  private view: RunViewModel;
  private readonly app: Promise<MountedHumanApp>;
  private finished = false;
  private renderError: unknown;

  constructor(private readonly capabilities: OutputCapabilities) {
    if (!capabilities.isTTY || capabilities.terminal === undefined) {
      throw new Error("Human output requires terminal streams");
    }
    this.view = createRunViewModel();
    const terminal = capabilities.terminal;
    this.app = import("./human/app.js").then(({ mountHumanApp }) =>
      mountHumanApp(this.props(), terminal),
    );
    // Surface startup errors during finalization without unhandled rejections.
    void this.app.catch((cause: unknown) => {
      this.renderError = cause;
    });
  }

  handle(event: SeqlaneExecutionEvent): void {
    if (this.finished) return;
    this.view = reduceRunViewModel(this.view, event);
    this.render();
  }

  handleRunnerFailure(failure: RendererFailure): void {
    if (this.finished) return;
    this.view = {
      ...this.view,
      runState: "failed",
      runError: { category: "ExecutorError", message: failure.message },
      finishedAt: this.view.now().toISOString(),
    };
    this.render();
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const app = await this.app;
    try {
      app.rerender(this.props());
    } finally {
      await app.finish();
    }
    if (this.renderError !== undefined) throw this.renderError;
    await this.capabilities.stdout.flush?.();
    await this.capabilities.stderr.flush?.();
  }

  private props(): HumanAppProps {
    return {
      view: this.view,
      capabilities: this.capabilities,
      spinnerFrame: 0,
    };
  }

  private render(): void {
    void this.app
      .then((app) => {
        if (!this.finished) app.rerender(this.props());
      })
      .catch((cause: unknown) => {
        this.renderError = cause;
      });
  }
}
