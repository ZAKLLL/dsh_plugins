# dsh-remote-agent · 远端 Agent 管理

把**跑在别的机器上的 coding agent** 拉到当前这扇窗口里来用。两种形态，因为它本来就有两种：

| 形态 | 适用于 | 怎么打开 |
| --- | --- | --- |
| **web** | 有 web 界面的 agent（DSH） | 经 SSH 端口转发把它拉过来，**带着 token 直接以已授权状态**打开 |
| **tty** | 没有 web 界面的 agent（codex、claude 等） | **一键复用本窗口的内置终端**：开出终端 tab 并自动输入 `ssh -t`（失败退化为复制命令） |

面板在右侧边栏（`sidebar.right.pane.tab`），每台机器一组，逐个 agent 显示状态、可用性与开关。

---

## 一条必须知道的约束：本地端口必须等于远端端口

`dsh web` 只绑 `127.0.0.1`，而它签发的授权 cookie 里 `authority` 字段**字面就是** `127.0.0.1:<port>`。所以：

```
-L 8080:127.0.0.1:19391     ← 错：浏览器拿到的 token 是对 127.0.0.1:19391 签的，
                              经过 8080 进来 authority 对不上，第一跳之后就一直在 401 里打转
-L 19391:127.0.0.1:19391    ← 对：两端同号，authority 天然匹配
```

因此配置里 `port` **是同一个数字管两端**，插件不会"贴心"地帮你换个本地端口。本地端口被占用时它明确报错而不是静默换端口 —— 换了就等于坏。

> 远端确实有个 `--trusted-host` 能绕过这件事，但让两端同号是彻底且零成本的做法。

### 内嵌 iframe：策略层面逐层核实可行（但没人真的"看"过它渲染）

"内嵌"这件事有三层可能挡路，逐层查过：

| 层 | 检查对象 | 结果 |
| --- | --- | --- |
| 子页面允许被嵌 | 远端实例 `/` 的响应头 | 无 `X-Frame-Options`、无 CSP |
| 父页面允许去嵌 | DSH 应用页的响应头**与 HTML** | 同样都没有，且无 `<meta http-equiv="Content-Security-Policy">` |
| cookie 在 iframe 里送不送 | 远端 auth cookie 的属性 | `SameSite=Strict; HttpOnly; Max-Age=30d` |

第三项乍看像问题，其实不是：cookie 的 **site** 判定是「scheme + 可注册域」，**端口不参与**，所以 `127.0.0.1:19399`（父）与 `127.0.0.1:19391`（子）是**同站**，`Strict` 不会拦。

而 iframe 加载时的真实条件是「浏览器把 `127.0.0.1` 上的 `dsh-auth-*` **全带上**」，所以把两个实例各自的合法 cookie 合成一个 jar 一起发，逐格量过：

```
remote/child (19391)  no cookie    -> 401
remote/child (19391)  parent only  -> 401     ← 外来 cookie 不被接受
remote/child (19391)  own only     -> 200
remote/child (19391)  BOTH cookies -> 200     ← iframe 的真实条件
desktop/parent(19399) BOTH cookies -> 200
```

即：每个实例只认自己那条，忽略外来的。**嵌入与越权是两件事** —— 能嵌进去，但跨实例不被认。

> 这同时解释了为什么**必须**让本地与远端同端口：如果把其中一端换成 `localhost`，就和 `127.0.0.1` 成了**跨站**，`SameSite=Strict` 会直接把 cookie 吃掉，iframe 里会看到登录页而不是已授权的界面。

另外确认全应用代码里**没有框架自破**（没有 `window.top !== self` 之类的拒绝逻辑）。反倒是 DSH 自己的浏览器侧栏就用 iframe 嵌站 —— 它的文案里写着 *"Many sites refuse iframe embedding"* —— 说明这条路在本应用里是一等公民。

> **边界**：以上都是**策略与代码层面**的核实，**没有一个浏览器真的渲染过这个 iframe**。Electron 侧是否另有设置、实际观感如何，要你在面板上点一下"内嵌"才知道。

### cookie 按 host 存、不区分端口：两个实例共享 `127.0.0.1`，但不构成越权

浏览器的 cookie 不区分端口，所以远端实例（`127.0.0.1:19391`）和你本机的桌面实例（`127.0.0.1:19387`）的 `dsh-auth-*` 落在**同一个 host 命名空间**里，双方的请求都会捎带上对方的 cookie。

把远端实例的 cookie 拿去打桌面实例，实测：

```
desktop with NO cookie      -> 401
desktop WITH remote cookie  -> 401
```

闸门是按 cookie 里的 `authority` 校验的，不是"有没有一条合法的 `dsh-auth-*`"，所以**跨实例鉴权混淆不存在**。这一点必须成立，否则任何能读到远端日志里那行 token 的人，就顺带登进了你本机的实例 —— 两个完全不同的信任域。

---

## 配置

插件行写在 `cordis.patch.yml` 里，`config.hosts` 是机器列表：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  config:
    web:
      # 远端状态目录（相对 $HOME），存 <agent>.pid / <agent>.log
      stateDir: .dsh-remote-agent
      # 等远端把 token 打进日志的上限
      startTimeoutMs: 30000
      # 端口转发保活巡检间隔；0 = 关闭
      healIntervalMs: 30000
    hosts:
      - alias: pro14uu          # ~/.ssh/config 里的 Host 别名
        label: pro14             # 面板上显示的名字
        agents:
          - id: dsh
            kind: web
            label: DSH
            port: 19391           # 本地/远端同号，见上
            bin: /home/zakl/.dsh-runtime/node_modules/.bin/dsh
            dshHome: /home/zakl/.dsh
            profile: remote-web
          - id: codex
            kind: tty
            label: Codex
            command: codex        # 裸可执行名，按远端「$SHELL -lic」的 PATH 找
          - id: claude
            kind: tty
            label: Claude Code
            command: claude
```

**配置项在激活时校验，不合规的行会被丢掉并打 warning**，而不是被引用进命令行。别名、agent id、路径、命令名都限定在保守字符集里 —— 配置在这个插件里等同代码，所以校验发生在边界上。

`ssh` 一律走 `execFile` 的参数数组，唯一一处"字符串变远端 shell 命令"由 `shq()` 单引号转义负责。

### `hosts` 就是机器清单：它同时被发布出去

`config.hosts` 是**整个窗口里机器只被声明一次的那个地方**。装了这个插件，`dsh-session-hub` 的 `cordis.patch.yml` 就**不需要再写 `environments`** —— 面板里的环境 chip 会直接长出这里定义的每一台。

```js
// apply() 里，紧跟在校验之后
ctx.provide("remoteHosts", {
  list: () => normalized.hosts.map((host) => ({
    alias: host.alias,
    label: host.label,
    dshHome: host.agents.find((agent) => agent.kind === "web")?.dshHome ?? null,
  })),
  problems: () => [...normalized.problems],
});
```

发布的是一个**方法而不是快照**：一个世代内按需读当前配置，而配置热更替会替换掉整个服务值。

发布字段只有三个，是刻意的：`alias`（对方要原样交给 `ssh`）、`label`（显示）、`dshHome`（**唯一一个远端读者自己探不准的事实** —— 参考机上 DSH home 不在默认的 `$HOME/.dsh`；没有 web agent 的机器报 `null`，而不是猜一个）。bin / port / profile 是**启动**才需要的，留在本地。

消费者用的是 `ctx.get("remoteHosts")` 而不是 `inject`：把这条写成硬依赖会让 session-hub 在没装本插件的组合里拒绝激活，为一个可选的机器列表付这个代价太重。`test/harness.mjs` 里有一条常驻断言钉住这个契约的形状（只发布那三个字段）。

---

## 宿主路由

`POST /api/remote-agent`，body `{ op, host?, agent? }`，响应恒为 `{ ok: true, ... }` 或 `{ ok: false, error, supported? }`。

| op | 作用 | 说明 |
| --- | --- | --- |
| `overview` | 每台机器**一次** SSH 往返拿到全部状态 | 可达性、远端二进制是否存在、进程存活、token、远端是否在监听、日志尾部 |
| `probe` | 看 login shell 到底能找到哪些 agent | 非交互 ssh 只拿到系统 PATH，`~/.local/bin` 里的东西会"看起来不存在"，所以这里显式跑 `bash -lc` |
| `start` | 起远端服务 + 建转发 + 抓 token | 已在跑则复用，不重启 |
| `stop` | 杀远端进程 + 拆转发 | 按 pidfile，不做宽泛 `pkill` |
| `restart` | 先 stop 再 start | |
| `url` | 复用已存在实例的 token | **不重启**——"再打开一次"不该让人丢掉正在跑的会话 |
| `logs` | 远端日志尾部 | |

两个反直觉但重要的行为：

- **停机后 `url` 必须拒绝**。日志比进程活得久，停掉的服务在日志里还留着上一个 token 且照样能解析出来。所以 `opUrl` 先看存活再谈 token，`overview` 在停机时也**不下发 url**，否则面板上会出现一个看着能用、点了就死的按钮。
- **`overview` 只做一次 SSH 往返**：状态、存活、token、可用性是同一个远端脚本一次性吐出来的 `key=value` 行。多行值用 ASCII 记录分隔符 `0x1e` 编码，避免在远端 shell 里塞一个 JSON 编码器。

---

## 远端需要什么

web 形态的 agent：

```bash
# 1) 装一份独立的 dsh（不要 sudo，装用户目录）
mkdir -p ~/.dsh-runtime && cd ~/.dsh-runtime
printf '%s\n' '{"name":"dsh-runtime","private":true}' > package.json
npm i @deepseek-ai/dsh@0.2.0-rc.2

# 2) 从模板生成一个 web profile
export DSH_HOME=~/.dsh
BIN=~/.dsh-runtime/node_modules/.bin/dsh
$BIN remote-web --from-default-profile web --dump-config    # 位置参数必须在最前

# 3) 模型通道：把 profile 的 cordis.patch.yml 配上 provider，密钥放
#    $DSH_HOME/.credentials.yaml（0600），由 apiKeyEnv 解析
```

> `@deepseek-ai/dsh@0.2.0-rc.2` 自带 `dsh-base` 与 `dsh-web-app` 两个 bundle 作为依赖，所以**独立安装就能组出 web profile**，不需要 Electron 应用。

远端进程用普通 `nohup ... &` 起，实测能活过 ssh 会话：

```bash
DSH_HOME=~/.dsh nohup $BIN remote-web --port 19391 --no-open >> ~/.dsh-remote-agent/dsh.log 2>&1 &
```

**不用 `setsid`**：它可能 fork，于是 `$!` 变成一个短命父进程，pidfile 就废了。

---

## 验收

**宿主半边**可以脱离 UI 直接验，而且是对**真机器**验：

```bash
node test/harness.mjs --start --stop     # 全链路：起服务 → 抓 token → 建转发 → 带 token 请求 → 拆掉
node test/harness.mjs                    # 只读：overview + probe
```

它给 `apply` 一个桩 Context 捕获路由，然后拿真 payload 打真实远端。之所以不用 mock：这里最容易错的两件事是**生成的远端脚本**和**端口转发**，对着 mock 验没有任何意义。

还有一条是**手工验过、但没法做成常驻断言**的（它需要真远端和一个 pty）：把生成的那条命令放进真实 pty 跑，`codex` 与 `claude` **都真的拉起了 TUI** —— 也就是 `ssh -t` + 交互式登录 shell + `exec` 这条链从 ssh 一直通到 agent 本身。剩下唯一没验的一跳是"插件把这条命令敲进浏览器里那个终端"，那需要人在界面上点一下（见下方验收）。

还有一条容易被忽略的：生成给你的 `ssh -t` 命令是**一条要粘贴的字符串，引号本身就是接口**。所以 harness 会在 PATH 里放一个假的 `ssh`，用 `sh -c` 把整条命令解析一遍，断言 ssh 只收到三个参数、第三个是**一整条**远端命令 —— 像 `includes("-lic")` 这种断言对引号错误完全无感。

其中最关键的一条断言是 `the forwarded URL authorizes` —— 经转发带 token 请求必须 < 400 并且真的下发 `dsh-auth` cookie。这一条挂了，就等于上面那条端口约束被破坏了。

那个桩 Context **故意复现 Cordis 的纪律**：未注入就读 `ctx.timer` 会**抛**。第一版插件正是死在这一点上（`ctx.timer?.interval` 这种"防御性"写法本身就是错的），而一个"礼貌地返回 undefined"的桩会让这个 bug 顺利溜过验收。所以它现在是一条常驻断言。

**客户端半边**没有构建步骤、原样下发，出错只会出现在浏览器里、任何日志都看不到。所以用一个最小的加载器 + 假 React 真的把 `apply` 跑一遍：

```bash
node test/client-load.mjs
```

它不渲染，因此只能验到 `apply` 为止；但它能证明模块可求值、工厂返回的形状正确（`{ name, inject, apply }`）、locale 与侧栏 tab 都登记上了，并且**只索取它真正需要的服务**（`sidebarRightTabs`），不去够一个它根本用不上的终端命名空间。

**渲染**则用另一个测试补上——那里才是崩得最多的地方（徽章构造、iframe 分支、按钮矩阵），而加载测试一行都执行不到：

```bash
node test/client-render.mjs
```

app 里**没有 `react-dom`**（React 是打进客户端 bundle 的平台模块），而本仓库刻意不引入开发依赖 —— 所以这里没有从 npm 拉 React，而是自己写了个 ~80 行的迷你渲染器：按 hook 顺序存状态单元、渲染后刷洗 effect、setter 触发重渲染。它**不是 React**，抓不到 hook 顺序或并发模式的坑；它能抓的是手写插件最现实的失败模式：**某条加载测试永远走不到的分支在渲染时抛异常**。喂进去的是一份真实的 `/api/remote-agent` fixture（一个 running 的 web agent + 一个 tty agent）走 stub 的 `fetch`，所以卡片、徽章、按钮矩阵都真的被渲染了一遍。

它还覆盖两个平时没人会想到要写测试的状态：

- **主机不可达**。面板必须用 ssh 的原话解释为什么（`host.error`），把 agents 仍然列出来，并且**不能**把"没问到"（`available: null`）说成"没安装"（`available: false`）——这两者对用户是完全不同的意思。此时一键终端**仍然可用**：开一个终端让 ssh 自己把错误打出来，比一个禁用的按钮有用。
- **文案完整性**。它记录面板用过的每一个 locale key，断言它们都在字典里，并且 **en 与 zh 的键集完全一致**（漏译会在某个人的界面上显示成一个原始 key，而仓库里没有任何别的东西会发现它）。

它顺带能断言**语义**而不只是文本：断言里保留了 host 元素的 props，于是"运行中的 agent 上 Start 应当**禁用**"是可验的 —— 我第一版断言写的是"Start 不该出现"，结果测出来是我错了（[client.js](client.js) 的设计是控件全渲染、不适用的禁用）。措辞与这个区别见下：

> 该测试上线当天就抓出两个真问题：一是我的断言写错（把"禁用"当成"不该存在"），二是**转发端口只存在于 tooltip 里** —— 而端口是这个插件最吃重的那个数字，现在它有了自己的可见徽章。

### 不重启也能验：临时 profile

宿主半边一旦被加载，dsh **不会**因为文件改动给它换世代 —— 所以验一个**新装**的插件，正常来说得重启整个应用。想在开发时免掉这一步，就在一个一次性 profile 里把它跑起来：这是**真实运行时**，不是仿真。

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 1) 从内置模板生成一次性 profile（位置参数必须在最前，否则报 --profile required）
"$DSH" plugincheck --from-default-profile web --dump-config

# 2) 把插件 link 进去；`add` 会同时写入 dsh.profile.bundles，所以 patch 层会生效
"$DSH" plugin --profile plugincheck add "link:$PWD/plugins/dsh-remote-agent"

# 3) 起在另一个端口（完全不碰正在跑的那个实例）
"$DSH" plugincheck --port 19399 --no-open

# 4) 用启动日志里那行 token 授权，然后直接打路由
curl -sL -c jar -b jar -o index.html "http://127.0.0.1:19399/?token=…"
curl -s -b jar -X POST -H 'content-type: application/json' \
     -d '{"op":"overview"}' http://127.0.0.1:19399/api/remote-agent

# 5) 用完删掉
rm -rf ~/.dsh/profiles/plugincheck
```

三个会让人得出**错误结论**的坑，都实际踩过：

- **`?token=` 返回的是 303**。`curl` 不加 `-L` 得到的是空体重定向体 —— 于是"客户端半边没进 boot 图"这个结论就凭空出现了，而真相只是我没跟随重定向。
- **客户端 bundle 的 URL 必须带 `&rev=`**。直接请求 `plugins/??<id>/client.js` 会 **404**；正确 URL 在页面注入的 `window.__DSH_BOOT__` 里。取到后跟本地文件比对会发现：服务端下发的是**本地文件的逐字节副本 + 一段 sourcemap trailer**，所以 sha256 必然不同 —— 别把它当成陈旧副本。
- **curl 的 cookie jar 里，`HttpOnly` cookie 写成 `#HttpOnly_…` 开头**，于是 `grep -v '^#'` 会把**整条 cookie 滤掉**（DSH 的 auth cookie 正好是 HttpOnly）。想合并/解析 jar 时数据行是 `grep -E '^#HttpOnly_|^[^#]'`。这个坑让我一度测出"两个 cookie 同时在也 401"的错误矩阵。

---

## tty 形态怎么做到一键：复用侧栏的内置终端

"在终端打开"按钮**不是**自己实现终端，而是复用 Sidebar 的内置终端 tab，走的是**它自己的快捷键走的那条路**：

```js
// 1) 拿一个 tab target —— 关键是传 null：
//    commandTarget(element = document.activeElement) 在 element 为 null 时
//    回退到“当前屏幕会话的活动 dock pane”，所以按钮也能调到它。
const target = ctx.sidebarRight.commandTarget(null);

// 2) 让 Sidebar 开一个终端 tab（kind 就是内置终端的注册名）
ctx.sidebarRight.openTabFromTarget("terminal", target);

// 3) 找到刚开的那个 tab，用和终端 UI 相同的一对 (sessionId, key) 取 view。
//    view() 按 (sessionId, key) 缓存并返回同一个实例 —— 这是能往里写的唯一原因。
const occurrence = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: tabId });
const { params, address } = occurrence.navigation.getSnapshot();
const view = ctx.webTerminals.view(sessionId, tabId, address, params?.terminalId, params?.shellPath);

// 4) 等它变得可写，再把命令打进去
view.write(`${command}\n`);
```

**第 4 步的等待不是可选的，这是整件事的难点**：`TerminalView.write()` 在 view 还没挂载/attach 时是**静默 no-op**（`if (!state.writable || state.info === undefined || attachmentId === undefined) return;`）。而"挂载"由终端 UI 在渲染那个 tab 时触发（`mount()` → `create` → `attach` → `writable`）。所以必须轮询到可写再写；写早了不会报错，只会什么都不发生。

失败时**退化为复制命令**，并且措辞如实：终端 tab 已经开出来了（那本来就能用），只是没能自动输入。

> ### 我在这里犯过两个错，都写下来
>
> **一、我说过"这条路对第三方插件不存在"，那是错的。** 我当时查到"开一个可见 tab 要 `commandTarget(domElement)`"就停了，没注意到 `commandTarget` 的 `element` 有默认值、且为 `null` 时会回退到屏幕上的活动 pane —— 也就是说侧栏快捷键用的正是 `commandTarget(null)`。**结论下得太早，把"我没想到"当成了"平台不给"。**
>
> **二、更严重的一个：我用 `bash -lc` 探测远端，于是把装好的 `claude` 判成"未安装"。** `claude` 在 `~/.bun/bin/claude`，而 `~/.bun/bin` 只在**交互式** zsh 的 PATH 里（同一条 PATH 上还有 `~/.opencode/bin`、`~/zakl_shell`）。`bash -l` 不读 `.zshrc`，`-i` 才是关键。所以现在：
>
> - 探测、可用性检查、以及生成的 `ssh -t` 命令，**一律走用户自己的 `$SHELL -lic`**；
> - 生成的命令形如 `ssh -t pro14uu 'exec "$SHELL" -lic "exec claude"'`，可以直接粘贴；
> - `probe` 会如实回报 `interactiveShell` 和那条 PATH，方便下次一眼看出是环境问题还是真的没装。
>
> 代价是 rc 可能往 stdout 打 banner（这台机器上是 `WSL ip … ssh:running`）——所以解析器只认 `key=value` 行、其余一律忽略。这不是随手写的宽容，而是必须的。

## 已知限制

- **远端可达性完全取决于那条 SSH 通路**，这也是最常见的"面板像是坏了"的原因。参考机器上 `pro14uu` 是 `127.0.0.1:2222`（端口由本机 `UURemote` 持有），隧道没真正转发到远端 sshd 时表现为 banner exchange 超时；此时面板会显示 `可达=否` 并把 ssh 的原始错误贴出来 —— 那是它在正确工作，不是在装死。
- **只支持 POSIX 远端**（Linux/macOS）。Windows 没做。
- **只支持密码学意义上的"已配置好"的 SSH**：`BatchMode` + 严格 host key。需要密码或首次指纹确认的机器会直接失败，这是故意的：会停下来等人的 agent 主机，会把一个请求挂住而不是让它失败。
- **远端状态靠 pidfile**，没有 pidfile 的旧进程认不出来（比如你手工起的），插件会以为它没在跑。
- **tty 形态依赖终端视图的内部状态**：自动输入前要轮询 `view.state` / `view.attachmentId` 直到可写。这是终端 UI 自己的字段，不是公开契约 —— 换版本后如果它变了，表现是**退化为复制命令**（而不是报错），所以不会把功能弄坏，但可能要跟着更新。
- **转发不跨插件重载**：它是进程的子进程，属于那一代插件。重载会拆掉它，需要时重新建。
- 面板本身不跨机器聚合**会话**（那是 `dsh-session-hub` 的活），这里只负责"把 agent 开起来"。
