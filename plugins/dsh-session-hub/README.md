# dsh-session-hub · Agents 会话管理

把**本机所有 coding agent 的会话**汇总到一个面板里——DSH、Claude Code、Codex、Gemini CLI、pi、opencode——跨全部项目收集，然后：

- **拖进输入框**：把那个会话的完整历史作为文件交给当前 agent，让它自己解析、接着推进。
- **「在此续接」**：把历史物化到当前工作区，并把引用写进当前草稿（等价、更省事的路径）。
- **「在 cmux 继续」/「在 DSH 打开」**：非 DSH 会话用 `cmux new-workspace` 按它自己的 resume 命令唤起；DSH 会话直接在 DSH 里打开。
- **按项目分组、可收起**；**运行中的会话有实时绿点**。

面向的场景是：**你同时用多个 agent、跨很多项目干活，会话散落在各家的私有目录里**。这个插件负责收集与归一，至于「这个历史该怎么读、怎么接」——交给 agent 自己判断。

---

## 架构：一个声明式 adapter 层

宿主半边**不按 agent 分支**。`index.js` 里没有任何 `card.agent === "..."`，也没有 `AGENT_LABELS` / `AGENT_EXECUTABLES` / `SPAWN_COMMANDS` 这类平行表——**所有针对某一个 agent 的知识都在 `sources/<agent>.js` 里**，由一个声明式接口约束。

```
sources/
├── adapter.js     # 契约本身：完整 typedef + defineAdapter() 加载时校验
├── dsh.js         # Zstandard 帧存储、进程内注册表存活、审批配对
├── claude.js      # ~/.claude/projects
├── codex.js       # rollout + session_index.jsonl（删除时要一起摘）
├── gemini.js      # $set 补丁流
├── pi.js          # JSONL，头和 DSH 近乎同构
└── opencode.js    # SQLite，自己实现 list/full/preview/remove
```

**接口是可执行的，不是注释**。`defineAdapter()` 在**模块加载时**校验必填项（`id` / `label` / `executables` / `root` / `resumeCommand`；`build` 与 `list` 必须二选一；`build` 必须有 `match`），所以「接口没接好」在加载时就报错，而不是等到第一次请求才静默少一半功能。

每个 adapter 自己声明方言差异：

| 声明 | 含义 | 谁在用 |
| --- | --- | --- |
| `build` / `match` / `prefix` | 走目录的源：怎么找、怎么增量读、怎么建卡片 | 5 家 |
| `list` / `full` / `preview` / `remove` | **不是「一堆文件」的源**自己答全套 | opencode |
| `storeKind` | `"jsonl"`（可按字节偏移增量读）/ `"frames"`（zstd 帧，只能整份解码）/ `null` | dsh 是 frames |
| `readPreview` | 把 store 尾部折成实时预览的 IN / OUT | 6 家 |
| `readStoreEvent` | 把 store 事件折成 token 总量与等待集合 | claude / codex / pi / dsh |
| `deletePlan` | 删什么、是否目录、删完还要做什么 | dsh 删整个目录；codex 还要摘索引 |
| `liveness` | 存活从哪来：`"registry"`（进程内注册表）还是 `"process"`（进程表） | dsh 是 registry |
| `clientOwned` | 打开会话由客户端负责，而不是拉起终端 | dsh |
| `spawnCommand` | 起新会话的命令；`null` = 本插件起不了 | dsh 是 null |

**加一个 agent = 新增一个 `sources/<agent>.js` 并在 `SOURCES` 里登记一行**，不需要改 `index.js` 的任何逻辑。

> 这次重构是分两步做的，因为「接口没接好」的错误很容易被静默吞掉：第一步抽出 `shared.js`（15 个方言无关助手，index.js 净减 176 行），第二步搬 6 个 adapter 并把 index.js 的去分支化做完（2694 → 1574 行）。第二步真的踩到了这个坑——`sources/codex.js` 用了 `readFileSync` 却没导入，而它的 `try/catch` 把 `ReferenceError` 吞了，表现只是「标题静默回落成 (untitled)」。为此加了一个**静态检查**：把每个模块用到的函数名与它的导入清单比对，专门抓这类遗漏。

---

## 它从哪里收集

| agent | 存在哪 | 格式 |
| --- | --- | --- |
| DSH | `~/.dsh/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd` | Zstandard（**多帧串联**）+ JSONL |
| Claude Code | `~/.claude/projects/<slug>/**.jsonl` | JSONL |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/**.jsonl` | JSONL（`$set` 补丁流） |
| **pi** | `~/.pi/agent/sessions/<slug>/<时间戳>_<id>.jsonl` | JSONL（头和 DSH 近乎同构） |
| **opencode** | `~/.local/share/opencode/opencode.db` | **SQLite**（`session` / `message` / `part` 三张表） |

六家的格式互不相同，解析器各自独立。实测本机 **367 个会话**（DSH 17 / Claude 35 / Codex 276 / Gemini 10 / pi 29 / opencode 0）。

### 临时工作区不算项目

有些工具会在**一次性的临时目录**里跑 agent。本机的 `avp-agent` 就是：它每次运行在 `~/blueai_tmp/avp-agent/cc_sessions/<uuid>/` 下起一个 Claude，于是 `~/.claude/projects` 里留下一批这样的会话记录。

这些**不是项目**：目录名是裸 UUID（表头就成了 `c995b594-d09c-43b3-b574-28e9a9df9da1` 这种东西），而且那个工作目录对「回到原 agent 继续」毫无意义。不处理的话，光这一个工具就给面板塞进 **17 个假项目**。

判定规则是**工作目录的 basename 是裸 UUID**——不是写死某个路径，所以别的工具做同样的事也覆盖得到。实测全库 414 个会话里 **41 个命中，其余一个都不中**，所以这条规则不牺牲任何真实项目。

被排除的数量**不静默丢弃**：每个源在 `list` 的 `sources` 里都会报告 `skipped`，测试也断言 `parsed + skipped === total`。实测 claude 源 `35/76, skipped=41`。

**opencode 是唯一一个不是「一堆文件」的源**：它整库存在一个 SQLite 里，所以那一项不走「遍历目录」的形状，而是自己实现 `list` / `full` / `preview` / `remove`，按 session id 查询、读取、删除（三张表的删除包在一个事务里）。读用 `node:sqlite`（运行时自带，**惰性 import**，所以机器上没有 opencode 或 Node 较老时这里就是空列表）。它也是唯一一个**自带 AI 标题**的源——标题直接来自 `session.title` 列。

### 标题从哪来

每个 agent 都有自己的自动命名，能抓的都抓了——**优先级从高到低**：

| agent | 标题来源 | 说明 |
| --- | --- | --- |
| DSH | `session/title` 事件的**最后一个** | 官方契约是「三源（`fallback`/`provider`/`user`）**最新者胜**」，所以取最后一条；我最初只取了第一条，那是错的 |
| Claude Code | `ai-title` 事件的**最后一个** | Claude 会随对话演进重新生成，取第一条会把早期猜测冻住 |
| Codex | **`~/.codex/session_index.jsonl` 的 `thread_name`** | Codex 把模型生成的线程名写在这个索引里，**不在 rollout 文件里**——205 条有名字，如「编写 SkillStudio 使用说明」 |
| Gemini CLI | 无 | 只有 `$set.summary`（原始模型响应），不是标题 |

拿不到时按序兜底：**首条真实人类消息 → 第一条助手回复 → `(untitled)`**。

两类需要特别处理：

- **注入内容被当成标题**。实测抓到 Codex 的 `<codex_internal_context>`、`<codex_delegation>`、`## Referenced chats`、`## Code review guidelines`、`# AGENTS.md instructions`；Claude 的 `<local-command-caveat>`、`<teammate-message>`、`## Context Usage`；以及 DSH 自己的 `Current runtime context`。通用规则是「以含 `-`/`_` 的尖括号标签开头」，所以用户粘 `<div>` 仍算他自己的话。
- **子 agent 会话没有人类回合**。DSH 会用 `origin: "subagent"` / `delegationDepth > 0` 标出来，它的「首条用户消息」其实是父级委派的 prompt（"You are researching…"），不该当标题——这类改用**第一条助手回复**（"I'll research the DSH plugin API…"）。

效果：`(untitled)` 从 **67 个降到 6 个**（共 378 个会话）。

### 各个格式里踩到的坑（都已处理）

- **DSH 的 zstd 是多帧串联的**。`zlib.zstdDecompressSync` 只解第一帧（212 字节），必须按魔数逐个定位帧边界并串联解码。魔数出现在压缩数据内部不会出错：在那里截断的切片解不开，会自动尝试下一个边界。
- **`FileHandle.read` 会短读**。不循环读满，前缀会比预期小一个数量级，标题和消息会凭空丢失。
- **前缀读取必须丢弃被截断的尾行**，否则一条长记录会让整行 JSON 解析失败。
- **Codex 的真实提问在 61KB 之后**。开头是 `session_meta` 与 `base_instructions`，所以读取要按需增长，而不是固定读一块。
- **agent 会把注入内容写成 user 消息**，而它们会被当成会话标题。实测抓到：Codex 的 `# AGENTS.md instructions`、`<environment_context>`、`<codex_internal_context>`、`<codex_delegation>`、`## Referenced chats`、`## Code review guidelines`；Claude 的 `<bizContext>`、`<local-command-caveat>`、`<teammate-message>`、`## Context Usage`。这些既不能当标题，也不该淹掉 transcript。通用规则是「以带 `-`/`_` 的尖括号标签开头」，因此用户粘贴 `<div>` 仍算他自己的话。
- **Gemini 的消息列表在文件末尾**（最后一条 `$set.messages`），但中间还夹着逐条追加的消息对象，前缀读取和完整读取要走不同的取法。
- **有些会话根本没有人类回合**（委派/自动化跑起来的）。标题退回**第一条助手回复**，比 `(untitled)` 有用得多——本机 `(untitled)` 从 67 个降到 7 个。

### 两条读取路径

- **列表**：读一个**按需增长的前缀**（128KB 起，最多 2MB），拿到「记录头 + 第一条真实人类消息」就停。所以 `messages` 在卡上是下界，卡会以 `partial: true` 标出来，UI 显示成 `12+ 条消息`。
- **transcript**：读**整个文件**再渲染。列表里看到的 `partial` 不影响它。

---

## 置顶

**项目**和**会话**都能置顶，而且**会话置顶是在它所在的项目内置顶**——只浮到该分组的最上面，不会跑到整个列表顶部。

| | 入口 | 表现 |
| --- | --- | --- |
| 会话 | 标题右侧的图钉格：**已置顶时常亮**（蓝色实心），未置顶时只在**行悬停**时出现（空心） | 在该分组内排到最前；分组排序不受影响 |
| 项目 | 表头悬停后出现在 🗑 左边的图钉按钮 | 整个分组排到最前；表头有一个常亮的图钉标记 |

图钉格是**它自己的开关**，没有再往悬停操作区塞第四个图标。项目置顶优先于分组大小排序；会话置顶优先于时间排序，**同一档内仍按时间倒序**（`Array.sort` 是稳定的）。

**状态存在插件自己的文件里**，不借用任何 agent 的存储：

```
~/.dsh/session-hub/state.json
{ "version": 1, "projects": ["<工作区完整路径>"], "sessions": ["<会话 key>"] }
```

理由：四家 agent 没有一个现成的「pinned」概念可以借用，而往别人的存储里塞自己的偏好是越界。写文件走**临时文件 + rename**，中断不会丢光全部置顶。

**删除会顺手清理置顶**：会话被删后它的 pin 也会摘掉（批量删除只写一次文件，不是每个会话写一次），所以状态文件不会长出指向空气的条目。

---

## 在项目里新建会话

项目表头的 **＋** 打开一个选择器：**DSH / Claude Code / Codex / Gemini CLI / pi / opencode**，选哪个就在**那个项目目录**里把那个 agent 跑起来。

两条启动路径，因为归属不同：

| Agent | 怎么启动 | 为什么这样 |
| --- | --- | --- |
| **DSH** | 客户端走 DSH 自己的工作区注册表：按路径找已有工作区（没有才 `workspaces.create({ path })`），然后 `uiWorkspace.openWorkspace(workspaceId)` | DSH 会话属于工作区注册表，不属于某个 shell。`openWorkspace` 是 DSH 原生的「新会话」语义——**它自己会复用该工作区里已有的空白会话，或新建一个**——所以这里不用自己拼 |
| Claude / Codex / Gemini / pi / opencode | 宿主在**该目录**下用 `cmux new-workspace --cwd … --command <agent>` 起一个 | 这些 agent 就是命令行程序；cmux 不可用时退 Terminal.app，再不行把命令复制到剪贴板 |

**为什么 DSH 不走同一条路**：它没有命令行入口，会话是由工作区创建的。把两者混成一个「spawn」概念会在任一侧失真——所以 `spawn` 这个宿主操作**明确拒绝 DSH**，由客户端自己处理。

**＋ 只在「按项目」分组时出现**：按 agent 分组时没有「项目」可谈，那个控件就不渲染（渲染测试里断言了项目表头恰好三个控件）。

---

## 删除会话

行末的 🗑 会打开一个**确认弹窗**（显示标题、agent、即将删除的确切路径），确认后才动手。**项目表头悬停时也有一个 🗑**，一次删掉该项目下的全部会话——跨所有 agent。删除的是**原始 agent 自己的存储**：

| agent | 删除目标 |
| --- | --- |
| DSH | `~/.dsh/sessions/<slug>/<sessionId>/` —— **整个目录**（含 `session.v4.jsonl.zstd` 与 `session.lock`） |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` |
| Codex | `~/.codex/sessions/…/rollout-*.jsonl`，**外加从 `session_index.jsonl` 摘掉它的 `thread_name` 条目**（否则会留下一个指向已删会话的名字） |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/*.jsonl` |
| pi | `~/.pi/agent/sessions/<slug>/<时间戳>_<id>.jsonl` |
| opencode | **不是文件**：`delete from part/message/session where session_id = ?`，三句包在一个事务里 |

### 整项目删除

- 弹窗列出**项目路径、会话总数、涉及的 agent**。
- **正在运行的会话默认跳过**，不阻断整批——批量删除应该删掉能删的、然后如实报告剩下的。弹窗会说明跳过了几个，并给一个「同时删除这 N 个运行中的会话」勾选项。
- 结果显示为「已删除 N 个，跳过 M 个」。
- 重复提交同一批是安全的：已删掉的 key 报为 **skipped，不是错误**。

> **一条真实的数据缺陷，顺手修了**：分组原本按项目**目录名**（`cwd` 的最后一段）做键。这台机器上有**三个不同目录都叫 `new-chat`**，会被合并成一组——按显示名删就会跨三个项目误删。现在分组键是**完整工作区路径**，显示名只用于展示，完整路径放在表头 tooltip 上。

### 三条护栏

删除不可逆、且落在工作区之外，所以宿主侧有三道检查（`test/delete.mjs` 逐条验证）：

1. **key 必须能解析成本插件真正列出来过的会话**；
2. **目标路径必须在该 agent 自己的存储根之内**——`~/.claude/history.jsonl` 这种同目录下但不在 `projects/` 里的文件会被拒绝；
3. **进程还活着的会话拒绝删除**，除非调用方显式传 `force`。单条删除时 UI 把按钮变成红色的「仍然删除」；批量删除时改成勾选框。

批量接口还多一层：**单次最多 2000 个 key**，防止一个失控的请求走遍磁盘。批量删除**只删调用方发来的那些 key**——也就是你**看到的那一批**。所以开着 agent 筛选或搜索时，「整组删除」删的是筛选后的那一组，而不是筛选前。

Codex 的索引是**先写临时文件再 rename** 重写的，写到一半被打断不会把索引截断。

**刻意没做的事**：cmux 的 hook 记录不动。它按 session id 索引，只是给卡片做装饰；卡片的文件没了，残留记录就是惰性的。而那个文件 cmux 自己也在写，去改它才真的有风险。

> 删除 DSH 会话时如果 DSH 正开着它，界面可能报错——这是删掉别人脚下文件的本性。运行中的会被护栏挡住，但「已关闭却仍挂在界面里」的会话仍需你自行刷新。

---

## 实时运行状态

**主来源是进程表，不是 cmux。**

| 来源 | 覆盖 | 判据 | 需要配合吗 |
| --- | --- | --- | --- |
| **进程表** | Claude / Codex / Gemini / pi / opencode | `ps -axo pid=,command=` 里那个进程是否真的在跑 | **不需要**——直接开在终端里的也看得见 |
| DSH `ctx.agents` | DSH 会话 | 进程内 agent 注册表的 `status === "running"`，精确 | 不需要 |
| cmux hook 记录 | cmux 启动的那些 | 记录里的 **PID 是否存活** | 只在 cmux 里跑的才有 |

### 进程表怎么映射到会话

1. **命令行里带会话 id** → 直接对上：Claude / Gemini 是 `--resume <id>`，Codex 是 `resume <id>` 子命令，pi 是 `--session <id>`，opencode 是 `--session <id>`。
2. **新开的、命令行里没有 id** → 用 `lsof -a -p <pid> -d cwd -Fn` 取它的工作目录，配上**该目录下最新的那个会话**——对刚启动的 agent 来说，那正是它自己建的那个。

匹配的是**可执行名和第一个参数**，而且用**分隔符界定**（`(?:^|[-_.])pi(?:$|[-_.])`）而不是子串包含——否则 `apiserver` 会被当成 `pi`，`xcode` 会被当成 `codex`。只看第一个参数是为了让扫描进程自己（一个跑 `ps` 的 `node`）以及**任何后面才提到 agent 名字的参数**都不被误判。

**两个踩到的坑**：

- **只匹配可执行名不够。** macOS 把 shebang 脚本报成 `/bin/sh /path/to/pi-selftest`——可执行名是 `sh`，脚本路径在参数里。cmux 那种 wrapper 同理（`node /path/to/claude-wrapper`）。所以第一个参数也要看。这是我把「直接跑 `/opt/homebrew/bin/pi` 能认出来」误当成「所有启动方式都能认出来」时留下的洞。
- **`lsof` 报的是规范路径。** macOS 上 `/tmp` 是 `/private/tmp`、`/var` 是 `/private/var`，而会话记录里存的可能是未解析的那个。直接比字符串永远不相等。现在两边都用 `realpath` 解析后再比（带缓存，只在直接匹配失败时才走这条路）。

> 一开始我**只用 cmux** 判断存活，这是个错误的前提：你很多 agent 是直接开在终端里的，cmux 根本没有它们的记录。现在 cmux 降级成「补充来源」——它仍有用，因为它的记录同时带 session id 和 pid，能补上进程表推不出来的映射。

> **另一个踩到的坑**：cmux 的 `agent_lifecycle` 字段**不可信**。实测 11 条记录里 8 条写着 `"running"`，但对应 PID 全都早就死了——那是 `Stop` 钩子没触发留下的。**真正的判据始终是进程是否存在**（`process.kill(pid, 0)`，`EPERM` 也算活着），`agent_lifecycle` 只作旁证。

面板打开时每 3 秒轮询一个**只读实时状态**的轻量操作：不重扫目录、不重新解析，只在已经解析好的卡片上重算存活状态。可以点「只看运行中」过滤。

**实测**：你新开的那个 `claude --resume 7d5d2d45-…`（cmux 里没有它的任何记录）现在被进程表识别为 `source: "process"`，并正确挂到了它的会话上。

---

## 实时预览

右侧栏那个 tab 有**两个模式**：**列表**（会话清单）和**实时**（正在跑的 agent）。

实时模式是**一格格方块**——每个运行中的 agent 一格，**每格都带那条会话的标题**（没有标题的网格只说明「有东西在跑」，说不清在跑什么）——**点任意一格展开它的详情**。宽度用 `repeat(auto-fill, minmax(152px, 1fr))`，所以在窄栏里是两列、宽处自动变多，不是写死的尺寸：

```
● 实时 · 3 个运行中                            点方块看详情  [↻]
┌───────────────────┐ ┌───────────────────┐
│ ● Claude Code  2m │ │ ● Codex   刚刚 ⚠  │
│ 我想做一个插件，在 │ │ 编写 SkillStudio  │
│ 你这里一次性管理… │ │ 使用说明           │
│ work_tree_dev     │ │ gagent             │
└───────────────────┘ └───────────────────┘

┌────────────────────────────────────────────────────────┐
│ ● Codex  gagent              [↓] [↗] [✕]              │
│ 编写 SkillStudio 使用说明                                │
│ 目录       /Users/zakl/projects/gagent                  │
│ 运行时长   2m · 3:39:35 PM                              │
│ Token 用量 输入 18.0k · 输出 1.2k · 缓存 26.7k · 合计 45.9k │
│ 等待中     等确认 · bash                                 │
│ IN        设计 Hook 主动事件 API                         │
│ OUT       方案已先冻结并落盘，暂不继续实现…               │
│ 从它自己的会话记录读取                                    │
└────────────────────────────────────────────────────────┘
```

方块用来扫「有什么在跑」，详情面板用来回答需要空间的问题。详情里的每个动作与清单里的一行**完全一致**：**在此续接**、**用原 agent 继续**、以及**拖进输入框**——两个模式共用同一套动作函数和同一套拖拽载荷。

### 详情里的每个数字从哪来

| 字段 | 来源 | 精确度 |
| --- | --- | --- |
| **目录** | 会话记录里的 `cwd` | 事实 |
| **运行时长** | 进程表的 `etime` 列（`ps -axo pid=,etime=,command=`） | 事实 |
| **Token 用量** | 见下表 | 事实（累加） |
| **等待中** | 见下下表 | DSH 是事实，其余是推断 |

**Token 用量按 agent 各自的方言累加**——没有一种是猜的：

| agent | 来源 | 形态 |
| --- | --- | --- |
| Claude Code | 每条 assistant 消息的 `message.usage` | 逐条**累加** |
| Codex | `event_msg` / `token_count` 的 `info.total_token_usage` | **本身就是累计值**，取最新一条 |
| pi | 每条 assistant 消息的 `message.usage` | 逐条**累加** |
| **DSH** | **没有** | DSH 的会话事件里**没有 token 事件**，只有 `tokenMeter.measure(session)`，而那需要活的 `Session` 对象——本插件的扫描器只有文件。所以 DSH 显示「无」而不是编一个数 |

**「等待中」区分事实与推断**：

| agent | 信号 | 性质 |
| --- | --- | --- |
| **DSH** | 会话里的 `approval/asked` 与 `approval/decided` **按 `data.id` 配对**；问了没答 = 真的在等确认 | **事实**，还能报出在等哪个工具 |
| Claude Code | 有 `tool_use` 没有配对的 `tool_result` | **推断**：可能在跑，也可能在等确认，所以只写「工具进行中」 |
| Codex | 有 `function_call` 没有配对的 `function_call_output` | 同上 |

### 只显示回答，不显示思考

预览的 OUT（以及转录、标题回落）走同一个取文本的规则：**只取可见正文，跳过模型的内部推理块**。

这件事对 DSH 尤其重要——它的 `reasoning` 块**也带 `text` 字段**：

```json
{"type": "reasoning", "text": "The user wants a plugin to manage..."}
```

所以「凡是带 text 的块就当正文」会把模型的自言自语当成它的回答。实测本机 DSH 日志里 **reasoning 905 块 vs text 386 块**——推理比回答多两倍多，于是每一处预览、每一份转录、每一次标题回落显示的都是思考过程。

现在按块类型显式排除（`reasoning` / `thinking` / `redacted_thinking` / `analysis` / `thought`），**没有 `type` 的块仍然算正文**，所以更简单的形状不受影响。Claude 和 pi 把这类块叫 `thinking`、正文放在 `thinking` 字段里，本来就被跳过了；现在把规则写明白，而不是靠巧合。

实测效果：DSH 转录从 **1,351,906 → 275,216 字符（降 80%）**；Claude 一字未变（403,145）。

### 两个输入 / 输出源，后者优先

| 来源 | 怎么来 | 需要 agent 配合吗 |
| --- | --- | --- |
| **从会话记录推导** | 读每个运行中会话**自己存储的尾部**（DSH 的 zstd 按帧边界切、其余直接切 JSONL），取最后一条人类输入和最后一条助手输出 | **不需要**，开箱即用 |
| **hook 上报** | agent 往 `~/.dsh/session-hub/hooks.jsonl` **追加一行 JSON** | 需要，但只是一行 |

每张卡底部会写明这条读数来自哪个来源，不猜、不混。

### 性能：增量读，不是每次重读

实时视图每 2 秒轮询一次，所以**不能**每次都重读整个转录。JSONL 是只追加的，所以扫描器**记住字节偏移**，每次只解析新增的那一段；累加器（token 总数、待审批集合）跨轮次保留，因此**写到一半的那一行会等它自己写完整**再解析。文件变小说明被轮转或替换了，读取器重置。

**DSH 是例外**：它的存储是一串 zstd 帧、不是纯 JSONL，字节偏移在那里不是行边界。但 DSH 的文件也是最小的那些，所以整份解码、按 `mtime + size` 缓存即可。

> 这里的第一次实现踩了一个坑：`decodeZstdFrames` 返回 **Buffer 而不是字符串**（其他调用点都跟着 `.toString("utf8")`），我漏了，于是 `parseJsonl` 对 Buffer 调 `.split` 抛错——而**被一个过宽的 `catch` 静默吞掉**。测试断言「未答复的审批必须被报出来」时才发现。现在那个 catch 只吞真正的解码错误，其余一律抛出。

---

## 用原 agent 打开：顺序由 adapter 声明

**切换顺序是 adapter 的，传输方式是宿主的。** adapter 声明一个**有序计划**，宿主逐步执行：

```js
// codex 声明「先试桌面端深链，不行再走终端」
openPlan: (card) => [
  { kind: "app", url: `codex://threads/${card.sessionId}`, label: "Codex" },
  { kind: "terminal" },
],
```

**为什么这么分**：只有 adapter 知道自己的 agent 听得懂什么（有没有桌面端、深链长什么样）；而「把 URL 交给系统」「聚焦一个已经开着的终端」「新开一个」这些传输方式对每个方言都一样，属于宿主。

没声明 `openPlan` 的方言默认 `[{ kind: "terminal" }]`——所以 claude / pi / gemini / opencode 什么都不用写。

**一条硬性不变量**：计划必须以 `terminal` 步收尾。否则在没装那个桌面端的机器上，会话就**完全打不开**了。测试守着这条。

终端步内部（宿主）依次是：

1. **已在 cmux 里运行的会话 → 聚焦它那个 workspace**（`cmux select-workspace`），而不是再 resume 一份
2. **在 cmux 里新开 workspace 跑 resume 命令**
3. cmux 没在运行 → **按 bundle id 启动它，然后轮询它的 socket**，就绪后再试一次
4. 都不行 → Terminal.app

> 第 3 步的两个细节都不是随手写的。**按 bundle id**（`com.cmuxterm.app`）而不是 `open -a cmux`，因为后者解析的是「应用文件」，比系统认的身份弱。**轮询 socket** 而不是固定 `sleep`：一个 app 启动要多久不是该猜的东西，而 socket 恰好就是下一条命令需要的东西——它是「启动了」和「能用了」的区别。``waitForCmuxSocket`` 看的是 cmux 自己报的两个路径：`~/.local/state/cmux/cmux.sock` 与 `/tmp/cmux.sock`。

> 第 4 步是补上的。cmux 的整套命令只有**裸的 `cmux <path>` 那种形式**会「launches cmux if needed」，`new-workspace` 需要它**已经在跑**（帮助原文：Create a new workspace in the caller's window）。所以 cmux 关着的时候，每一次「打开」都静默落到了 Terminal.app——看起来就像「没有优先用 cmux」。

**刻意不跑 `codex app`**：那个子命令在桌面端缺失时会拉起安装器，点一下「打开」就下载东西不是好体验。深链要么被处理、要么静默失败。

---

## 阅读一条会话

点行标题打开只读阅读器。它不是把消息平铺出来，而是**按 turn 分组**：

```
● 你            第一个请求                                    2026-10-02 10:00
  ▸ 2 条中间过程                       ← 折叠着
● Claude Code   第一个最终回答                                2026-10-02 10:02

▸ 上下文在此被压缩 · 10:30 · 折叠了 2,735 tokens   ← 折叠着，展开看摘要

● 你            第二个请求                                    2026-10-02 11:00
● Claude Code   第二个最终回答                                2026-10-02 11:01
```

**一个 turn = 一条用户请求 + agent 对此做的全部**，**只有最后一条是回答**，前面的是中间过程（工具调用之间的叙述），默认折叠。一屏能宏观看，点开能看细节——平铺出来的是不可读的（实测某条会话 43 条消息里 216 个工具调用）。

### 正文按 markdown 渲染

转录是文章：代码块、列表、强调、表格是 agent 说话的**形状**，把星号原样显示出来是不可读的。

渲染器**产出 React 元素，不是 HTML 字符串**——转录里是这条会话引用过的任何东西，构建元素意味着**里面的内容永远变不成标记**。同理，链接只对 `http/https/mailto` 生成 `<a>`：`javascript:` 会退化成纯文本（它的文字仍然显示，只是不是链接）。这条有断言守着。

覆盖的是 agent 实际会写的东西：围栏代码、标题、有序/无序列表、引用、表格、分隔线、段落；**不认识的结构保持原文**，所以未知语法只是没样式，不会丢。

> 客户端能用的只有 `ctx / React / host / styles / console`（`Builtin.listBuiltins` 查证），Client Service 里也没有 markdown 能力，所以是自己写的，不是重复造轮子。

**时间戳写在轮次标题上**（`## User · 2026-10-02 15:04`），不另开平行列表：一轮和它的时刻因此不可能错位，而且**转录本身也带上了时间**——那份转录是要交给另一个 agent 读的。

### 压缩是可查的

**每次压缩都记为记录里的一道缝**，带三样东西：发生在什么时候、**折叠掉了多少 token**、以及**压缩后替换成了什么**（摘要正文），默认折叠。

摘要写在正文里而不是另列一处，这样它在对话中的**位置是准的**；也意味着交给另一个 agent 的转录会带上「这里压缩过、摘要是什么」。

| agent | 压缩数据 |
| --- | --- |
| **DSH** | `compaction/prune` 给出折叠的 token 数 → `compaction/summary` 给出摘要正文 |
| **Codex** | 单个 `compacted` 事件，`payload.message` 是摘要散文（不带 token 数） |

---

## 热重载与重启

客户端半边改完即时生效（插槽占用者会重新注册）。**宿主半边**有一个容易踩的坑：

`ctx.connection.fetch.register` 的 owner 是 **connection 服务自己的 ctx（root）**，不是本插件的 fiber——所以那条 `/api/session-hub` 路由**比插件活得久**，而且一直带着**第一次注册时那个闭包**。

早期版本因此踩了一个大的：我把被调度的 handler 存在模块作用域里，插件重载会重新求值模块、造出一个**全新的对象**，而那条老路由根本不会读它。结果是**第一代实现永远服务下去**，客户端已经更新了，宿主还在老代码上——表现就是一串 `unknown op: xxx`。

现在的做法有两层：

1. **注册包在本插件 ctx 的 `effect` 里**，并调用它返回的 disposer——重载时旧路由先被释放，新的一代再注册自己的。这是根治。
2. **handler 放在进程级全局槽**（`Symbol.for("dsh-session-hub/route-state")`），路由在**调用时**才去读。这是第二道防线，兜住「上一代留下的路由」。

> 但它**救不了已经冻结的进程**：被冻结那条路由的闭包已经不可达了。所以如果你撞见过 `unknown op`，需要**⌘Q 完全退出再打开**一次——关窗口不算，宿主是长驻进程（我实测过一次它连续跑了 1 天 21 小时）。
>
> 为了让这件事一眼可查，`unknown op` 的报错会**直接列出宿主支持哪些操作**：
>
> ```
> unknown op: preview — host answers: list, status, transcript, continue, open
> ```
>
> 看到这个就说明跑的是老宿主，重启即可。

---

## 让别的 agent 注册进来

hook 机制**写在本插件里**，任何能执行命令的 agent 追加一行就算注册：

```sh
node /path/to/dsh-session-hub/hook.mjs \
  --agent claude --session "$SESSION_ID" --phase working \
  --input "用户问了什么" --output "目前产出的内容"
```

也可以走 stdin：`echo '{"agent":"codex","sessionId":"…","phase":"working"}' | node hook.mjs`（flag 覆盖 stdin）。字段：`agent`、`sessionId` 必填，其余 `phase` / `input` / `output` / `cwd` / `title` / `at` 可选。**缺少 agent 或 session 的记录会被直接丢弃**，不会张冠李戴。

它**永远不会以非零码失败**——hook 跑在别的产品的一轮对话里，预览坏掉不能连累那个 agent。

### 为什么是文件而不是 HTTP 接口

`/api` 上的路由**在浏览器信任围栏之内**：它要求浏览器 cookie 或进程启动令牌。而一个 hook 是普通 shell 命令，手里两样都没有。所以用**只能追加的 spool 文件**——`O_APPEND` 单次写入，多个 hook 并发也只会整行交错，不会写半行。

### 接线示例

**Claude Code**（`~/.claude/settings.json`）。它的 hook 会把 `{ session_id, prompt, hook_event_name, … }` 从 stdin 交给命令，而 sink 认识这些字段名——所以**不用 `jq`，直接透传 stdin 就是完整记录**：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/dsh-session-hub/hook.mjs --agent claude --session \"$CLAUDE_CODE_SESSION_ID\" --phase working" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/dsh-session-hub/hook.mjs --agent claude --session \"$CLAUDE_CODE_SESSION_ID\" --phase done" }] }]
  }
}
```

> 会话 id 的环境变量名是 **`CLAUDE_CODE_SESSION_ID`**（我一开始写成了 `CLAUDE_SESSION_ID`，是从这台机器的 claude 二进制里核对出来的）。`UserPromptSubmit` 与 `Stop` 两个事件名也已核对。

**Codex**：用它的 `notify` 配置指向同一个 sink。

**任何自制 agent**：在开始一轮时和产出时各追加一行即可，本插件不需要知道你的实现。

> 注意：**不注册也能用**。预览的默认路径是从会话记录推导，所以装完插件就有内容；hook 只是让你能把更准的「当前输入 / 当前输出」推上来。

---

## 用原 agent 唤起会话

非 DSH 会话的按钮是**「在 cmux 继续」**，它执行：

```sh
cmux new-workspace --cwd <会话的 cwd> --command "<resume 命令>" --name "<agent> · <标题>" --focus true
```

resume 命令按 agent 各自的口径拼：

| agent | 命令 |
| --- | --- |
| Claude Code | `claude --resume <sessionId>` |
| Codex | `codex resume <sessionId>` |
| Gemini CLI | `gemini --resume <sessionId>` |

cmux CLI 的查找顺序：`CMUX_BUNDLED_CLI_PATH` → `PATH` 里的 `cmux` → `/Applications/cmux.app/Contents/Resources/bin/cmux`。找不到 cmux、或者 `new-workspace` 失败，就退回 Terminal.app 执行同一条命令；再不行就把命令复制到剪贴板。**无论走哪条路，实际执行的命令都会在按钮 tooltip 上显示**。

DSH 会话不走 cmux——它本来就在 DSH 里，客户端直接 `uiWorkspace.openSession()`。

> 注意：这里用的是**朴素的 resume 命令**，不会自动补上你当初的启动参数（比如 `--dangerously-skip-permissions`）。cmux 的记录里存有原始 `launch_arguments`，但自动加上权限绕过标志是个安全决定，所以刻意没做。

---

## 用法

**两个入口，同一份清单：**

| 入口 | 位置 | 适合 |
| --- | --- | --- |
| **右侧栏 Tab**「Agents 会话管理」 | 右侧栏 guide 页里选，或从 tab 条的 **+** 打开 | **拖拽**——栏就在对话旁边，不遮挡输入框 |
| 侧栏底部「Agents 会话管理」 | Settings 上方 | 全屏总览 |

右侧栏那个 tab 里有**两个模式**：**列表**（会话清单）和**实时**（正在跑的 agent）。

1. 打开任一个入口，面板内容一致：**按项目分组的紧凑清单**（点分组标题收起/展开）、按 agent 筛选、全字段搜索、**只看运行中**。
2. **项目表头显示该项目最近一次交互的时间**，取该项目下**所有会话 `updatedAt` 的最大值**——所以项目即使收起，也一眼看得出有多新。悬停能看到精确到秒的绝对时间。
3. **项目表头悬停时出现三个控件**：**＋ 新建会话**、📌 置顶该项目、🗑 删除该项目全部会话。
4. **打开时只有最上面那个项目是展开的，其余全部收起**——几十个项目一次性铺开会淹没一切。每个展开的分组默认只显示最新修改的 10 条顶层会话，底部一条「查看更多 · 剩余数」每次再放 10 条，全展开后变成「收起」。收起/展开的选择是**每个分组模式各记一次**，不会在你刚点开一个之后又被自动重置。
5. **子代理会话收在父会话下面，是一棵树**，不再平铺：

   ```
   ▾ 🗂 work_tree_dev                              1h    147
       ● 我想做一个插件，在你这里一                    3   2分钟
         ├ ● I'll research the DSH plugin API from …
         ├ ● I'll start by exploring the reference …
         └ ● I'll research this systematically. …
       ● 帮我分析一下cc 是怎么做的                     3   8分钟
         ├ ● Let me start exploring the codebase…
         └ ● Let me start by exploring the relevant…
   ```

   父行左侧的小箭头就是展开开关（带后代数量徽标）；**分页只对顶层行计数**，子会话不会把分页刷爆。
6. 每一行就是左侧栏那种形态：**展开箭头位（固定 14px，保持标题对齐）→ 16px 前导位（agent 配色圆点，运行中的会呼吸）→ 标题 → 右侧相对时间 → 悬停时时间让位给三个图标按钮**。
7. 行操作：
   - **拖进输入框**（↓ 图标）→ 历史成为附件，我就能读到。**在右侧栏里拖是最顺的**——不需要任何 pointer-events 技巧。

  > 拖拽载荷经过一次修正。输入框的 drop **只把 `text/plain` 当文本插入**（`dsh-client-ui-conversation` 里 `insertFromDrop` 读的就是它），而**附件层**会拦截任何带 `Files` 的拖拽转成附件 chip。原来 `text/plain` 放的是「agent · 标题 + 存储路径」，附件名是 `claude-<slug>.md`——**两种情况看起来都只是「一个文件名」**。现在 `text/plain` 放**转录本身**，附件名是 **`<agent> · <会话标题>.md`**。
  >
  > 还有一处时序问题：`dragstart` **不能 await**，所以转录必须在拖动开始前就取到。原来只在悬停时预取，**没取到就根本不会加 `File`**，于是只剩那条路径。现在悬停 / 按下 / 聚焦都会预取；万一仍未就绪，`text/plain` 会明说「history still loading」而不是丢一个路径出去。
   - **在此续接**（↓ 图标）→ 把 transcript 写成 `<当前工作区>/.dsh-session-hub/<agent>-<标题>-<短id>.md`，并把一段引用提示插进**当前草稿**（光标处，失败则替换草稿）。回车发送即可。
   - **用原 agent 继续**（↗ 图标）→ 见上一节；鼠标悬停能看到**确切会执行的命令**。
   - **删除**（🗑 图标）→ 删这一个会话；**项目表头悬停时也有 🗑**，一次删掉该项目的全部会话。都见下一节。

### 树是怎么来的

DSH 的会话头里有 `parentSession`、`origin: "subagent"`、`delegationDepth`，所以父子关系是**记录里的事实**，不是猜的。宿主在扫描后做一次连接（按 session id、限定同 agent），客户端在每个分组内建树。

两条刻意的降级：

- **父会话不在同一分组、或被筛选掉了**，子会话就**留在顶层**而不是被藏起来——树不能因为过滤而吞掉会话。
- **父会话不存在**（记录被删、被裁掉）同理，子会话升为顶层。

`test/smoke.mjs` 会断言：每个 `parentKey` 都必须指向清单里真实存在的卡，且**任何 `subagent` 会话都不允许没有可解析的父**——否则它会从树里静默消失。

### 视觉语言是照抄左侧栏的

行高 32px、圆角 `--dsw-radius-md`、悬停 `--dsw-alias-interactive-bg-hover`、标题 14px/20px、时间 10px 且**悬停时被行操作替换**、项目表头 34px 带文件夹图标——这些数值全部取自 `dsh-client-ui-workspace` 自己的样式表，不是估的。插件不 import 任何 Harness 客户端包，图标是自己画的 inline SVG。

> 右侧栏 Tab 是**会话作用域**的，框架直接把当前 composer 的 `inputActions` 交给它，所以「在此续接」在那边不需要任何桥。全屏遮罩在 root 作用域，才需要 `conversation.composer.dock` 上那个不渲染的桥来转发。

> 「在此续接」写入的目录是**当前会话自己的工作区**，由宿主按当前 sessionId 反查它的 `cwd` 得到——这样 agent 一定读得到。查不到才退回临时目录，此时提示里给的是绝对路径。

---

## 结构

```
dsh-session-hub/
├── package.json        # dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml    # 插入 session-hub 这一行
├── index.js            # 宿主半边：四个扫描器 + 统一模型 + 实时状态 + 预览 + transcript + 删除 + 置顶 + /api 路由
├── client.js           # 客户端半边：侧栏入口 / 全屏面板 / 右侧栏 tab（会话·实时）/ 输入框桥 / 删除弹窗
├── hook.mjs            # hook 汇聚入口：任何 agent 追加一行即可注册
├── locale/{en,zh}.json # 插件卡片显示文案
├── icon.svg
└── test/
    ├── render.mjs      # 渲染回归（真实 client.js + 极简 React）
    ├── reload.mjs      # 热重载替换宿主实现（必须独立进程）
    ├── smoke.mjs       # 宿主半边冒烟测试（读真实会话库）
    ├── delete.mjs      # 删除路径与护栏（自建 fixture，用完即清）
    ├── pins.mjs        # 置顶状态（备份并还原你真实的置顶文件）
    └── preview.mjs     # 实时预览、hook 汇聚、进程表发现（备份并还原真实的 spool）
```

### 两端怎么通信

typert 的 `@Remote` 需要整套代码生成流水线，第三方插件走不通；而官方的 `ctx.sessionProjections` 是 per-session 的投影机制，装不下「扫全盘文件系统」这种需求。

所以走 DSH 给插件留的正式传输层：

```js
// 宿主
ctx.connection.fetch.register({
  path: "/api/session-hub",
  methods: ["POST"],
  requestBody: "buffered",
  fetch: (request) => ...,
});
```

它挂在共享的 `/api` 通道上，**自动经过 Host/Origin 信任围栏与浏览器鉴权**（`/api` 前缀处理器先 `admit()` 再分发）。浏览器侧同源 `fetch` 即可，Cookie 自带。

所有操作走同一个精确路由，用 body 里的 `op` 分发：`list` / `transcript` / `continue` / `open`。

### 客户端挂载点

| 插槽 | id / key | 作用 |
| --- | --- | --- |
| `sidebar.footer.action` | `session-hub` | 侧栏底部入口按钮 |
| `shell.overlay` | `session-hub-panel` | 全屏面板 |
| `shell.overlay` | `session-hub-confirm` | 删除确认弹窗（放这里，右侧栏那种会裁切溢出的容器里塞不下弹窗） |
| `shell.overlay` | `session-hub-spawn` | 新建会话的 agent 选择器（同上原因） |
| `sidebar.right.pane.tab` | `dsh-session-hub` | **右侧栏 tab 的 body**——「会话 / 实时」两个模式（会话作用域，自带 `inputActions`） |
| `sidebar.right.pane.tab.title` | `dsh-session-hub` | 该 tab 的 chip 内容 |
| `conversation.composer.dock` | `session-hub-bridge` | 会话作用域、不渲染，只把当前 composer 的 `inputActions` 发布给全屏面板 |

右侧栏 tab 走的是**每个官方 tab 类型都走的公开两段式注册**：

```js
ctx.inject(["sidebarRightTabs"], (scoped) => {
  scoped.effect(() => scoped.sidebarRightTabs.register({
    id: "dsh-session-hub",        // type 身份，也是 body/chip 的 key
    kind: "dsh-session-hub",
    title: () => t("tab"),
    guide: [{ order: 30, title: () => t("tab"), description: () => t("guide"), icon: HubIcon }],
  }), "…");
  scoped.slots.inject("sidebar.right.pane.tab", () => scoped.slots.register({
    name: "sidebar.right.pane.tab", key: "dsh-session-hub", locale: NS,
  }, SidebarTab));
});
```

`guide` 数组就是让它在右侧栏 guide 页里出现的那一项。

**为什么全屏面板需要那座桥**：面板在 root 作用域，但「续接」必须写进**当前会话**的草稿，而 `inputActions` 只在会话作用域的插槽里拿得到。右侧栏 tab 本身就是会话作用域，所以直接拿得到——桥只为遮罩存在。

### 拖拽怎么落到输入框

卡片是原生 HTML5 `draggable`：

- `dragstart` 时把**已预取**的 transcript 装成 `File` 塞进 `dataTransfer.items`——所以指针一进入卡片就开始取历史，`dragstart` 里才能同步拿到内容。
- 同时把覆盖层的 `pointer-events` 置为 `none`（**命令式改样式，不触发重渲染**——拖拽过程中重渲染拖拽源会让某些浏览器取消拖拽），这样 `dragover` 才能穿透到下面输入框的附件区。
- 输入框侧接收的是标准文件投递，因此拿到的是普通附件。

### 已知边界

- 卡片上的「消息数」在前缀读取时是**下界**（列表改版后不再显示，transcript 仍是全量）。
- transcript 是**有损归一**：省略了 reasoning、工具结果与附件，工具调用只留一行标记。这是刻意的——续接需要的是对话主线，不是完整回放。
- 前缀上限 2MB。极长的会话在列表里可能拿不到标题，此时**退回第一条助手回复**作为标题（这类会话通常是委派/自动化跑起来的，本来就没有人类回合）；两条都没有才显示 `(untitled)`——本机 378 个会话里剩 7 个。
- 「运行中」以**进程是否存在**为准。进程表的映射在两种情况下是推断而不是事实：命令行没带会话 id 时按工作目录取最新的那个；以及 PID 复用理论上可能误判。
- Claude / Codex / Gemini 的实时状态来自**本机进程表**（`ps` + `lsof`），所以任何终端里跑的都能看见——但也意味着**只能看见本机的**，远程机器上的进程看不见。
- 唤起走 `cmux new-workspace`，**开发中未实机触发**（那会拉起 cmux 窗口）；CLI 解析、参数拼写与降级链已验证，实际唤起需要你点一次。
- 无配置文件：四个来源按固定约定自动发现，插件不导出 `Config`。

---

## 测试

```sh
node test/render.mjs   # 渲染回归：把真实 client.js 在 Node 里渲染一遍
node test/reload.mjs   # 热重载必须真的换掉宿主实现（两代模块实例共用 globalThis）
node test/smoke.mjs    # 采集 / 标题 / transcript / 实时状态 / 树的完整性
node test/delete.mjs   # 删除路径、批量删除与三条护栏
node test/pins.mjs     # 置顶的读写、两种置顶互不干扰、删除时清理
node test/preview.mjs  # 实时预览的推导、hook 覆盖、sink 的输入校验，以及「终端里直接起的 agent」能否被进程表发现
```

### 为什么有 reload 测试

宿主的路由是用 `ctx.connection.fetch.register` 注册的，而它的 owner 是 **connection 服务自己的 ctx（root）**，不是本插件的 fiber。所以**路由比插件活得久**，并且一直带着**第一次注册时那个闭包**。

如果被调度的 handler 存在模块作用域里，插件重载会重新求值模块、造出一个**全新的对象**，而那条老路由根本不会去读它——于是**第一代实现会永远服务下去**，客户端已经更新了，宿主还在老代码上，表现就是一连串 `unknown op: xxx`。

修法是把可变的那一半放进**进程级全局槽**（`Symbol.for("dsh-session-hub/route-state")`），路由在**调用时**才去读它。`test/reload.mjs` 用两次**带查询串的 import** 造出两个真正的模块实例（共用同一个 `globalThis`），断言第一代的路由对象最终会调度到第二代的 handler——并且 `pin` / `preview` / `status` / `delete-many` 都能通过那条老路由到达。

> 这个坑真实发生过：插件装好后我改了十几轮宿主代码，而**运行中的宿主一直停在第一代**。客户端每轮都热重载（插槽占用者是活跃的），所以我误以为两端都生效了。客户端侧我一直在验证，宿主侧我只验证了「测试通过」而不是「进程生效」——这是方法上的漏洞，现在由这个测试补上。

### 为什么有 render 测试

这个仓库没有浏览器可用，而 **`node --check` 看不见渲染期错误**。

有一次我把 `const pinnedSessions` 写在 `groups` 的 `useMemo` **之后**，而依赖数组 `[visible, group, pinnedSessions, pinnedProjects]` 就在那个 useMemo 上——依赖数组是**立即求值**的，于是 `HubBody` 每次渲染都抛 `ReferenceError: Cannot access 'pinnedSessions' before initialization`。整个右侧栏 tab 就此变成死的。

而它在外部只留下**一个信号**：插槽占用者的 `active: false`。读完 `dsh-client-ui-slots` 才知道 `active` 的真义是「未被 abdicate」——而 `abdicated` 的定义是「**渲染崩溃后被退役的 entry**，其注册留在账本上但不再参与投影」。换句话说，`active: false` 就是**这个组件崩了**。

所以 `test/render.mjs` 干了三件事：

1. 用 `window.__ModuleLoader__` 的**真实握手机制**加载 `client.js`；
2. 用桩 Cordis 上下文跑 `apply()`，抓出注册的六个组件（并按 `name#key` 区分——右侧栏 body 和它的 chip 用的是同一个 key）；
3. 用一个极简 React（函数组件即普通函数、函数元素立即求值、hook 单元按组件身份持久化）**真的渲染一遍**，并把 `fetch` 转发到真实的宿主路由，让数据链路也是真的。

实测渲染出 **56 个分组、167 行、2 个展开箭头、167 个置顶开关**——167 行正好是「每组前 10 条 + 子代理行」的分页结果，2 个箭头正好是两个有子代理的会话。

> **渲染测试的假 React 会拒绝非法元素类型**（既不是字符串标签名、也不是组件）。这是补上去的：一次批量替换把 `h("button", {…}, icon)` 改成了 `h({…}, icon)`——元素类型成了对象，真实 React 直接抛错。
>
> 而**真实环境的表现是插槽占用者变成 `active: false`**（abdicated = 渲染时崩溃），界面上就是「这个组件打不开」。用 `cordis_inspect_query` 查 `sidebar.right.pane.tab` 时 `"registrant": "dsh-session-hub", "active": false` 一眼可见。**这是排查「组件打不开」的第一手段**：注册还在、但 `active` 为 false，就是渲染崩了，而不是没注册。
>
> 原来的假 React 不校验类型，于是**测试全绿而线上崩**——这个缺口是本次补上的。

它同时也验证了：`apply()` 恰好注册七个组件（多一个少一个都失败）、桥与确认弹窗与新建会话选择器在无状态时确实渲染 `null`、以及**没有一行标题渲染出 `undefined`**。它还**渲染实时模式**（用一个合成的 preview 响应，不依赖这台机器当下在跑什么），断言那张卡带着**两个动作**、**可拖拽**、并且 IN / OUT / 来源三者都渲染出来；**每个项目表头恰好三个控件**（新建会话 / 置顶 / 删除）且都带 tooltip、**每个项目表头都显示了真实的最近交互时间**、以及**打开时恰好一个项目是展开的**（其余收起的那个默认）。

`smoke` 按 Cordis 的真实调用方式驱动宿主半边（`apply(ctx)` → 抓取注册的路由 → 发真实 `Request`），断言：清单非空且按时间倒序、每张卡字段完整（含 `running`/`subagent` 布尔与 `live` 证据）、每个有会话的 agent 都能产出含 `## User` 的 transcript、**`status` 轮询覆盖清单里的每一个 key 且与 `runningCount` 一致**、**任何被判为「运行中」的卡都必须给出证据来源**、`continue` 必须落在当前工作区内、未知 key/op 返回结构化错误、重复 `apply()` 不因路由已注册而抛出。

`delete` **不碰你任何真实会话**：它在真实存储目录里用唯一命名的 fixture 自建临时会话（Claude / Codex / DSH 各一个，外加一批用于批量删除的 3 个 Claude + 1 个 DSH；DSH 那几个靠一个假 agent 注册表标记成「运行中」），跑完断言后在 `finally` 里全部删除并把 `session_index.jsonl` 按备份逐字节还原。它验证的是：

- 会话确实从原存储消失，重新扫描后不会复活；
- Codex 索引条目一并摘掉；
- 越界路径被拒（并确认那个文件仍在）；
- 运行中无 `force` 被拒、有 `force` 成功；
- **批量删除：普通会话全部删掉、运行中的被跳过而不阻断整批、加 `force` 后补上、已删的 key 报为 skipped 而非错误、空批次被拒**。

---

## 安装 / 卸载

已安装在 `desktop` profile（`link:` 到本目录，改代码即时生效）。

- 卸载：`plugin_manager` → `remove_bundle`，目标 `dsh-session-hub`
- 重装：`plugin_manager` → `install_bundle`，目标为本目录绝对路径

## 许可

Apache-2.0
