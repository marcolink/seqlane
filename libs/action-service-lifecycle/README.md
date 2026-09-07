# @seqlane/action-service-lifecycle

Private, Toolkit-free process supervision, identity, and termination
primitives for the OpenCode and zvec-grep GitHub Actions.

Action adapters own GitHub Actions inputs, outputs, state, post handlers,
filesystem checks, and service-specific readiness commands. This package must
not depend on `@actions/core`, service-specific readiness behavior, or Seqlane
application packages.
