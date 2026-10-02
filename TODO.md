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

**已验证（决定了修法）**：这些 rollout 是**分段**，不是累积快照。判据是取同一 thread 的全部文件、按时间排序后看各自的「第一条用户消息」——实测有 **4 种不同**；若是累积，它们应当全都相同（每个文件都从头开始）。

**因此合并分两步，第二步才是难点**：

1. **清单层**（简单）：按 `(agent, sessionId)` 合并卡片——`createdAt` 取最早、`updatedAt` 取最新、`key`/`file` 取最新那个分段作为代表。
2. **读取层**（难点）：`fullValueByKey` 必须把该会话的**全部分段按时间拼接**，否则点开阅读器只看得到最后一段。这意味着 `key` 不能再等同于单个文件路径——需要一张 `sessionId → 分段文件列表` 的索引，`transcript` / `messages` / `continue` 都走它。

**步骤**：

- [x] 验证累积 / 分段 → **分段**
- [ ] `inventory` 建 `sessionId → 有序分段列表` 索引，并据此合并卡片
- [ ] `fullValueByKey` 支持「一个 key 对应多个文件」，按时间顺序拼接各段的 `body`
- [ ] `bytes` / `messages` 此时**可以求和**（各段不重叠）
- [ ] 测试：断言 `(agent, sessionId)` 在清单里唯一；断言合并后的发言数**等于各段之和**

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
