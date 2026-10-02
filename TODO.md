# TODO

> 仓库级待办。约定：每项写清「背景 / 决定 / 步骤 / 验收」，完成后从本文件删除并进提交历史。

---

## 1. 仓库结构调整为多插件布局（已决定，**暂缓执行**）

**背景**：本仓库后续不只 `dsh-session-hub` 一个插件。当前插件目录直接放在仓库根，仓库级文件（README / LICENSE / .githooks / .gitignore）与插件目录混在一起，插件变多后层级会越来越乱。

**DSH 的安装模型（决定了怎么改才安全）**：

- 安装单位是**一个含 `package.json` 的包目录**，通过 `plugin_manager` 的 `install_bundle`（`target` = 包目录绝对路径）安装；
- 安装后 profile 的 `package.json` 里留下一条 `link:<绝对路径>` 依赖（本机为 `$DSH_PROFILE_DIR/package.json`，profile 名见 `$DSH_PROFILE`）；
- 因此**移动插件目录会让这条 link 失效**，必须重新安装，`install_bundle` 之外的步骤（手写 profile、在 profile 目录跑 pnpm）官方都不建议。

**决定**：采用 `plugins/<插件名>/`。

```
dsh_plugins/
├── README.md            # 仓库总览 + 插件索引
├── TODO.md
├── LICENSE
├── .githooks/ .gitmessage .gitattributes .gitignore
└── plugins/
    └── dsh-session-hub/ # 自成一个包目录（package.json 所在层）
```

同时决定：**暂不引入** pnpm workspace / 根 `package.json`。当前插件无任何依赖，加 workspace 会给 profile 的安装路径引入额外变量；等第二个插件真的需要共享开发依赖时再加。

**暂缓原因**：`dsh-session-hub` 代码正在开发中（工作区有未提交改动），等这轮功能告一段落再动，避免边改边搬家。

**执行步骤**：

- [ ] `git mv dsh-session-hub plugins/dsh-session-hub`（保留历史）
- [ ] 更新根 `README.md`：目录结构图、插件索引链接 `plugins/dsh-session-hub/README.md`
- [ ] `.gitignore` 补 `plugins/*/node_modules/`；确认 `.dsh-session-hub/` 规则不受影响
- [ ] 移动前先提交/暂存进行中的开发改动，保证工作区干净
- [ ] 重新安装插件：`plugin_manager` → `install_bundle`，`target` = 新的 `plugins/dsh-session-hub` 绝对路径
- [ ] 确认 profile 里的旧 `link:` 已被替换为新路径，无残留
- [ ] 重启后验证：插件在 Harness Web UI 中照常加载、面板可用
- [ ] 提交：`refactor: 仓库结构调整为 plugins/<插件名>`

**验收**：重启 DSH 后 Session Hub 面板正常；profile 的 `package.json` 只指向新路径；根目录不再有插件目录。

---

## 2. profile link 失效风险（与第 1 项绑定）

**问题**：profile 记录的是绝对路径 link，目录一挪就断，且**重启后才会暴露**（表现为插件加载失败）。

**处理方式（择一）**：

- **A（推荐）**：用 `plugin_manager` 的 `install_bundle` 重新安装新路径，由它负责替换 link；旧的 link 一并移除。
- **B（权宜）**：手改 `$DSH_PROFILE_DIR/package.json` 的 link 路径并在 profile 目录执行 `pnpm install`。官方明确不建议手写 profile，仅在 A 不可用时使用，且改完应尽快回归 A。

**注意**：这件事必须和第 1 项的目录移动**同一次完成**，不要先挪目录、隔天再修 link。

---

## 3. 未提交的开发中改动（别忘）

工作区当前有以下未提交改动（Session Hub 新功能开发中，含 `PlusIcon` / `SPAWNABLE` 相关逻辑）：

- `dsh-session-hub/client.js`
- `dsh-session-hub/index.js`
- `dsh-session-hub/README.md`
- `dsh-session-hub/test/render.mjs`
- `dsh-session-hub/test/smoke.mjs`

提醒：这批改动只在本地，**未推送**。功能完成后按 `feat:` 提交；做第 1 项重构前先把它们落地或暂存。

---

## 4. 已完成的仓库基建（记录，非待办）

- Git 初始化，默认分支 `main`，SSH remote `git@github.com:ZAKLLL/dsh_plugins.git`
- 沿用 zakl_jvs 约定：`core.hooksPath=.githooks`（`commit-msg` 格式校验）、`commit.template=.gitmessage`、`.gitattributes` 强制 LF
- 开源协议 MIT（`LICENSE`、`package.json` 的 `license` 字段）
- 仓库已从 private 切为 public；提交身份改为 `ZAKLLL <41239425+ZAKLLL@users.noreply.github.com>`，历史已重写
- **敏感信息审计结论：干净**。无凭证/密钥、无绝对路径、无邮箱、无内网地址；`.ref/`、`.research/`、`.dsh-session-hub/` 均已忽略。**后续提交请保持这一状态**（不要提交 token、真实会话转录、本机绝对路径）
