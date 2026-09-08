import { spawn } from "node:child_process";

let adopted = false;

process.on("exit", () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // The process group may already be gone.
  }
});

const [command, serializedArgs] = process.argv.slice(2);
if (!command || serializedArgs === undefined) {
  throw new Error("Process anchor requires a command and serialized arguments");
}

let args;
try {
  args = JSON.parse(serializedArgs);
} catch (error) {
  throw new Error("Process anchor received invalid serialized arguments", {
    cause: error,
  });
}
if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
  throw new Error("Process anchor received invalid command arguments");
}

function sendMessage(message, onSent) {
  if (!process.connected || typeof process.send !== "function") {
    onSent?.();
    return;
  }
  process.send(message, onSent);
}

function killUnadoptedGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}

process.on("message", (message) => {
  if (message?.type === "adopt") {
    adopted = true;
    sendMessage({ type: "adopted" });
  }
});
process.on("disconnect", () => {
  if (!adopted) killUnadoptedGroup();
});

process.on("SIGTERM", () => {
  // Keep the anchor alive during graceful process-group shutdown.
});
process.on("SIGINT", () => {
  // Keep the anchor alive during graceful process-group shutdown.
});
process.on("SIGHUP", () => {
  // Keep the anchor alive during graceful process-group shutdown.
});
setInterval(() => {
  // Keep the anchor event loop alive between action steps.
}, 60_000);

const sentinel = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 60_000);',
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  },
);

sentinel.once("error", (error) => {
  sendMessage({ type: "error", message: error.message }, () => process.exit(1));
});

sentinel.once("spawn", () => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.once("error", (error) => {
    sendMessage({ type: "error", message: error.message }, () =>
      process.exit(1),
    );
  });

  child.once("spawn", () => {
    sendMessage({ type: "ready", sentinelPid: sentinel.pid });
  });

  child.once("exit", (code, signal) => {
    sendMessage(
      {
        type: "child-exited",
        code,
        signal,
      },
      () => process.exit(code === 0 ? 0 : 1),
    );
  });
});
