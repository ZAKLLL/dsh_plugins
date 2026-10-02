# dsh_plugins

DeepSeek Harness（DSH）插件开发仓库。

## 插件列表

| 插件 | 说明 | 状态 |
|------|------|------|
| [`dsh-session-hub`](plugins/dsh-session-hub/README.md) | 把本机所有 coding-agent 会话（DSH、Claude Code、Codex、Gemini CLI、pi、opencode）汇总到一个面板：跨全部项目收集，可拖进当前对话作为历史续接、可一键用原 Agent 打开、可实时预览正在跑的 agent，也能按项目直接起一个新会话 | 开发中 |

## 目录结构

```
dsh_plugins/
├── plugins/
│   └── dsh-session-hub/   # 插件包目录（package.json 所在层，自成一个包）
├── .githooks/             # Git hooks（通过 core.hooksPath 生效）
├── .gitmessage            # 提交信息模板
├── TODO.md                # 仓库级待办
├── LICENSE                # MIT
└── .gitignore             # 忽略临时参考、运行期产物与依赖目录
```

**每个插件自成一个包目录**，层级为 `plugins/<插件名>/`，`package.json` 就在这一层。

这个层级不是审美问题，而是由 DSH 的安装模型决定的：

- 安装单位是**一个含 `package.json` 的包目录**，通过 `plugin_manager` 的 `install_bundle` 安装，`target` 是该目录的**绝对路径**；
- 安装后 profile 的 `package.json` 里留下一条 `link:<绝对路径>` 依赖；
- 因此**移动插件目录会让这条 link 失效**，表现为重启后插件加载失败。

> ⚠️ **挪动插件目录时必须同时重新安装**，不能只挪目录：先 `plugin_manager remove_bundle` 卸掉旧条目（同名 bundle 直接再装会报 `ambiguous-install`），再 `install_bundle` 到新路径，最后重启验证。
>
> 实测补充：改完 link 后**宿主半边会自行按新路径重新加载**（`plugin_manager list_plugins` 里 `fiberPhase: active`），但**客户端半边不会**——浏览器侧仍持有移动前的模块解析，而客户端 HMR 监视的是**已经不存在**的旧路径，所以 touch 新文件也唤不回来（表现为插槽注册整批消失，例如 `sidebar.footer.action` 里找不到本插件）。**刷新页面**即可重新拉取；重启则一定生效。

**暂不引入**根 `package.json` 与 pnpm workspace：插件目前无任何依赖，加 workspace 会给 profile 的安装路径引入额外变量；等第二个插件真的需要共享开发依赖时再加。

- `.ref/`、`.research/`：从 DSH 应用包提取的运行时包与插件开发文档副本，仅作 API 参考，**不入库**，过期可直接删除后重新提取。
- `.dsh-session-hub/`：Session Hub 插件在工作区落地的会话转录，**不入库**。

## 开发与提交

```bash
git add .
git commit          # 触发 .githooks/commit-msg 格式检查
git push
```

提交信息格式为 `类型: 简要描述`，类型：`feat` | `fix` | `docs` | `style` | `refactor` | `test` | `chore` | `env`。

插件自身的测试与用法见各插件的 README。

## 许可证

[MIT](LICENSE) © 2026 ZAKLLL
