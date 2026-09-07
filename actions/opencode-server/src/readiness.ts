const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function waitForHttpHealth(
  url: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    let response: Response | undefined;
    try {
      response = await fetch(url, { signal: controller.signal });
      if (response.ok) return;
    } catch {
      // The service may still be starting.
    } finally {
      try {
        await response?.body?.cancel();
      } catch {
        // Ignore body cleanup failures while the service is starting.
      }
      clearTimeout(timeout);
    }
    await sleep(1_000);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
