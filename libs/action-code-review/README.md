# Code-review Action library

This private package contains the trusted code-review workflow, the model-free
publication workflow, Action contracts, and narrow GitHub ports. It has no
GitHub Actions Toolkit dependency. The Node 24 Action entrypoint adapts Toolkit
inputs and GitHub clients to these ports, then invokes both bundled workflows
through `startWorkflowRun`.
The main Action composition owns one scoped Effect program. `SIGINT` and
`SIGTERM` abort the OpenCode runtime and the active review or publication run;
the post entrypoint owns marker cleanup in its own scoped program. Post requests
have a 20-second deadline and validate the saved comment before removing a
marker. Publication writes require an exact readback of the same report body
and run identity before the Action reports success.

Reports have a 60,000-byte publication limit. The publisher compacts metrics
JSON whitespace before shortening review text, removing task details, or
reducing visible findings. Text compaction adds a limitation notice.
If task details exceed the limit, it retains run totals and adds a limitation
notice. It then reduces finding rows in priority order, retaining the complete
bounded finding state. A report with retained findings never says "No findings."
If one finding row and the required state cannot fit, publication fails.
