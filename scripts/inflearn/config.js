const source = require("../hola/config-b");

module.exports = {
  title: source.title,
  body: source.body,
  tags: ["사이드프로젝트", "팀프로젝트", "프로젝트", "PM", "디자이너"],
  dryRun: process.env.INFLEARN_DRY_RUN === "1",
};
