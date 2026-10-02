# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

当前没有未完成的待办。

---

## 仓库基建记录（非待办）

- 目录结构为 `plugins/<插件名>/`，每个插件自成一个包目录；**移动插件目录必须同时重新安装**，原因与步骤见根 [README](README.md)。
- Git 默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、插件 `package.json` 的 `license` 字段）
- 仓库为 public；提交身份 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/`、`plugins/*/node_modules/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
