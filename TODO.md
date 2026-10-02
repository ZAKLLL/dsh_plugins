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

## 2. adapter 提供 getModelUsage：按模型分列的用量（**已定接口，未实现**）

**决定**：不要只记「最后一个模型」，而是**每个出现过的模型各记一份用量**。adapter 上新增一个读取目标，形状是：

```js
/** 模型 → 该模型在本会话里的用量。键是稳定的模型标识（见下表），值是 Tokens。 */
models: Map<string, Tokens>   // Tokens 沿用现有形状：input/output/cacheRead/cacheWrite/total
```

**为什么放在 reading 而不是新开一个 op**：这三家的读取**本来就在各自的 `readStoreEvent` 里逐事件走 store**（取 token 用量与等待状态那条路径）。在同一个遍历里顺手按当前模型分桶，代价为零；单开一个 op 会把同一份 store 再读一遍。

**各家的数据形状（已实测）**：

| agent | 模型从哪来 | 用量从哪来 | 能否按模型分 |
| --- | --- | --- | --- |
| **claude** | assistant 消息的 `message.model`（实测 `glm-5.3`） | **同一条消息**的 `message.usage` | ✅ 天然可分，逐条累加即可 |
| **pi** | `model_change` 事件的 `provider` + `modelId`（实测 `blueai-relay-200k/glm-5.3`） | assistant 消息的 `message.usage` | ✅ 记住「当前模型」，用量到达时归到它名下 |
| **codex** | 事件的 `payload.model`（实测 `gpt-6-luna`；`session_meta` 只有 `model_provider: "custom"`） | `event_msg/token_count` 的 `info.total_token_usage` | ⚠️ **见下** |
| **dsh** | **未知** | 无 token 事件 | ❌ 待查 |

**codex 的陷阱（必须处理，否则数字是错的）**：它的 `token_count` 报的是**累计值**，不是每轮的增量。所以「把当前累计归到当前模型」在换过模型的会话里会**把之前模型的用量也算给最后一个模型**。要做对只有两条路：

1. 记相邻两次 `token_count` 的**差值**，把差值归给「两次之间使用的模型」；
2. 或者明确只支持「单一模型的会话」，遇到多个模型就标注不可分。

**建议走 1**，并在 `models` 的键里带上 provider（例如 `custom/gpt-6-luna`），因为仅凭 model 名可能撞车。

**UI 注意**：`models` 有多个键时说明会话中途换过模型，展示要能让两者都看见；只有一个键时不要让它看起来像「整条会话只有这一个模型」的结论。

**步骤**：

- [ ] `freshReading()` 增加 `models: new Map()` 与 `model: null`
- [ ] claude：assistant 有 `message.model` 时按它分桶累加 usage
- [ ] pi：`model_change` 更新 `reading.model`；assistant usage 归到它名下
- [ ] codex：`payload.model` 更新 `reading.model`；`token_count` 改用**差值**归桶
- [ ] dsh：先查 `model/selection` 的 `data` 形状
- [ ] `Value` / `preview` / `messages` 带出 `models`（Map 需转成普通对象过 JSON）
- [ ] 测试：断言 claude 的一条会话里若换过模型，会出现**两个键**且各自用量之和等于总量

## 3. 实时视图的详情面板## 3. 实时视图的详情面板

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
