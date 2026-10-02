# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

## 1. Codex 子代理被算到根会话头上（**已修** `fix: codex 用 thread 自己的 id`）

**现象**：列表里出现 63 行同名「修复 sandboxbash 多行命令」，全是 Codex。

**根因**：`session_meta` 有**两个 id**，我取错了：

```
subagent:  session_id=019f25a3…  id=019f2699…  parent_thread_id=019f25a3…
root    :  session_id=019ed32f…  id=019ed32f…
```

`session_id` 是**根会话**，对子代理等于父；**`id` 才是这条 thread 自己**。`buildCodex` 取 `session_id`，于是把子代理全都算到根头上——不只是 63 行同名，`codex resume <id>` 也会去 resume 根而不是那个子代理。

实测对照：

```
按 session_id 分组 → 177 组，最大一组 63 段     ← 我原来走这条
按 id 分组         → 269 组，最大一组  4 段     ← 正确
```

**修法**：`sessionId` 改用 `meta.id`，并补上 `subagent` / `parentSessionId`（原先这两个字段根本没填）。结果：codex 276 张卡片 269 个唯一 id，最大同 id 组 6 段，**101 条子代理全部正确挂到父节点**，树对 Codex 也生效了。

**顺带排除了一个错误结论**：我先前说「rollout 是分段、同一会话被列成多行」——**那个判断是错的**。真正的大头是子代理归属错误。分段确实存在（`compacted` 是真实事件类型，同 id 最多 6 段），但那是个小得多的问题。

**仍待做**：

- [ ] 同一 `id` 的多段（最多 6 段）仍然一个文件一张卡片——需要按 id 合并，且 `fullValueByKey` 要按时间拼接各段
- [ ] 子代理标题仍在漏注入文本：最大标题簇是 21 条 `"The following is the Codex agent history"`、8 条 `"## Handoff ### Goal / design User chose…"`——`looksInjected` 需要认这些委派前言

## 2. 捕获每条会话最后使用的大模型（**已验证字段路径，未实现**）

**结论：claude / codex / pi 都能拿到，DSH 待查。**

实测（读真实 store 的最后一个相关事件）：

| agent | 字段 | 实测值 |
| --- | --- | --- |
| claude | assistant 消息的 `message.model` | `glm-5.3` |
| codex | 事件的 `payload.model`（晚于 `session_meta`；后者只有 `model_provider: "custom"`） | `gpt-6-luna` |
| pi | `model_change` 事件的 `provider` + `modelId` | `blueai-relay-200k/glm-5.3` |
| **dsh** | **未找到**——`model/selection` 在事件词汇表里存在，但最新那条会话里没探到；`assistant/message` 也没有 `model` 字段。需要针对性再查（`model/selection` 的 `data` 形状、或 `request/header`） | — |

**实现位置（不需要新 op）**：这三家的读取都已经在各自的 `readStoreEvent` 里走 store 了，所以把 `model` 加进 reading 即可——`Value` 增加 `model` 字段，`preview` / `messages` / `list` 带出去，行尾或详情面板显示。

**注意**：走的是「最后一个相关事件」，所以它反映的是**当前**用的模型；会话中途换过模型时，更早的消息是别的模型，这一点在 UI 上要说明，不要让它看起来像「整条会话的模型」。

## 3. 实时视图的详情面板

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
