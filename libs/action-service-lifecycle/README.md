# @seqlane/action-service-lifecycle

Private, Toolkit-free process supervision for the OpenCode, zvec-grep, and
Ripwire service Actions. Public Action inputs and saved state remain Zod-owned.

`spawnDetached` acquires an anchored service in an Effect scope. The Action must
persist validated process and sentinel identities, wait for `adoptDetachedProcess`
to receive the resident acknowledgment, and finish readiness checks before it
calls `completeDetachedProcessHandoff`. The scope finalizer cleans partial
startup, failed readiness, and interruption. It keeps cleanup ownership until
the explicit handoff completes.

`terminateProcessGroup` checks process birth and process-group identity before
each signal. It returns `false` when it cannot prove safe ownership or cleanup.
It ignores process groups with only zombie or exited members.

The package exports `./process-anchor.js` as a self-contained Node 24 resident
asset. Each Action imports that declared export from its resident entrypoint.
The atomic Action build bundles main, post, and resident together. Each Action's
`processAnchorPath()` resolves the adjacent resident asset.

Linux and macOS provide the required process identity checks. Other platforms
fail before a child starts. If identity capture fails after spawning, cleanup
disconnects private IPC and waits for the resident's group cleanup. Unconfirmed
termination remains explicit and never authorizes a foreign process signal.
