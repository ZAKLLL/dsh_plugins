# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

## 1. 同一条会话被列成很多行（按 (agent, sessionId) 去重）

**现象**：列表里出现 **63 行**同名「修复 sandboxbash 多行命令」（全是 Codex）。不是标题重复，是**同一条会话的多个存储文件各占一行**。

**实测数据**：

```
会话数: 371 | 唯一 key: 371 | 重复 key: 0
唯一 (agent, sessionId): 267 | 重复: 104        ← 104 张卡片与其他卡片共用 sessionId（28%）
最大的一个: 一个 codex sessionId → 14 个文件，合计约 80MB
```

**原因**：Codex 一条 thread 每跑一轮就写一个 rollout 文件。文件名里是**每次运行的新 uuid**，而文件内容里的 `session_meta.session_id` 是**稳定的 thread id**：

```
rollout-2026-09-23T21-25-…-01a0d029….jsonl   ← 文件名 uuid 每次都变
  内容 session_meta.session_id = 同一个值      ← 我取的是这个，所以识别成同一会话
```

`inventory` 正确地识别出它们属于同一会话，却仍然**一个文件产出一张卡片**。`codex resume <id>` 用的正是这个 `session_id`，所以它确实是同一会话。

**待定的关键问题**（决定怎么合并）：这些 rollout 是**累积快照**（最新一个就含完整历史）还是**分段**（各含一部分，必须全部读）？还没验证——从 `msgs` 看 21:25 两文件各 4 条、21:30 两文件各 3 条，像是分段而非累积，但样本不足。

**步骤**：

- [ ] 先验证累积 / 分段
- [ ] `inventory` 按 `(agent, sessionId)` 合并：`createdAt` 取最早、`updatedAt` 取最新、`key`/`file` 取代表文件
- [ ] 若为分段：`fullValueByKey` 与 `messages`/`transcript` 都要遍历该会话的全部文件
- [ ] 若为累积：取最新的即可，`bytes`/`messages` **不求和**（否则重复计数）
- [ ] 测试：断言 `(agent, sessionId)` 在清单里唯一

**注意**：`claude` 也有同样现象（一个 sessionId → 6 个文件），不是 Codex 独有。

## 2. 实时视图的详情面板

已完成：宿主 `reference` op + 行右侧引用按钮（DSH 走原生 mention，其余走 `@` + `adapter.sessionFile(card).path`）。

仍未做：实时视图的详情面板里还没有引用按钮（行上已有）。
---

## 仓库基建记录（非待办）

- 目录结构为 `plugins/<插件名>/`，每个插件自成一个包目录；**移动插件目录必须同时重新安装**，原因与步骤见根 [README](README.md)。
- Git 默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、插件 `package.json` 的 `license` 字段）
- 仓库为 public；提交身份 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/`、`plugins/*/node_modules/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
