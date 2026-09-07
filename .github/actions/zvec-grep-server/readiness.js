export function buildReadinessArguments(packageSpec, home) {
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
