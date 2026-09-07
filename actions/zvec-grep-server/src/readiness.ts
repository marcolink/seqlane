export function buildReadinessArguments(
  packageSpec: string,
  home: string,
): string[] {
  return [
    "dlx",
    packageSpec,
    "server",
    "status",
    "--check-ready",
    "--home",
    home,
  ];
}

export function mcpUrl(listen: string): string {
  const parsed = new URL(`http://${listen}`);
  if (!parsed.hostname || !parsed.port) {
    throw new Error("listen must contain a hostname and port");
  }
  return `${parsed.origin}/mcp`;
}
