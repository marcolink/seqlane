# @seqlane/action-merge-conflict-resolution

Private Action-specific infrastructure for resolving pull-request merge
conflicts.

This package owns the resolver's plain contracts, policy, and state model. It
is not a public Seqlane application package or a generic GitHub Action support
library. GitHub Actions, Git, filesystem, lockfile, agent, and summary
integrations enter through resolver-specific ports.

The package must not be imported by `@seqlane/core`, `@seqlane/runtime`, the
CLI, or generic workflow packages.
