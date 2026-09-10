# @seqlane/action-service-lifecycle

Private, Toolkit-free process supervision, identity, and termination
primitives for the OpenCode and zvec-grep GitHub Actions.

Action adapters own GitHub Actions inputs, outputs, state, post handlers,
filesystem checks, and service-specific readiness commands. This package must
not depend on `@actions/core`, service-specific readiness behavior, or Seqlane
application packages.

If an anchored child fails after creation, `spawnDetached` waits for the child
and its process group before it rejects. It throws `SpawnDetachedError` with a
`cleanupSucceeded` field and any validated primary or sentinel ownership. An
Action adapter can persist that ownership for post-job cleanup when the field
is false. A false result without ownership means that post-job cleanup must
retain the install because ownership was not verified.
