const development = process.env.SEQLANE_CLI_DEVELOPMENT === "1";

export default {
  bin: "seqlane",
  commands: development ? "./src/commands" : "./dist/commands",
  dirname: "seqlane",
  topicSeparator: " ",
};
