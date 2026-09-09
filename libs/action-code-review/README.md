# Code-review Action library

This private package contains the trusted code-review workflow, the model-free
publication workflow, Action contracts, and narrow GitHub ports. It has no
GitHub Actions Toolkit dependency. The Node 24 Action entrypoint adapts Toolkit
inputs and GitHub clients to these ports, then invokes both bundled workflows
through `startWorkflowRun`.
