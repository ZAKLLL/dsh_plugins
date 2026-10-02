# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

当前有一项未完成的待办。

---

## 1. 会话行右侧增加「引用到会话」，所有 agent 都提供

**背景**：拖动把整条会话交给下一个 agent，但很多时候只想**引用**它——「看这条会话，接着它的活干」。DSH 原生有 `@` 引用语法，但没有从面板插入引用的入口。

**决定（已确认）**：**所有 agent 都提供这个动作**，引用目标一律来自适配器，而不是各写一套。

| agent | 引用的东西 | 怎么拿 |
| --- | --- | --- |
| **DSH** | **原生会话 mention** | 宿主侧 `ctx.get("sessionReference").listCandidates(agent, query, signal)`，每个候选带「宿主插入草稿的规范 mention」；`agent` 用 `ctx.get("agents").get(当前会话 id)` 拿 |
| **其余** | **原始会话产物的文件引用** | `adapter.sessionFile(card).path`——上一轮已实现，claude/pi 等 kind 为 `file` 时就是那个 `.jsonl`；kind 不是 `file` 时用 `adapter.handoff(card, {dir})` dump 出来的副本路径 |

**已完成的前置**（`d1c7584` / `53d8189`）：契约里的 `sessionFile(card) → { path, kind, label }`（必填）与可选的 `handoff(card, {dir}) → { path, name, origin, bytes }`。**DSH 不提供 handoff**（本来就在 DSH 里）。

**步骤**：

- [ ] 先单独验证 `listCandidates`：service 的 key 名、`SessionReferenceMentionCandidate` 的字段名（注释里写的是 `mention`，未验证）、以及它对 DSH 之外的会话返回什么
- [ ] 宿主加 `reference` op：入参 `{ key, currentSessionId }`，返回 `{ kind: "mention"|"file", text, description }`
- [ ] 客户端在行右侧动作簇加一个引用按钮（与现有五个按钮同样式，**必须带 tooltip**），点击走 `inputActions.insertText()` 写进草稿
- [ ] 实时视图的详情面板同样加一个
- [ ] 测试：断言 `reference` op 对 DSH 与非 DSH 各返回什么形状；渲染测试断言按钮存在且带 tooltip

**验收**：任意 agent 的会话行都能一键把引用写进草稿；DSH 会话插入的是原生 mention（能 `@` 到），其余插入的是指向原始会话文件的引用。

---


## 仓库基建记录（非待办）

- 目录结构为 `plugins/<插件名>/`，每个插件自成一个包目录；**移动插件目录必须同时重新安装**，原因与步骤见根 [README](README.md)。
- Git 默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、插件 `package.json` 的 `license` 字段）
- 仓库为 public；提交身份 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/`、`plugins/*/node_modules/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
