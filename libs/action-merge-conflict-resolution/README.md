# @seqlane/action-merge-conflict-resolution

Private Action-specific infrastructure for resolving pull-request merge
conflicts.

This package owns the resolver's plain contracts, policy, and state model. It
is not a public Seqlane application package or a generic GitHub Action support
library. GitHub Actions, Git, filesystem, lockfile, agent, and summary
integrations enter through resolver-specific ports.
The Action composition evaluates a native Effect program and owns its temporary
agent workspace with a scope. Git runs in an isolated process group. Shutdown
stops and verifies that group before the command settles. If ownership or
termination is uncertain, the Action reports the failure and retains its
temporary agent workspace. Filesystem and SDK calls without cancellation
support settle before cleanup begins; the scope then stops and joins the agent.

OpenCode startup and shutdown follow the same retention rule for their
installation directory and the enclosing agent workspace. Docker regeneration
owns an exact container ID and a random ownership label. Cleanup verifies both,
removes that container, and confirms its absence before deleting temporary
inputs. Unconfirmed cleanup retains the workspace and reports the failure.
Commit and push stay separate, explicit operations.

The package must not be imported by `@seqlane/core`, `@seqlane/runtime`, the
CLI, or generic workflow packages.
