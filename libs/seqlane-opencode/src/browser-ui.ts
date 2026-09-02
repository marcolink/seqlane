function isSupportedRuntimeUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}

/** Detects whether the configured OpenCode runtime also hosts a web UI. */
export async function resolveOpenCodeBrowserUiUrl(
  runtimeUrl: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let runtime: URL;
  try {
    runtime = new URL(runtimeUrl);
  } catch {
    return undefined;
  }
  if (!isSupportedRuntimeUrl(runtime)) return undefined;

  try {
    const response = await fetch(new URL("/", runtime), {
      redirect: "error",
      signal,
    });
    await response.body?.cancel();
    const contentType = response.headers.get("content-type");
    return response.ok && contentType?.startsWith("text/html")
      ? runtime.origin
      : undefined;
  } catch {
    return undefined;
  }
}
