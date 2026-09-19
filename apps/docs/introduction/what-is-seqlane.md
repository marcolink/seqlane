# What is Seqlane?

Seqlane is a TypeScript workflow controller for software-engineering agents.
It turns workflows into typed graphs of agent and deterministic tasks.

## A controller for coding agents

Seqlane has a different role from general async AI runners such as Trigger.dev
and Mastra. It does not make model calls. An adapter sends each agent task to
an external coding agent.

Seqlane controls task order, session use, workspace use, and parallel
execution. It keeps task boundaries explicit and reserves agent time for agent
work.

Seqlane works with your preferred coding agent and harness. It coordinates the
agent with the repository structure and tools that it already uses.

After a useful session, ask the agent to make an optimized workflow from the
process. Commit it, then run it the next time.

## Workflow or skill?

A skill improves an agent's method. A workflow also controls when to use that
agent.

A Seqlane workflow defines typed inputs and outputs, task dependencies,
sessions, workspace policy, and the final result. Skills can support an agent
task, but they do not define the complete process.

## Why use a workflow?

Seqlane can reduce token use. Each agent task receives only its required input
and session context. Each new agent session can [select a model](/authoring-workflows/models).

A later task can reuse a session or branch it when the selected adapter
supports branches. Deterministic work and local processes run outside the agent
loop.

Agents use context and tokens only for work that needs agent judgment.

## When to use Seqlane

Use Seqlane for repeatable software-engineering work that can run
autonomously. It fits tasks with defined inputs and expected output. It also
fits work that benefits from session, workspace, or parallel execution control.

## When not to use Seqlane

Do not use Seqlane for work that needs a person during execution. This includes
tasks that need questions answered, choices made, actions approved, or live
steering. Prepare the required input and permissions before the run, or use an
interactive agent session instead.

## Workflows travel with your code

A workflow is an ordinary TypeScript module. Develop it locally, commit it, and
share it as code. Run the same workflow in CI or on infrastructure where the
CLI and selected agent are available.

Next, read [How it works](/introduction/how-it-works), then
[install Seqlane](/introduction/getting-started).
