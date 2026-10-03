/**
 * dsh-remote-agent — Client half.
 *
 * One contribution: the right Sidebar's tab body. It reads the Host half's
 * `/api/remote-agent` route and lets a person drive the coding agents that live
 * on other machines without leaving the window:
 *
 *   - see each configured SSH host, whether it answers, and what its agents are
 *     doing (running / stopped, forward up / down, binary present / missing);
 *   - open a remote `dsh web` UI in a new browser tab — or embedded right here —
 *     already carrying the token the remote server printed at boot;
 *   - start / stop / restart that remote server and read its log;
 *   - open a remote CLI agent (codex, …) in this window's own terminal.
 *
 * THE ONE CONSTRAINT THAT SHAPES EVERYTHING (also documented in the Host half):
 * a `web` agent binds `127.0.0.1` on the remote machine and is reached through
 * an SSH port-forward whose LOCAL PORT MUST EQUAL THE REMOTE PORT. The remote
 * server mints an authorization cookie whose `authority` is literally
 * `127.0.0.1:<port>`; a forward that retargeted the local end (`-L 8080:…:19391`)
 * would hand the browser a cookie issued for an authority the browser is not
 * talking to, and every request would 401. Equal ports cost nothing and are the
 * whole fix. This half therefore never invents, rewrites or re-bases a port: it
 * only ever uses the `url` the Host produced, which is already `127.0.0.1:<port>`.
 *
 * Same constraint, second consequence: because the browser talks to
 * `127.0.0.1:<port>` and the remote server sends no `X-Frame-Options` and no
 * frame-ancestors CSP, the authorized page CAN be embedded in an iframe here —
 * the cookie's authority matches the frame's origin, so the embed authenticates
 * exactly like the pop-out tab does.
 *
 * Only theme tokens are used for styling, and no Harness Client package is
 * imported: the controls are plain markup so a host upgrade cannot blank the
 * slot entry. React comes from the browser module table, like every other
 * installed Client half.
 *
 * @module dsh-remote-agent/client
 */

window.__ModuleLoader__.load({
  id: "dsh-remote-agent",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-remote-agent";
    const ROUTE = "/api/remote-agent";
    const STYLE_ID = "dsh-remote-agent/client.css";
    /** The right-Sidebar tab type's identity; also the key its body and chip use. */
    const TAB_ID = "remote-agent";

    /** Host-side default is 200; the route clamps to 2000, so 200 is a safe ask. */
    const LOG_LINES = 200;
    /** How long an inline per-agent message stays on screen. */
    const NOTE_TTL_MS = 8_000;
    /** Relative timestamps age out; re-render them about once a minute. */
    const CLOCK_MS = 20_000;
    /** How long to wait for the Sidebar to put the requested terminal on screen. */
    const TERMINAL_OPEN_MS = 4_000;
    /** How long to wait for that terminal to become writable (mount -> attach). */
    const TERMINAL_WRITE_MS = 6_000;

    /* ---------------------------------------------------------------- *
     * Dictionaries
     * ---------------------------------------------------------------- */

    const DICT_EN = {
      tab: "Remote Agents",
      guide: "Agents on your other machines: remote DSH web UIs through an SSH port-forward, and remote CLI agents in this terminal.",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      probe: "Probe",
      probing: "Probing…",
      loginPath: "Login PATH",
      probeNone: "No command was found.",
      notFound: "missing",
      reachable: "ssh answers",
      unreachable: "ssh does not answer",
      noHosts: "No host is configured.",
      noAgents: "No agent is configured for this host.",
      generated: "Updated {when}",
      justNow: "just now",
      secondsAgo: "{n}s ago",
      minutesAgo: "{n}m ago",
      hoursAgo: "{n}h ago",
      daysAgo: "{n}d ago",
      kindWeb: "web",
      kindTty: "tty",
      available: "installed",
      unavailable: "not installed",
      notProbed: "not probed",
      notInstalled: "The remote executable is missing: {cmd}",
      stateRunning: "running",
      stateStopped: "stopped",
      stateUnknown: "unknown",
      pid: "pid {pid}",
      tunnelUp: "forward up",
      tunnelDown: "forward down",
      tunnelNa: "no forward",
      tunnelDownRunning: "The server is running but the local SSH forward is down, so nothing answers on 127.0.0.1. Start it again to re-open the forward.",
      open: "Open",
      copyUrl: "Copy URL",
      start: "Start",
      stop: "Stop",
      restart: "Restart",
      logs: "Logs",
      reload: "Reload",
      embed: "Embed",
      unembed: "Unembed",
      embedNoUrl: "There is no URL to embed yet — start the agent or open its URL first.",
      noUrlYet: "The server is running but it has not printed a URL yet — try again in a moment.",
      openTerminal: "Open in terminal",
      copyCommand: "Copy command",
      terminalNoCommand: "This agent has no command to run.",
      terminalHint: "Reuses this window's built-in terminal tab.",
      terminalTyped: "Typed into this window's terminal.",
      terminalFallback: "Opened a terminal but could not type into it ({message}). The command is copied — paste it.",
      commandCopied: "Copied — open a terminal in this window and paste.",
      copyFailed: "Copying failed; select the command and copy it by hand.",
      logsTitle: "Log tail",
      logsEmpty: "The log is empty.",
      close: "Close",
      copy: "Copy",
      copied: "Copied",
      busy: "Working…",
      failed: "Failed: {message}",
      retry: "Retry",
    };

    const DICT_ZH = {
      tab: "远程 Agent",
      guide: "管理其他机器上的 Agent：通过 SSH 端口转发打开远程 DSH Web 界面，或在本窗口终端里打开远程 CLI Agent。",
      refresh: "刷新",
      refreshing: "刷新中…",
      probe: "探测",
      probing: "探测中…",
      loginPath: "登录 PATH",
      probeNone: "没有找到任何命令。",
      notFound: "缺失",
      reachable: "ssh 可达",
      unreachable: "ssh 不可达",
      noHosts: "没有配置任何主机。",
      noAgents: "该主机没有配置 Agent。",
      generated: "更新于 {when}",
      justNow: "刚刚",
      secondsAgo: "{n} 秒前",
      minutesAgo: "{n} 分钟前",
      hoursAgo: "{n} 小时前",
      daysAgo: "{n} 天前",
      kindWeb: "web",
      kindTty: "tty",
      available: "已安装",
      unavailable: "未安装",
      notProbed: "未探测",
      notInstalled: "远端可执行文件不存在：{cmd}",
      stateRunning: "运行中",
      stateStopped: "已停止",
      stateUnknown: "未知",
      pid: "pid {pid}",
      tunnelUp: "转发正常",
      tunnelDown: "转发断开",
      tunnelNa: "无转发",
      tunnelDownRunning: "服务在运行，但本地 SSH 转发已断开，127.0.0.1 上没有任何响应。再次点“启动”即可重新建立转发。",
      open: "打开",
      copyUrl: "复制 URL",
      start: "启动",
      stop: "停止",
      restart: "重启",
      logs: "日志",
      reload: "重新加载",
      embed: "内嵌",
      unembed: "取消内嵌",
      embedNoUrl: "还没有可内嵌的 URL——请先启动该 Agent，或先获取它的 URL。",
      noUrlYet: "服务在运行，但还没打印出 URL——请稍后再试。",
      openTerminal: "在终端打开",
      copyCommand: "复制命令",
      terminalNoCommand: "该 Agent 没有可执行的命令。",
      terminalHint: "复用本窗口的内置终端标签。",
      terminalTyped: "已输入本窗口的终端。",
      terminalFallback: "终端已打开，但没能自动输入（{message}）。命令已复制，直接粘贴即可。",
      commandCopied: "已复制 —— 在本窗口开一个终端后粘贴。",
      copyFailed: "复制失败，请手动选中命令复制。",
      logsTitle: "日志尾部",
      logsEmpty: "日志为空。",
      close: "关闭",
      copy: "复制",
      copied: "已复制",
      busy: "执行中…",
      failed: "失败：{message}",
      retry: "重试",
    };

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    const CSS = `
.dra-root{box-sizing:border-box;color:var(--dsw-alias-label-primary);flex-direction:column;height:100%;min-height:0;padding:10px 12px 12px;font-size:13px;line-height:1.5;display:flex;overflow:hidden}
.dra-head{align-items:center;gap:6px;flex:none;display:flex;margin-bottom:8px}
.dra-title{white-space:nowrap;text-overflow:ellipsis;min-width:0;font-weight:600;overflow:hidden;flex:auto}
.dra-iconbtn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;cursor:pointer;flex:none;padding:2px 7px;font-size:11px;line-height:18px;font-family:inherit}
.dra-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dra-iconbtn:disabled{opacity:.45;cursor:default}
.dra-scroll{scrollbar-gutter:stable;flex:auto;min-height:0;overflow-y:auto;padding-right:4px}
.dra-toast{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;flex:none;margin-bottom:8px;padding:6px 9px;font-size:11px;word-break:break-word}
.dra-toast[data-error="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dra-host{background:var(--dsw-alias-bg-layer-2);border-radius:10px;flex:none;margin-bottom:10px;padding:9px 10px}
.dra-host-head{align-items:center;gap:6px;display:flex}
.dra-dot{border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none;width:7px;height:7px}
.dra-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}
.dra-host-label{font-weight:600;font-size:12.5px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dra-host-alias{color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
.dra-host-head .dra-btn{margin-left:auto;flex:none}
.dra-probe{border-top:1px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:7px}
.dra-probe-path{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:5px}
.dra-chips{gap:4px;flex-wrap:wrap;display:flex}
.dra-chip{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dra-chip[data-on="true"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dra-agents{flex-direction:column;gap:8px;display:flex;margin-top:9px}
.dra-agent{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:7px 8px}
.dra-agent-top{align-items:center;gap:5px;flex-wrap:wrap;display:flex}
.dra-agent-name{font-weight:600;font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dra-badge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:0 6px;font-size:9.5px;line-height:15px;white-space:nowrap}
.dra-badge[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dra-badge[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dra-badge[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dra-badge[data-tone="business"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dra-btns{gap:5px;flex-wrap:wrap;display:flex;margin-top:7px}
.dra-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;padding:1px 8px;font-size:11px;line-height:18px;font-family:inherit}
.dra-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dra-btn:disabled{opacity:.45;cursor:default}
.dra-btn[data-primary="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dra-btn[data-on="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dra-warn{color:var(--dsw-alias-state-warn-primary);font-size:10.5px;line-height:1.5;margin-top:6px}
.dra-err{color:var(--dsw-alias-state-error-primary);word-break:break-word;text-align:left;font-size:11px;line-height:1.5;margin-top:6px}
.dra-hint{color:var(--dsw-alias-label-tertiary);word-break:break-word;font-size:10.5px;line-height:1.5;margin-top:6px}
.dra-note{background:var(--dsw-alias-bg-layer-2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;margin-top:6px;padding:5px 7px;word-break:break-word}
.dra-note[data-error="true"]{color:var(--dsw-alias-state-warn-primary)}
.dra-frame{border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-top:7px;display:block}
.dra-logs{border-top:1px solid var(--dsw-alias-border-l2);margin-top:7px;padding-top:6px}
.dra-logs-head{align-items:center;gap:6px;display:flex;margin-bottom:5px}
.dra-logs-title{color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;font-weight:600;font-size:10px}
.dra-logs-head .dra-btn{margin-left:auto}
.dra-pre{background:var(--dsw-alias-bg-layer-2);border-radius:8px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:260px;margin:0;padding:7px 8px;font-size:10.5px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto}
.dra-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:12px 6px;font-size:12px}
.dra-empty .dra-btn{margin-top:6px}
.dra-foot{color:var(--dsw-alias-label-tertiary);flex:none;text-align:right;font-size:10px;margin-top:6px}
.dra-tab-title{align-items:center;gap:6px;min-width:0;display:flex}
.dra-tab-title-label{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
`;

    function installStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-remote-agent";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------------------------------------------------------- *
     * Host transport
     * ---------------------------------------------------------------- */

    async function call(op, payload) {
      const response = await fetch(ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...payload }),
      });
      if (!response.ok) throw new Error(`remote-agent ${op}: HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      if (body?.ok !== true) {
        const supported = Array.isArray(body?.supported) ? ` — host answers: ${body.supported.join(", ")}` : "";
        throw new Error(`${body?.error ?? `remote-agent ${op} failed`}${supported}`);
      }
      return body;
    }

    /* ---------------------------------------------------------------- *
     * Small helpers
     * ---------------------------------------------------------------- */

    /**
     * A host-loaded value, with the three states a card must distinguish:
     * `loading`, `ready`, and `error`.
     *
     * The error state matters: a host generation that predates an operation
     * answers `unknown op`, and a card that cannot say so just looks stuck
     * forever. A failed refresh KEEPS whatever it already had, so one bad SSH
     * round trip never blanks a working panel.
     */
    function useResource(op) {
      const [state, setState] = React.useState({ status: "loading", data: null, error: null });
      const load = React.useCallback(
        async (silent) => {
          if (silent !== true) setState((current) => ({ ...current, status: "loading" }));
          try {
            setState({ status: "ready", data: await call(op), error: null });
          } catch (error) {
            setState((current) => ({
              status: "error",
              data: current.data,
              error: String(error?.message ?? error),
            }));
          }
        },
        [op],
      );
      return [state, load, setState];
    }

    /**
     * `generatedAt` (a Host epoch-ms stamp) as a short relative phrase.
     * `now` is injected so the panel's clock tick can drive the re-render.
     */
    function relativeTime(t, stamp, now) {
      if (!Number.isFinite(stamp)) return "—";
      const seconds = Math.max(0, Math.round((now - stamp) / 1000));
      if (seconds < 45) return t("justNow");
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return seconds < 120 ? t("secondsAgo", { n: seconds }) : t("minutesAgo", { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("hoursAgo", { n: hours });
      return t("daysAgo", { n: Math.round(hours / 24) });
    }

    /** Two remote agents on different hosts may share an id, so keys are composite. */
    function agentKey(alias, id) {
      return `${alias}\u0000${id}`;
    }

    /** A badge whose colour comes from one theme token, never a literal palette. */
    function badge(label, tone, title) {
      return h(
        "span",
        { className: "dra-badge", "data-tone": tone ?? "muted", title: title ?? label },
        label,
      );
    }

    /**
     * The availability badge. `available === false` is the one value the UI must
     * treat as a hard stop (it disables every launch button), so it reads as an
     * error; `null` only means nothing has probed the machine yet.
     */
    function availabilityBadge(t, agent) {
      if (agent.available === false) return badge(t("unavailable"), "error");
      if (agent.available === null) return badge(t("notProbed"), "muted");
      return badge(t("available"), "success");
    }

    /** The lifecycle badge shared by both kinds; only a web agent reports a pid. */
    function stateBadge(t, agent) {
      if (agent.state === "running") {
        // The pid is visible text, not just a tooltip: "which process is this"
        // is the first thing a person asks before pressing Stop.
        const label = agent.pid ? `${t("stateRunning")} · ${t("pid", { pid: agent.pid })}` : t("stateRunning");
        return badge(label, "success");
      }
      if (agent.state === "stopped") return badge(t("stateStopped"), "muted");
      return badge(t("stateUnknown"), "warn");
    }

    function RemoteIcon({ size = 15 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: { flex: "none" },
        },
        h("rect", { x: 2.5, y: 3.5, width: 19, height: 12.5, rx: 2.5 }),
        h("path", { d: "M12 16v4" }),
        h("path", { d: "M8 20.5h8" }),
        h("path", { d: "M6.5 8h5" }),
        h("path", { d: "M6.5 11h3" }),
        h("path", { d: "M14.5 6.5l2.7 2.7-2.7 2.7" }),
      );
    }

    /* ---------------------------------------------------------------- *
     * The panel
     * ---------------------------------------------------------------- */

    /** Terminal tab identities currently open, so a new one can be told apart. */
    function terminalTabIds(sidebar) {
      try {
        const tabs = sidebar.openTabs?.getSnapshot?.();
        if (!Array.isArray(tabs)) return new Set();
        return new Set(
          tabs.filter((tab) => tab?.kind === "terminal").map((tab) => tab.id ?? tab.key),
        );
      } catch {
        return new Set();
      }
    }

    /**
     * The terminal tab that was not open before, or null while it is still coming.
     *
     * "Newest terminal tab" alone would be wrong the moment another terminal is
     * restored or opened for a different Session at the same moment, so a tab
     * belonging to the Session we asked for wins; newest is only the tie-breaker.
     */
    function newTerminalTab(sidebar, before, sessionId) {
      try {
        const tabs = sidebar.openTabs?.getSnapshot?.();
        if (!Array.isArray(tabs)) return null;
        const fresh = tabs.filter(
          (tab) => tab?.kind === "terminal" && !before.has(tab.id ?? tab.key),
        );
        if (fresh.length === 0) return null;
        const mine = fresh.filter(
          (tab) => tab.sessionId === undefined || tab.sessionId === sessionId,
        );
        return (mine.length > 0 ? mine : fresh).pop() ?? null;
      } catch {
        return null;
      }
    }

    /**
     * Poll a predicate until it answers truthy or the deadline passes.
     *
     * Polling rather than listening is deliberate here: the two things being
     * waited on are owned by another plugin (the Sidebar puts the tab on screen,
     * the terminal view mounts and attaches), and neither publishes an event this
     * half is allowed to subscribe to.
     */
    async function pollUntil(predicate, timeoutMs, stepMs = 150) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let value = null;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) return value;
        if (Date.now() >= deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
      }
    }

    function makeBody(ctx, t, faces) {
      return function RemoteAgentPanel(props) {
        const [resource, loadOverview] = useResource("overview");
        /** alias -> { status, data, error } — the last `probe` result per host. */
        const [probes, setProbes] = React.useState({});
        /** agentKey -> { status, text, error } — the last `logs` answer per agent. */
        const [logs, setLogs] = React.useState({});
        /** agentKey -> boolean — whether the agent's card shows an embedded frame. */
        const [embeds, setEmbeds] = React.useState({});
        /** agentKey -> { message, error } — short-lived, inline, per agent. */
        const [notes, setNotes] = React.useState({});
        /** One mutating operation at a time, named `verb:key`, so buttons can wait. */
        const [busy, setBusy] = React.useState(null);
        const [toast, setToast] = React.useState(null);
        const [now, setNow] = React.useState(() => Date.now());
        const toastTimer = React.useRef(null);
        const noteTimers = React.useRef(new Map());

        // The panel-level banner: for failures that are not about one agent row.
        const say = React.useCallback((message, error) => {
          setToast({ message, error: error === true });
          if (toastTimer.current !== null) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setToast(null), 6000);
        }, []);

        // The row-level banner: stays next to the agent it is about, because
        // "the command was copied instead" is useless if it scrolls away at the
        // top of a long host list.
        const note = React.useCallback((key, message, error) => {
          setNotes((current) => ({ ...current, [key]: { message, error: error === true } }));
          const timers = noteTimers.current;
          if (timers.has(key)) clearTimeout(timers.get(key));
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key);
              setNotes((current) => {
                if (current[key] === undefined) return current;
                const next = { ...current };
                delete next[key];
                return next;
              });
            }, NOTE_TTL_MS),
          );
        }, []);

        const copyText = React.useCallback(async (value) => {
          const text = String(value ?? "");
          if (text === "") return false;
          try {
            if (!navigator?.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(text);
            return true;
          } catch {
            return false;
          }
        }, []);

        const copyOrSay = React.useCallback(
          async (value) => {
            const ok = await copyText(value);
            if (ok) say(t("copied"));
            else say(t("failed", { message: "clipboard" }), true);
            return ok;
          },
          [copyText, say, t],
        );

        React.useEffect(() => {
          loadOverview(false);
        }, [loadOverview]);

        // A relative "Updated 3m ago" has to be re-rendered to stay true; this
        // clock is the only thing it depends on.
        React.useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
          return () => clearInterval(timer);
        }, []);

        React.useEffect(
          () => () => {
            if (toastTimer.current !== null) clearTimeout(toastTimer.current);
            for (const timer of noteTimers.current.values()) clearTimeout(timer);
            noteTimers.current.clear();
          },
          [],
        );

        /* ------------------------------------------------------------ *
         * Operations
         * ------------------------------------------------------------ */

        const probeHost = React.useCallback(
          async (alias) => {
            setBusy(`probe:${alias}`);
            setProbes((current) => ({
              ...current,
              [alias]: { status: "loading", data: current[alias]?.data ?? null, error: null },
            }));
            try {
              // A probe is about the MACHINE, not about any one agent on it, so
              // the payload is host-only — the documented `{ op, host }` shape.
              const body = await call("probe", { host: alias });
              setProbes((current) => ({ ...current, [alias]: { status: "ready", data: body, error: null } }));
              // A probe is also the cheapest way to refresh "installed" badges
              // that the overview derives from the same login PATH.
              await loadOverview(true);
            } catch (error) {
              setProbes((current) => ({
                ...current,
                [alias]: {
                  status: "error",
                  data: current[alias]?.data ?? null,
                  error: String(error?.message ?? error),
                },
              }));
            } finally {
              setBusy(null);
            }
          },
          [loadOverview],
        );

        const agentOp = React.useCallback(
          async (op, alias, agentId) => {
            const key = agentKey(alias, agentId);
            setBusy(`${op}:${key}`);
            try {
              const body = await call(op, { host: alias, agent: agentId });
              // The row's own view of the world (pid / state / url / tunnel) is
              // computed Host-side, so the only honest way to show the result is
              // to re-read the overview rather than to guess it here.
              await loadOverview(true);
              return body;
            } catch (error) {
              say(t("failed", { message: String(error?.message ?? error) }), true);
              return null;
            } finally {
              setBusy(null);
            }
          },
          [loadOverview, say, t],
        );

        /**
         * The URL for one web agent, asking the Host for it when the overview
         * did not carry one.
         *
         * `op: "url"` deliberately does NOT restart anything: it re-reads the
         * token already in the remote log and re-ensures the forward. That is
         * what makes "Open" safe to press on a server somebody is working in.
         */
        const resolveUrl = React.useCallback(async (alias, agent) => {
          const known = typeof agent?.url === "string" && agent.url !== "" ? agent.url : null;
          if (known !== null) return known;
          const body = await call("url", { host: alias, agent: agent.id });
          return typeof body.url === "string" && body.url !== "" ? body.url : null;
        }, []);

        /** Resolve a URL, hand it to `use`, and report whatever went wrong. */
        const withUrl = React.useCallback(
          async (alias, agent, use) => {
            setBusy(`url:${agentKey(alias, agent.id)}`);
            try {
              const url = await resolveUrl(alias, agent);
              if (url === null) throw new Error(t("noUrlYet"));
              await use(url);
            } catch (error) {
              say(t("failed", { message: String(error?.message ?? error) }), true);
            } finally {
              setBusy(null);
            }
          },
          [resolveUrl, say, t],
        );

        const showLogs = React.useCallback(
          async (alias, agentId) => {
            const key = agentKey(alias, agentId);
            setLogs((current) => ({
              ...current,
              [key]: { status: "loading", text: current[key]?.text ?? "", error: null },
            }));
            try {
              const body = await call("logs", { host: alias, agent: agentId, lines: LOG_LINES });
              setLogs((current) => ({
                ...current,
                [key]: { status: "ready", text: String(body.log ?? ""), error: null },
              }));
            } catch (error) {
              // Keep whatever log text we already had: a failed re-read of a
              // running server's log is not a reason to throw away the last one.
              setLogs((current) => ({
                ...current,
                [key]: {
                  status: "error",
                  text: current[key]?.text ?? "",
                  error: String(error?.message ?? error),
                },
              }));
            }
          },
          [],
        );

        const closeLogs = React.useCallback((alias, agentId) => {
          const key = agentKey(alias, agentId);
          setLogs((current) => {
            if (current[key] === undefined) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        }, []);

        /**
         * Hand the person the `ssh -t` command for a remote `tty` agent.
         *
         * This used to try to open a terminal in this window and type the command
         * into it. It deliberately no longer does, because that attempt could
         * never succeed: the terminal is a **builtin Sidebar tab type** whose
         * lifecycle belongs to the terminal UI. Opening a visible one goes
         * through `sidebarRight.commandTarget(element)` to build a tab target,
         * and binding a view to it additionally needs a sidebar occurrence key.
         * A third-party plugin has no supported way to obtain a live, visible
         * terminal, so the old call threw every single time and fell through to
         * its own fallback — a button that only ever reported its own failure.
         *
         * So the click copies, and the row states the one keystroke that gets a
         * shell (Ctrl+Backquote) so the paste is all that is left.
         */
        const copyCommand = React.useCallback(
          async (alias, agent) => {
            const key = agentKey(alias, agent.id);
            const command = typeof agent?.ttyCommand === "string" ? agent.ttyCommand.trim() : "";
            if (command === "") {
              note(key, t("terminalNoCommand"), true);
              return;
            }
            setBusy(`copy:${key}`);
            try {
              // The button must never be silently dead: if the clipboard is
              // unavailable, say so instead of pretending something happened.
              const copied = await copyText(command);
              note(key, copied ? t("commandCopied") : t("copyFailed"), !copied);
            } finally {
              setBusy(null);
            }
          },
          [copyText, note, t],
        );

        /**
         * Open the remote `tty` agent in this window's built-in terminal.
         *
         * This REUSES the Sidebar's terminal tab instead of reimplementing one,
         * and it reaches it the same way the built-in shortcut does:
         *
         *   target = sidebarRight.commandTarget(null)      // no DOM element needed
         *   sidebarRight.openTabFromTarget("terminal", target)
         *
         * `commandTarget(null)` falls back to the on-screen Session's active dock
         * pane, which is why a button can call it at all. `webTerminals.view()`
         * then returns the SAME per-(session, tab) view the tab itself renders, and
         * `write()` types into it — so the ssh command lands in a real shell rather
         * than the clipboard.
         *
         * The timing is the whole difficulty and it is not optional: `view.write()`
         * is a SILENT no-op until the view is mounted, attached and writable,
         * because input without an attachment has nowhere to go. So this waits for
         * writability and gives up honestly rather than pretending. Giving up is
         * cheap for the person: the tab is open either way (a usable shell), and
         * the command goes to the clipboard.
         */
        const openInTerminal = React.useCallback(
          async (alias, agent) => {
            const key = agentKey(alias, agent.id);
            const command = typeof agent?.ttyCommand === "string" ? agent.ttyCommand.trim() : "";
            if (command === "") {
              note(key, t("terminalNoCommand"), true);
              return;
            }
            setBusy(`terminal:${key}`);
            let reason = null;
            try {
              const sidebar = faces.sidebarRight();
              const terminals = faces.webTerminals();
              if (
                sidebar === null ||
                typeof sidebar.commandTarget !== "function" ||
                typeof sidebar.openTabFromTarget !== "function"
              ) {
                throw new Error("the Sidebar tab API is not available in this build");
              }
              if (terminals === null || typeof terminals.view !== "function") {
                throw new Error("the terminal service is not available in this build");
              }

              const before = terminalTabIds(sidebar);
              const target = sidebar.commandTarget(null);
              if (target === null || target === undefined) {
                throw new Error("no on-screen Session to open a terminal for");
              }
              sidebar.openTabFromTarget("terminal", target);

              const tab = await pollUntil(
                () => newTerminalTab(sidebar, before, target.sessionId),
                TERMINAL_OPEN_MS,
              );
              if (tab === null || tab === undefined) throw new Error("the terminal tab did not appear");

              const sessionId = tab.sessionId ?? target.sessionId;
              const tabId = tab.id ?? tab.key;
              // The terminal UI derives these from the occurrence it is showing;
              // reading the same two values is what makes `view()` hand back the
              // instance that is actually on screen rather than a second one.
              const occurrence = sidebar.tabDomain?.occurrence?.(sessionId, { id: tabId });
              const snapshot = occurrence?.navigation?.getSnapshot?.();
              const params = snapshot?.params;
              // `tab.contentId` is what the terminal UI itself passes when it
              // closes a tab; the occurrence address is the same value and stays
              // as the fallback, so a slightly different snapshot shape cannot
              // silently point `view()` at a second, invisible instance.
              const contentId = tab.contentId ?? snapshot?.address;
              const view = terminals.view(
                sessionId,
                tabId,
                contentId,
                params !== undefined && params !== null && "terminalId" in params ? params.terminalId : undefined,
                params !== undefined && params !== null && "shellPath" in params ? params.shellPath : undefined,
              );

              const writable = await pollUntil(
                () =>
                  view?.attachmentId !== undefined &&
                  view?.state?.getSnapshot?.().writable === true,
                TERMINAL_WRITE_MS,
              );
              if (writable !== true) {
                throw new Error("the terminal opened but did not accept input in time");
              }
              view.write(`${command}\n`);
              note(key, t("terminalTyped"), false);
              return;
            } catch (error) {
              reason = String(error?.message ?? error);
            } finally {
              setBusy(null);
            }
            const copied = await copyText(command);
            note(
              key,
              copied ? t("terminalFallback", { message: reason }) : t("copyFailed"),
              true,
            );
          },
          [copyText, faces, note, t],
        );

        /* ------------------------------------------------------------ *
         * Rendering
         * ------------------------------------------------------------ */

        const webAgent = (alias, agent, key) => {
          const url = typeof agent.url === "string" && agent.url !== "" ? agent.url : null;
          const running = agent.state === "running";
          const blocked = agent.available === false;
          const tunnelDown = agent.tunnel === "down";
          // "Running but the forward is down" is the one state where the server
          // is fine, the login session probably died, and Start is exactly the
          // right button — it re-ensures the forward without touching the
          // remote process (see the Host half's `ensureTunnel` reuse path).
          const canStart = !blocked && (!running || tunnelDown);
          const logsEntry = logs[key] ?? null;
          const embedded = embeds[key] === true;
          const noteEntry = notes[key] ?? null;

          return h(
            "div",
            { className: "dra-agent", key },
            h(
              "div",
              { className: "dra-agent-top" },
              h("span", { className: "dra-dot", "data-on": running ? "true" : "false" }),
              h("span", { className: "dra-agent-name" }, agent.label ?? agent.id),
              badge(t("kindWeb"), "business"),
              stateBadge(t, agent),
              availabilityBadge(t, agent),
              agent.port
                ? badge(
                    tunnelDown ? t("tunnelDown") : t("tunnelUp"),
                    tunnelDown ? "warn" : "success",
                    `127.0.0.1:${agent.port}`,
                  )
                : null,
              // The local port is the most load-bearing number in this plugin (it
              // must equal the remote one — see the README), so it is visible text
              // on its own chip rather than a tooltip you have to know to hover.
              agent.port ? badge(`:${agent.port}`, "muted", `127.0.0.1:${agent.port}`) : null,
            ),

            // `available === false` is a hard stop: the remote binary is not
            // there, so every launch button is disabled rather than left to fail
            // with an ssh exit code the person has to decode.
            agent.available === false
              ? h("div", { className: "dra-err" }, t("notInstalled", { cmd: agent.command ?? agent.id }))
              : agent.hint
                ? h("div", { className: "dra-hint" }, agent.hint)
                : null,

            running && tunnelDown ? h("div", { className: "dra-warn" }, t("tunnelDownRunning")) : null,

            h(
              "div",
              { className: "dra-btns" },
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  "data-primary": "true",
                  disabled: busy !== null || blocked || (url === null && !running),
                  title: url ?? t("noUrlYet"),
                  // `noopener` is deliberate: the remote page is authorized by a
                  // cookie for 127.0.0.1:<port> and has no business holding a
                  // handle on this window.
                  onClick: () => withUrl(alias, agent, (target) => window.open(target, "_blank", "noopener")),
                },
                t("open"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  disabled: busy !== null || blocked || (url === null && !running),
                  onClick: () => withUrl(alias, agent, copyOrSay),
                },
                t("copyUrl"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  "data-primary": canStart ? "true" : "false",
                  disabled: busy !== null || !canStart,
                  onClick: () => agentOp("start", alias, agent.id),
                },
                t("start"),
              ),
              h(
                "button",
                { type: "button", className: "dra-btn", disabled: busy !== null || !running, onClick: () => agentOp("stop", alias, agent.id) },
                t("stop"),
              ),
              h(
                "button",
                { type: "button", className: "dra-btn", disabled: busy !== null || blocked, onClick: () => agentOp("restart", alias, agent.id) },
                t("restart"),
              ),
              h(
                "button",
                { type: "button", className: "dra-btn", disabled: busy !== null, onClick: () => showLogs(alias, agent.id) },
                logsEntry === null ? t("logs") : t("reload"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  "data-on": embedded ? "true" : "false",
                  disabled: busy !== null || (url === null && !running),
                  title: embedded ? t("unembed") : t("embed"),
                  onClick: () => setEmbeds((current) => ({ ...current, [key]: current[key] !== true })),
                },
                embedded ? t("unembed") : t("embed"),
              ),
            ),

            noteEntry !== null
              ? h("div", { className: "dra-note", "data-error": noteEntry.error ? "true" : "false" }, noteEntry.message)
              : null,

            // The frame is only rendered with a real URL. The remote page is
            // allowed to be framed (no X-Frame-Options, no frame-ancestors CSP)
            // and the cookie's authority — 127.0.0.1:<port>, the same port the
            // forward binds locally — matches the frame's origin, so the embed
            // authenticates exactly like the pop-out tab.
            embedded && url !== null
              ? h("iframe", {
                  className: "dra-frame",
                  src: url,
                  title: `${alias} · ${agent.label ?? agent.id}`,
                  style: {
                    width: "100%",
                    height: "420px",
                    border: "1px solid var(--dsw-alias-border-l2)",
                  },
                })
              : embedded
                ? h("div", { className: "dra-hint" }, t("embedNoUrl"))
                : null,

            logsEntry !== null
              ? h(
                  "div",
                  { className: "dra-logs" },
                  h(
                    "div",
                    { className: "dra-logs-head" },
                    h("span", { className: "dra-logs-title" }, t("logsTitle")),
                    h(
                      "button",
                      { type: "button", className: "dra-btn", disabled: busy !== null || logsEntry.status === "loading", onClick: () => showLogs(alias, agent.id) },
                      logsEntry.status === "loading" ? t("busy") : t("reload"),
                    ),
                    h(
                      "button",
                      { type: "button", className: "dra-btn", onClick: () => closeLogs(alias, agent.id) },
                      t("close"),
                    ),
                  ),
                  logsEntry.error ? h("div", { className: "dra-err" }, t("failed", { message: logsEntry.error })) : null,
                  h("pre", { className: "dra-pre" }, logsEntry.text === "" ? t("logsEmpty") : logsEntry.text),
                )
              : null,
          );
        };

        const ttyAgent = (alias, agent, key) => {
          const blocked = agent.available === false;
          const noteEntry = notes[key] ?? null;
          const hasCommand = typeof agent.ttyCommand === "string" && agent.ttyCommand.trim() !== "";
          return h(
            "div",
            { className: "dra-agent", key },
            h(
              "div",
              { className: "dra-agent-top" },
              h("span", { className: "dra-dot", "data-on": agent.state === "running" ? "true" : "false" }),
              h("span", { className: "dra-agent-name" }, agent.label ?? agent.id),
              badge(t("kindTty"), "business"),
              stateBadge(t, agent),
              availabilityBadge(t, agent),
              agent.command ? badge(agent.command, "muted") : null,
            ),

            blocked
              ? h("div", { className: "dra-err" }, t("notInstalled", { cmd: agent.command ?? agent.id }))
              : agent.hint
                ? h("div", { className: "dra-hint" }, agent.hint)
                : null,

            h(
              "div",
              { className: "dra-btns" },
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  "data-primary": "true",
                  // A tty agent is reached by opening a shell and typing, so
                  // "not installed" must not offer it — there is nothing to type.
                  disabled: busy !== null || blocked,
                  onClick: () => openInTerminal(alias, agent),
                },
                t("openTerminal"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dra-btn",
                  disabled: busy !== null || !hasCommand,
                  onClick: () => copyCommand(alias, agent),
                },
                t("copyCommand"),
              ),
            ),

            // The command is typed into this window's own terminal tab (see
            // `openInTerminal`); copy is the fallback when that cannot happen.
            blocked ? null : h("div", { className: "dra-hint" }, t("terminalHint")),

            noteEntry !== null
              ? h("div", { className: "dra-note", "data-error": noteEntry.error ? "true" : "false" }, noteEntry.message)
              : null,
          );
        };

        const agentRow = (alias, agent, index) => {
          const key = agentKey(alias, agent.id ?? index);
          return agent.kind === "tty" ? ttyAgent(alias, agent, key) : webAgent(alias, agent, key);
        };

        /** The result of one `probe`, kept under the host header that asked for it. */
        const probeBlock = (entry) => {
          const data = entry?.data ?? null;
          if (data === null) return null;
          const found = data.found !== null && typeof data.found === "object" ? data.found : {};
          const commands = Object.keys(found);
          return h(
            "div",
            { className: "dra-probe" },
            data.loginPath
              ? h("div", { className: "dra-probe-path", title: data.loginPath }, `${t("loginPath")}: ${data.loginPath}`)
              : null,
            commands.length === 0
              ? h("div", { className: "dra-hint" }, t("probeNone"))
              : h(
                  "div",
                  { className: "dra-chips" },
                  commands.map((command) =>
                    h(
                      "span",
                      {
                        key: command,
                        className: "dra-chip",
                        "data-on": typeof found[command] === "string" ? "true" : "false",
                        title: typeof found[command] === "string" ? found[command] : t("notFound"),
                      },
                      typeof found[command] === "string" ? command : `${command} · ${t("notFound")}`,
                    ),
                  ),
                ),
          );
        };

        const hostCard = (host, index) => {
          const alias = String(host.alias ?? index);
          const agents = Array.isArray(host.agents) ? host.agents : [];
          const probe = probes[alias] ?? null;
          const reachable = host.reachable === true;
          return h(
            "div",
            { className: "dra-host", key: alias },
            h(
              "div",
              { className: "dra-host-head" },
              h("span", {
                className: "dra-dot",
                "data-on": reachable ? "true" : "false",
                title: reachable ? t("reachable") : t("unreachable"),
              }),
              h("span", { className: "dra-host-label" }, host.label ?? alias),
              h("code", { className: "dra-host-alias", title: alias }, alias),
              h(
                "button",
                { type: "button", className: "dra-btn", disabled: busy !== null, onClick: () => probeHost(alias) },
                busy === `probe:${alias}` ? t("probing") : t("probe"),
              ),
            ),

            // An unreachable host still lists its agents — as `unknown` rows —
            // because "which agents would I have if this machine answered" is
            // the question a broken ssh connection makes you ask.
            reachable === false && host.error
              ? h("div", { className: "dra-err" }, t("failed", { message: host.error }))
              : null,

            probe !== null && probe.status === "error"
              ? h("div", { className: "dra-err" }, t("failed", { message: probe.error }))
              : null,
            probeBlock(probe),

            agents.length === 0
              ? h("div", { className: "dra-empty" }, t("noAgents"))
              : h("div", { className: "dra-agents" }, agents.map((agent, i) => agentRow(alias, agent, i))),
          );
        };

        const data = resource.data;
        const hosts = data !== null && Array.isArray(data.hosts) ? data.hosts : [];
        const problems = data !== null && Array.isArray(data.problems) ? data.problems : [];
        const busyAny = busy !== null;

        return h(
          "div",
          { className: "dra-root" },
          h(
            "div",
            { className: "dra-head" },
            h(RemoteIcon, { size: 15 }),
            h("span", { className: "dra-title" }, t("tab")),
            h(
              "button",
              {
                type: "button",
                className: "dra-iconbtn",
                disabled: busyAny || resource.status === "loading",
                onClick: () => loadOverview(false),
              },
              resource.status === "loading" ? t("refreshing") : t("refresh"),
            ),
          ),

          toast !== null
            ? h("div", { className: "dra-toast", "data-error": toast.error ? "true" : "false" }, toast.message)
            : null,

          h(
            "div",
            { className: "dra-scroll" },

            // A config problem is not an agent failure, but it explains why a
            // host or agent the person expected is simply absent from the list.
            problems.length > 0
              ? h(
                  "div",
                  { className: "dra-host" },
                  ...problems.map((problem, index) =>
                    h("div", { className: "dra-err", key: `${index}` }, String(problem)),
                  ),
                )
              : null,

            // A refresh that failed on top of good data names the failure and
            // keeps the rows: the last known state of a remote machine is still
            // worth more than an empty panel.
            resource.status === "error" && hosts.length > 0
              ? h("div", { className: "dra-err" }, t("failed", { message: resource.error }))
              : null,

            hosts.length > 0
              ? hosts.map(hostCard)
              : resource.status === "error"
                ? h(
                    "div",
                    { className: "dra-empty" },
                    h("div", { className: "dra-err" }, t("failed", { message: resource.error })),
                    h(
                      "button",
                      { type: "button", className: "dra-btn", disabled: busyAny, onClick: () => loadOverview(false) },
                      t("retry"),
                    ),
                  )
                : resource.status === "loading"
                  ? h("div", { className: "dra-empty" }, t("busy"))
                  : h("div", { className: "dra-empty" }, t("noHosts")),
          ),

          data !== null && Number.isFinite(data.generatedAt)
            ? h("div", { className: "dra-foot" }, t("generated", { when: relativeTime(t, data.generatedAt, now) }))
            : null,
        );
      };
    }

    /** The tab chip; kept boxless so the strip lays it out. */
    function makeTabTitle(t) {
      return function RemoteAgentTabTitle() {
        return h(
          "span",
          { className: "dra-tab-title" },
          h(RemoteIcon, { size: 15 }),
          h("span", { className: "dra-tab-title-label" }, t("tab")),
        );
      };
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    function apply(ctx) {
      installStyles();

      ctx.effect(() => ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH }), "dsh-remote-agent: dictionaries");
      const t = ctx.locale.bind(NS);

      // The built-in terminal IS reachable from a plugin — the Sidebar owns the
      // tab and opens it through the same pair its own shortcut uses
      // (`commandTarget(null)` then `openTabFromTarget("terminal", …)`), and
      // `webTerminals` hands back the view that tab renders. Both faces start
      // absent on purpose: a build without either package must still get a
      // working tab, and the tty rows then fall back to copying the command.
      const faces = { sidebarRight: () => null, webTerminals: () => null };
      const captureFace = (name) => (scoped) => {
        const read = () => scoped?.[name] ?? null;
        faces[name] = read;
        scoped.effect(
          () => {
            faces[name] = read;
            return () => {
              faces[name] = () => null;
            };
          },
          `dsh-remote-agent: ${name} face`,
        );
      };
      ctx.inject(["sidebarRight"], captureFace("sidebarRight"));
      ctx.inject(["webTerminals"], captureFace("webTerminals"));

      const Body = makeBody(ctx, t, faces);

      // The right Sidebar tab: the type first (which also contributes the guide
      // card), then its body and chip under the type's own id.
      ctx.inject(["sidebarRightTabs"], (scoped) => {
        const tabs = scoped.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== "function") return;

        scoped.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              title: () => t("tab"),
              guide: [{ order: 30, title: () => t("tab"), description: () => t("guide"), icon: RemoteIcon }],
            }),
          "dsh-remote-agent: sidebar tab type",
        );
        scoped.slots.inject("sidebar.right.pane.tab", () =>
          scoped.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, locale: NS }, Body),
        );
        scoped.slots.inject("sidebar.right.pane.tab.title", () =>
          scoped.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, makeTabTitle(t)),
        );
      });
    }

    return { name: "dsh-remote-agent", inject: ["slots", "locale"], apply };
  },
});
