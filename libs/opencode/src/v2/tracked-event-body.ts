/** Join the native response reader even when SDK subscriber return is immediate. */
export function trackedEventBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | null | undefined,
  onClosed: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closing: Promise<void> | undefined;
  const abort = () => {
    void close();
  };
  const close = () => {
    closing ??= reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        reader.releaseLock();
        onClosed();
      });
    return closing;
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          await close();
          controller.close();
        } else controller.enqueue(item.value);
      } catch (cause) {
        await close();
        controller.error(cause);
      }
    },
    cancel: close,
  });
}
