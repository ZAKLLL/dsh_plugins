/**
 * dsh-session-hub — Client half.
 *
 * Three contributions, one story:
 *
 *   sidebar.footer.action        the entry beside Settings
 *   shell.overlay                the full-screen Session Hub panel
 *   conversation.composer.dock   a session-scoped bridge that hands the panel the
 *                                live composer's `inputActions`, so "continue"
 *                                can put the transcript into the current draft
 *
 * Data comes from the Host half over the shared `/api` Fetch route.
 *
 * @module dsh-session-hub/client
 */

window.__ModuleLoader__.load({
  id: "dsh-session-hub",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "session-hub";
    const ROUTE = "/api/session-hub";
    const STYLE_ID = "dsh-session-hub/client.css";
    /** The right-Sidebar tab type's identity; also the key its body and chip use. */
    const TAB_ID = "dsh-session-hub";
    /** Rows a group shows before "show more". */
    const PAGE_SIZE = 10;

    /* ---------------------------------------------------------------- *
     * Dictionaries
     * ---------------------------------------------------------------- */

    const DICT_EN = {
      entry: "Agents Session Manager",
      title: "Agents Session Manager",
      tab: "Agents Session Manager",
      modeList: "List",
      lastActive: "Last activity",
      guide: "Every coding-agent session on this machine, draggable into the composer.",
      subtitle: "Every coding-agent session on this machine, across every project.",
      close: "Close",
      refresh: "Refresh",
      refreshing: "Scanning…",
      search: "Search titles, projects, session ids…",
      groupProject: "By project",
      groupAgent: "By agent",
      groupFlat: "Ungrouped",
      all: "All",
      empty: "No sessions match.",
      emptyHint: "Sessions appear here once an agent has written one to disk.",
      continue: "Continue here",
      continuing: "Preparing…",
      openOriginal: "Open in {agent}",
      openInDsh: "Open in DSH",
      resumeIn: "Resume in {terminal}",
      opened: "Resumed in {terminal}",
      copied: "Resume command copied",
      manual: "Run this in a terminal",
      running: "running",
      onlyRunning: "Running only",
      noComposer: "Open a conversation first — the draft lives in the composer.",
      dragHint: "Drag a card into the composer to hand its history to the agent.",
      inserted: "Transcript added to the draft — press Enter to send.",
      failed: "Failed: {message}",
      count: "{n} sessions",
      countOf: "{n} of {total}",
      partial: "partially read",
      messages: "{n} messages",
      messagesPlus: "{n}+ messages",
      updated: "updated {when}",
      showHint: "Drag into the composer, or use Continue here.",
      collapse: "Collapse this group",
      expand: "Expand this group",
      showMore: "Show more",
      showLess: "Show less",
      remove: "Delete session",
      deleting: "Deleting…",
      deleteTitle: "Delete this session?",
      deleteBody: "This removes the session from {agent}'s own store. It cannot be undone.",
      deleteRunning: "That agent is still running. Deleting a live session's log can break it.",
      deleteForce: "Delete anyway",
      cancel: "Cancel",
      deleted: "Deleted from {agent}",
      expandTree: "Show {n} subagent sessions",
      collapseTree: "Hide subagent sessions",
      subagents: "{n} subagents",
      removeGroup: "Delete every session in this project",
      deleteGroupTitle: "Delete every session in this project?",
      deleteGroupBody: "Removes {n} sessions from each agent's own store. It cannot be undone.",
      deleteGroupRunning: "{n} of them are running and will be skipped.",
      alsoRunning: "Also delete the {n} running sessions",
      deleteGroupAction: "Delete {n} sessions",
      deletedMany: "Deleted {n} sessions, skipped {m}",
      pin: "Pin to the top",
      unpin: "Unpin",
      pinProject: "Pin this project to the top",
      unpinProject: "Unpin this project",
      live: "Live",
      liveRunning: "{n} running",
      liveIn: "in",
      liveOut: "out",
      liveNothing: "nothing reported yet",
      liveNoOutput: "no output yet",
      liveHookSource: "reported through a hook",
      liveStoreSource: "read from its own session store",
      liveIdle: "No agent is running right now",
      reference: "Reference this session in the draft",
      focusIn: "Jump to the {terminal} window it is already running in",
      openInVscode: "Open this project in VS Code",
      detailModel: "Model",
      stepsCount: "{n} intermediate steps",
      compacted: "Context compacted here",
      showSummary: "Show what it was replaced with",
      hideSummary: "Hide the summary",
      collapsedTokens: "{n} tokens folded away",
      showSteps: "Show the working-out",
      hideSteps: "Hide the working-out",
      openedEditor: "Opened in {editor}",
      readSession: "Read this conversation",
      loading: "Loading…",
      you: "You",
      noTurns: "This session recorded no turns",
      truncatedNote: "Showing the newest turns of {n}",
      focused: "Switched to its {terminal} window",
      referenceNone: "This session has no store that can be referenced",
      liveHint: "Select a tile for detail",
      detailDir: "Directory",
      detailUptime: "Up for",
      detailPid: "Process",
      detailTokens: "Tokens",
      detailWaiting: "Waiting",
      waitApproval: "Needs approval",
      waitTool: "Tool running",
      noWaiting: "Nothing blocked",
      noTokens: "none \u2014 this agent records no token usage",
      tokIn: "in",
      tokOut: "out",
      tokCache: "cache",
      tokTotal: "total",
      close: "Close",
      newSession: "Start a session in this project",
      spawnTitle: "Start a new session",
      spawnBody: "Pick the agent to run in {project}.",
      started: "Started {agent} in that project",
      startedDsh: "Opened a new DSH session there",
      noWorkspace: "DSH workspace registry or navigation is unavailable",
      liveCollapse: "Collapse the live preview",
      liveExpand: "Expand the live preview",
    };

    const DICT_ZH = {
      entry: "Agents 会话管理",
      title: "Agents 会话管理",
      tab: "Agents 会话管理",
      modeList: "列表",
      lastActive: "最近交互",
      guide: "本机全部 coding agent 的会话，可拖进输入框交给我。",
      subtitle: "本机全部 coding agent 的会话，跨所有项目汇总在这里。",
      close: "关闭",
      refresh: "重新扫描",
      refreshing: "扫描中…",
      search: "搜索标题、项目、会话 id…",
      groupProject: "按项目",
      groupAgent: "按 agent",
      groupFlat: "不分组",
      all: "全部",
      empty: "没有匹配的会话。",
      emptyHint: "某个 agent 落盘会话后，这里就会出现。",
      continue: "在此续接",
      continuing: "准备中…",
      openOriginal: "用 {agent} 打开",
      openInDsh: "在 DSH 打开",
      resumeIn: "在 {terminal} 继续",
      opened: "已在 {terminal} 唤起",
      copied: "续接命令已复制",
      manual: "请在终端执行",
      running: "运行中",
      onlyRunning: "只看运行中",
      noComposer: "请先打开一个对话——草稿住在输入框里。",
      dragHint: "把卡片拖进输入框，即可把会话历史交给当前 agent。",
      inserted: "会话历史已放进输入框，回车即可发送。",
      failed: "失败：{message}",
      count: "{n} 个会话",
      countOf: "{n} / {total}",
      partial: "仅读取了前缀",
      messages: "{n} 条消息",
      messagesPlus: "{n}+ 条消息",
      updated: "更新于 {when}",
      showHint: "拖进输入框，或点「在此续接」。",
      collapse: "收起该分组",
      expand: "展开该分组",
      showMore: "查看更多",
      showLess: "收起",
      remove: "删除会话",
      deleting: "删除中…",
      deleteTitle: "删除这个会话？",
      deleteBody: "这会从 {agent} 自己的存储里删除该会话，无法撤销。",
      deleteRunning: "该 agent 仍在运行。删除运行中会话的日志可能让它出错。",
      deleteForce: "仍然删除",
      cancel: "取消",
      deleted: "已从 {agent} 删除",
      expandTree: "展开 {n} 个子代理会话",
      collapseTree: "收起子代理会话",
      subagents: "{n} 个子代理",
      removeGroup: "删除该项目下的全部会话",
      deleteGroupTitle: "删除这个项目下的全部会话？",
      deleteGroupBody: "会从各 agent 自己的存储中删除 {n} 个会话，无法撤销。",
      deleteGroupRunning: "其中 {n} 个正在运行，默认跳过。",
      alsoRunning: "同时删除这 {n} 个运行中的会话",
      deleteGroupAction: "删除 {n} 个会话",
      deletedMany: "已删除 {n} 个，跳过 {m} 个",
      pin: "置顶",
      unpin: "取消置顶",
      pinProject: "置顶该项目",
      unpinProject: "取消置顶该项目",
      live: "实时",
      liveRunning: "{n} 个运行中",
      liveIn: "输入",
      liveOut: "输出",
      liveNothing: "暂无内容",
      liveNoOutput: "还没有输出",
      liveHookSource: "由 hook 上报",
      liveStoreSource: "从它自己的会话记录读取",
      liveIdle: "目前没有 agent 在运行",
      reference: "把这条会话引用进草稿",
      focusIn: "跳到它正在运行的 {terminal} 窗口",
      openInVscode: "用 VS Code 打开这个项目",
      detailModel: "模型",
      stepsCount: "{n} 条中间过程",
      compacted: "上下文在此被压缩",
      showSummary: "查看压缩后替换成了什么",
      hideSummary: "收起摘要",
      collapsedTokens: "折叠了 {n} tokens",
      showSteps: "展开中间过程",
      hideSteps: "收起中间过程",
      openedEditor: "已在 {editor} 中打开",
      readSession: "阅读这条会话",
      loading: "加载中…",
      you: "你",
      noTurns: "这条会话没有记录任何发言",
      truncatedNote: "只显示最新的若干轮（共 {n} 轮）",
      focused: "已切换到它的 {terminal} 窗口",
      referenceNone: "这条会话没有可作为引用目标的存储",
      liveHint: "点方块看详情",
      detailDir: "目录",
      detailUptime: "运行时长",
      detailPid: "进程",
      detailTokens: "Token 用量",
      detailWaiting: "等待中",
      waitApproval: "等确认",
      waitTool: "工具进行中",
      noWaiting: "没有阻塞",
      noTokens: "无 —— 该 agent 不记录 token 用量",
      tokIn: "输入",
      tokOut: "输出",
      tokCache: "缓存",
      tokTotal: "合计",
      close: "关闭",
      newSession: "在该项目新建会话",
      spawnTitle: "新建会话",
      spawnBody: "选择要在 {project} 里运行的 agent。",
      started: "已在该项目启动 {agent}",
      startedDsh: "已在那里打开一个新的 DSH 会话",
      noWorkspace: "DSH 工作区注册表或导航不可用",
      liveCollapse: "收起实时预览",
      liveExpand: "展开实时预览",
    };

    /* ---------------------------------------------------------------- *
     * Styles — theme tokens only, so light/dark follow the host
     * ---------------------------------------------------------------- */

    const CSS = `
.sh-entry{box-sizing:border-box;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.sh-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sh-entry-rail{border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.sh-entry-label{text-align:left;white-space:nowrap;text-overflow:ellipsis;flex:auto;min-width:0;overflow:hidden}
.sh-badge{font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:0 6px;font-size:10px;line-height:16px}
.sh-backdrop{z-index:200;background:var(--dsw-alias-bg-mask-1,#00000073);justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.sh-card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);width:min(1180px,100vw - 32px);height:calc(100% - 80px);box-shadow:var(--dsw-shadow-lv3,0 12px 32px #0006);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:16px 18px 14px;font-size:13px;display:flex;overflow:hidden}
.sh-head{flex-wrap:wrap;flex:none;align-items:center;gap:10px;margin-bottom:12px;display:flex}
.sh-title{white-space:nowrap;font-size:15px;font-weight:600}
.sh-sub{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0;font-size:12px}
.sh-btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:8px;flex:none;align-items:center;gap:5px;padding:4px 10px;font-size:12px;display:inline-flex}
.sh-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary)}
.sh-btn:disabled{opacity:.45;cursor:default}
.sh-icon{width:26px;height:26px;justify-content:center;padding:0}
.sh-close{width:28px;height:28px;justify-content:center;padding:0;margin-left:auto}
.sh-tools{flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;display:flex}
.sh-search{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);min-width:140px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;outline:none;flex:1 1 230px;padding:5px 10px;font-size:12px}
.sh-search:focus{border-color:var(--dsw-alias-label-secondary)}
.sh-search::placeholder{color:var(--dsw-alias-label-secondary)}
.sh-chips{flex-wrap:wrap;gap:6px;display:flex}
.sh-chip{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap;background:0 0;border-radius:999px;align-items:baseline;gap:5px;padding:2px 10px;font-size:11px;line-height:1.5;display:inline-flex}
.sh-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.sh-chip-on,.sh-chip-on:hover{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:#0000}
.sh-chip-n{font-variant-numeric:tabular-nums;opacity:.65;font-size:10px}
.sh-scroll{scrollbar-gutter:stable;flex:auto;min-height:0;padding-right:8px;overflow-y:auto}
.sh-slot{flex-direction:column}
.sh-rowlist>*+*{margin-top:2px}
/* The header row has to be a flex line of its own: without it the head button,
   being block-level, takes the full width and pushes its controls onto a second
   line instead of sitting beside the project name. */
.sh-group{align-items:center;padding:0 4px 0 0;display:flex}
.sh-group-head{box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);height:34px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;padding:0 8px;display:flex;flex:1 1 auto;min-width:0;background:0 0;border:0;font:inherit;text-align:left}
.sh-group-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sh-group-actions{flex:none;align-items:center;gap:2px;display:none;margin-left:4px}
.sh-group:hover .sh-group-actions{display:inline-flex}
.sh-group-name{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;font-weight:600;flex:1;overflow:hidden}
.sh-group-count{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;line-height:16px;font-variant-numeric:tabular-nums}
.sh-group-time{color:var(--dsw-alias-label-secondary);flex:none;font-variant-numeric:tabular-nums;font-size:11px;line-height:16px;margin-right:2px}
.sh-group-arrow{transition:transform .15s var(--ds-ease-in-out,ease);color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex:none;display:inline-flex}
.sh-group-arrow-open{transform:rotate(90deg)}
.sh-group-folder{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}
.sh-row{box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);padding:0 4px 0 8px;cursor:grab;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;display:flex;height:32px}
.sh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sh-row-slot{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:inline-flex}
.sh-caret-cell{width:14px;height:20px;flex:none;justify-content:center;align-items:center;display:inline-flex}
.sh-caret-btn{border:0;background:0 0;cursor:pointer;width:14px;height:20px;color:var(--dsw-alias-label-tertiary);justify-content:center;align-items:center;padding:0;display:inline-flex}
.sh-caret-btn:hover{color:var(--dsw-alias-label-primary)}
.sh-pin-cell{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:inline-flex}
.sh-pin-btn{border:0;background:0 0;cursor:pointer;width:16px;height:20px;color:var(--dsw-alias-label-tertiary);opacity:0;justify-content:center;align-items:center;padding:0;display:inline-flex}
.sh-row:hover .sh-pin-btn{opacity:1}
.sh-pin-btn:hover{color:var(--dsw-alias-label-primary)}
.sh-pin-on,.sh-pin-on:hover{opacity:1;color:var(--dsw-alias-state-business-primary)}
.sh-pin-mark{color:var(--dsw-alias-state-business-primary);flex:none;display:inline-flex;margin-left:-2px}
.sh-sub-count{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;flex:none;padding:0 5px;font-size:9px;line-height:14px;font-variant-numeric:tabular-nums}
.sh-agent-dot{border-radius:50%;width:7px;height:7px;flex:none}
.sh-agent-dot-dsh{background:var(--color-blue-500);color:var(--color-blue-500)}
.sh-agent-dot-claude{background:#d97757;color:#d97757}
.sh-agent-dot-codex{background:var(--color-green-500);color:var(--color-green-500)}
.sh-agent-dot-gemini{background:#7b6cff;color:#7b6cff}
.sh-agent-dot-pi{background:#e879a6;color:#e879a6}
.sh-agent-dot-opencode{background:#06b6d4;color:#06b6d4}
.sh-dot-running{animation:sh-pulse 2.2s ease-out infinite}
@keyframes sh-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 55%,transparent)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.sh-row-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;flex:1;overflow:hidden}
.sh-agent-tag{border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary-inverted);flex:none;font-size:9px;font-weight:600;line-height:15px;padding:0 4px;letter-spacing:.02em}
.sh-row-time{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums;font-size:10px;line-height:16px}
.sh-row-actions{flex:none;align-items:center;gap:2px;display:none}
.sh-row:hover .sh-row-actions{display:inline-flex}
.sh-row:hover .sh-row-time{display:none}
.sh-icon-btn{border-radius:var(--dsw-radius-xs,4px);cursor:pointer;width:22px;height:22px;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.sh-icon-btn:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.sh-icon-btn:disabled{opacity:.4;cursor:default}
.sh-icon-btn-danger:hover:enabled{color:var(--dsw-alias-state-error-primary)}
.sh-more{border-radius:var(--dsw-radius-md,8px);width:100%;height:28px;margin-top:2px;cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;align-items:center;gap:6px;padding:0 8px 0 28px;font:inherit;font-size:12px;display:flex}
.sh-more:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sh-dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);width:min(520px,100vw - 48px);box-shadow:var(--dsw-shadow-lv3,0 12px 32px #0006);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;gap:12px;padding:18px 20px 16px;font-size:13px;display:flex}
.sh-dialog-title{font-size:15px;font-weight:600}
.sh-dialog-session{align-items:center;gap:8px;min-width:0;display:flex}
.sh-dialog-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.sh-dialog-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-tertiary);word-break:break-all;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px;font-size:11px;line-height:16px}
.sh-dialog-warn{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.sh-dialog-danger{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.sh-dialog-check{color:var(--dsw-alias-label-primary);cursor:pointer;align-items:center;gap:7px;font-size:12px;line-height:18px;display:flex}
.sh-dialog-check input{accent-color:var(--dsw-alias-state-error-primary);margin:0}
.sh-spawn-list{flex-direction:column;gap:5px;display:flex}
.sh-spawn-btn{justify-content:flex-start;gap:8px;padding:8px 11px;font-size:13px}
.sh-dialog-actions{justify-content:flex-end;gap:8px;display:flex}
.sh-danger{color:var(--dsw-alias-state-error-primary)}
.sh-danger-strong,.sh-danger-strong:hover:enabled{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.sh-danger-strong:hover:enabled{opacity:.88}
.sh-spacer{flex:auto}
.sh-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:44px 12px;font-size:12px;line-height:1.7}
.sh-foot{color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:10px;margin-top:10px;padding-top:9px;font-size:11px;display:flex}
.sh-toast{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3,0 8px 24px #0004);color:var(--dsw-alias-label-primary);border-radius:999px;flex:none;padding:4px 12px;font-size:11px}
.sh-toast-error{color:var(--dsw-alias-state-error-primary,inherit)}
.sh-tab-title{align-items:center;gap:6px;min-width:0;display:flex}
.sh-tab-title-label{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
.sh-sidebar{box-sizing:border-box;color:var(--dsw-alias-label-primary);flex-direction:column;height:100%;min-height:0;padding:10px 12px;font-size:13px;display:flex;overflow:hidden}
.sh-sidebar .sh-head{margin-bottom:9px}
.sh-sidebar .sh-scroll{padding-right:4px}
.sh-sidebar .sh-rowlist{padding-bottom:10px}
.sh-sidebar .sh-foot{flex-wrap:wrap;gap:6px}
.sh-modes{gap:6px;margin-bottom:10px;flex:none;display:flex}
.sh-lp-dot{background:var(--color-green-500);border-radius:50%;flex:none;width:7px;height:7px;animation:sh-pulse 2.2s ease-out infinite;color:var(--color-green-500)}
.sh-lp-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);flex-direction:column;gap:5px;padding:8px 10px;display:flex}
.sh-lp-card+.sh-lp-card{margin-top:8px}
.sh-lp-card-head{align-items:center;gap:6px;min-width:0;display:flex}
.sh-lp-actions{flex:none;align-items:center;gap:2px;display:inline-flex}
.sh-lp-agent{color:var(--dsw-alias-label-primary);white-space:nowrap;flex:none}
.sh-lp-proj{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.sh-lp-line{display:flex;gap:7px;min-width:0}
.sh-lp-k{color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.05em;flex:none;min-width:24px;font-size:10px;padding-top:2px}
.sh-lp-v{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden;white-space:pre-wrap}
.sh-lp-kind{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:10px}
.sh-lp-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-weight:600;overflow-wrap:anywhere}
.sh-lp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.sh-live-detail{margin-top:8px}
.sh-tiles{gap:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr))}
.sh-tile{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:inherit;font:inherit;text-align:left;flex-direction:column;gap:4px;padding:9px 10px;min-height:100px;display:flex;overflow:hidden}
.sh-tile:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sh-tile:focus-visible{outline:2px solid var(--color-blue-500);outline-offset:1px}
.sh-tile-on{border-color:var(--color-blue-500)}
.sh-tile-wait{border-color:var(--dsw-alias-state-error-primary)}
.sh-tile-agent{color:var(--dsw-alias-label-primary);font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-tile-head{align-items:center;gap:5px;min-width:0;display:flex}
.sh-tile-title{color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;white-space:normal}
.sh-tile-proj{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sh-tile-foot{margin-top:auto;align-items:center;gap:5px;display:flex;min-width:0}
.sh-tile .sh-icon-btn{width:18px;height:18px}
.sh-row-title-open{cursor:pointer}
.sh-row-title-open:hover{text-decoration:underline}
.sh-row-title-open:focus-visible{outline:2px solid var(--color-blue-500);outline-offset:1px;border-radius:var(--dsw-radius-xs)}
.sh-read{max-width:min(720px,92vw);width:100%;max-height:84vh;flex-direction:column;padding:0;display:flex;overflow:hidden}
.sh-read-head{align-items:center;gap:8px;padding:12px 16px;display:flex;min-width:0;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2)}
.sh-read-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sh-read-model{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}
.sh-read-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;flex-direction:column;gap:14px;padding:14px 16px 18px;display:flex}
.sh-read-note{color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}
.sh-turn-group{flex-direction:column;gap:8px;display:flex;min-width:0}
.sh-compacted{border-left:2px solid var(--dsw-alias-state-business-primary,var(--color-blue-500));padding-left:9px}
.sh-compacted-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}
.sh-compacted-count{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;font-variant-numeric:tabular-nums}
.sh-turn-compacted .sh-turn-body{border-left:0;padding-left:0}
.sh-turn-compacted .sh-turn-text{color:var(--dsw-alias-label-tertiary)}
.sh-steps-toggle{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;align-items:center;gap:5px;padding:2px 0;display:flex;font-size:11px;text-align:left}
.sh-steps-toggle:hover{color:var(--dsw-alias-label-secondary)}
.sh-steps-toggle:focus-visible{outline:2px solid var(--color-blue-500);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.sh-turn{flex-direction:column;gap:5px;display:flex;min-width:0}
.sh-turn-head{align-items:center;gap:6px;display:flex}
.sh-turn-dot{border-radius:50%;flex:none;width:6px;height:6px}
.sh-turn-dot-user{background:var(--color-blue-500)}
.sh-turn-dot-assistant{background:var(--color-green-500)}
.sh-turn-who{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.sh-turn-at{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex:none;font-variant-numeric:tabular-nums;font-size:10px}
.sh-turn-body{flex-direction:column;gap:5px;min-width:0;display:flex;padding-left:12px}
.sh-turn-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:19px}
.sh-turn-user .sh-turn-body{border-left:2px solid var(--color-blue-500);padding-left:11px}
.sh-turn-user .sh-turn-text{color:var(--dsw-alias-label-primary)}
.sh-turn-assistant .sh-turn-body{border-left:2px solid var(--dsw-alias-border-l2);padding-left:11px}
.sh-turn-assistant .sh-turn-text{color:var(--dsw-alias-label-secondary)}
.sh-turn-tool{align-self:flex-start;max-width:100%;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:16px;padding:1px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-tile-time{color:var(--dsw-alias-label-secondary);flex:none;font-variant-numeric:tabular-nums;font-size:10px;line-height:14px}
.sh-tile-badge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px;line-height:13px;padding:0 4px}
.sh-tile-badge-wait{color:var(--dsw-alias-state-error-primary)}
/* The at-sign for the reference action: text, not an icon, so it cannot be
   mistaken for another verb. */
.sh-at{font-size:13px;font-weight:600;line-height:1}
`;

    function installStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-hub";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------------------------------------------------------- *
     * Tiny external stores
     * ---------------------------------------------------------------- */

    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        get: () => snapshot,
        set(next) {
          if (Object.is(next, snapshot)) return;
          snapshot = next;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /** Panel visibility. */
    const panel = createStore({ open: false, toast: null });
    /** The live composer of the session being viewed, published by the dock bridge. */
    const composer = createStore({ sessionId: null, inputActions: null });
    /** The session awaiting delete confirmation, shared by both entry points. */
    const confirming = createStore(null);
    /** The session whose turns are being read, shared by both entry points. */
    const reading = createStore(null);
    /** The project a new session is being started in, shared by both entry points. */
    const spawning = createStore(null);
    /** Bumped after a destructive change so every mounted body reloads. */
    const revision = createStore(0);

    let toastTimer = null;
    function say(message, error) {
      panel.set({ ...panel.get(), toast: { message, error: error === true } });
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => panel.set({ ...panel.get(), toast: null }), 4600);
    }

    /** A stable no-op, so slot props never change identity between renders. */
    function noop() {}

    /* ---------------------------------------------------------------- *
     * Host transport
     * ---------------------------------------------------------------- */

    async function hub(op, payload) {
      const response = await fetch(ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...payload }),
      });
      if (!response.ok) throw new Error(`session-hub ${op}: HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      if (body?.ok !== true) {
        // A Host that does not know this operation is a stale generation, so the
        // message names the operations it does know.
        const supported = Array.isArray(body?.supported) ? ` — host answers: ${body.supported.join(", ")}` : "";
        throw new Error(`${body?.error ?? `session-hub ${op} failed`}${supported}`);
      }
      return body;
    }

    /* ---------------------------------------------------------------- *
     * Formatting
     * ---------------------------------------------------------------- */

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "—";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatWhen(ms, now) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const delta = Math.max(0, now - ms);
      const minute = 60000;
      if (delta < minute) return "now";
      if (delta < 60 * minute) return `${Math.floor(delta / minute)}m`;
      if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))}h`;
      if (delta < 30 * 24 * 60 * minute) return `${Math.floor(delta / (24 * 60 * minute))}d`;
      return new Date(ms).toISOString().slice(0, 10);
    }

    /**
     * What the open action will do, for its tooltip.
     *
     * A session cmux is already running gets focused rather than resumed, so the
     * tooltip has to say which of the two it is — otherwise one icon means two
     * very different things.
     */
    function sessionOpenTitle(t, session) {
      if (session.agent === "dsh") return t("openInDsh");
      if (typeof session.surfaceId === "string" && session.surfaceId !== "") return t("focusIn", { terminal: "cmux" });
      return [t("resumeIn", { terminal: "cmux" }), session.resumeCommand].filter(Boolean).join(" — ");
    }

    /**
     * Group a flat message list into turns.
     *
     * A turn is one user request plus everything the agent did about it. Only the
     * last agent message is the answer; the ones before it are the working-out —
     * narration between tool calls, which is what makes a long session unreadable
     * when every message is laid out flat.
     */
    function groupTurns(messages) {
      const turns = [];
      let current = null;
      for (const message of messages) {
        // Anything that is not the agent's own output opens a turn: a request,
        // or a compaction marker — which is a boundary in its own right.
        const opens = message.role !== "assistant";
        if (opens || current === null) {
          current = { lead: opens ? message : null, steps: [] };
          turns.push(current);
          if (!opens) current.steps.push(message);
          continue;
        }
        current.steps.push(message);
      }
      return turns;
    }

    /**
     * Break one turn into what was said and what was run.
     *
     * The transcripts carry five times as many `> tool: …` lines as turns — 216
     * against 43 in one session here — and interleaved with the prose they turn
     * the reader into a wall of call names. Pulling them out is the difference
     * between reading a conversation and reading a log.
     */
    function turnParts(text) {
      const blocks = [];
      let prose = null;
      for (const line of String(text ?? "").split("\n")) {
        const call = /^>\s*tool:\s*(.*)$/.exec(line);
        if (call !== null) {
          if (prose !== null) {
            blocks.push({ kind: "text", text: prose.join("\n").trim() });
            prose = null;
          }
          blocks.push({ kind: "tool", text: call[1].replace(/^`|`$/g, "") });
          continue;
        }
        if (prose === null) prose = [];
        prose.push(line);
      }
      if (prose !== null) blocks.push({ kind: "text", text: prose.join("\n").trim() });
      return blocks.filter((block) => block.kind === "tool" || block.text !== "");
    }

    /** A running time, kept coarse: 3s / 4m / 2h 10m / 1d 3h. */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return "\u2014";
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
      const days = Math.floor(hours / 24);
      return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
    }

    /** Token counts compactly: 812 / 4.7k / 1.2M. */
    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return "0";
      if (value < 1000) return String(value);
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
      return `${(value / 1000000).toFixed(1)}M`;
    }

    function slugify(text, max = 40) {
      const flat = String(text ?? "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
      return (flat.slice(0, max) || "session").toLowerCase();
    }

    /** The containing directory — what a DSH delete actually removes. */
    function parentOf(path) {
      const cut = String(path).lastIndexOf("/");
      return cut > 0 ? String(path).slice(0, cut) : String(path);
    }

    /* ---------------------------------------------------------------- *
     * Components
     * ---------------------------------------------------------------- */

    function HubIcon(props) {
      const size = props?.size ?? 16;
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
          style: { flex: "none", display: "block" },
        },
        h("rect", { x: 2.5, y: 4, width: 19, height: 13, rx: 2.5 }),
        h("path", { d: "M2.5 8.5h19" }),
        h("path", { d: "M6 11.5h5M6 13.8h8" }),
        h("path", { d: "M11 17v3.5l2.6-1.6" }),
      );
    }

    /** The sidebar entry that opens the panel. */
    function makeEntry(t) {
      return function Entry(props) {
        const wide = props?.wide === true;
        return h(
          "button",
          {
            type: "button",
            className: wide ? "sh-entry" : "sh-entry sh-entry-rail",
            title: t("entry"),
            "aria-label": t("entry"),
            onClick: () => panel.set({ ...panel.get(), open: !panel.get().open }),
          },
          h(HubIcon, { size: wide ? 16 : 18 }),
          wide && h("span", { className: "sh-entry-label" }, t("entry")),
        );
      };
    }

    /** One session card: draggable, with the two continuation verbs. */
    /** Small inline glyphs — this plugin draws its own controls, per the host's rules. */
    function ChevronIcon() {
      return h("svg", { viewBox: "0 0 16 16", width: 12, height: 12, fill: "currentColor", "aria-hidden": true },
        h("path", { d: "M6 3.5 10.5 8 6 12.5z" }));
    }

    function FolderIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor",
        strokeWidth: 1.4, strokeLinejoin: "round", "aria-hidden": true,
      }, h("path", { d: "M1.9 4.3c0-.72.58-1.3 1.3-1.3h2.63l1.4 1.62h5.57c.72 0 1.3.58 1.3 1.3v5.78c0 .72-.58 1.3-1.3 1.3H3.2c-.72 0-1.3-.58-1.3-1.3z" }));
    }

    function ContinueIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("path", { d: "M8 2.6v7.1" }),
        h("path", { d: "M4.8 6.7 8 9.9l3.2-3.2" }),
        h("path", { d: "M2.9 13.3h10.2" }));
    }

    /**
     * The agent, as a short tag in the row head.
     *
     * Its name used to sit as plain text beside the hover actions, where it read
     * as a stray label among the icons. The tag borrows the agent's own colour —
     * deliberately only the `sh-agent-dot-<agent>` class, which sets nothing but
     * `background` and `color`, so the palette stays in one place.
     *
     * The text is the agent id itself: it is already short and recognisable, so a
     * second abbreviation table on top of it would be one more thing to keep in
     * step with the adapters for no gain.
     */
    function AgentTag({ card, t }) {
      return h(
        "span",
        {
          className: `sh-agent-tag sh-agent-dot-${card.agent}`,
          title: card.agentLabel,
        },
        card.agent,
      );
    }

    /** Angle brackets: the universal "open in an editor". */
    function CodeIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("path", { d: "M5.7 4.2 2.5 8l3.2 3.8" }),
        h("path", { d: "M10.3 4.2 13.5 8l-3.2 3.8" }));
    }

    /**
     * A terminal window.
     *
     * This used to draw an arrow leaving an open box — which IS the share icon,
     * and read as one. The verb is "hand this session to the agent that owns
     * it", so the glyph is the thing that runs it: a window with a prompt in it.
     */
    function OpenIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("rect", { x: 1.9, y: 3.1, width: 12.2, height: 9.8, rx: 1.6 }),
        h("path", { d: "M4.9 6.6l1.7 1.7-1.7 1.7" }),
        h("path", { d: "M8.6 10h2.7" }));
    }

    function RefreshIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("path", { d: "M13.2 8a5.2 5.2 0 1 1-1.6-3.75" }),
        h("path", { d: "M13.4 2.4v3.3h-3.3" }));
    }

    function TrashIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("path", { d: "M2.9 4.4h10.2" }),
        h("path", { d: "M6.4 4.4V3.2c0-.44.36-.8.8-.8h1.6c.44 0 .8.36.8.8v1.2" }),
        h("path", { d: "M4.2 4.4l.6 8.1c.03.44.4.79.85.79h4.7c.45 0 .82-.35.85-.79l.6-8.1" }),
        h("path", { d: "M6.7 7v4M9.3 7v4" }));
    }

    function PlusIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor",
        strokeWidth: 1.6, strokeLinecap: "round", "aria-hidden": true,
      },
        h("path", { d: "M8 3.4v9.2" }),
        h("path", { d: "M3.4 8h9.2" }));
    }

    function CloseIcon() {
      return h("svg", {
        viewBox: "0 0 16 16", width: 13, height: 13, fill: "none", stroke: "currentColor",
        strokeWidth: 1.6, strokeLinecap: "round", "aria-hidden": true,
      },
        h("path", { d: "M4.2 4.2l7.6 7.6" }),
        h("path", { d: "M11.8 4.2l-7.6 7.6" }));
    }

    /** The agents a project can start a session with, in a stable order. */
    const SPAWNABLE = [
      { id: "dsh", label: "DSH" },
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "gemini", label: "Gemini CLI" },
      { id: "pi", label: "pi" },
      { id: "opencode", label: "opencode" },
    ];

    /**
     * A push-pin.
     *
     * The first version was a circle with a diagonal line — which is a magnifier,
     * and read as a search control. This is the Material `push_pin` silhouette,
     * outlined when unpinned and filled when pinned.
     */
    function PinIcon({ filled }) {
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 13,
          height: 13,
          fill: filled ? "currentColor" : "none",
          stroke: "currentColor",
          strokeWidth: filled ? 0 : 1.7,
          strokeLinejoin: "round",
          strokeLinecap: "round",
          "aria-hidden": true,
        },
        h("path", {
          d: "M16,9V4l1,0c0.55,0,1-0.45,1-1v0c0-0.55-0.45-1-1-1H7C6.45,2,6,2.45,6,3v0c0,0.55,0.45,1,1,1l1,0v5c0,1.66-1.34,3-3,3v2h5.97v7l1,1l1-1v-7H19v-2C17.34,12,16,10.66,16,9z",
        }),
      );
    }

    /**
     * One session row, laid out like the shipped workspace list: a 16px leading
     * slot carrying the agent colour and the live pulse, one ellipsized title,
     * and a right-aligned time that gives way to the hover actions.
     */
    /**
     * Dragging a session out of the panel and into the composer.
     *
     * Shared by the session list and the live view: the payload is a `File`
     * carrying the transcript when the prefetch has landed, plus a readable
     * text fallback for anything that refuses file items.
     */
    function useSessionDrag({ card, transcriptCache, onDragState }) {
      /**
       * Fetch (and cache) the transcript so `dragstart` can carry it.
       *
       * `dragstart` cannot await, so the fetch has to have finished before the
       * drag begins. Hover is the earliest signal; a press is the last one that
       * still leaves any time, and a focus is what a keyboard drag gets.
       */
      const prefetch = React.useCallback(() => {
        if (transcriptCache.has(card.key)) return;
        transcriptCache.set(card.key, null);
        hub("transcript", { key: card.key })
          .then((result) => transcriptCache.set(card.key, result.markdown))
          .catch(() => transcriptCache.delete(card.key));
      }, [card.key, transcriptCache]);

      const onDragStart = React.useCallback(
        (event) => {
          // Clear the overlay's pointer events so the drop lands on the composer
          // underneath. Applied imperatively: re-rendering the drag source
          // mid-drag cancels the drag in some browsers.
          onDragState(true);

          const text = transcriptCache.get(card.key);
          const ready = typeof text === "string" && text !== "";
          // Name the file after the session, not after the store path: this name
          // is what the drop shows as a chip, and `claude-<slug>.md` reads as a
          // stray file rather than as the conversation that was dragged.
          const name = `${card.agentLabel} · ${slugify(card.title, 60)}.md`;

          try {
            event.dataTransfer.effectAllowed = "copy";
            // `text/plain` is the only representation this composer inserts
            // literally, and it is what every text-only drop target reads — so it
            // carries the transcript itself, not a path to it. The Host resolves
            // the attachment route separately; either way the content arrives.
            event.dataTransfer.setData(
              "text/plain",
              ready ? text : `${card.agentLabel} · ${card.title}\n${card.file}\n\n(history still loading — hover the row a moment and drag again)`,
            );
            if (ready) event.dataTransfer.items.add(new File([text], name, { type: "text/markdown" }));
          } catch {
            /* A browser that refuses File items still carries the text payload. */
          }
        },
        [card, transcriptCache, onDragState],
      );

      const onDragEnd = React.useCallback(() => onDragState(false), [onDragState]);
      return { prefetch, onDragStart, onDragEnd };
    }

    function SessionRow({ card, t, onContinue, onOpen, onDelete, onToggleTree, onTogglePin, transcriptCache, onDragState, now, running, cmuxAvailable, showAgent, depth = 0, descendants = 0, open = false, pinned = false }) {
      const [busy, setBusy] = React.useState(false);
      const { prefetch, onDragStart, onDragEnd } = useSessionDrag({ card, transcriptCache, onDragState });

      const run = (operation) => async () => {
        setBusy(true);
        try {
          await operation();
        } finally {
          setBusy(false);
        }
      };

      const openTitle = card.agent === "dsh"
        ? t("openInDsh")
        : [
            t("resumeIn", { terminal: cmuxAvailable ? "cmux" : "Terminal" }),
            card.resumeCommand,
          ].filter(Boolean).join(" — ");

      return h(
        "div",
        {
          className: "sh-row",
          draggable: true,
          onDragStart,
          onDragEnd,
          onPointerEnter: prefetch,
            onPointerDown: prefetch,
            onFocus: prefetch,
          // Subagents indent under the session that started them.
          style: depth > 0 ? { paddingLeft: `${4 + depth * 14}px` } : undefined,
          title: [`${card.agentLabel}`, card.cwd, card.partial ? t("partial") : null].filter(Boolean).join(" · "),
        },
        // A fixed disclosure cell keeps every title aligned, whether or not the
        // row has children.
        h(
          "span",
          { className: "sh-caret-cell" },
          descendants > 0 &&
            h(
              "button",
              {
                type: "button",
                className: "sh-caret-btn",
                onClick: () => onToggleTree(card.key),
                title: open ? t("collapseTree") : t("expandTree", { n: descendants }),
                "aria-expanded": open,
                "aria-label": open ? t("collapseTree") : t("expandTree", { n: descendants }),
              },
              h("span", { className: `sh-group-arrow${open ? " sh-group-arrow-open" : ""}`, "aria-hidden": true }, h(ChevronIcon)),
            ),
        ),
        h(
          "span",
          { className: "sh-row-slot" },
          h("span", {
            className: `sh-agent-dot sh-agent-dot-${card.agent}${running ? " sh-dot-running" : ""}`,
            title: running ? `${card.agentLabel} · ${t("running")}` : card.agentLabel,
            "aria-label": running ? `${card.agentLabel} ${t("running")}` : card.agentLabel,
            role: "img",
          }),
        ),
        showAgent && h(AgentTag, { card, t }),
        h(
          "span",
          {
            className: "sh-row-title sh-row-title-open",
            role: "button",
            tabIndex: 0,
            title: t("readSession"),
            onClick: () => reading.set({ key: card.key, title: card.title }),
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              reading.set({ key: card.key, title: card.title });
            },
          },
          card.title,
        ),
        // The pin cell is its own toggle: visible when pinned, or on hover when
        // not. That keeps a fourth icon out of the hover action row.
        h(
          "span",
          { className: "sh-pin-cell" },
          h(
            "button",
            {
              type: "button",
              className: `sh-pin-btn${pinned ? " sh-pin-on" : ""}`,
              onClick: () => onTogglePin(card),
              title: pinned ? t("unpin") : t("pin"),
              "aria-label": pinned ? t("unpin") : t("pin"),
              "aria-pressed": pinned,
            },
            h(PinIcon, { filled: pinned }),
          ),
        ),
        descendants > 0 && h("span", { className: "sh-sub-count", title: t("subagents", { n: descendants }) }, String(descendants)),
        h(
          "span",
          {
            className: "sh-row-time",
            title: card.updatedAt === null ? "" : new Date(card.updatedAt).toLocaleString(),
          },
          formatWhen(card.updatedAt, now),
        ),
        h(
          "span",
          { className: "sh-row-actions" },
          h(
            "button",
            {
              type: "button",
              className: "sh-icon-btn",
              disabled: busy,
              title: t("reference"),
              "aria-label": t("reference"),
              onClick: run(() => onReference(card)),
            },
            h("span", { className: "sh-at", "aria-hidden": true }, "@"),
          ),
          h(
            "button",
            { type: "button", className: "sh-icon-btn", disabled: busy, title: t("continue"), "aria-label": t("continue"), onClick: run(() => onContinue(card)) },
            h(ContinueIcon),
          ),
          h(
            "button",
            { type: "button", className: "sh-icon-btn", disabled: busy, title: openTitle, "aria-label": openTitle, onClick: run(() => onOpen(card)) },
            h(OpenIcon),
          ),
          h(
            "button",
            {
              type: "button",
              className: "sh-icon-btn sh-icon-btn-danger",
              disabled: busy,
              title: t("remove"),
              "aria-label": t("remove"),
              onClick: () => onDelete(card),
            },
            h(TrashIcon),
          ),
        ),
      );
    }

    /** The full-screen panel. */
    function makeHub(ctx, t, faces) {
      const transcriptCache = new Map();
      const LivePanel = makeLivePanel(t);

      /**
       * Put one session's history into the draft of the session on screen.
       *
       * Shared by the session list and the live view so both offer the same
       * verb; the caller supplies the composer it should write into.
       */
      /**
       * Put `text` into the draft of the session on screen.
       *
       * Insertion at the caret is preferred and a whole-draft replacement is the
       * fallback, because losing the text entirely is the one unacceptable
       * outcome. Shared by every verb that writes into the composer.
       */
      function insertIntoDraft(actions, text) {
        let inserted = false;
        try {
          const span = actions.captureInsertion();
          inserted = actions.insertText(text, span) === true;
        } catch {
          inserted = false;
        }
        if (!inserted) actions.setDraft(text);
      }

      async function continueSession(card, composerFace, close) {
        const actions = composerFace?.inputActions ?? null;
        const liveSessionId = composerFace?.sessionId ?? null;
        if (actions === null || actions === undefined) {
          say(t("noComposer"), true);
          return;
        }
        try {
          const result = await hub("continue", { key: card.key, currentSessionId: liveSessionId });
          insertIntoDraft(actions, result.prompt ?? "");
          say(t("inserted"));
          close();
        } catch (caught) {
          say(t("failed", { message: String(caught?.message ?? caught) }), true);
        }
      }

      /**
       * Write a reference to this session into the draft.
       *
       * Which reference — a native DSH mention, or an `@` to the session's own
       * store artifact — is the Host's answer, because it depends on the agent.
       */
      async function referenceSession(card, composerFace, close) {
        const actions = composerFace?.inputActions ?? null;
        const liveSessionId = composerFace?.sessionId ?? null;
        if (actions === null || actions === undefined) {
          say(t("noComposer"), true);
          return;
        }
        try {
          const result = await hub("reference", { key: card.key, currentSessionId: liveSessionId });
          if (typeof result.text !== "string" || result.text === "") {
            say(t("referenceNone"), true);
            return;
          }
          insertIntoDraft(actions, result.text);
          say(t("inserted"));
          close();
        } catch (caught) {
          say(t("failed", { message: String(caught?.message ?? caught) }), true);
        }
      }

      /**
       * Reopen a session in its own agent: DSH sessions open in the DSH UI,
       * everything else is resumed in a cmux workspace (Terminal.app when cmux
       * is unavailable).
       */
      async function openSession(card, close) {
        if (card.agent === "dsh") {
          const uiWorkspace = faces.uiWorkspace();
          if (uiWorkspace === null) {
            say(t("failed", { message: "uiWorkspace unavailable" }), true);
            return;
          }
          uiWorkspace.openSession(card.sessionId);
          close();
          return;
        }
        try {
          const result = await hub("open", { key: card.key });
          if (result.kind === "focus") {
            say(t("focused", { terminal: result.terminal ?? "cmux" }));
          } else if (result.kind === "cmux" || result.kind === "terminal") {
            say(t("opened", { terminal: result.terminal ?? "terminal" }));
          } else {
            const command = result.command ?? card.resumeCommand ?? "";
            try {
              await navigator.clipboard.writeText(command);
              say(`${t("copied")} — ${command}`);
            } catch {
              say(`${t("manual")}: ${command}`);
            }
          }
        } catch (caught) {
          say(t("failed", { message: String(caught?.message ?? caught) }), true);
        }
      }

      function useEscape(open, close) {
        React.useEffect(() => {
          if (!open) return undefined;
          const onKey = (event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          };
          window.addEventListener("keydown", onKey, true);
          return () => window.removeEventListener("keydown", onKey, true);
        }, [open, close]);
      }

      /**
       * The shared body.
       *
       * The frame-wide overlay and the right Sidebar's tab render the same list;
       * they differ only in their chrome, and in how they reach the composer that
       * "Continue here" writes into — the Sidebar tab is session-scoped and holds
       * `inputActions` directly, while the overlay reads the dock bridge's store.
       */
      function HubBody({ variant, composerFace, setDragging, close }) {
        const panelState = React.useSyncExternalStore(panel.subscribe, panel.get, panel.get);
        const [sessions, setSessions] = React.useState([]);
        const [agents, setAgents] = React.useState([]);
        const [loading, setLoading] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [query, setQuery] = React.useState("");
        const [agentFilter, setAgentFilter] = React.useState(null);
        const [group, setGroup] = React.useState("project");
        const [onlyRunning, setOnlyRunning] = React.useState(false);
        const [collapsed, setCollapsed] = React.useState(() => new Set());
        const [runningKeys, setRunningKeys] = React.useState(() => new Set());
        const [cmuxAvailable, setCmuxAvailable] = React.useState(false);
        const [now, setNow] = React.useState(() => Date.now());
        /** groupId → how many rows that group is showing; absent means the first page. */
        const [shown, setShown] = React.useState(() => new Map());
        /** Session keys whose subagent subtree is open. */
        const [expandedTree, setExpandedTree] = React.useState(() => new Set());
        /** The plugin's own pin sets, owned by the Host so they survive the browser. */
        const [pins, setPins] = React.useState(() => ({ projects: [], sessions: [] }));
        const rev = React.useSyncExternalStore(revision.subscribe, revision.get, revision.get);

        const load = React.useCallback(async (refresh) => {
          setLoading(true);
          setError(null);
          try {
            const result = await hub("list", { refresh: refresh === true });
            const rows = result.sessions ?? [];
            setSessions(rows);
            setAgents(result.agents ?? []);
            setCmuxAvailable(result.cmux === true);
            setPins({ projects: result.pins?.projects ?? [], sessions: result.pins?.sessions ?? [] });
            setRunningKeys(new Set(rows.filter((session) => session.running === true).map((session) => session.key)));
            setNow(Date.now());
          } catch (caught) {
            setError(String(caught?.message ?? caught));
          } finally {
            setLoading(false);
          }
        }, []);

        React.useEffect(() => {
          load(false);
        }, [load, rev]);

        /**
         * Live state is polled, never rescanned: `status` re-reads only the DSH
         * agent registry and cmux's hook records over the cards already parsed,
         * so a short interval stays cheap.
         */
        React.useEffect(() => {
          let cancelled = false;
          let inFlight = false;
          const tick = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
              const result = await hub("status");
              if (cancelled) return;
              const entries = Object.entries(result.running ?? {});
              setRunningKeys(new Set(entries.filter(([, up]) => up === true).map(([key]) => key)));
              setNow(Date.now());
            } catch {
              /* A failed poll keeps the last known state. */
            } finally {
              inFlight = false;
            }
          };
          const timer = setInterval(tick, 3000);
          tick();
          return () => {
            cancelled = true;
            clearInterval(timer);
          };
        }, []);

        const onContinue = React.useCallback(
          (card) => continueSession(card, composerFace, close),
          [composerFace, close],
        );

        const onOpen = React.useCallback((card) => openSession(card, close), [close]);
        const onReference = React.useCallback((card) => referenceSession(card, composerFace, close), [composerFace, close]);

        const counts = React.useMemo(() => {
          const map = new Map();
          for (const session of sessions) map.set(session.agent, (map.get(session.agent) ?? 0) + 1);
          return map;
        }, [sessions]);

        const visible = React.useMemo(() => {
          const needle = query.trim().toLowerCase();
          return sessions.filter((session) => {
            if (agentFilter !== null && session.agent !== agentFilter) return false;
            if (onlyRunning && !runningKeys.has(session.key)) return false;
            if (needle === "") return true;
            return (
              String(session.title).toLowerCase().includes(needle) ||
              String(session.project ?? "").toLowerCase().includes(needle) ||
              String(session.cwd ?? "").toLowerCase().includes(needle) ||
              String(session.sessionId ?? "").toLowerCase().includes(needle)
            );
          });
        }, [sessions, query, agentFilter, onlyRunning, runningKeys]);

        /**
         * Bucket the visible sessions, then nest each bucket into a family tree.
         *
         * A subagent is a session in its own right, but listing it beside the
         * sessions a person started buries them. Nesting happens *within* a
         * bucket: a parent that fell into another project (or was filtered out)
         * cannot hide its child, so that child stays a root.
         */
        const pinnedSessions = React.useMemo(() => new Set(pins.sessions), [pins.sessions]);
        const pinnedProjects = React.useMemo(() => new Set(pins.projects), [pins.projects]);

        const groups = React.useMemo(() => {
          const bucketOf = (session) => {
            if (group === "flat") return { key: null, label: null, path: null };
            if (group === "agent") return { key: session.agent, label: session.agentLabel, path: null };
            // Keyed by the full workspace path, never by the display name: this
            // machine holds three different checkouts all called `new-chat`, and
            // a group that merged them would delete across three projects.
            return { key: session.cwd ?? "", label: session.project ?? "—", path: session.cwd ?? null };
          };

          const map = new Map();
          for (const session of visible) {
            const bucket = bucketOf(session);
            if (!map.has(bucket.key)) map.set(bucket.key, { ...bucket, items: [] });
            map.get(bucket.key).items.push(session);
          }

          for (const entry of map.values()) {
            // The project's own last-interaction time: the newest session in it,
            // so a collapsed project still says when it was last touched.
            entry.latestAt = entry.items.reduce(
              (newest, session) => Math.max(newest, Number.isFinite(session.updatedAt) ? session.updatedAt : 0),
              0,
            );

            const inBucket = new Set(entry.items.map((session) => session.key));
            const children = new Map();
            const roots = [];
            for (const session of entry.items) {
              const parent = session.parentKey;
              if (parent !== null && parent !== undefined && parent !== session.key && inBucket.has(parent)) {
                if (!children.has(parent)) children.set(parent, []);
                children.get(parent).push(session);
              } else {
                roots.push(session);
              }
            }

            const countBelow = (key) =>
              (children.get(key) ?? []).reduce((total, child) => total + 1 + countBelow(child.key), 0);
            const descendants = new Map();
            for (const root of roots) descendants.set(root.key, countBelow(root.key));

            // Pins float to the top of their own group. `sort` is stable, so the
            // newest-first order survives inside each partition.
            const byPin = (a, b) => (pinnedSessions.has(b.key) ? 1 : 0) - (pinnedSessions.has(a.key) ? 1 : 0);
            roots.sort(byPin);
            for (const list of children.values()) list.sort(byPin);

            entry.roots = roots;
            entry.children = children;
            entry.descendants = descendants;
          }

          // A pinned project outranks an unpinned one regardless of size.
          return [...map.values()].sort((a, b) => {
            const byPinnedProject = (pinnedProjects.has(b.key) ? 1 : 0) - (pinnedProjects.has(a.key) ? 1 : 0);
            return byPinnedProject !== 0 ? byPinnedProject : b.roots.length - a.roots.length;
          });
        }, [visible, group, pinnedSessions, pinnedProjects]);

        /**
         * Open on the first group only.
         *
         * A corpus of hundreds of sessions across dozens of projects is noise if
         * every project unfolds at once, so everything below the topmost group
         * starts collapsed. Applied once per grouping mode — never on every
         * recompute, which would fight a person who just opened something.
         */
        const defaultedFor = React.useRef(null);
        React.useEffect(() => {
          if (groups.length === 0 || defaultedFor.current === group) return;
          defaultedFor.current = group;
          setCollapsed(new Set(groups.slice(1).map((bucket) => bucket.key ?? "__flat")));
        }, [groups, group]);

        const runningCount = React.useMemo(
          () => sessions.reduce((total, session) => total + (runningKeys.has(session.key) ? 1 : 0), 0),
          [sessions, runningKeys],
        );

        const toggleGroup = React.useCallback((id) => {
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }, []);

        /** Deleting is never one click: the row opens a confirmation dialog. */
        const onDelete = React.useCallback((card) => confirming.set({ kind: "session", card }), []);

        /**
         * A whole project, across every agent.
         *
         * The dialog carries the exact keys on screen, so the batch is what the
         * person saw. With an agent filter or a search active, "the group" means
         * the filtered group — deleting more than what is displayed would be a
         * surprise the dialog could not describe.
         */
        const onDeleteGroup = React.useCallback(
          (bucket) => {
            confirming.set({
              kind: "group",
              label: bucket.label,
              path: bucket.path ?? null,
              keys: bucket.items.map((session) => session.key),
              total: bucket.items.length,
              running: bucket.items.filter((session) => runningKeys.has(session.key)).length,
              agents: [...new Set(bucket.items.map((session) => session.agentLabel))],
            });
          },
          [runningKeys],
        );

        /** Hand this project's directory to VS Code. */
        const onOpenVscode = React.useCallback(
          async (bucket) => {
            if (bucket.path === null || bucket.path === undefined) return;
            try {
              const result = await hub("vscode", { cwd: bucket.path });
              if (result.ok !== true) throw new Error(result.error ?? "vscode failed");
              say(t("openedEditor", { editor: "VS Code" }));
            } catch (caught) {
              say(t("failed", { message: String(caught?.message ?? caught) }), true);
            }
          },
          [],
        );

        /** Only a project group has a directory to start a session in. */
        const onSpawnSession = React.useCallback((bucket) => {
          if (bucket.path === null || bucket.path === undefined) return;
          spawning.set({ cwd: bucket.path, label: bucket.label });
        }, []);

        const toggleTree = React.useCallback((key) => {
          setExpandedTree((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }, []);

        /** Pins round-trip through the Host, which owns the file they live in. */
        const togglePin = React.useCallback(
          async (kind, id, pinned) => {
            try {
              const result = await hub("pin", { kind, id, pinned: !pinned });
              if (result.ok !== true) throw new Error(result.error ?? "pin failed");
              setPins({ projects: result.projects ?? [], sessions: result.sessions ?? [] });
            } catch (caught) {
              say(t("failed", { message: String(caught?.message ?? caught) }), true);
            }
          },
          [t],
        );

        const onTogglePin = React.useCallback(
          (card) => togglePin("session", card.key, pinnedSessions.has(card.key)),
          [togglePin, pinnedSessions],
        );

        const onToggleProjectPin = React.useCallback(
          (bucket) => togglePin("project", bucket.key, pinnedProjects.has(bucket.key)),
          [togglePin, pinnedProjects],
        );

        return h(
          React.Fragment,
          null,
          variant === "overlay" &&
            h(
              "div",
              { className: "sh-head" },
              h(HubIcon, { size: 18 }),
              h("span", { className: "sh-title" }, t("title")),
              h("span", { className: "sh-sub" }, t("subtitle")),
              h(
                "button",
                { type: "button", className: "sh-btn", disabled: loading, onClick: () => load(true) },
                loading ? t("refreshing") : t("refresh"),
              ),
              h("button", { type: "button", className: "sh-btn sh-close", onClick: close, title: t("close"), "aria-label": t("close") }, "✕"),
            ),
          h(
              "div",
              { className: "sh-tools" },
              h("input", {
                className: "sh-search",
                type: "search",
                value: query,
                placeholder: t("search"),
                onChange: (event) => setQuery(event.target.value),
              }),
              h(
                "div",
                { className: "sh-chips" },
                h(
                  "button",
                  {
                    type: "button",
                    className: `sh-chip${agentFilter === null ? " sh-chip-on" : ""}`,
                    onClick: () => setAgentFilter(null),
                  },
                  t("all"),
                  h("span", { className: "sh-chip-n" }, String(sessions.length)),
                ),
                agents.map((agent) =>
                  h(
                    "button",
                    {
                      key: agent.id,
                      type: "button",
                      className: `sh-chip${agentFilter === agent.id ? " sh-chip-on" : ""}`,
                      onClick: () => setAgentFilter(agentFilter === agent.id ? null : agent.id),
                    },
                    agent.label,
                    h("span", { className: "sh-chip-n" }, String(counts.get(agent.id) ?? 0)),
                  ),
                ),
              ),
              h(
                "div",
                { className: "sh-chips" },
                ...[
                  ["project", t("groupProject")],
                  ["agent", t("groupAgent")],
                  ["flat", t("groupFlat")],
                ].map(([value, label]) =>
                  h(
                    "button",
                    {
                      key: value,
                      type: "button",
                      className: `sh-chip${group === value ? " sh-chip-on" : ""}`,
                      onClick: () => setGroup(value),
                    },
                    label,
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `sh-chip${onlyRunning ? " sh-chip-on" : ""}`,
                    onClick: () => setOnlyRunning((current) => !current),
                  },
                  t("onlyRunning"),
                  runningCount > 0 && h("span", { className: "sh-chip-n" }, String(runningCount)),
                ),
                variant === "sidebar" &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "sh-icon-btn",
                      disabled: loading,
                      onClick: () => load(true),
                      title: loading ? t("refreshing") : t("refresh"),
                      "aria-label": t("refresh"),
                    },
                    h(RefreshIcon),
                  ),
              ),
            ),
            h(
              "div",
              { className: "sh-scroll" },
              error !== null
                ? h("div", { className: "sh-empty" }, t("failed", { message: error }))
                : visible.length === 0
                  ? h(
                      "div",
                      { className: "sh-empty" },
                      loading ? t("refreshing") : [t("empty"), t("emptyHint")].join(" "),
                    )
                  : groups.map((bucket) => {
                      const id = bucket.key ?? "__flat";
                      const isCollapsed = collapsed.has(id);
                      const live = bucket.items.reduce((total, card) => total + (runningKeys.has(card.key) ? 1 : 0), 0);
                      // A group opens on its newest page of *top-level* sessions;
                      // subagent sessions come into view by opening their parent.
                      const limit = Math.min(shown.get(id) ?? PAGE_SIZE, bucket.roots.length);
                      const hidden = bucket.roots.length - limit;

                      const renderRow = (card, depth) =>
                        h(
                          React.Fragment,
                          { key: card.key },
                          h(SessionRow, {
                          onReference,
                            card,
                            t,
                            onContinue,
                            onOpen,
                            onDelete,
                            onToggleTree: toggleTree,
                            onTogglePin,
                            transcriptCache,
                            onDragState: setDragging,
                            now,
                            running: runningKeys.has(card.key),
                            cmuxAvailable,
                            showAgent: group !== "agent",
                            depth,
                            descendants: bucket.descendants.get(card.key) ?? 0,
                            open: expandedTree.has(card.key),
                            pinned: pinnedSessions.has(card.key),
                          }),
                          expandedTree.has(card.key) &&
                            (bucket.children.get(card.key) ?? []).map((child) => renderRow(child, depth + 1)),
                        );

                      return h(
                        React.Fragment,
                        { key: id },
                        bucket.label !== null &&
                          h(
                            "div",
                            { className: "sh-group" },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "sh-group-head",
                                onClick: () => toggleGroup(id),
                                title: bucket.path ?? (isCollapsed ? t("expand") : t("collapse")),
                                "aria-expanded": !isCollapsed,
                              },
                              h(
                                "span",
                                { className: `sh-group-arrow${isCollapsed ? "" : " sh-group-arrow-open"}`, "aria-hidden": true },
                                h(ChevronIcon),
                              ),
                              h("span", { className: "sh-group-folder", "aria-hidden": true }, h(FolderIcon)),
                              h("span", { className: "sh-group-name" }, bucket.label),
                              pinnedProjects.has(id) &&
                                h("span", { className: "sh-pin-mark", "aria-hidden": true }, h(PinIcon, { filled: true })),
                              bucket.latestAt > 0 &&
                                h(
                                  "span",
                                  {
                                    className: "sh-group-time",
                                    title: `${t("lastActive")}: ${new Date(bucket.latestAt).toLocaleString()}`,
                                  },
                                  formatWhen(bucket.latestAt, now),
                                ),
                              live > 0 && h("span", { className: "sh-group-count" }, `${live} ●`),
                              h("span", { className: "sh-group-count" }, String(bucket.items.length)),
                            ),
                            // A sibling of the header button, never a child: a button
                            // inside a button is invalid and swallows the click.
                            h(
                              "span",
                              { className: "sh-group-actions" },
                              bucket.path !== null &&
                                bucket.path !== undefined &&
                                h(
                                  "button",
                                  {
                                    type: "button",
                                    className: "sh-icon-btn",
                                    title: t("openInVscode"),
                                    "aria-label": t("openInVscode"),
                                    onClick: () => onOpenVscode(bucket),
                                  },
                                  h(CodeIcon),
                                ),
                              bucket.path !== null &&
                                bucket.path !== undefined &&
                                h(
                                  "button",
                                  {
                                    type: "button",
                                    className: "sh-icon-btn",
                                    title: t("newSession"),
                                    "aria-label": t("newSession"),
                                    onClick: () => onSpawnSession(bucket),
                                  },
                                  h(PlusIcon),
                                ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: `sh-icon-btn${pinnedProjects.has(id) ? " sh-pin-on" : ""}`,
                                  title: pinnedProjects.has(id) ? t("unpinProject") : t("pinProject"),
                                  "aria-label": pinnedProjects.has(id) ? t("unpinProject") : t("pinProject"),
                                  "aria-pressed": pinnedProjects.has(id),
                                  onClick: () => onToggleProjectPin(bucket),
                                },
                                h(PinIcon, { filled: pinnedProjects.has(id) }),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "sh-icon-btn sh-icon-btn-danger",
                                  title: t("removeGroup"),
                                  "aria-label": t("removeGroup"),
                                  onClick: () => onDeleteGroup(bucket),
                                },
                                h(TrashIcon),
                              ),
                            ),
                          ),
                        !isCollapsed &&
                          h(
                            "div",
                            { className: "sh-rowlist" },
                            bucket.roots.slice(0, limit).map((card) => renderRow(card, 0)),
                            bucket.roots.length > PAGE_SIZE &&
                              h(
                                "button",
                                {
                                  type: "button",
                                  className: "sh-more",
                                  onClick: () =>
                                    setShown((current) => {
                                      const next = new Map(current);
                                      if (hidden > 0) next.set(id, limit + PAGE_SIZE);
                                      else next.set(id, PAGE_SIZE);
                                      return next;
                                    }),
                                },
                                hidden > 0 ? `${t("showMore")} · ${hidden}` : t("showLess"),
                              ),
                          ),
                      );
                    }),
            ),
            h(
              "div",
              { className: "sh-foot" },
              h("span", { className: "sh-spacer" }),
              panelState.toast !== null &&
                h(
                  "span",
                  { className: `sh-toast${panelState.toast.error ? " sh-toast-error" : ""}` },
                  panelState.toast.message,
                ),
              runningCount > 0 && h("span", { className: "sh-group-count" }, `${runningCount} ● ${t("running")}`),
              h("span", { className: "sh-group-count" }, t("countOf", { n: visible.length, total: sessions.length })),
            ),
        );
      }

      /**
       * The frame-wide overlay, opened from the sidebar foot.
       *
       * While a card is dragged, the backdrop must stop intercepting pointer
       * events so the composer underneath becomes the drop target. That is
       * applied directly to the node — re-rendering the drag source mid-drag
       * cancels the drag in some browsers.
       */
      function Overlay() {
        const state = React.useSyncExternalStore(panel.subscribe, panel.get, panel.get);
        const face = React.useSyncExternalStore(composer.subscribe, composer.get, composer.get);
        const backdropRef = React.useRef(null);

        const close = React.useCallback(() => panel.set({ ...panel.get(), open: false }), []);
        useEscape(state.open, close);

        const setDragging = React.useCallback((active) => {
          const node = backdropRef.current;
          if (node === null) return;
          node.style.pointerEvents = active ? "none" : "";
          node.style.opacity = active ? "0.25" : "";
        }, []);

        if (!state.open) return null;

        return h(
          "div",
          { className: "sh-backdrop", ref: backdropRef, onClick: close },
          h(
            "div",
            {
              className: "sh-card",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("title"),
              onClick: (event) => event.stopPropagation(),
            },
            h(HubBody, { variant: "overlay", composerFace: face, setDragging, close }),
          ),
        );
      }

      /**
       * The right Sidebar's tab body.
       *
       * This seat is session-scoped, so it already holds the live composer's
       * `inputActions` — "Continue here" needs no bridge here. And because the
       * column sits beside the conversation rather than over it, a card drags
       * straight onto the composer with no pointer-event games.
       */
      function SidebarTab(props) {
        const sessionId = props?.sessionId ?? null;
        const inputActions = props?.inputActions ?? null;
        const face = React.useMemo(() => ({ sessionId, inputActions }), [sessionId, inputActions]);
        const [mode, setMode] = React.useState("sessions");
        // The live view writes into the same composer the list does, so both
        // modes offer identical verbs.
        const liveContinue = React.useCallback((card) => continueSession(card, face, noop), [face]);
        const liveOpen = React.useCallback((card) => openSession(card, noop), []);
        return h(
          "div",
          { className: "sh-sidebar" },
          // Two modes, one column: browse the corpus, or watch what is live.
          h(
            "div",
            { className: "sh-modes", role: "tablist" },
            ...[
              ["sessions", t("modeList")],
              ["live", t("live")],
            ].map(([value, label]) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  role: "tab",
                  "aria-selected": mode === value,
                  className: `sh-chip${mode === value ? " sh-chip-on" : ""}`,
                  onClick: () => setMode(value),
                },
                label,
              ),
            ),
          ),
          mode === "live"
            ? h(LivePanel, {
                onContinue: liveContinue,
                onOpen: liveOpen,
                transcriptCache,
                onDragState: noop,
              })
            : h(HubBody, { variant: "sidebar", composerFace: face, setDragging: noop, close: noop }),
        );
      }

      /**
       * The session reader.
       *
       * A read-only scroller over one session's turns, in the frame-wide overlay
       * so the narrow right sidebar does not have to fit it.
       */
      function PreviewDialog() {
        const state = React.useSyncExternalStore(reading.subscribe, reading.get, reading.get);
        const [data, setData] = React.useState(null);
        const [error, setError] = React.useState(null);

        const close = React.useCallback(() => reading.set(null), []);
        // Which turns have their working-out opened. Kept per dialog, not per
        // turn, so opening one does not close another.
        const [expanded, setExpanded] = React.useState(() => new Set());
        useEscape(state !== null, close);

        React.useEffect(() => {
          if (state === null) return undefined;
          let cancelled = false;
          setData(null);
          setError(null);
          hub("messages", { key: state.key })
            .then((result) => {
              if (!cancelled) setData(result);
            })
            .catch((caught) => {
              if (!cancelled) setError(String(caught?.message ?? caught));
            });
          return () => {
            cancelled = true;
          };
        }, [state]);

        if (state === null) return null;

        const turns =
          data === null
            ? null
            : (() => {
                const render = (message, who, key) =>
                  h(
                    "div",
                    { key, className: `sh-turn sh-turn-${message.role}` },
                    h(
                      "div",
                      { className: "sh-turn-head" },
                      h("span", { className: `sh-turn-dot sh-turn-dot-${message.role}`, "aria-hidden": true }),
                      h("span", { className: "sh-turn-who" }, who),
                      h("span", { className: "sh-spacer" }),
                      typeof message.at === "string" && h("span", { className: "sh-turn-at" }, message.at),
                    ),
                    h(
                      "div",
                      { className: "sh-turn-body" },
                      turnParts(message.text).map((block, part) =>
                        block.kind === "tool"
                          ? h("div", { key: part, className: "sh-turn-tool" }, h("span", { className: "sh-turn-tool-name" }, block.text))
                          : h("div", { key: part, className: "sh-turn-text" }, block.text),
                      ),
                    ),
                  );

                return groupTurns(data.messages).map((turn, index) => {
                  // A compaction is not a request with an answer; it is a seam in
                  // the record, and its own summary is what it was replaced with.
                  if (turn.lead !== null && turn.lead.role === "compacted") {
                    const openSummary = expanded.has(index);
                    return h(
                      "div",
                      { key: index, className: "sh-turn-group sh-compacted" },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "sh-steps-toggle",
                          "aria-expanded": openSummary,
                          onClick: () => {
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(index)) next.delete(index);
                              else next.add(index);
                              return next;
                            });
                          },
                          title: openSummary ? t("hideSummary") : t("showSummary"),
                        },
                        h(
                          "span",
                          { className: `sh-group-arrow${openSummary ? " sh-group-arrow-open" : ""}`, "aria-hidden": true },
                          h(ChevronIcon),
                        ),
                        h("span", { className: "sh-compacted-label" }, t("compacted")),
                        typeof turn.lead.at === "string" && h("span", { className: "sh-turn-at" }, turn.lead.at),
                        turn.lead.collapsed !== null &&
                          h("span", { className: "sh-compacted-count" }, t("collapsedTokens", { n: turn.lead.collapsed.toLocaleString() })),
                      ),
                      openSummary && h("div", { className: "sh-turn sh-turn-compacted" },
                        h("div", { className: "sh-turn-body" }, h("div", { className: "sh-turn-text" }, turn.lead.text))),
                    );
                  }
                  const steps = turn.steps;
                  const answer = steps.length > 0 ? steps[steps.length - 1] : null;
                  const middle = steps.slice(0, -1);
                  const open = expanded.has(index);
                  const toggle = () => {
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    });
                  };
                  return h(
                    "div",
                    { key: index, className: "sh-turn-group" },
                    turn.lead !== null && render(turn.lead, t("you"), `u${index}`),
                    middle.length > 0 &&
                      h(
                        "button",
                        {
                          type: "button",
                          className: "sh-steps-toggle",
                          "aria-expanded": open,
                          onClick: toggle,
                          title: open ? t("hideSteps") : t("showSteps"),
                        },
                        h(
                          "span",
                          { className: `sh-group-arrow${open ? " sh-group-arrow-open" : ""}`, "aria-hidden": true },
                          h(ChevronIcon),
                        ),
                        t("stepsCount", { n: middle.length }),
                      ),
                    middle.length > 0 && open && middle.map((message, step) => render(message, data.agentLabel, `m${index}-${step}`)),
                    answer !== null && render(answer, data.agentLabel, `a${index}`),
                  );
                });
              })();

        return h(
          "div",
          { className: "sh-backdrop", onClick: close },
          h(
            "div",
            {
              className: "sh-dialog sh-read",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("readSession"),
              onClick: (event) => event.stopPropagation(),
            },
            h(
              "div",
              { className: "sh-read-head" },
              h("span", { className: `sh-agent-dot sh-agent-dot-${data === null ? "dsh" : data.agent}`, "aria-hidden": true }),
              h("span", { className: "sh-lp-agent" }, data === null ? "" : data.agentLabel),
              h("span", { className: "sh-read-title" }, state.title),
              h("span", { className: "sh-spacer" }),
              data !== null && data.model !== null && h("span", { className: "sh-read-model", title: t("detailModel") }, data.model),
              data !== null && h("span", { className: "sh-group-count" }, String(data.total)),
              h(
                "button",
                { type: "button", className: "sh-btn sh-close", onClick: close, title: t("close"), "aria-label": t("close") },
                "\u2715",
              ),
            ),
            error !== null
              ? h("div", { className: "sh-empty" }, error)
              : turns === null
                ? h("div", { className: "sh-empty" }, t("loading"))
                : h(
                    "div",
                    { className: "sh-read-body" },
                    data.truncated && h("div", { className: "sh-read-note" }, t("truncatedNote", { n: data.total })),
                    turns.length === 0 ? h("div", { className: "sh-empty" }, t("noTurns")) : turns,
                  ),
          ),
        );
      }

      /**
       * The delete confirmation.
       *
       * It renders in the frame-wide overlay rather than inside the panel, so one
       * dialog serves both entry points: the right Sidebar's pane clips its own
       * overflow, and a confirmation must never be clipped.
       */
      function DeleteDialog() {
        const state = React.useSyncExternalStore(confirming.subscribe, confirming.get, confirming.get);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [withRunning, setWithRunning] = React.useState(false);

        const close = React.useCallback(() => {
          if (busy) return;
          confirming.set(null);
        }, [busy]);

        useEscape(state !== null, close);
        React.useEffect(() => {
          setBusy(false);
          setError(null);
          setWithRunning(false);
        }, [state]);

        if (state === null) return null;

        const isGroup = state.kind === "group";
        const card = state.card ?? null;
        const total = isGroup ? state.total : 1;
        const running = isGroup ? state.running : card.running === true ? 1 : 0;
        // Skipping is the default for a bulk delete: a project-wide sweep should
        // remove what it can and report the rest, never fail as a whole.
        const willDelete = isGroup ? total - (withRunning ? 0 : running) : 1;

        const run = async () => {
          setBusy(true);
          setError(null);
          try {
            if (isGroup) {
              const result = await hub("delete-many", { keys: state.keys, force: withRunning });
              if (result.ok !== true) throw new Error(result.error ?? "delete failed");
              confirming.set(null);
              say(t("deletedMany", { n: result.deleted, m: result.skipped }));
            } else {
              const result = await hub("delete", { key: card.key, force: card.running === true });
              if (result.ok !== true) throw new Error(result.error ?? "delete failed");
              confirming.set(null);
              say(t("deleted", { agent: card.agentLabel }));
            }
            revision.set(revision.get() + 1);
          } catch (caught) {
            setError(String(caught?.message ?? caught));
          } finally {
            setBusy(false);
          }
        };

        return h(
          "div",
          { className: "sh-backdrop", onClick: close },
          h(
            "div",
            {
              className: "sh-dialog",
              role: "alertdialog",
              "aria-modal": "true",
              "aria-label": isGroup ? t("deleteGroupTitle") : t("deleteTitle"),
              onClick: (event) => event.stopPropagation(),
            },
            h("div", { className: "sh-dialog-title" }, isGroup ? t("deleteGroupTitle") : t("deleteTitle")),
            isGroup
              ? h(
                  "div",
                  null,
                  h("div", { className: "sh-dialog-session" }, h("span", { className: "sh-group-folder" }, h(FolderIcon)), h("span", { className: "sh-row-title" }, state.label)),
                  state.path !== null && h("div", { className: "sh-dialog-path" }, state.path),
                  h(
                    "div",
                    { className: "sh-chips", style: { marginTop: 8 } },
                    state.agents.map((agent) => h("span", { key: agent, className: "sh-chip" }, agent)),
                    h("span", { className: "sh-chip" }, t("count", { n: total })),
                  ),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    "div",
                    { className: "sh-dialog-session" },
                    h("span", { className: `sh-agent-dot sh-agent-dot-${card.agent}` }),
                    h("span", { className: "sh-row-title" }, card.title),
                  ),
                  h("div", { className: "sh-dialog-meta" }, [card.agentLabel, card.project, card.cwd].filter(Boolean).join(" · ")),
                  // DSH keeps one directory per session; that directory is the target.
                  h("div", { className: "sh-dialog-path" }, card.agent === "dsh" ? parentOf(card.file) : card.file),
                ),
            h("div", { className: "sh-dialog-warn" }, isGroup ? t("deleteGroupBody", { n: total }) : t("deleteBody", { agent: card.agentLabel })),
            running > 0 &&
              isGroup &&
              h(
                "label",
                { className: "sh-dialog-check" },
                h("input", { type: "checkbox", checked: withRunning, disabled: busy, onChange: (event) => setWithRunning(event.target.checked) }),
                h("span", null, t("alsoRunning", { n: running })),
              ),
            running > 0 && !isGroup && h("div", { className: "sh-dialog-danger" }, t("deleteRunning")),
            running > 0 && isGroup && !withRunning && h("div", { className: "sh-dialog-warn" }, t("deleteGroupRunning", { n: running })),
            error !== null && h("div", { className: "sh-dialog-danger" }, error),
            h(
              "div",
              { className: "sh-dialog-actions" },
              h("button", { type: "button", className: "sh-btn", disabled: busy, onClick: close }, t("cancel")),
              h(
                "button",
                {
                  type: "button",
                  className: `sh-btn sh-danger${running > 0 || error !== null ? " sh-danger-strong" : ""}`,
                  disabled: busy || willDelete === 0,
                  onClick: run,
                },
                busy
                  ? t("deleting")
                  : isGroup
                    ? t("deleteGroupAction", { n: willDelete })
                    : running > 0
                      ? t("deleteForce")
                      : t("remove"),
              ),
            ),
          ),
        );
      }

      /**
       * Start a DSH session in a project.
       *
       * `openWorkspace` is the DSH-native verb: it reuses a blank session in
       * that workspace or creates one, then brings it on screen. The workspace
       * is looked up by path first, so a project that already exists is not
       * registered twice.
       */
      async function startDshSession(cwd, faces) {
        const uiWorkspace = faces.uiWorkspace();
        const workspaces = faces.workspaces();
        if (uiWorkspace === null || workspaces === null) throw new Error(t("noWorkspace"));

        let workspaceId;
        const items = workspaces.list?.getSnapshot?.().items;
        if (Array.isArray(items)) {
          workspaceId = items.find((item) => item.path === cwd)?.workspaceId;
        }
        if (workspaceId === undefined && typeof workspaces.create === "function") {
          const view = await workspaces.create({ path: cwd });
          workspaceId = view?.workspaceId ?? view?.id;
        }
        if (workspaceId === undefined) throw new Error(`no DSH workspace for ${cwd}`);
        await uiWorkspace.openWorkspace(workspaceId);
      }

      /**
       * The "start a session here" picker.
       *
       * DSH owns its workspace registry, so a DSH session is created through the
       * client; the command-line agents are launched by the Host in a terminal
       * at the project directory.
       */
      function SpawnDialog() {
        const state = React.useSyncExternalStore(spawning.subscribe, spawning.get, spawning.get);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);

        const close = React.useCallback(() => {
          if (busy) return;
          spawning.set(null);
        }, [busy]);

        useEscape(state !== null, close);
        React.useEffect(() => {
          setBusy(false);
          setError(null);
        }, [state]);

        if (state === null) return null;

        const start = async (agent) => {
          setBusy(true);
          setError(null);
          try {
            if (agent === "dsh") {
              await startDshSession(state.cwd, faces);
              say(t("startedDsh"));
            } else {
              const result = await hub("spawn", { agent, cwd: state.cwd });
              if (result.ok !== true) throw new Error(result.error ?? "spawn failed");
              const label = SPAWNABLE.find((entry) => entry.id === agent)?.label ?? agent;
              say(t("started", { agent: label }));
            }
            spawning.set(null);
          } catch (caught) {
            setError(String(caught?.message ?? caught));
          } finally {
            setBusy(false);
          }
        };

        return h(
          "div",
          { className: "sh-backdrop", onClick: close },
          h(
            "div",
            {
              className: "sh-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("spawnTitle"),
              onClick: (event) => event.stopPropagation(),
            },
            h("div", { className: "sh-dialog-title" }, t("spawnTitle")),
            h(
              "div",
              { className: "sh-dialog-session" },
              h("span", { className: "sh-group-folder", "aria-hidden": true }, h(FolderIcon)),
              h("span", { className: "sh-row-title" }, state.label),
            ),
            h("div", { className: "sh-dialog-path" }, state.cwd),
            h("div", { className: "sh-dialog-warn" }, t("spawnBody", { project: state.label })),
            h(
              "div",
              { className: "sh-spawn-list" },
              SPAWNABLE.map((agent) =>
                h(
                  "button",
                  { key: agent.id, type: "button", className: "sh-btn sh-spawn-btn", disabled: busy, onClick: () => start(agent.id) },
                  h("span", { className: `sh-agent-dot sh-agent-dot-${agent.id}`, "aria-hidden": true }),
                  h("span", null, agent.label),
                ),
              ),
            ),
            error !== null && h("div", { className: "sh-dialog-danger" }, error),
            h(
              "div",
              { className: "sh-dialog-actions" },
              h("button", { type: "button", className: "sh-btn", disabled: busy, onClick: close }, t("cancel")),
            ),
          ),
        );
      }

      return { Overlay, SidebarTab, DeleteDialog, SpawnDialog, PreviewDialog };
    }

    /**
     * A session-scoped, render-nothing bridge.
     *
     * The panel lives at root scope but must write into the *current* composer.
     * The composer's `inputActions` are only reachable from a session-scoped
     * slot, so this entry publishes them for the panel to use.
     */
    function Bridge(props) {
      const actions = props?.inputActions ?? null;
      const sessionId = props?.sessionId ?? null;
      React.useEffect(() => {
        composer.set({ sessionId, inputActions: actions });
        return () => {
          if (composer.get().sessionId === sessionId) composer.set({ sessionId: null, inputActions: null });
        };
      }, [sessionId, actions]);
      return null;
    }

    /**
    /**
    /**
    /**
     * The live preview, as one of the right Sidebar tab's modes.
     *
     * A grid of small tiles — one per running agent — plus a detail panel for
     * whichever tile is selected. The grid answers "what is running at all";
     * the panel is for the questions that need room: which directory, how long
     * it has been up, what it has spent, and what it is waiting on.
     */
    function makeLivePanel(t) {
      function LiveTile({ session, selected, onSelect, onOpen, transcriptCache, onDragState }) {
        const { prefetch, onDragStart, onDragEnd } = useSessionDrag({ card: session, transcriptCache, onDragState });
        const pending = session.pending ?? null;

        return h(
          "div",
          {
            className: `sh-tile${selected ? " sh-tile-on" : ""}${pending !== null ? " sh-tile-wait" : ""}`,
            role: "button",
            tabIndex: 0,
            draggable: true,
            "aria-pressed": selected,
            onDragStart,
            onDragEnd,
            onPointerEnter: prefetch,
            onPointerDown: prefetch,
            onFocus: prefetch,
            onClick: onSelect,
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect();
            },
            title: [session.agentLabel, session.cwd].filter(Boolean).join(" · "),
          },
          h(
            "div",
            { className: "sh-tile-head" },
            h("span", { className: `sh-agent-dot sh-agent-dot-${session.agent}`, "aria-hidden": true }),
            h("span", { className: "sh-tile-agent" }, session.agentLabel),
            h("span", { className: "sh-spacer" }),
            h("span", { className: "sh-tile-time" }, formatDuration(session.elapsedMs)),
            // Jump straight out of the grid: opening the detail panel first is
            // two clicks for the one thing a tile is usually wanted for.
            h(
              "button",
              {
                type: "button",
                className: "sh-icon-btn",
                title: sessionOpenTitle(t, session),
                "aria-label": sessionOpenTitle(t, session),
                onClick: (event) => {
                  event.stopPropagation();
                  onOpen(session);
                },
              },
              h(OpenIcon),
            ),
          ),
          // The title is the point of a tile: without it the grid says "something
          // is running" but not what.
          h("span", { className: "sh-tile-title" }, session.title),
          h(
            "div",
            { className: "sh-tile-foot" },
            h("span", { className: "sh-tile-proj" }, session.project ?? "\u2014"),
            pending !== null &&
              h(
                "span",
                { className: `sh-tile-badge${pending.kind === "approval" ? " sh-tile-badge-wait" : ""}` },
                pending.kind === "approval" ? t("waitApproval") : t("waitTool"),
              ),
          ),
        );
      }

      function DetailLine({ label, value, mono }) {
        return h(
          "div",
          { className: "sh-lp-line" },
          h("span", { className: "sh-lp-k" }, label),
          h("span", { className: `sh-lp-v${mono === true ? " sh-lp-mono" : ""}` }, value),
        );
      }

      function LiveDetail({ session, onContinue, onOpen, onClose, transcriptCache, onDragState }) {
        const { prefetch, onDragStart, onDragEnd } = useSessionDrag({ card: session, transcriptCache, onDragState });
        const pending = session.pending ?? null;
        const tokens = session.tokens ?? null;

        const tokensText =
          tokens === null
            ? t("noTokens")
            : [
                `${t("tokIn")} ${formatTokens(tokens.input)}`,
                `${t("tokOut")} ${formatTokens(tokens.output)}`,
                tokens.cacheRead + tokens.cacheWrite > 0
                  ? `${t("tokCache")} ${formatTokens(tokens.cacheRead + tokens.cacheWrite)}`
                  : null,
                `${t("tokTotal")} ${formatTokens(tokens.total)}`,
              ]
                .filter(Boolean)
                .join(" · ");

        const waitingText =
          pending === null
            ? t("noWaiting")
            : [
                pending.kind === "approval" ? t("waitApproval") : t("waitTool"),
                pending.label,
                pending.count > 1 ? `\u00d7${pending.count}` : null,
              ]
                .filter(Boolean)
                .join(" · ");

        const uptimeText =
          session.elapsedMs === null || session.elapsedMs === undefined
            ? "\u2014"
            : `${formatDuration(session.elapsedMs)}${session.startedAt ? ` \u00b7 ${new Date(session.startedAt).toLocaleTimeString()}` : ""}`;

        const openTitle = sessionOpenTitle(t, session);

        return h(
          "div",
          {
            className: "sh-lp-card",
            draggable: true,
            onDragStart,
            onDragEnd,
            onPointerEnter: prefetch,
            onPointerDown: prefetch,
            onFocus: prefetch,
          },
          h(
            "div",
            { className: "sh-lp-card-head" },
            h("span", { className: `sh-agent-dot sh-agent-dot-${session.agent}`, "aria-hidden": true }),
            h("span", { className: "sh-lp-agent" }, session.agentLabel),
            h("span", { className: "sh-lp-proj" }, session.project ?? "\u2014"),
            h("span", { className: "sh-spacer" }),
            h(
              "span",
              { className: "sh-lp-actions" },
              h(
                "button",
                { type: "button", className: "sh-icon-btn", title: t("continue"), "aria-label": t("continue"), onClick: () => onContinue(session) },
                h(ContinueIcon),
              ),
              h(
                "button",
                { type: "button", className: "sh-icon-btn", title: openTitle, "aria-label": openTitle, onClick: () => onOpen(session) },
                h(OpenIcon),
              ),
              h(
                "button",
                { type: "button", className: "sh-icon-btn", title: t("close"), "aria-label": t("close"), onClick: onClose },
                h(CloseIcon),
              ),
            ),
          ),
          h("div", { className: "sh-lp-title" }, session.title),
          h(DetailLine, { label: t("detailDir"), value: session.cwd ?? "\u2014", mono: true }),
          h(DetailLine, { label: t("detailUptime"), value: uptimeText }),
          h(DetailLine, { label: t("detailModel"), value: session.model ?? "\u2014" }),
          h(DetailLine, { label: t("detailTokens"), value: tokensText }),
          // A session that switched models shows each one's own usage; a single
          // line would read as though the whole conversation ran on the last.
          ...Object.entries(session.models ?? {}).map(([name, usage]) =>
            h(DetailLine, {
              key: name,
              label: name,
              value: `${t("tokIn")} ${formatTokens(usage.input)} \u00b7 ${t("tokOut")} ${formatTokens(usage.output)} \u00b7 ${t("tokTotal")} ${formatTokens(usage.total)}`,
            }),
          ),
          h(DetailLine, { label: t("detailWaiting"), value: waitingText }),
          h(
            "div",
            { className: "sh-lp-line" },
            h("span", { className: "sh-lp-k" }, t("liveIn")),
            h("span", { className: "sh-lp-v" }, session.input ?? t("liveNothing")),
          ),
          h(
            "div",
            { className: "sh-lp-line" },
            h("span", { className: "sh-lp-k" }, t("liveOut")),
            h("span", { className: "sh-lp-v" }, session.output ?? t("liveNoOutput")),
          ),
          h("div", { className: "sh-lp-kind" }, session.source === "hook" ? t("liveHookSource") : t("liveStoreSource")),
        );
      }

      return function LivePanel({ onContinue, onOpen, transcriptCache, onDragState }) {
        const [state, setState] = React.useState({ running: 0, sessions: [], error: null });
        const [now, setNow] = React.useState(() => Date.now());
        const [reloadAt, setReloadAt] = React.useState(0);
        const [selected, setSelected] = React.useState(null);

        React.useEffect(() => {
          let cancelled = false;
          let inFlight = false;
          const tick = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
              const result = await hub("preview");
              if (cancelled) return;
              setState({ running: result.runningCount ?? 0, sessions: result.sessions ?? [], error: null });
              setNow(Date.now());
            } catch (caught) {
              if (!cancelled) setState((current) => ({ ...current, error: String(caught?.message ?? caught) }));
            } finally {
              inFlight = false;
            }
          };
          const timer = setInterval(tick, 2000);
          tick();
          return () => {
            cancelled = true;
            clearInterval(timer);
          };
        }, [reloadAt]);

        // A session that stopped running must not leave its detail panel open.
        const detail = state.sessions.find((session) => session.key === selected) ?? null;

        return h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "sh-head" },
            h("span", { className: "sh-lp-dot", "aria-hidden": true }),
            h("span", { className: "sh-title" }, t("live")),
            h("span", { className: "sh-group-count" }, t("liveRunning", { n: state.running })),
            h("span", { className: "sh-spacer" }),
            state.sessions.length > 1 && h("span", { className: "sh-group-count" }, t("liveHint")),
            h(
              "button",
              {
                type: "button",
                className: "sh-icon-btn",
                onClick: () => setReloadAt((value) => value + 1),
                title: t("refresh"),
                "aria-label": t("refresh"),
              },
              h(RefreshIcon),
            ),
          ),
          h(
            "div",
            { className: "sh-scroll" },
            state.error !== null
              ? h("div", { className: "sh-empty" }, state.error)
              : state.sessions.length === 0
                ? h("div", { className: "sh-empty" }, t("liveIdle"))
                : h(
                    React.Fragment,
                    null,
                    h(
                      "div",
                      { className: "sh-tiles" },
                      state.sessions.map((session) =>
                        h(LiveTile, {
                          key: session.key,
                          session,
                          selected: session.key === selected,
                          onOpen,
                          onSelect: () => setSelected((current) => (current === session.key ? null : session.key)),
                          transcriptCache,
                          onDragState,
                        }),
                      ),
                    ),
                    detail !== null &&
                      h(LiveDetail, {
                        session: detail,
                        onContinue,
                        onOpen,
                        onClose: () => setSelected(null),
                        transcriptCache,
                        onDragState,
                      }),
                  ),
          ),
        );
      };
    }

    /** The right Sidebar tab's chip content. Kept boxless so dockkit lays it out. */
    function makeTabTitle(t) {
      return function SessionHubTabTitle() {
        return h(
          "span",
          { className: "sh-tab-title" },
          h(HubIcon, { size: 15 }),
          h("span", { className: "sh-tab-title-label" }, t("tab")),
        );
      };
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    function apply(ctx) {
      installStyles();

      ctx.effect(() => ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH }), "dsh-session-hub: dictionaries");
      const t = ctx.locale.bind(NS);

      // `uiWorkspace` is optional: without it, DSH sessions simply cannot be reopened.
      const faces = { uiWorkspace: () => null, workspaces: () => null };
      ctx.inject(["uiWorkspace"], (scoped) => {
        const read = () => scoped.uiWorkspace ?? null;
        faces.uiWorkspace = read;
        scoped.effect(() => {
          faces.uiWorkspace = read;
          return () => {
            faces.uiWorkspace = () => null;
          };
        }, "dsh-session-hub: uiWorkspace face");
      });

      // The workspace registry is what turns a project path into the workspace a
      // new DSH session can be created in.
      ctx.inject(["workspaces"], (scoped) => {
        const read = () => scoped.workspaces ?? null;
        faces.workspaces = read;
        scoped.effect(() => {
          faces.workspaces = read;
          return () => {
            faces.workspaces = () => null;
          };
        }, "dsh-session-hub: workspaces face");
      });

      const { Overlay, SidebarTab, DeleteDialog, SpawnDialog, PreviewDialog } = makeHub(ctx, t, faces);

      // Frame-wide entry + overlay.
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-hub", order: 20, locale: NS, label: () => t("entry") },
          makeEntry(t),
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "session-hub-panel", order: 20, locale: NS }, Overlay),
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "session-hub-confirm", order: 21, locale: NS }, DeleteDialog),
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "session-hub-spawn", order: 22, locale: NS }, SpawnDialog),
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "session-hub-preview", order: 23, locale: NS }, PreviewDialog),
      );

      // The dock bridge that hands the overlay the live composer's actions.
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register({ name: "conversation.composer.dock", id: "session-hub-bridge", order: 1000, locale: NS }, Bridge),
      );

      // The live preview is a mode inside the right Sidebar's tab, not a strip
      // above the composer.

      /**
       * The right Sidebar tab — the seat meant for dragging, since the column
       * sits beside the conversation instead of over it.
       *
       * A tab type registers in two stages, the same public path every shipped
       * type uses: the type itself (which also contributes the guide card), then
       * its body and chip under the type's own id.
       */
      ctx.inject(["sidebarRightTabs"], (scoped) => {
        const tabs = scoped.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== "function") return;

        scoped.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              title: () => t("tab"),
              guide: [{ order: 30, title: () => t("tab"), description: () => t("guide"), icon: HubIcon }],
            }),
          "dsh-session-hub: sidebar tab type",
        );
        scoped.slots.inject("sidebar.right.pane.tab", () =>
          scoped.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID, locale: NS }, SidebarTab),
        );
        scoped.slots.inject("sidebar.right.pane.tab.title", () =>
          scoped.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, makeTabTitle(t)),
        );
      });
    }

    return { name: "dsh-session-hub", inject: ["slots", "locale"], apply };
  },
});
