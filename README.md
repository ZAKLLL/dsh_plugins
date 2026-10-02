# dsh_plugins

DeepSeek Harness（DSH）插件开发仓库。

## 插件列表

| 插件 | 说明 | 状态 |
|------|------|------|
| [`dsh-session-hub`](dsh-session-hub/README.md) | 把本机所有 coding-agent 会话（DSH、Claude Code、Codex、Gemini CLI）汇总到一个面板，支持拖拽续聊与一键回到原 Agent | 开发中 |

## 目录说明

```
dsh_plugins/
├── dsh-session-hub/     # Session Hub 插件（index.js / client.js / locale / test）
├── .githooks/           # Git hooks（通过 core.hooksPath 生效）
├── .gitmessage          # 提交信息模板
└── .gitignore           # 忽略临时参考与运行期产物
```

- `.ref/`、`.research/`：从 DSH 应用包提取的运行时包与插件开发文档副本，仅作 API 参考，**不入库**，过期可直接删除后重新提取。
- `.dsh-session-hub/`：Session Hub 插件在工作区落地的会话转录，**不入库**。

## 开发与提交

```bash
git add .
git commit          # 触发 .githooks/commit-msg 格式检查
git push
```

提交信息格式为 `类型: 简要描述`，类型：`feat` | `fix` | `docs` | `style` | `refactor` | `test` | `chore` | `env`。
