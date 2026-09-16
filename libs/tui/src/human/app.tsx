import {
  Box,
  render,
  Text,
  useAnimation,
  useWindowSize,
  type Instance,
} from "ink";
import type { RunViewModel } from "../run-view-model.js";
import { getRootRunElapsedMs } from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { HumanHeader } from "./header.js";
import { HumanTree } from "./tree.js";

export interface HumanAppProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
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
  const { frame } = useAnimation({
    interval: 100,
    isActive: props.view.runState === "active",
  });
  const { columns, rows } = useWindowSize();
  return (
    <HumanApp
      {...props}
      spinnerFrame={frame}
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
}: HumanAppProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <HumanHeader
        view={view}
        elapsedMs={getRootRunElapsedMs(view)}
        capabilities={capabilities}
        spinnerFrame={spinnerFrame}
      />
      <Box marginTop={1} flexDirection="column">
        <HumanTree
          view={view}
          capabilities={capabilities}
          spinnerFrame={spinnerFrame}
        />
      </Box>
      {view.runError === undefined ? null : (
        <Text color={capabilities.supportsAnsi ? "red" : undefined}>
          {view.runError.message}
        </Text>
      )}
    </Box>
  );
}
