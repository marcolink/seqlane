import { Box, render, Text, useWindowSize, type Instance } from "ink";
import { useMemo } from "react";
import type { RunViewModel } from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { HumanHeader } from "./header.js";
import { HumanTree } from "./tree.js";
import { encodeTerminalField } from "../terminal-field.js";

export interface HumanAppProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
  readonly animate?: boolean;
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
  const instance: Instance = render(<LiveHumanApp {...props} />, {
    ...terminal,
    alternateScreen: false,
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 12,
  });
  return {
    rerender: (next) => instance.rerender(<LiveHumanApp {...next} />),
    async finish() {
      try {
        await instance.waitUntilRenderFlush();
      } finally {
        instance.unmount();
        try {
          await instance.waitUntilExit();
        } finally {
          instance.cleanup();
        }
      }
    },
  };
}

export function LiveHumanApp(props: HumanAppProps): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  return (
    <HumanApp
      {...props}
      animate
      capabilities={{
        ...props.capabilities,
        width: columns,
        height: rows,
      }}
    />
  );
}

export function HumanApp({
  view,
  capabilities,
  spinnerFrame,
  animate = false,
}: HumanAppProps): React.JSX.Element {
  // Leave the terminal's final column unused to avoid edge clipping/autowrap.
  const contentCapabilities = useMemo(
    () => ({
      ...capabilities,
      width: Math.max(1, (capabilities.width ?? 80) - 1),
    }),
    [capabilities],
  );
  return (
    <Box flexDirection="column">
      <HumanHeader
        view={view}
        capabilities={contentCapabilities}
        spinnerFrame={spinnerFrame}
        animate={animate}
      />
      <Box marginTop={1} flexDirection="column">
        <HumanTree
          view={view}
          capabilities={contentCapabilities}
          spinnerFrame={spinnerFrame}
          animate={animate}
        />
      </Box>
      {view.runError === undefined ? null : (
        <Text color={capabilities.supportsAnsi ? "red" : undefined}>
          {encodeTerminalField(view.runError.message, capabilities.redactions)}
        </Text>
      )}
    </Box>
  );
}
