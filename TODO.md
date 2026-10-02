# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

当前有一项未完成的待办。

---

## 1. Session Hub：把 6 个方言的 adapter 实现搬进 `sources/<agent>.js`

**背景**：`plugins/dsh-session-hub/` 现在有 6 个 agent（DSH / Claude / Codex / Gemini / pi / opencode），但只有一层**非正式的**「源注册表」`SOURCES`，**没有声明式接口**。方言知识散在 11 处，其中 3 处是 `if (agent === ...)` 链——加一个 agent 要改 3 张平行表 + 2~3 条分支链 + 写 2 个函数。加 pi 和 opencode 时就是逐处补的。

**已完成的第一步**（`feat: 抽出 shared.js 与 adapter 契约`）：

- `shared.js`：11 个方言无关的助手（`textOf` / `toMs` / `parseJsonl` / `decodeZstdFrames` / `looksInjected` / `projectOf` / `oneLine` / `num` / `blocksOf` / `UNTITLED` 等）。index.js 已改为 import 并从自身删除副本，**净减 176 行**，六套测试全绿。
- `sources/adapter.js`：**声明式契约**。完整 JSDoc typedef（`AgentAdapter` / `Value` / `SessionCard` / `Tokens` / `Pending` / `Reading` / `StoreKind` / `DeletePlan` / `ReadingState` / `PreviewState`），以及 `defineAdapter()` 在**模块加载时**校验必填项（`id` / `label` / `executables` / `root` / `resumeCommand` / `build` 与 `list` 二选一 / `build` 必须有 `match`）。

**剩余步骤**：

- [ ] 建 `sources/{dsh,claude,codex,gemini,pi,opencode}.js`，每个 `export default defineAdapter({...})`，把各自的 `build*` / `has*Signal` / 读事件逻辑搬进去
- [ ] `previewFrom` 的 5 分支链 → `adapter.readPreview(event, state)`
- [ ] `readEvent` 的 4 分支链 → `adapter.readStoreEvent(event, state)`
- [ ] `resumeCommandFor` 的 5 分支链 → `adapter.resumeCommand(sessionId)`
- [ ] `deleteSession` 的两处特例 → `adapter.deletePlan(card)`
- [ ] `derivePreview` / `readStore` 的 DSH 特例 → `adapter.storeKind`（`"jsonl"` / `"frames"` / `null`）
- [ ] `AGENT_LABELS` / `AGENT_EXECUTABLES` / `SPAWN_COMMANDS` / `rootOf` → adapter 字段
- [ ] `openOriginal` / `spawnSession` 的 DSH 特例 → `adapter.spawnCommand === null`
- [ ] `SOURCES` → `[dsh, claude, codex, gemini, pi, opencode]`

**验收**：`grep -n 'agent ===' plugins/dsh-session-hub/index.js` 在 index.js 里**一条都不剩**（全部落在 adapter 内）；六套测试全绿；加一个 agent 只需新增一个 `sources/<agent>.js` 并登记。

**注意**：这是纯结构性重构，零用户可见变化，但会动 index.js 的大部分。**必须先 ⌘Q 重启 DSH 确认当前功能（实时方块 / token / 推理过滤）都正常，再动手**——不要在一个尚未验收的基础上重构。

---

## 仓库基建记录（非待办）

- 目录结构为 `plugins/<插件名>/`，每个插件自成一个包目录；**移动插件目录必须同时重新安装**，原因与步骤见根 [README](README.md)。
- Git 默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、插件 `package.json` 的 `license` 字段）
- 仓库为 public；提交身份 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/`、`plugins/*/node_modules/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
