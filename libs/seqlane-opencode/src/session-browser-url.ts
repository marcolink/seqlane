function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

/**
 * Returns the OpenCode web route for a session when the configured runtime
 * endpoint can also serve the web UI.
 */
export function createOpenCodeSessionBrowserUrl(
  runtimeUrl: string,
  workspace: string,
  sessionId: string,
): string | undefined {
  try {
    const runtime = new URL(runtimeUrl);
    if (
      (runtime.protocol !== "http:" && runtime.protocol !== "https:") ||
      runtime.username.length > 0 ||
      runtime.password.length > 0
    ) {
      return undefined;
    }

    const workspacePath = Buffer.from(workspace, "utf8").toString("base64url");
    return new URL(
      `/${workspacePath}/session/${encodePathSegment(sessionId)}`,
      runtime.origin,
    ).href;
  } catch {
    return undefined;
  }
}
