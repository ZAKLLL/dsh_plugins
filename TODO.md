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

## 2. adapter 提供 getModelUsage（**已完成**）

`reading` 增加 `model`（当前模型）与 `models`（模型 → 用量），由共享的
`accumulate` 在累加总量时**顺手分桶**——一次遍历两个答案。新增 `models` op，
`preview` 与 `messages` 也带出。界面：实时详情面板列出每个模型的用量，
阅读器头部标出当前模型。

**五家全部打通**（实测覆盖）：

| agent | 来源 | 有模型 | 多模型会话 |
| --- | --- | --- | --- |
| dsh | `request/header` 的 `data.header.config` | 19/20 | 0 |
| claude | assistant 消息的 `message.model`（与 usage 同一条） | 31/34 | 9 |
| codex | 事件的 `payload.model` | 269/269 | 20 |
| gemini | `type:"gemini"` 事件的 `model`（与该轮 tokens 同一条） | 9/10 | 1 |
| pi | `model_change` 的 provider + modelId | 28/28 | 0 |

**过程中修掉三个自己的错**：

1. **`total` 不能自己加**：Codex 的 `cached_input_tokens` **已经包含在**
   `input_tokens` 里，四项相加会把缓存算两遍——实测 33,472,212 对权威的
   16,773,939。现在 `total` 优先用方言自己的数字，没有才退回相加。
   （原先「claude 完全一致」的验证是**循环论证**：拿自己算的和跟自己算的和比。）
2. **DSH 有两个 `readStoreEvent` 键**（我先加模型、它后面已有审批的那个），
   同名字面量**后者生效**，模型跟踪静默失效（0/20）。已合并为一个。
3. **DSH 的 token 用量并非不存在**——`assistant/attempt` 的流里确实有 `usage`
   chunk，只是本机**全为 0**（provider 不上报），且无法从零值反推它是每轮还是
   累计，所以不从它取数。先前「DSH 没有 token 事件」的说法不准确。

**不变量测试**：`models` 各桶之和必须等于会话总量——**这条正是抓出 Codex
那个 bug 的检查**，现由 preview 测试以两个模型 + 各自用量的 fixture 钉住；
另有一条断言 DSH 的模型与审批必须同时生效，防同名键再次互相覆盖。

## 3. 实时视图的详情面板## 3. 实时视图的详情面板## 3. 实时视图的详情面板

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
