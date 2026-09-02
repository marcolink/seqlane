# ADR-020 Admission Audit

Current implementation uses workspace policy only: `shared` tasks overlap with
other shared tasks; `exclusive` tasks serialize all workspace work. Admission
is deterministic, respects DAG and session constraints, and is held through
tracked invocation lifetime.

Seqlane no longer owns executor permissions. Runtime configuration controls
authority and unsupported interaction requests fail via the generic
non-interactive path. The previous capability-enforcement and
multiple-writer-diagnostic audit is obsolete.
