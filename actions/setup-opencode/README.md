# Set up OpenCode

This Action installs and verifies one exact OpenCode release. It supports
Linux and macOS runners with x64 and arm64 architectures.

```yaml
- id: opencode
  uses: ./actions/setup-opencode
  with:
    version: 1.18.27

- uses: ./actions/opencode-server
  with:
    executable: ${{ steps.opencode.outputs.executable }}
    working-directory: ${{ github.workspace }}
```

The Action uses an exact internal cache for verified installations. Cache
failures do not change setup behavior. The consuming workflow must provide the
version explicitly; this Action does not select a default or a mutable release.
Setup runs under one scoped Effect program with a ten-minute deadline. Runner
interruption aborts metadata and archive downloads, and executable checks.
Setup waits for each executable process to close and each toolkit cache,
extraction, or placement call to settle before it removes temporary files.
