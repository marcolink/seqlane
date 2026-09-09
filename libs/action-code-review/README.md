# Code-review Action library

This private package contains the trusted code-review Action contracts and
model-free publication helpers. It has no GitHub Actions Toolkit dependency;
the Node 24 Action entrypoint adapts Toolkit inputs and GitHub clients to these
ports and invokes the bundled trusted workflow through `startWorkflowRun`.
