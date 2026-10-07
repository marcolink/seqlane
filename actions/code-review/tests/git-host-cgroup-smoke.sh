#!/usr/bin/env bash
set -euo pipefail

# Trusted fixture setup only. Action code runs as the normal runner user.
review_root=$(sudo mktemp -d /sys/fs/cgroup/seqlane-review-XXXXXXXX)
cleanup_review_root() {
  local review_status=$?
  if ! sudo /usr/bin/env REVIEW_CGROUP_ROOT="$review_root" /bin/bash -euc '
    printf "1" > "$REVIEW_CGROUP_ROOT/cgroup.kill"
    for attempt in $(seq 1 500); do
      if grep -q "^populated 0$" "$REVIEW_CGROUP_ROOT/cgroup.events"; then break; fi
      sleep 0.01
    done
    for group in "$REVIEW_CGROUP_ROOT"/seqlane-* "$REVIEW_CGROUP_ROOT/supervisor"; do
      if [ -d "$group" ]; then rmdir "$group"; fi
    done
    rmdir "$REVIEW_CGROUP_ROOT"
  '; then review_status=1; fi
  exit "$review_status"
}
trap cleanup_review_root EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '+cpu +memory +pids' | sudo tee "$review_root/cgroup.subtree_control" > /dev/null
sudo mkdir "$review_root/supervisor"
sudo chown -R "$(id -u):$(id -g)" "$review_root"

# Placement is privileged; every descendant then uses the runner identity.
sudo /usr/bin/env PATH="$PATH" HOME="$HOME" PNPM_HOME="$PNPM_HOME" CI=true NX_DAEMON=false \
  SEQLANE_REVIEW_CGROUP_ROOT="$review_root" /bin/bash -euc '
    printf "%s" "$$" > "$SEQLANE_REVIEW_CGROUP_ROOT/supervisor/cgroup.procs"
    exec /usr/bin/setpriv --reuid="$1" --regid="$2" --init-groups \
      "$3" exec nx run action-code-review:verify-git-host --output-style=static
  ' -- "$(id -u)" "$(id -g)" "$(command -v pnpm)"
