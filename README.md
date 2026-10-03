# dsh_plugins

DeepSeek Harness（DSH）插件开发仓库。

## 插件列表

| 插件 | 说明 | 状态 |
|------|------|------|
| [`dsh-session-hub`](plugins/dsh-session-hub/README.md) | 把**所有** coding-agent 会话（DSH、Claude Code、Codex、Gemini CLI、pi、opencode）汇总到一个面板：跨全部项目收集，可拖进当前对话作为历史续接、可一键用原 Agent 打开、可实时预览正在跑的 agent，也能按项目直接起一个新会话。**可一键切到另一台机器**——走 SSH，同一套 adapter 读对面存储；并能就地读改每个 agent 的配置文件 | 开发中 |
| [`dsh-remote-agent`](plugins/dsh-remote-agent/README.md) | 把**别的机器上**的 coding agent 拉到当前窗口：有 web 界面的（DSH）经 SSH 转发 + 从日志抓 token 自动授权直接打开，没有 web 界面的（codex 等）在当前窗口终端里开 `ssh -t` | 开发中 |
| [`dsh-jvs-console`](plugins/dsh-jvs-console/README.md) | Zakl Agent（zakl_jvs）快捷控制台：右侧边栏直接看 jvs 状态、开关经跳板机的内部隧道（xy_proxy），并一键运行 jvs 子命令 | 开发中 |

## 目录结构

```
dsh_plugins/
├── plugins/
│   ├── dsh-session-hub/   # 每个插件自成一个包（package.json 就在这一层）
│   ├── dsh-remote-agent/
│   └── dsh-jvs-console/
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
> 实测补充：移动之后，两个半边的恢复方式**不一样**，而这一点很反直觉：
>
> | 半边 | 移动后改文件是否生效 | 为什么 |
> | --- | --- | --- |
> | 客户端 | **刷新页面即可** | 浏览器重新拉取 bundle，服务器是按新路径**现读文件**的 |
> | 宿主 | **不生效，必须重启 DSH** | 热重载不再看见这个文件，宿主会一直跑**移动前加载的那份代码** |
>
> ⚠️ **`plugin_manager list_plugins` 的 `fiberPhase: active` 具有误导性**：它只反映**安装时**触发的那次加载，**不能**用来判断「移动之后对宿主半边的改动已经生效」。唯一的判断依据是重启后看行为。
>
> 这次就是踩了这个坑：移动并重装后，只改了 `client.js` 的「分组时间」刷新就出现了，而只改了 `index.js` 的「临时工作区过滤」在界面上**完全看不到**——排查到 `index.js` 的改动历史只有两条、最后一条正是那个过滤，才确认宿主根本没重载。

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
