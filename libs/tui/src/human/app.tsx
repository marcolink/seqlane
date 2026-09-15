import { Box, render, Text, useInput, type Instance } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import { getRootRunElapsedMs } from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { HumanDetails } from "./details.js";
import { HumanHeader } from "./header.js";
import { HumanTree } from "./tree.js";

export type HumanInputAction =
  | "previous"
  | "next"
  | "collapse"
  | "expand"
  | "toggle-details"
  | "next-failure"
  | "toggle-help"
  | "cancel";

export interface HumanAppProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
  readonly detailsVisible: boolean;
  readonly helpVisible: boolean;
  readonly onInput: (action: HumanInputAction) => void;
}

export interface MountedHumanApp {
  rerender(props: HumanAppProps): void;
  finish(): Promise<void>;
}

export function mountHumanApp(
  props: HumanAppProps,
  terminal: {
    readonly stdin: NodeJS.ReadStream;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
  },
): MountedHumanApp {
  const instance: Instance = render(<HumanApp {...props} />, {
    ...terminal,
    alternateScreen: false,
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 12,
  });
  return {
    rerender: (next) => instance.rerender(<HumanApp {...next} />),
    async finish() {
      await instance.waitUntilRenderFlush();
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

export function HumanApp({
  view,
  capabilities,
  spinnerFrame,
  detailsVisible,
  helpVisible,
  onInput,
}: HumanAppProps): React.JSX.Element {
  const width = capabilities.width ?? 80;
  const height = capabilities.height ?? 24;
  const detailLines =
    width >= 100 && height >= 16 ? 5 : width >= 60 && height >= 16 ? 3 : 1;
  const showDetails = detailsVisible && (height >= 10 || width >= 40);
  useInput((input, key) => {
    if (key.ctrl && input === "c") return onInput("cancel");
    if (key.upArrow || input === "k") return onInput("previous");
    if (key.downArrow || input === "j") return onInput("next");
    if (key.leftArrow || input === "h") return onInput("collapse");
    if (key.rightArrow || input === "l") return onInput("expand");
    if (key.return) return onInput("toggle-details");
    if (input === "f") return onInput("next-failure");
    if (input === "?") return onInput("toggle-help");
  });

  return (
    <Box flexDirection="column">
      <HumanHeader view={view} elapsedMs={getRootRunElapsedMs(view)} />
      <Box marginTop={1} flexDirection="column">
        <HumanTree
          view={view}
          capabilities={capabilities}
          spinnerFrame={spinnerFrame}
        />
      </Box>
      {showDetails ? <HumanDetails view={view} maxLines={detailLines} /> : null}
      {helpVisible ? (
        <Text dimColor>
          ↑↓/jk move · ←→/hl expand · enter details · f failures · ^C cancel
        </Text>
      ) : null}
      {view.runState === "active" ? (
        <Text dimColor>
          {width < 60 ? "? help · ^C cancel" : "? help · ↑↓ move · ^C cancel"}
        </Text>
      ) : null}
    </Box>
  );
}
