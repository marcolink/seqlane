import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/seqlane/",
  cacheDir: "../../node_modules/.vitepress-cache",
  title: "Seqlane",
  description: "Typed workflows for software-engineering work.",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Introduction", link: "/introduction/what-is-seqlane" },
      { text: "Authoring workflows", link: "/authoring-workflows/overview" },
      { text: "Adapters", link: "/adapters/overview" },
      { text: "CLI Commands", link: "/cli/run" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is Seqlane?", link: "/introduction/what-is-seqlane" },
          { text: "How it works", link: "/introduction/how-it-works" },
          { text: "Getting started", link: "/introduction/getting-started" },
        ],
      },
      {
        text: "Authoring workflows",
        items: [
          { text: "Overview", link: "/authoring-workflows/overview" },
          {
            text: "Tasks and data flow",
            link: "/authoring-workflows/tasks-and-data-flow",
          },
          {
            text: "Workflow composition",
            link: "/authoring-workflows/workflow-composition",
          },
          { text: "Plan", link: "/authoring-workflows/plan" },
          { text: "Agent tasks", link: "/authoring-workflows/agent-tasks" },
          { text: "Shell tasks", link: "/authoring-workflows/shell-tasks" },
          {
            text: "Dependencies",
            link: "/authoring-workflows/dependencies",
          },
          { text: "Repetition", link: "/authoring-workflows/repetition" },
          { text: "Sessions", link: "/authoring-workflows/sessions" },
          { text: "Workspaces", link: "/authoring-workflows/workspaces" },
          { text: "Model selection", link: "/authoring-workflows/models" },
        ],
      },
      {
        text: "Adapters",
        items: [
          { text: "Overview", link: "/adapters/overview" },
          { text: "OpenCode", link: "/adapters/opencode" },
          { text: "Codex", link: "/adapters/codex" },
        ],
      },
      {
        text: "CLI Commands",
        items: [{ text: "Run", link: "/cli/run" }],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/marcolink/seqlane" },
    ],
  },
});
