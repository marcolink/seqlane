import { Box, Text, useInput } from "ink";
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

export function HumanApp({
  view,
  capabilities,
  spinnerFrame,
  detailsVisible,
  helpVisible,
  onInput,
}: HumanAppProps): React.JSX.Element {
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
      {detailsVisible ? <HumanDetails view={view} /> : null}
      {helpVisible ? (
        <Text dimColor>
          ↑↓/jk move · ←→/hl expand · enter details · f failures · ^C cancel
        </Text>
      ) : null}
      {view.runState === "active" ? (
        <Text dimColor>? help · ^C cancel</Text>
      ) : null}
    </Box>
  );
}
