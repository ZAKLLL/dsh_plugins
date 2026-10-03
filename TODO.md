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

## 4. `dsh-remote-agent`（**已移除**：能力已并入 session-hub）

原插件把别的机器上的 agent 拉到当前窗口。按「本机/远端用同一个 client 抽象」的方向重构后，它的三样能力去向如下：

| 原能力 | 现在在哪 |
| --- | --- |
| 远端会话的读取/删除/配置 | session-hub 的 store 缝隙 + 环境切换（**已实测**：`215` 上读到 18 条会话） |
| tty 在**侧栏内置终端**里 `ssh -t` | session-hub 的客户端（`openTabFromTarget("terminal")` + 轮询到可写再 `write`），**已并入并有渲染测试** |
| 远端 `dsh web`（端口转发 + 抓 token） | **放弃**：它的用途是「在本地看远端会话」，而 session-hub 现在直接读远端会话，这条路已无必要 |
| 远端机器概览 | 由 session-hub 的「⚙ 机器」取代（读 `~/.ssh/config` + 探活 + 每个 agent 的存在性） |

机器清单已迁移：`pro14uu` 现在写在 session-hub 自己的状态文件里，**在没有 remote-agent 的 profile 里实测仍然出现**（`source: saved`）。插件已从 `desktop` profile 卸载，目录已删除；代码在 git 里（`9a2b0c9`），需要时 `git checkout HEAD -- plugins/dsh-remote-agent`。

---

## 4b. 测试里的 hook spool：读写两边曾经指着不同路径（**已修**）

跑全量时 `delete` / `pins` / `preview` / `reload` 四个套件同时报
`list failed: Connection timed out during banner exchange`——它们去 SSH 了。

**我当时的判断是错的。** 我先写成「偶发」（重跑就恢复），又写过一个 `test/env.mjs`
助手去改真实的 `environment.json`——**两者都不对**：问题不在环境状态，而在
**`hook.mjs` 与宿主对「spool 在哪」的算法不一致**。

`sessionHubHome()` 是**可重定位**的（`DSH_SESSION_HUB_HOME`，为测试准备的），宿主读
spool 时走它；而 `hook.mjs` 当时**只认 `DSH_HOME`**——于是把插件状态搬进临时目录后，
**读的一边搬了、写的一边没搬**，写进去的 hook 落在没人读的文件里。preview 套件因此
拿不到本轮的 hook 报告，只有上一次运行留下的陈旧报告。

两处已修（都在 `094be52` 里，当时被 `git add -A` 与文档改动一起提交了）：

- `hook.mjs` 改成和宿主同一套解析（`DSH_SESSION_HUB_HOME` 优先，`DSH_SESSION_HUB_HOOKS` 仍可指名文件）
- `shared.js` 的 `sessionHubHome()` 把这个目录抽成一个概念

**教训**：同一份「文件在哪」的算法出现在两个进程里时，必须只有一个来源；测试里的
重定位只要有一边没跟上，症状会表现为**与本轮无关的陈旧数据**，而不是报错。
`test/env.mjs` 那个助手已删除（它去动使用者真实的文件，而且实测禁用后四个套件照样全绿）。

- [ ] 顺带确认：环境状态是否在**激活时**被读一次并缓存——若是，测试必须在 import 之前
      设好 `DSH_SESSION_HUB_HOME`（`preview.mjs` 目前是 import 之后才设）

## 5. `dsh-session-hub` 的 remote 模式（**代码与自动化验收已完成**，桌面端待重启生效）

**背景**：把远端机器的会话来进 Session Hub，**不是**再加一个平行插件，而是在 adapter 层下面换一层「字节从哪来」——所以六个 adapter 一行都没改。

**已完成（本机全绿 + 一次性 profile 的真实运行时全绿）**：

- [x] **store 缝隙**：`store.js`（`localStore` / `createRemoteStore`）+ `ssh.js` + `environments.js`。所有会话存储的读写都过 store；pins / hook spool / 进程表 / `code` CLI / transcript 落盘**明确留成本机**。
- [x] **本机行为逐字节不变**：`smoke` / `preview` / `render` 三个老测试在重构后原样全绿（含批量化的 `cachedCards`）。
- [x] **`home()`/`dshHome()` 按环境定 scope**，所以 adapter 的 `root()` / `configFiles()` 自动跟着环境走，零方言代码改动。
- [x] **批量**：`statMany` + `readHeads`（NUL 分帧 + base64），`cachedCards` 按前缀大小分轮，一轮一次 ssh——不是每文件一次。
- [x] **「连不上」不冒充「没有会话」**：环境不可用时所有读存储的 op 返回 `ok:false` + ssh 原话，**不带 `sessions` 字段**。真 HTTP 实测（桌面实例之外的一次性 profile）：`set pro14uu` → `reachable:false`，`list` → `ok:false`、无 `sessions`。
- [x] **环境选择记在宿主侧** `~/.dsh/session-hub/environment.json`；**重启一次性实例后确认恢复成上次那台**（"默认就是上次打开的"）。
- [x] **配置文件**：adapter 声明 `configFiles()`，6 家都有；ops `config list/read/write`，**逐字路径围栏** + 写前备份 `<path>.dsh-session-hub.bak` + `sensitive` 需二次「显示」。真 HTTP 实测列出 11 个文件、`opencode.json` 正确显示为未创建。
- [x] **`test/remote.mjs`（68 断言）**：假 `ssh` + `stat` shim 把"远端"跑在本机，覆盖 walk/stat/statMany/readHead/readHeads/readAt/readTail/readFile/writeText/remove/check；并把**合成远端 home** 挂到切换器后面，断言只存在于对面的 Claude 会话被正确列出、本机会话一条不混入。**它抓出一个真 bug**：探针脚本的 `exit 0` 吞掉了收尾哨兵 → 已用子 shell 修掉。
- [x] **`test/environments.mjs`（63 断言）**：环境目录、配置围栏（前缀相同也拒）、备份内容正确、不可达时拒绝且无 `sessions`、切回后清单条数一致。
- [x] **`test/render.mjs` 扩容**：配置编辑器真点进去——`.credentials.yaml` 打开后**无编辑器**、点「显示」后出现并带正文、普通 `settings.json` 直接可编辑（1640 字符）。顺手记下一个**假 React 保真度缺口**（不比较依赖数组 → effect 每轮重跑），测试里改用"只渲染不跑 effect"。
- [x] **客户端 bundle 逐字节核实**：一次性实例的 `plugins/??dsh-session-hub/client.js&rev=…` 返回 200，含新代码（153303 = 源文件 153231 + 72 字节 sourcemap trailer）；`cordis.patch.yml` 的 `environments` 经 `dsh hubcheck --dump-config` 确认组合进真实加载路径。

**剩余（需要你）**：

- [x] **测试不再读你的真实插件状态**：新增 `$DSH_SESSION_HUB_HOME`（默认 `$DSH_HOME/session-hub`），置顶 / hook spool / 记住的环境都从它推。**这条是被真事故逼出来的**：机器清单迁移之后 `environment.json` 里有了 `pro14uu`，于是 6 个测试全部开始在一条断隧道上失败——不是代码回归，是**测试依赖了你上次切到哪台机器**。改的时候又踩第二次：宿主的读取端搬走了、`hook.mjs` 没搬，hook 全被追加进一个没人读的 spool（`preview` 测试当场抓住）。
- [ ] **重启桌面应用**：宿主半边的新 op（`environment` / `config`）要重启才加载——DSH 不给已加载的宿主模块换世代。**客户端半边会随刷新自动生效**（bundle 是逐字节直接服务的），所以在重启前：环境条不显示、点「配置」会报 `unknown op`（`loadEnvironment` 的失败被吞掉，不会崩）。
- [ ] 重启后看一眼：面板顶部是否出现 `环境 · 本机 · ⇄ pro14` 的 chip；点 `⇄ pro14` 在 `pro14uu` 通的时候是否列出对面会话、不通时是否给横幅而不是空列表。
- [x] **机器清单只声明一次**：`dsh-remote-agent` 用 `ctx.provide("remoteHosts", ...)` 发布 `{alias, label, dshHome}`；session-hub 用 `ctx.get("remoteHosts")` 读进来合并成环境，自己的 `cordis.patch.yml` **不再声明 `environments`**（仍保留作为独立运行/覆盖路径，同名时本插件那条赢）。合并是纯函数 `mergeEnvironments()`，测试覆盖「另一个插件发布的机器会变成环境」「同名不重复且本地那条赢」「`local` 不可被冒充」「跨插件边界的 alias 照样过校验」。**两个插件同时装载的一次性 profile 里验过**：session-hub 那行**完全没有 config**，`--dump-config` 里 `environments` 一个字都没有，而 `environment list` 仍返回 `pro14uu`、`set pro14uu` 后 `active.dshHome` 正是发布者给的 `/home/zakl/.dsh`、`list` 依旧 `ok:false` 且无 `sessions`。
- [x] **远端「打开/新建会话」接上了**：`open` / `spawn` 现在按环境翻译——本机照旧；远端是 `ssh -t <alias> 'exec "$SHELL" -lic "cd <远端 cwd> && exec <命令>"'`（`$SHELL -lic` 不能省：`claude` 只在交互式 rc 的 PATH 里；`cd` 必须在对面，否则会拿远端路径在本机跑）。桌面深链与 cmux 聚焦**显式跳过**（都是「跑在这里的 app」），DSH 会话在远端**拒绝打开并说明原因**，`spawn` 也拒绝（否则会往本机工作区注册表里塞一个指向远端路径的 workspace）。客户端不再对远端环境走本机的 DSH 快捷路径，`open` 无命令可给时改为显示宿主给的原因而不是空的「已复制」。`test/remote.mjs` 把生成的字符串**交给真的 `sh`**、让假 `ssh` 报告收到的 argv（必须 3 个，第三个是一整条远端命令，含带空格的 cwd）。
- [x] **远端删除接上了，并且把一条会静默失效的护栏补上**：本机删除的三条护栏里，「还在跑就不许删」在远端**不可能生效**（liveness 来自本机进程表/cmux 记录），而删除照样会成功——卡片看起来空闲、日志没了、无人提醒。现在远端删除默认拒绝（`code: "liveness-unknown"`，指名机器），拿到明确确认（`force: true`）才放行；**`delete-many` 的守卫必须写在批量入口**，因为它的循环给每个 key 都传 `force`，逐会话检查永远走不到（把这条守卫删掉，测试立刻变红）。客户端弹窗在远端**先要求勾选**才让按钮可用。`test/remote.mjs` 真删远端文件：拒绝时无 `deleted` 字段、放行时 `target` 是远端路径、文件消失、**对面的 `session_index.jsonl` 也通过同一个 store 被摘干净**。
- [x] **远端 liveness 真的过去了**：`host.js` 把「跑一条命令」抽成第二个能力（`exec`），`scanAgentProcesses()` 与 `cwdOf()` 改成问**当前环境**——本机 `/bin/sh -c`、远端 `ssh sh -c`。`ps -eo pid=,etime=,args=` 在 macOS/Linux 输出同样字段（无平台分支），cwd 用 `/proc` 优先、`lsof` 回落。**实测**：在 `215` 上起一个叫 `codex` 并声明真实会话 id 的 shebang 进程 → 远端 list 报 `runningCount: 1` + 正确 pid；同一台机器上**别人的** codex 进程没被认领。删除判断随之精确：看见在跑 → `code: "running"`；没看见 → 仍是 `liveness-unknown`（远端更弱：只有报 id 或 cwd 对得上才匹配得到，「没看见」≠「没在跑」）。
- [x] **远端慢的三件事**（实测 冷 47.3s→5.3s，热 16.9s→2.0s）：ssh 连接复用（`ControlMaster`+`%C`+`ControlPersist`，1.34s→0.24s/次，放在 `ssh.js` 这个唯一入口）、一次扫描的 stat 只取一次（批量 `statMany` 之后不再逐卡问）、六个源并发取（`mapLimit` 保序，坏源降级为少一个源）。
- [x] **机器管理**：环境条与右栏都有「⚙ 机器」。候选来自 `~/.ssh/config`（解析别名+HostName/User/Port，**跳过通配符与取反**）、remote-agent 发布的、插件配置的、以及面板自己记的；每行标来源，可启用/停用/测试/编辑/忘记。状态文件升到 v2 且**仍读 v1**；`writeActiveId` 改成读-改-写，否则切机器会抹掉机器列表。关掉正在看的那台会送回本机。`hosts` op **唯一不设可达性护栏**——它是从连不上的机器里出来的路。
- [x] **补上 README 声称存在、实际不存在的静态检查**：`test/imports.mjs`，两个方向——「用了没导入」（就是当年 `codex.js` 那个被 try/catch 吞掉的 ReferenceError）与「导入了没用」。先剥注释和字面量再分析（否则每句 JSDoc 的 `@property {() => …} readTail` 都会被读成调用）。**它立刻抓出 39 个死导入**（index.js 10 个：`shq`/`homedir`/`UNTITLED`…；五个 adapter 仍整条导入已被搬走的 `node:zlib`/`node:fs` 助手）。写这个检查时自己踩了一次：模板字面量里的 `${shq(x)}` 被整段抹掉，于是它把**还在用的** `shq` 判成死导入并删掉——**另一个方向当场把它抓回来**，这正好证明两个方向都得留。
- [x] **移除 `dsh-remote-agent`（已完成）**：按「两边都用同一个 client 抽象」的方向重构后，它还剩三样只在那边的能力——远端 `dsh web` 的启动/端口转发/抓 token、**侧栏内置终端**里的 `ssh -t`、远端机器概览。远端 web 模式的价值已被 session-hub 直接读远端会话取代；侧栏终端那条是真实的 UX 缺口。计划：先把侧栏终端按 `host.invocation()` 的方式接上（它现在走 cmux/Terminal.app），再把机器清单迁进 session-hub（否则删掉后 `⇄ pro14` 会从环境条消失），最后卸载。


**已知边界（写下来免得当成已处理）**：

- `stat -c '%s|%y|%w'` 是 GNU 形式，远端按 Linux 假设（macOS 靠测试里的 shim）。
- 远端 liveness 天然更弱：本机是进程内注册表 / 进程表，远端只能是「ssh 过去 `printf $HOME` 有没有回话」。

**已补掉（原第一版留的洞）**：

- Codex 的线程名索引 / Gemini 的 `.project_root` 原先用 `node:fs` **同步**读——面板指向远端时会读本机，远端每一行 Codex 都会变成 `(untitled)`。现在走契约里的新钩子 `hydrate({ store, files })`：`build` 保持同步，预热通过**活动 store** 完成，幂等且带失效（Codex 按 mtime+size，Gemini 按 5 秒 TTL）。`deletePlan.after(store)` 也改成接收 store，所以远端删会话时清理的是**对面**的索引。
- **更严重的一条**：DSH 的 `frames` 存储（zstd 串联、不可按字节定位）原先由 `buildDsh` **自己**用 `node:fs` 整份读，而且它是 `async`——六个 adapter 里唯一违反「`build` 同步」的那个。远端后果是那条会话**静默消失**（读本机路径 → ENOENT → 从清单里没了），界面上等于「对面的 DSH 没有会话」。现在引擎读字节、adapter 只解码：`build` 的第三个参数对可前缀读的方言是**已解析事件**，对 `frames` 方言是**整份 Buffer**，`buildDsh` 回到同步。
- **这两条都是 `test/remote.mjs` 用「能区分真假」的 fixture 钉住的**：远端线程名 ≠ rollout 首条消息兜底标题、`.project_root` ≠ 目录名、DSH 那条 fixture 只存在于合成的远端 home 且是**两帧** zstd。**把 `frames` 分支临时删掉，测试立刻从 5 条会话变成 4 条**——本机 fixture 抓不到它，因为本机路径恰好是对的。本机 Gemini 10 条会话的 cwd 也复核过（目录名 `zakl-jvs`、解析出 `zakl_jvs`，确实读了 `.project_root`）。
- 顺手清掉 `claude.js` / `dsh.js` / `pi.js` 里重构后残留的**整条未使用的 `node:fs/promises` 导入**——它让 adapter 看起来可能碰文件系统，正是上面两条 bug 的温床。



---

## 仓库基建记录（非待办）

- 目录结构为 `plugins/<插件名>/`，每个插件自成一个包目录；**移动插件目录必须同时重新安装**，原因与步骤见根 [README](README.md)。
- Git 默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、插件 `package.json` 的 `license` 字段）
- 仓库为 public；提交身份 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/`、`plugins/*/node_modules/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
