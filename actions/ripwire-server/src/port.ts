import { createServer } from "node:net";

export async function assertListenAvailable(listen: string): Promise<void> {
  const separator = listen.lastIndexOf(":");
  const host = listen.slice(0, separator);
  const port = Number(listen.slice(separator + 1));
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.close((error) => (error ? reject(error) : resolve()));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Ripwire listen address is already in use: ${listen}`, {
        cause: error,
      });
    }
    throw new Error(`Ripwire listen address is unavailable: ${listen}`, {
      cause: error,
    });
  }
}
