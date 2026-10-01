// dsh-meeting-room v3 客户端
//
// 结构：
//   sidebar.panellist —— 分组导航树（标题 / 新建 / 设置 / 分类组 / 房间行 / 已归档组）
//   main              —— 总览树页（工作区式：＋ 新建 / 设置 / ⋯ 菜单）、聊天室页 + 「策划会议」抽屉、
//                        《会议结果》页签、全局设置页
//
// 契约见 docs/v3-API.md。仅依赖 react，React.createElement 风格（无 JSX）。
window.__ModuleLoader__.load({
  id: 'dsh-meeting-room',
  factory: (require) => {
    const react = require('react');
    const h = react.createElement;

    const API = '/dsh-room';
    const POLL_MS = 1500;
    const PANEL_ID = 'dsh-meeting-room';
    const KEY_PREFIX = 'dsh-meeting-room:';
    const NEW_ID = `${PANEL_ID}:new`;
    const SETTINGS_ID = `${PANEL_ID}:settings`;
    const GROUP_PREFIX = `${PANEL_ID}:cat:`;
    const ARCHIVE_ID = `${PANEL_ID}:archived`;
    const FOLD_KEY = `${KEY_PREFIX}fold`;
    const ENTRY_ORDER = 100;
    const NEW_ORDER = 101;
    const SETTINGS_ORDER = 102;
    const GROUP_ORDER = 200;
    const ARCHIVE_ORDER = 9000;

    // v7①：发送即自动提醒 ⇒ 用户正文永不进与会者会话，但每条消息都固定发一行 notice（不含正文）
    //（既没有「默认投递方式」档位，也没有手动唤醒按钮：客户端只发 notice，正文只落在会议记录里）
    const REASONING_LEVELS = ['inherit', 'low', 'medium', 'high'];
    const REASONING_LABEL = { inherit: '跟随房间', low: '低', medium: '中', high: '高' };

    // ── 主题常量 ────────────────────────────────────────────────────────────────
    const LINE = 'var(--dsw-alias-border-l1)';
    const LINE2 = 'var(--dsw-alias-border-l2)';
    const FILL = 'var(--dsw-alias-interactive-bg-hover)';
    const LAYER = 'var(--dsw-alias-bg-layer-1)';
    const LAYER2 = 'var(--dsw-alias-bg-layer-2)';
    const OVERLAY = 'var(--dsw-alias-bg-overlay)';
    const TEXT = 'var(--dsw-alias-label-primary)';
    const TEXT_INVERTED = 'var(--dsw-alias-label-primary-inverted)';
    const MUTED = 'var(--dsw-alias-label-secondary)';
    const FAINT = 'var(--dsw-alias-label-tertiary)';
    const ACCENT = 'var(--dsw-alias-brand-primary)';
    const WARN = 'var(--dsw-alias-state-warn-primary)';
    const DANGER = 'var(--dsw-alias-state-error-primary)';
    const OK = 'var(--dsw-alias-state-success-primary)';
    const IDLE = 'var(--dsw-alias-state-idle-primary)';
    const SIDEBAR_FILL = 'var(--dsw-specific-sidebar-fill)';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    // v14④：消息索引的刻度粒度 —— 每个「轮次头」占 RAIL_TICK 像素，整条索引最高 RAIL_MAX_HEIGHT。
    // 必须声明在 S 之前（S.rail / S.railList 直接引用），否则 const 的 TDZ 会让整个客户端炸掉。
    const RAIL_TICK = 10;
    const RAIL_MAX_HEIGHT = 420;

    // ── 样式 ────────────────────────────────────────────────────────────────────
    const S = {
      // v9：外层是「左列（原房间页）+ 右侧栏」的横向容器
      cols: { display: 'flex', alignItems: 'stretch', height: '100%', minHeight: 0, width: '100%' },
      root: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: '1 1 auto', minWidth: 0, fontSize: 13, lineHeight: 1.55, color: TEXT },
      head: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${LINE}`, flex: 'none', flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 14 },
      chip: { padding: '1px 8px', borderRadius: 999, background: FILL, color: MUTED, fontSize: 12, whiteSpace: 'nowrap' },
      chipOn: { padding: '1px 8px', borderRadius: 999, background: LAYER2, color: OK, fontSize: 12, whiteSpace: 'nowrap' },
      chipOff: { padding: '1px 8px', borderRadius: 999, background: LAYER2, color: FAINT, fontSize: 12, whiteSpace: 'nowrap' },
      chipWarn: { padding: '1px 8px', borderRadius: 999, background: LAYER2, color: WARN, fontSize: 12, whiteSpace: 'nowrap' },
      chipAccent: { padding: '1px 8px', borderRadius: 999, background: LAYER2, color: ACCENT, fontSize: 12, whiteSpace: 'nowrap' },
      spacer: { flex: '1 1 auto' },
      btn: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${LINE}`, background: 'transparent', color: TEXT, cursor: 'pointer', fontSize: 12, lineHeight: '18px', fontFamily: 'inherit' },
      btnPrimary: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${ACCENT}`, background: ACCENT, color: TEXT_INVERTED, cursor: 'pointer', fontSize: 12, lineHeight: '18px', fontFamily: 'inherit' },
      btnOn: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${ACCENT}`, background: LAYER2, color: ACCENT, cursor: 'pointer', fontSize: 12, lineHeight: '18px', fontFamily: 'inherit' },
      btnDanger: { padding: '4px 10px', borderRadius: 6, border: `1px solid ${DANGER}`, background: 'transparent', color: DANGER, cursor: 'pointer', fontSize: 12, lineHeight: '18px', fontFamily: 'inherit' },
      btnTiny: { padding: '1px 6px', borderRadius: 5, border: `1px solid ${LINE}`, background: 'transparent', color: MUTED, cursor: 'pointer', fontSize: 11, lineHeight: '16px', fontFamily: 'inherit' },
      iconBtn: { width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer', fontSize: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      hint: { color: FAINT, fontSize: 11 },
      box: { border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
      boxWarn: { border: `1px solid ${WARN}`, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: LAYER2 },
      boxHead: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      grow: { flex: '1 1 auto' },
      inlineInput: { flex: '1 1 120px', minWidth: 80, padding: '3px 6px', borderRadius: 6, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 12, fontFamily: 'inherit' },
      select: { padding: '2px 4px', borderRadius: 6, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 12, fontFamily: 'inherit' },
      textarea: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' },
      online: { width: 8, height: 8, borderRadius: 999, background: OK, flex: 'none' },
      offline: { width: 8, height: 8, borderRadius: 999, background: FAINT, flex: 'none' },
      member: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 999, border: `1px solid ${LINE}`, background: 'transparent', color: TEXT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      memberOn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 999, border: `1px solid ${ACCENT}`, background: LAYER2, color: ACCENT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      dead: { color: FAINT, textDecoration: 'line-through' },
      kick: { border: 'none', background: 'transparent', color: FAINT, cursor: 'pointer', fontSize: 12, padding: '0 2px' },
      scroll: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', scrollbarGutter: 'stable' },
      messages: { display: 'flex', flexDirection: 'column', gap: 8 },
      inner: { padding: '10px 26px 10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
      empty: { color: FAINT, padding: '16px 4px' },
      msg: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderRadius: 8 },
      msgUser: { alignItems: 'flex-end' },
      msgOther: { alignItems: 'flex-start' },
      bubbleUser: { background: LAYER2, borderRadius: 10, padding: '6px 10px', maxWidth: '78%' },
      bubbleOther: { borderRadius: 10, padding: '6px 10px', maxWidth: '78%' },
      bubbleSystem: { padding: '2px 0', maxWidth: '78%', color: FAINT, fontStyle: 'italic' },
      meta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: FAINT, flexWrap: 'wrap' },
      who_user: { color: ACCENT, fontWeight: 600 },
      who_agent: { color: OK, fontWeight: 600 },
      who_system: { color: FAINT, fontStyle: 'italic' },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      file: { color: ACCENT, textDecoration: 'none', fontSize: 12 },
      // ── v13③④ / v14③④：跟随滚动 + 右侧轮次轨道（只在这一带新增样式，不改上面任何一条） ──
      scrollWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      // DSH 的 [data-chat-following-tail]：跟随时关掉 overflow-anchor，新消息才不会被浏览器的锚定逻辑顶歪
      scrollFollowing: { overflowAnchor: 'none' },
      // v14③：仿普通会话的轮次轨道 —— 悬浮在右侧（离边 12px）、垂直居中、最高 420px；整条 pointerEvents:none，
      // 滚轮与滚动条拖动照常穿透（只有刻度按钮自己 pointerEvents:auto）。
      rail: { position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 20, maxHeight: RAIL_MAX_HEIGHT, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', pointerEvents: 'none', zIndex: 3 },
      railList: { maxHeight: RAIL_MAX_HEIGHT, overflowY: 'auto', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
      // 刻度行固定 10px 高，横线画在行里 ⇒ 等距排列，不再被消息正文的长短拉开
      mark: { width: 20, height: 10, flex: 'none', border: 'none', padding: 0, margin: 0, background: 'transparent', cursor: 'pointer', pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
      markLine: { width: 12, height: 2, borderRadius: 1, background: FAINT, opacity: 0.5 },
      markGoal: { width: 20, height: 3, background: ACCENT, opacity: 0.85 },
      markView: { width: 20, background: TEXT, opacity: 1 },
      markOn: { width: 20, height: 3, background: TEXT, opacity: 1 },
      railPreview: { position: 'absolute', right: 26, maxWidth: 240, padding: '3px 7px', borderRadius: 6, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none', zIndex: 4, boxSizing: 'border-box' },
      msgFlash: { background: LAYER2 },
      toBottom: { position: 'absolute', right: 14, bottom: 10, width: 30, height: 30, borderRadius: 15, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, cursor: 'pointer', fontSize: 14, lineHeight: '28px', padding: 0, textAlign: 'center', zIndex: 5 },
      // v16①：滚上去浏览历史时图标常驻；真有新消息时用主题色点亮
      toBottomNew: { border: `1px solid ${ACCENT}`, color: ACCENT, fontWeight: 700 },
      // v16⑦：底栏数字条（宿主给数、客户端只排版；鼠标悬停看每个人的明细）
      stats: { flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '4px 12px', borderTop: `1px solid ${LINE}`, color: FAINT, fontSize: 11, whiteSpace: 'nowrap', overflowX: 'auto' },
      statPill: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' },
      composer: { flex: 'none', borderTop: `1px solid ${LINE}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
      composerInner: { display: 'flex', alignItems: 'flex-end', gap: 6 },
      input: { flex: '1 1 auto', minHeight: 34, maxHeight: 140, padding: '6px 8px', borderRadius: 8, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' },
      send: { padding: '6px 14px', borderRadius: 8, border: `1px solid ${ACCENT}`, background: ACCENT, color: TEXT_INVERTED, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
      note: { color: FAINT, fontSize: 11, fontFamily: MONO, wordBreak: 'break-all' },
      bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: `1px solid ${LINE}`, flex: 'none', flexWrap: 'wrap' },
      barLabel: { color: FAINT, fontSize: 12 },
      pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: MONO, fontSize: 12, margin: 0 },
      tabRoot: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      // 工作区式树
      tree: { display: 'flex', flexDirection: 'column', gap: 10 },
      group: { display: 'flex', flexDirection: 'column', gap: 2 },
      groupHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer', userSelect: 'none', borderRadius: 6 },
      caret: { width: 12, color: FAINT, fontSize: 10 },
      groupName: { fontWeight: 600, fontSize: 12 },
      groupCount: { color: FAINT, fontSize: 11 },
      groupPath: { color: FAINT, fontSize: 11, marginLeft: 'auto', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' },
      groupBody: { display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 12 },
      roomRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, border: `1px solid transparent` },
      roomRowDim: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, border: `1px solid transparent`, opacity: 0.62 },
      roomMain: { display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0, cursor: 'pointer', background: 'transparent', border: 'none', color: TEXT, textAlign: 'left', font: 'inherit', padding: 0 },
      roomName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      roomTime: { color: FAINT, fontSize: 11, whiteSpace: 'nowrap' },
      dot: { width: 8, height: 8, borderRadius: 999, flex: 'none' },
      menuWrap: { position: 'relative', flex: 'none' },
      menu: { position: 'absolute', right: 0, top: 24, zIndex: 40, minWidth: 150, padding: 4, borderRadius: 8, border: `1px solid ${LINE}`, background: LAYER, boxShadow: '0 6px 24px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: 1 },
      menuItem: { textAlign: 'left', padding: '4px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: TEXT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      // 抽屉
      overlay: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 60 },
      sheet: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(430px, 94%)', zIndex: 61, background: LAYER, borderLeft: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,0.18)' },
      sheetHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${LINE}`, flex: 'none' },
      sheetBody: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 },
      // v6③：插件自带输入框（宿主运行时没有原生输入对话框，必须自己出面板）
      dialogWrap: { position: 'absolute', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      dialogCard: { position: 'relative', zIndex: 71, width: 'min(420px, 92%)', background: LAYER, border: `1px solid ${LINE}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.22)' },
      dialogError: { color: DANGER, fontSize: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldLabel: { fontSize: 11, color: MUTED, fontWeight: 600 },
      dirList: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 160, overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: 6, padding: 4 },
      dirItem: { textAlign: 'left', padding: '3px 6px', borderRadius: 5, border: 'none', background: 'transparent', color: TEXT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      seg: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
      toast: { position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)', zIndex: 90, padding: '6px 12px', borderRadius: 8, border: `1px solid ${LINE}`, background: LAYER2, color: TEXT, fontSize: 12, maxWidth: '80%', boxShadow: '0 6px 24px rgba(0,0,0,0.18)' },
      banner: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${LINE}`, background: LAYER2, flex: 'none', flexWrap: 'wrap' },
      active: { borderColor: ACCENT },
      // v9：右侧栏（会议文件 / 会议结果）
      side: { flex: 'none', width: 300, minWidth: 240, maxWidth: '46%', borderLeft: `1px solid ${LINE}`, background: SIDEBAR_FILL, display: 'flex', flexDirection: 'column', minHeight: 0 },
      sideHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${LINE}`, flex: 'none' },
      sideBody: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
      tabBtn: { padding: '3px 10px', borderRadius: 999, border: `1px solid ${LINE}`, background: 'transparent', color: MUTED, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' },
      tabBtnOn: { padding: '3px 10px', borderRadius: 999, border: `1px solid ${ACCENT}`, background: LAYER2, color: TEXT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600 },
      sideList: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: '38%', flex: 'none', overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: 8, padding: 4 },
      fileItem: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6, border: 'none', background: 'transparent', color: TEXT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'left' },
      fileItemOn: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6, border: 'none', background: LAYER2, color: ACCENT, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'left' },
      fileName: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
      preview: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, background: LAYER, display: 'flex', flexDirection: 'column', gap: 6 },
      resRow: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 4px', borderBottom: `1px solid ${LINE}` },
    };

    // 与会者名字稳定分色：同一 label/sessionId 每次落到同一个官方 token
    const NAME_COLORS = [ACCENT, OK, WARN, DANGER, IDLE, MUTED];
    function hashName(key) {
      const text = String(key == null ? '' : key);
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      return hash;
    }
    function nameColor(key) { return NAME_COLORS[hashName(key) % NAME_COLORS.length]; }

    function whoStyle(kind, key) {
      if (kind === 'system') return S.who_system;
      return { color: nameColor(key || kind), fontWeight: 600 };
    }

    // ── 基础工具 ────────────────────────────────────────────────────────────────
    function q(text) { return encodeURIComponent(String(text == null ? '' : text)); }
    function shortId(id) { return String(id || '').slice(0, 8); }
    function stamp(at) {
      if (!at) return '';
      try { return new Date(at).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; }
    }
    function relTime(at) {
      if (!at) return '';
      const diff = Date.now() - Number(at);
      if (!Number.isFinite(diff) || diff < 0) return '刚刚';
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
      if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
      try { const d = new Date(Number(at)); return `${d.getMonth() + 1}/${d.getDate()}`; } catch { return ''; }
    }
    function baseName(p) {
      const text = String(p || '').replace(/[\\/]+$/, '');
      const parts = text.split(/[\\/]/);
      return parts[parts.length - 1] || text;
    }
    function byteSize(n) {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / 1024 / 1024).toFixed(1)} MB`;
    }
    function firstLine(text, max) {
      const line = String(text == null ? '' : text).split('\n')[0];
      const limit = max || 36;
      return line.length > limit ? `${line.slice(0, limit)}…` : line;
    }
    function warn(message) {
      try { console.warn(`[dsh-meeting-room] ${message}`); } catch { /* noop */ }
    }

    // ── HTTP ────────────────────────────────────────────────────────────────────
    // v12①：触发记录员的接口（散会 / 标记达成）要等一轮 LLM（实测 ≈50s，宿主自己 240s 放弃），
    // 所以这两条走 300s 超时 —— 8s 超时正是截图里那个 `signal timed out` 红框的唯一来源。
    const DEFAULT_TIMEOUT_MS = 8000;
    const RECORDER_TIMEOUT_MS = 300000;
    async function json(path, init, timeoutMs) {
      const opts = { method: (init && init.method) || 'GET', headers: {} };
      if (init && init.body !== undefined) {
        opts.body = init.body;
        opts.headers['content-type'] = 'application/json';
      }
      const limit = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
      try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(limit); } catch { /* noop */ }
      let res;
      try {
        res = await fetch(`${API}${path}`, opts);
      } catch (error) {
        // 超时/中断：把 DOMException 的 `signal timed out` 换成人能读的话
        if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new Error(`等待超过 ${Math.round(limit / 1000)} 秒没有回应${limit > DEFAULT_TIMEOUT_MS ? '（记录员可能还在写，稍后刷新看看）' : ''}`);
        }
        throw error;
      }
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }
    const getJson = (path) => json(path, { method: 'GET' });
    const postJson = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body || {}) });
    // 只有「会触发记录员跑一轮」的接口用长超时
    const postJsonLong = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body || {}) }, RECORDER_TIMEOUT_MS);
    const patchJson = (path, body) => json(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
    const deleteJson = (path) => json(path, { method: 'DELETE' });
    async function getText(path) {
      const res = await fetch(`${API}${path}`);
      const text = await res.text();
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try { message = JSON.parse(text).error || message; } catch { /* noop */ }
        throw new Error(message);
      }
      return text;
    }

    // ── 全局状态 ────────────────────────────────────────────────────────────────
    const meeting = {
      rooms: [],
      loaded: false,
      error: '',
      activeRoom: '',
      activePanelId: '',
      defaultRoomId: '',
      collapsed: false,
      folded: {},
      groups: [],
      archivedGroup: { id: ARCHIVE_ID, name: '已归档', archived: true, rooms: [] },
      settings: null,
      defaultCategory: '',
      sessions: [],
      toast: null,
      createOpen: false,
      // v16④：从某个分组里点「＋」新建时，把该分组的目录带进来（房间就建在这个分组的文件夹下）
      createCategory: '',
      rightGoal: '',
    };

    const views = new Map();
    const listeners = new Set();
    let revision = 0;

    function emit() {
      revision += 1;
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { warn(`listener: ${error && error.message}`); }
      }
    }
    function subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
    function snapshot() { return revision; }
    function useStore() {
      if (typeof react.useSyncExternalStore === 'function') return react.useSyncExternalStore(subscribe, snapshot);
      const [, force] = react.useState(0);
      const seen = react.useRef(revision);
      react.useEffect(() => subscribe(() => force((n) => n + 1)), []);
      seen.current = revision;
      return revision;
    }

    let toastTimer = null;
    function toast(text, kind) {
      meeting.toast = { text: String(text == null ? '' : text), kind: kind || 'info' };
      emit();
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { meeting.toast = null; emit(); }, kind === 'error' ? 6000 : 3200);
    }

    function newView(roomId) {
      return {
        roomId,
        loaded: false,
        inFlight: false,
        error: '',
        since: 0,
        log: [],
        room: null,
        root: '',
        members: [],
        files: [],
        goals: [],
        results: [],
        push: '',
        reasoning: '',
        resolution: null,
        draft: '',
        targets: {},
        invites: null,
        inviteBusy: false,
        drawer: false,
        // v9：右侧常驻栏（会议文件 / 会议结果）
        sideOpen: true,
        sideTab: 'files',
        fileSel: '',
        preview: null,  // { name, loading, error, kind:'text'|'binary', text, bytes, truncated }
        dialog: null,   // v6③：插件自带输入框 { title, hint, value, placeholder, required, confirmLabel, error, onOk }
        deleting: false,
        purge: false,
      };
    }
    function viewOf(roomId) {
      if (!views.has(roomId)) views.set(roomId, newView(roomId));
      return views.get(roomId);
    }

    function roomById(id) { return meeting.rooms.find((room) => room.id === id) || null; }

    // ── 折叠状态（本地记住） ────────────────────────────────────────────────────
    function loadFold() {
      try {
        const raw = window.localStorage.getItem(FOLD_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') meeting.folded = parsed;
        }
      } catch { /* noop */ }
    }
    function saveFold() {
      try { window.localStorage.setItem(FOLD_KEY, JSON.stringify(meeting.folded)); } catch { /* noop */ }
    }
    function isFolded(id) { return !!meeting.folded[id]; }
    function toggleFold(id) {
      const next = { ...meeting.folded };
      if (next[id]) delete next[id]; else next[id] = true;
      meeting.folded = next;
      saveFold();
      emit();
      syncSlots();
    }

    // ── 数据加载 ────────────────────────────────────────────────────────────────
    function groupName(category) {
      const name = baseName(category);
      return name || category || '未分类';
    }

    function rebuildGroups() {
      const map = new Map();
      const groups = [];
      for (const room of meeting.rooms) {
        if (room.archived) continue;
        const category = room.category || meeting.defaultCategory || '';
        if (!map.has(category)) {
          const group = { id: `${GROUP_PREFIX}${q(category)}`, category, name: groupName(category), archived: false, rooms: [] };
          map.set(category, group);
          groups.push(group);
        }
        map.get(category).rooms.push(room);
      }
      for (const group of groups) group.rooms.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const archived = meeting.rooms.filter((room) => room.archived)
        .sort((a, b) => (b.archivedAt || b.updatedAt || 0) - (a.archivedAt || a.updatedAt || 0));
      meeting.groups = groups;
      meeting.archivedGroup = { id: ARCHIVE_ID, name: '已归档', archived: true, rooms: archived };
    }

    const roomsState = { inFlight: false, timer: null };

    async function loadRooms() {
      if (roomsState.inFlight) return;
      roomsState.inFlight = true;
      try {
        const data = await getJson('/rooms');
        const list = data && Array.isArray(data.rooms) ? data.rooms : [];
        meeting.rooms = list;
        meeting.loaded = true;
        meeting.error = '';
        if (data && data.defaultRoomId) meeting.defaultRoomId = data.defaultRoomId;
        if (!meeting.activeRoom) meeting.activeRoom = meeting.defaultRoomId || (list[0] && list[0].id) || '';
      } catch (error) {
        meeting.loaded = true;
        meeting.error = (error && error.message) || String(error);
      } finally {
        roomsState.inFlight = false;
      }
      rebuildGroups();
      emit();
      syncSlots();
    }

    async function loadSettings() {
      try {
        const data = await getJson('/settings');
        meeting.settings = (data && data.settings) || null;
        meeting.defaultCategory = (data && data.defaultCategory) || (meeting.settings && meeting.settings.category) || '';
      } catch (error) {
        warn(`加载设置失败：${error && error.message}`);
      }
      emit();
    }

    async function loadSessions() {
      try {
        const data = await getJson('/sessions');
        const list = data && Array.isArray(data.sessions) ? data.sessions
          : (data && Array.isArray(data.candidates) ? data.candidates : []);
        meeting.sessions = list;
        // v4 宿主返回 { total, filtered }（已过滤子智能体/子会话）；旧宿主没有这两个字段 → 不显示统计行
        const total = data && typeof data.total === 'number' ? data.total : null;
        const filtered = data && typeof data.filtered === 'number' ? data.filtered : null;
        meeting.sessionMeta = (total === null && filtered === null) ? null : { total, filtered };
      } catch (error) {
        warn(`加载会话列表失败：${error && error.message}`);
        meeting.sessions = meeting.sessions || [];
        meeting.sessionMeta = null;
      }
      emit();
      return meeting.sessions;
    }

    async function pullRoom(roomId) {
      if (!roomId) return;
      const view = viewOf(roomId);
      if (view.inFlight) return;
      view.inFlight = true;
      try {
        const data = await getJson(`/rooms/${q(roomId)}/state${view.since ? `?since=${view.since}` : ''}`);
        if (!data || typeof data !== 'object') throw new Error('响应无效');
        if (data.room) view.room = data.room;
        if (typeof data.root === 'string') view.root = data.root;
        if (Array.isArray(data.members)) view.members = data.members;
        if (Array.isArray(data.files)) view.files = data.files;
        if (Array.isArray(data.goals)) view.goals = data.goals;
        if (Array.isArray(data.results)) view.results = data.results;
        if (data.push) view.push = data.push;
        if (data.reasoning) view.reasoning = data.reasoning;
        if (data.resolution !== undefined) view.resolution = data.resolution;
        if (Array.isArray(data.messages) && data.messages.length) {
          const seen = new Set(view.log.map((m) => m.seq));
          const merged = view.log.concat(data.messages.filter((m) => !seen.has(m.seq)));
          merged.sort((a, b) => (a.seq || 0) - (b.seq || 0));
          view.log = merged.slice(-2000);
        }
        const seq = Number(data.seq);
        if (Number.isFinite(seq)) view.since = seq;
        view.loaded = true;
        view.error = '';
        if (view.room) {
          const index = meeting.rooms.findIndex((room) => room.id === roomId);
          if (index >= 0) meeting.rooms[index] = { ...meeting.rooms[index], ...view.room };
          else meeting.rooms.push(view.room);
          rebuildGroups();
        }
      } catch (error) {
        view.error = (error && error.message) || String(error);
        view.loaded = true;
      } finally {
        view.inFlight = false;
      }
      emit();
    }

    const soonTimers = new Map();
    function pullRoomSoon(roomId) {
      if (!roomId || soonTimers.has(roomId)) return;
      soonTimers.set(roomId, setTimeout(() => { soonTimers.delete(roomId); pullRoom(roomId); }, 40));
    }

    async function refreshAll(roomId) {
      await Promise.all([roomId ? pullRoom(roomId) : Promise.resolve(), loadRooms()]);
    }

    function apiDirPath(dir) { return dir || ''; }

    // v15①：原先的 joinPath（拼 <父目录>\<新名字>\<房间id>）已删除 —— 现在「选择文件夹」拿到的
    // 绝对路径就是房间目录本身，客户端不再往后面拼房间 id（宿主 PATCH {dir} 本来就把 dir 当房间目录）。

    // 在资源管理器中打开：契约没有该端点，退化为复制路径。
    async function revealDir(dir) {
      const target = apiDirPath(dir);
      if (!target) { toast('该会议室还没有目录', 'error'); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(target);
          toast(`已复制目录路径，可在资源管理器中打开：${target}`, 'ok');
          return;
        }
      } catch { /* noop */ }
      toast(`目录：${target}`, 'info');
    }

    /**
     * v15①：弹**系统文件夹界面**拿绝对路径。两条路，按可用性依次尝试：
     *   ① DSH 桌面窗口的 preload 桥 —— 主进程 `dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`，
     *      返回绝对路径、取消时 null（纯浏览器页面里这个全局是 undefined）；
     *   ② 第一方客户端服务 `uiWorkspace.pickDirectory(): Promise<string|null>`（跨桌面/浏览器）。
     * 返回：字符串 = 选中目录；null = 用户取消；undefined = 两条路都不可用 ⇒ 调用方退回房间内浏览式选目录。
     */
    async function pickSystemFolder() {
      const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
      if (bridge && typeof bridge.pick === 'function') {
        try {
          const picked = await bridge.pick();
          if (typeof picked === 'string' && picked) return picked;
          if (picked === null || picked === '') return null;
        } catch { /* 落到 ② */ }
      }
      let workspace = null;
      try { workspace = (hostCtx && hostCtx.get && hostCtx.get('uiWorkspace')) || null; } catch { workspace = null; }
      if (workspace && typeof workspace.pickDirectory === 'function') {
        try {
          const picked = await workspace.pickDirectory();
          if (typeof picked === 'string' && picked) return picked;
          if (picked === null || picked === '') return null;
        } catch { /* 落到浏览式 */ }
      }
      return undefined;
    }

    /**
     * v15①：在系统资源管理器里打开房间目录。
     * 宿主插件拿不到 Electron API（宿主是纯 Node），但第一方宿主提供
     * `POST /open-in-app/open {app:'explorer', path}`（path 必须绝对且已存在）；
     * 用不了就退回「复制路径」的老行为。
     */
    async function revealDirInOS(dir) {
      const target = apiDirPath(dir);
      if (!target) { toast('该会议室还没有目录', 'error'); return; }
      try {
        const res = await fetch('/open-in-app/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: 'explorer', path: target }),
        });
        if (res.ok) return;
      } catch { /* 退回复制路径 */ }
      await revealDir(target);
    }

    // ── 面板跳转 ────────────────────────────────────────────────────────────────
    let hostCtx = null;

    function selectPanel(id) {
      try {
        if (hostCtx && hostCtx.layout && hostCtx.layout.selectPanel) hostCtx.layout.selectPanel(id);
      } catch (error) {
        toast((error && error.message) || String(error), 'error');
      }
    }
    function backToConversation() {
      // 这是我们自己主动回会话：告诉守卫别把用户又抢回会议室（否则「回会话」按钮会失效）
      panelGuard.selfClearAt = Date.now();
      selectPanel(null);
    }
    function hostActivePanelId() {
      try {
        const info = hostCtx && hostCtx.layout && hostCtx.layout.panelInfo;
        const snap = info && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null;
        return (snap && snap.activePanelId) || '';
      } catch { return ''; }
    }
    // ①② 面板内导航：只改插件自己的 activePanelId；只有宿主当前不在我们的面板时才让 shell 跳一次
    function goInternal(id) {
      const next = id || PANEL_ID;
      meeting.activePanelId = next;
      if (next === NEW_ID) meeting.createOpen = true;
      if (hostActivePanelId() !== PANEL_ID) selectPanel(PANEL_ID);
      emit();
      syncSlots();
    }
    function openRoom(roomId) {
      meeting.activeRoom = roomId;
      pullRoomSoon(roomId);
      goInternal(`${KEY_PREFIX}${roomId}`);
    }
    function openResult(roomId, goalId) {
      meeting.rightGoal = `${roomId}::${goalId || ''}`;
      emit();
      selectPanel(`${KEY_PREFIX}result:${roomId}`);
    }

    // ── 图标 ────────────────────────────────────────────────────────────────────
    function RoomIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3 20V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v14' }),
        h('path', { d: 'M16 10h3a2 2 0 0 1 2 2v8' }),
        h('path', { d: 'M2 20h20' }),
        h('path', { d: 'M7 8h4M7 12h4M7 16h4' }));
    }
    function ResultRowIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M6 3h9l4 4v14H6z' }),
        h('path', { d: 'M14 3v5h5' }),
        h('path', { d: 'M9 13h7M9 17h5' }));
    }
    function PlusIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('path', { d: 'M12 5v14M5 12h14' }));
    }
    function GearIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 2.6h.09A2 2 0 1 1 13 2.6h.09a1.7 1.7 0 0 0 1.51 1.01' }));
    }
    function CaretIcon(props) {
      const size = (props && props.size) || 18;
      const open = !(props && props.folded);
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6' }));
    }
    function statusColor(room) {
      if (room.archived) return FAINT;
      if (room.status === 'closed') return MUTED;
      return OK;
    }

    // ── 侧边栏行 ────────────────────────────────────────────────────────────────
    function roomRowLabel(room) {
      const time = relTime(room.updatedAt);
      const suffix = room.status === 'closed' ? '（已结束）' : (room.archived ? '（已归档）' : '');
      return `${room.title}${suffix}${time ? ` · ${time}` : ''}`;
    }

    function CaretGlyph(props) {
      const folded = isFolded(props.groupId);
      const size = (props && props.size) || 18;
      const narrow = size >= 18;
      return h('span', {
        role: 'button',
        tabIndex: -1,
        title: folded ? '展开分组' : '折叠分组',
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: narrow ? size : size, height: size, color: FAINT },
        onClick: (event) => { event.stopPropagation(); event.preventDefault(); toggleFold(props.groupId); },
      }, h(CaretIcon, { size: narrow ? 14 : 12, folded }));
    }

    function DotGlyph(props) {
      const room = props.room || {};
      const size = (props && props.size) || 18;
      const dot = narrowDot(size);
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size },
        title: room.status === 'closed' ? '已结束' : (room.archived ? '已归档' : '进行中'),
      }, h('span', { style: { ...S.dot, width: dot, height: dot, background: statusColor(room) } }));
    }
    function narrowDot(size) { return size >= 18 ? 9 : 8; }

    function desiredRows() {
      // ① 侧边栏只保留一个入口「会议室」：分类树 / 房间列表 / 新建 / 设置全部搬进面板内部
      return [{
        id: PANEL_ID,
        order: ENTRY_ORDER,
        label: '会议室',
        glyph: (props) => h(RoomIcon, { size: (props && props.size) || 18 }),
      }];
    }

    // ── 槽位注册 ────────────────────────────────────────────────────────────────
    const teardown = [];
    function mount(slotName, options, component) {
      const what = options.id || options.key;
      const register = () => {
        try {
          const dispose = hostCtx.slots.register(options, component);
          panelDiag({ kind: 'register', slot: slotName, id: what });
          return dispose;
        } catch (error) {
          warn(`注册 ${slotName} ${what} 失败：${(error && error.message) || error}`);
          panelDiag({ kind: 'register-failed', slot: slotName, id: what, error: (error && error.message) || String(error) });
          return () => {};
        }
      };
      let dispose = () => {};
      try {
        if (hostCtx && hostCtx.slots && typeof hostCtx.slots.inject === 'function') {
          const cancel = hostCtx.slots.inject(slotName, register);
          dispose = () => { try { cancel(); } catch { /* noop */ } };
        } else {
          dispose = register();
        }
      } catch (error) {
        warn(`注入 ${slotName} 失败：${(error && error.message) || error}`);
        panelDiag({ kind: 'inject-failed', slot: slotName, id: what, error: (error && error.message) || String(error) });
        dispose = register();
      }
      return dispose;
    }

    const rowDisposers = new Map();
    function applyRoomRows() {
      const rows = desiredRows();
      const wanted = new Set(rows.map((row) => row.id));
      for (const [id, record] of [...rowDisposers]) {
        if (wanted.has(id)) continue;
        try { record.dispose(); } catch { /* noop */ }
        rowDisposers.delete(id);
      }
      for (const row of rows) {
        const signature = `${row.order}|${row.label}`;
        const previous = rowDisposers.get(row.id);
        if (previous && previous.signature === signature) continue;
        if (previous) { try { previous.dispose(); } catch { /* noop */ } }
        const glyph = row.glyph;
        const dispose = mount('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: row.id,
          order: row.order,
          label: () => row.label,
        }, (props) => glyph(props));
        rowDisposers.set(row.id, { signature, dispose });
      }
    }

    const mainDisposers = new Map();
    // ① main 只注册一个面板键 + 结果页键；房间 / 设置 / 新建 / 分类焦点都在面板内部切换
    function MainPane() {
      useStore();
      const id = meeting.activePanelId || '';
      if (id === SETTINGS_ID) return h(SettingsPanel);
      // 保留 id（NEW_ID/SETTINGS_ID）不是房间：绝不因为 views 里意外多了一条 'new' 就漂到 RoomPanel
      const roomId = id !== NEW_ID && id.startsWith(KEY_PREFIX) && !id.startsWith(`${KEY_PREFIX}result:`)
        ? id.slice(KEY_PREFIX.length) : '';
      if (roomId && (roomById(roomId) || views.has(roomId))) return h(RoomPanel, { key: roomId, roomId });
      return h(RoomOverview);
    }
    function desiredMain() {
      const wanted = new Map();
      wanted.set(PANEL_ID, { label: () => '会议室', component: MainPane });
      for (const room of meeting.rooms) {
        if ((room.resultCount || 0) > 0) {
          wanted.set(`${KEY_PREFIX}result:${room.id}`, {
            label: () => { const found = roomById(room.id); return `${(found && found.title) || room.title}｜会议结果`; },
            component: ResultTab,
          });
        }
      }
      return wanted;
    }
    function applyRoomPanels() {
      const wanted = desiredMain();
      for (const [key, record] of [...mainDisposers]) {
        if (wanted.has(key)) continue;
        try { record.dispose(); } catch { /* noop */ }
        mainDisposers.delete(key);
        panelDiag({ kind: 'unmount-main', key });
      }
      for (const [key, def] of wanted) {
        if (mainDisposers.has(key)) continue;
        const dispose = mount('main', { name: 'main', key, label: def.label }, def.component);
        mainDisposers.set(key, { dispose });
      }
    }

    // v10 守卫的第二步：外壳在「main 槽登记表变化」时会调 retainMainPanels()——当前选中的 key
    // 不在登记表里就把选中态置成 null。如果我们的 main 登记被宿主在某个窗口里撤掉过，
    // 只把选中态设回来是没用的（key 仍不在表里，下一轮又会被清）。所以抢回时先重挂一次：
    // 撤销可能已失效的注入 + 重新 register，保证 key 一定在登记表里，再选中。
    function remountMain() {
      const def = desiredMain().get(PANEL_ID);
      if (!def) return;
      const record = mainDisposers.get(PANEL_ID);
      if (record) {
        try { record.dispose(); } catch { /* noop */ }
        mainDisposers.delete(PANEL_ID);
      }
      const dispose = mount('main', { name: 'main', key: PANEL_ID, label: def.label }, def.component);
      mainDisposers.set(PANEL_ID, { dispose });
      panelDiag({ kind: 'remount-main' });
    }

    let syncing = false;
    function syncSlots() {
      if (syncing || !hostCtx) return;
      syncing = true;
      try {
        applyRoomPanels();
        applyRoomRows();
      } catch (error) {
        warn(`同步槽位失败：${(error && error.message) || error}`);
      } finally {
        syncing = false;
      }
    }

    // ── v10 面板粘性守卫 ────────────────────────────────────────────────────────
    // 2026-09-27 用户反馈：停在会议室页没几秒就被弹回聊天界面。
    // 全 asar 只有两处会写 panelInfo.activePanelId：
    //   layout 的 selectPanel(id)，以及 retainMainPanels()——「当前选中的 key 不在 main
    //   注册表里」时把它置成 null。二者都不是我们主动调用的，所以这里做兜底：
    //   在我们处于会议室面板时，如果外壳把它清成 null，且用户没有任何「导航动作」，
    //   就把面板抢回来。导航动作 = 点侧边栏会话/工作区（会改动 sessions 列表）或
    //   1.2 s 内的任意 pointerdown / keydown。
    const panelGuard = {
      wasOurs: false, lastGestureAt: 0, lastSessionsAt: 0, lastRescueAt: 0,
      selfClearAt: 0, giveUp: false, rescueTimes: [], busy: false,
    };
    // 诊断环（localStorage，最多 60 条）：万一再复现，可以直接看到清空/抢回的时序与原因
    function panelDiag(record) {
      try {
        const key = 'dsh-meeting-room.panel-diag';
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        list.push({ t: Date.now(), ...record });
        while (list.length > 60) list.shift();
        localStorage.setItem(key, JSON.stringify(list));
      } catch { /* noop */ }
    }
    // 用户「导航动作」的两个信号源：原生输入事件 + sessions 列表变化
    function watchPanelGestures(ctx) {
      try {
        if (typeof window !== 'undefined' && window.addEventListener) {
          const mark = () => { panelGuard.lastGestureAt = Date.now(); };
          window.addEventListener('pointerdown', mark, true);
          window.addEventListener('keydown', mark, true);
        }
      } catch { /* noop */ }
      try {
        const list = ctx && ctx.sessions && ctx.sessions.list;
        if (list && typeof list.subscribe === 'function') {
          list.subscribe(() => { panelGuard.lastSessionsAt = Date.now(); });
        }
      } catch { /* noop */ }
    }

    function followActive(ctx) {
      const info = ctx && ctx.layout && ctx.layout.panelInfo;
      if (!info || typeof info.getSnapshot !== 'function') return;
      const resultPrefix = `${KEY_PREFIX}result:`;
      const applyInfo = () => {
        if (panelGuard.busy) return;   // 重挂/抢回期间外壳的同步回声：不重复计数
        let id = '';
        try { id = info.getSnapshot() ? info.getSnapshot().activePanelId || '' : ''; } catch { id = ''; }
        const ours = !!id && (id === PANEL_ID || id.startsWith(resultPrefix));
        if (id && id.startsWith(resultPrefix)) {
          // 结果页是官方 shell 的右侧页签：跟进它，并把结果页锚定到这个房间
          meeting.activePanelId = id;
          const roomId = id.slice(resultPrefix.length);
          if (roomId) {
            meeting.activeRoom = roomId;
            meeting.rightGoal = `${roomId}::`;
            pullRoomSoon(roomId);
          }
        }
        // ② 其余情况一律保留面板内部模式：
        //    id === PANEL_ID（点我们的入口）→ 回到刚才那一屏；id 为空（回 Conversation）→ 不清空内部状态
        if (ours) {
          const now = Date.now();
          if (!panelGuard.wasOurs) panelDiag({ kind: 'enter', id });
          // 用户 1.5 s 内有输入动作后又选中我们的面板：认为是他主动切回来，解除放弃状态
          if (panelGuard.giveUp && panelGuard.lastGestureAt && now - panelGuard.lastGestureAt < 1500) {
            panelGuard.giveUp = false;
            panelGuard.rescueTimes.length = 0;
            panelDiag({ kind: 'guard-reset' });
          }
          panelGuard.wasOurs = true;
        } else if (id) {
          // 用户切到了别的全局面板（插件、日程…）：明确尊重，不再抢
          if (panelGuard.wasOurs) panelDiag({ kind: 'leave', id });
          panelGuard.wasOurs = false;
        } else if (panelGuard.wasOurs) {
          // 外壳把选中态清成了 Conversation
          const now = Date.now();
          const navigated = (panelGuard.selfClearAt && now - panelGuard.selfClearAt < 1500)
            || (panelGuard.lastSessionsAt && now - panelGuard.lastSessionsAt < 700)
            || (panelGuard.lastGestureAt && now - panelGuard.lastGestureAt < 1200);
          panelDiag({
            kind: 'cleared',
            navigated: !!navigated,
            msSelf: panelGuard.selfClearAt ? now - panelGuard.selfClearAt : -1,
            msGesture: panelGuard.lastGestureAt ? now - panelGuard.lastGestureAt : -1,
            msSessions: panelGuard.lastSessionsAt ? now - panelGuard.lastSessionsAt : -1,
          });
          if (navigated) {
            panelGuard.wasOurs = false;   // 用户自己点会话/工作区走的：尊重
          } else {
            panelGuard.rescueTimes.push(now);
            while (panelGuard.rescueTimes.length && now - panelGuard.rescueTimes[0] > 6000) panelGuard.rescueTimes.shift();
            if (panelGuard.rescueTimes.length > 3) {
              if (!panelGuard.giveUp) { panelGuard.giveUp = true; panelDiag({ kind: 'giveup' }); }
            } else if (now - panelGuard.lastRescueAt > 400) {
              panelGuard.lastRescueAt = now;
              panelGuard.busy = true;
              try {
                remountMain();               // 先保证 key 在 main 登记表里（否则选中态还会被清）
                panelDiag({ kind: 'rescue' });
                selectPanel(PANEL_ID);
              } finally { panelGuard.busy = false; }
            }
          }
        }
        emit();
      };
      applyInfo();
      try { if (typeof info.subscribe === 'function') info.subscribe(applyInfo); } catch { /* noop */ }
    }

    // ── v6③：插件自带输入框 ──────────────────────────────────────────────────────
    // 运行时（桌面客户端渲染进程）不实现原生输入对话框，所以凡是需要用户输入的地方
    // 都在插件自己的面板里问，取值走 onOk 回调（不再有任何原生弹窗调用）。
    function askText(view, opts, notify) {
      const options = opts || {};
      view.dialog = {
        title: options.title || '',
        hint: options.hint || '',
        value: options.value == null ? '' : String(options.value),
        placeholder: options.placeholder || '',
        required: !!options.required,
        confirmLabel: options.confirmLabel || '确认',
        error: '',
        onOk: options.onOk,
      };
      (typeof notify === 'function' ? notify : emit)();
    }

    function dismissDialog(view) {
      if (!view || !view.dialog) return;
      view.dialog = null;
      emit();
    }

    function confirmDialog(view) {
      const dialog = view && view.dialog;
      if (!dialog) return;
      const value = String(dialog.value == null ? '' : dialog.value);
      if (dialog.required && !value.trim()) {
        dialog.error = '必填';
        emit();
        return;
      }
      view.dialog = null;
      emit();
      if (typeof dialog.onOk !== 'function') return;
      try {
        const result = dialog.onOk(value);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => { warn(`dialog: ${(error && error.message) || error}`); });
        }
      } catch (error) {
        warn(`dialog: ${(error && error.message) || error}`);
      }
    }

    function Dialog(props) {
      const view = props.view;
      const dialog = view.dialog;
      const inputRef = react.useRef(null);
      // autoFocus 在部分宿主里不生效，兜底手动聚焦（对话框每次打开才挂载一次）
      react.useEffect(() => {
        const el = inputRef.current;
        if (el && typeof el.focus === 'function') { try { el.focus(); } catch { /* noop */ } }
      }, []);
      react.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKey = (event) => { if (event.key === 'Escape' && view.dialog) dismissDialog(view); };
        window.addEventListener('keydown', onKey);
        return () => { try { window.removeEventListener('keydown', onKey); } catch { /* noop */ } };
      }, []);
      if (!dialog) return null;
      const onKeyDown = (event) => {
        if (event.key === 'Enter') { event.preventDefault(); confirmDialog(view); }
        else if (event.key === 'Escape') { event.preventDefault(); dismissDialog(view); }
      };
      return h('div', { style: S.dialogWrap },
        h('div', { style: S.overlay, onClick: () => dismissDialog(view) }),
        h('div', { style: S.dialogCard },
          h('div', { style: S.title }, dialog.title),
          dialog.hint ? h('div', { style: S.hint }, dialog.hint) : null,
          h('input', {
            ref: inputRef,
            style: S.inlineInput,
            type: 'text',
            autoFocus: true,
            value: dialog.value == null ? '' : dialog.value,
            placeholder: dialog.placeholder || '',
            onChange: (event) => { dialog.value = event.target.value; if (dialog.error) dialog.error = ''; emit(); },
            onKeyDown,
          }),
          dialog.error ? h('div', { style: S.dialogError }, dialog.error) : null,
          h('div', { style: S.row },
            h('span', { style: S.spacer }),
            h('button', { type: 'button', style: S.btn, onClick: () => dismissDialog(view) }, '取消'),
            h('button', { type: 'button', style: S.btnPrimary, onClick: () => confirmDialog(view) }, dialog.confirmLabel))));
    }

    // ── 通用小组件 ──────────────────────────────────────────────────────────────
    function Toast() {
      useStore();
      if (!meeting.toast) return null;
      const kind = meeting.toast.kind;
      const style = kind === 'error'
        ? { ...S.toast, border: `1px solid ${DANGER}`, color: DANGER }
        : (kind === 'ok' ? { ...S.toast, border: `1px solid ${OK}`, color: OK } : S.toast);
      return h('div', { style }, meeting.toast.text);
    }

    function Field(props) {
      return h('label', { style: S.field },
        props.label ? h('span', { style: S.fieldLabel }, props.label) : null,
        props.children);
    }

    function DirPicker(props) {
      const [path, setPath] = react.useState(props.value || meeting.defaultCategory || '');
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const load = async (target) => {
        setBusy(true);
        setError('');
        try {
          const result = await getJson(`/browse${target ? `?path=${q(target)}` : ''}`);
          setData(result);
          if (result && result.path) setPath(result.path);
        } catch (err) {
          setError((err && err.message) || String(err));
        } finally {
          setBusy(false);
        }
      };
      react.useEffect(() => { load(props.value); }, []);
      const dirs = (data && Array.isArray(data.dirs)) ? data.dirs : [];
      return h('div', { style: S.box },
        h('div', { style: S.row },
          h('span', { style: S.fieldLabel }, '分类目录'),
          h('span', { style: S.note, title: path }, path || '（默认分类）'),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btnTiny, onClick: () => load(null) }, '默认'),
          data && data.parent ? h('button', { type: 'button', style: S.btnTiny, onClick: () => load(data.parent) }, '上一层') : null,
        ),
        error ? h('div', { style: { color: DANGER, fontSize: 12 } }, error) : null,
        h('div', { style: S.dirList },
          busy && !dirs.length ? h('div', { style: S.hint }, '读取中…') : null,
          !busy && !dirs.length ? h('div', { style: S.hint }, '（没有子目录）') : null,
          dirs.map((dir) => h('button', {
            key: dir.path,
            type: 'button',
            style: S.dirItem,
            onClick: () => load(dir.path),
          }, `📁 ${dir.name}`))),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btnPrimary, onClick: () => props.onPick(path) }, props.pickLabel || '选用此目录'),
          props.onCancel ? h('button', { type: 'button', style: S.btn, onClick: props.onCancel }, '取消') : null));
    }

    // ── 总览 / 工作区式树 ───────────────────────────────────────────────────────
    function RoomOverview() {
      useStore();
      const activeIsCreate = meeting.activePanelId === NEW_ID;
      react.useEffect(() => {
        if (activeIsCreate && !meeting.createOpen) { meeting.createOpen = true; emit(); }
      }, [activeIsCreate]);

      const focusId = meeting.activePanelId && (meeting.activePanelId.startsWith(GROUP_PREFIX) || meeting.activePanelId === ARCHIVE_ID)
        ? meeting.activePanelId : '';
      const archived = meeting.archivedGroup || { id: ARCHIVE_ID, name: '已归档', archived: true, rooms: [] };
      const allGroups = archived.rooms.length ? [...meeting.groups, archived] : [...meeting.groups];
      const groups = focusId
        ? allGroups.filter((group) => group && group.id === focusId)
        : allGroups;
      const focused = focusId ? allGroups.find((group) => group && group.id === focusId) : null;

      return h('div', { style: S.root },
        h('div', { style: S.head },
          h('span', { style: S.title }, focused ? focused.name : '会议室'),
          h('span', { style: S.chip }, `${meeting.rooms.filter((room) => !room.archived).length} 个进行/已结束`),
          archived.rooms.length ? h('button', {
            type: 'button',
            style: focused && focused.archived ? S.btnOn : S.btn,
            onClick: () => goInternal(ARCHIVE_ID),
          }, `已归档 ${archived.rooms.length}`) : null,
          meeting.error ? h('span', { style: S.chipWarn }, meeting.error) : null,
          h('span', { style: S.spacer }),
          focused ? h('button', { type: 'button', style: S.btn, onClick: () => goInternal(PANEL_ID) }, '全部分类') : null,
          h('button', {
            type: 'button',
            style: meeting.createOpen ? S.btnOn : S.btn,
            onClick: () => {
              if (meeting.createOpen) { meeting.createOpen = false; meeting.createCategory = ''; emit(); return; }
              meeting.createCategory = '';
              goInternal(NEW_ID);
            },
          }, '＋ 新建会议室'),
          h('button', { type: 'button', style: S.btn, onClick: () => goInternal(SETTINGS_ID) }, '设置')),
        // v16④：从分组「＋」进来时用该分组的目录；key 保证换分组时表单状态重新初始化
        meeting.createOpen ? h(CreateRoomForm, {
          key: meeting.createCategory || 'default',
          defaultCategory: meeting.createCategory || (focused && focused.category ? focused.category : ''),
        }) : null,
        h('div', { style: S.scroll },
          h('div', { style: S.inner },
            !meeting.loaded ? h('div', { style: S.empty }, '加载中…') : null,
            meeting.loaded && !meeting.rooms.length ? h('div', { style: S.empty }, '还没有会议室，点右上角「＋ 新建会议室」开始。') : null,
            groups.length ? groups.map((group) => h(GroupBlock, { key: group.id, group })) : null,
            focused && focused.archived && !focused.rooms.length ? h('div', { style: S.empty }, '还没有归档的会议室。') : null)),
        h(Toast));
    }

    function CreateRoomForm(props) {
      useStore();
      const [title, setTitle] = react.useState('');
      const [goal, setGoal] = react.useState('');
      const [category, setCategory] = react.useState((props && props.defaultCategory) || meeting.defaultCategory || '');
      const [showPicker, setShowPicker] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      react.useEffect(() => {
        if (!category && meeting.defaultCategory) setCategory(meeting.defaultCategory);
      }, [meeting.defaultCategory]);
      // v16⑤：「换分类目录」优先走系统文件夹界面（和「策划会议」里选文件夹一致），
      // 拿不到系统界面（浏览器 / preload 桥不存在）才退回房间内的浏览式选择，绝不无声失败。
      const chooseCategory = async () => {
        const picked = await pickSystemFolder();
        if (picked === undefined) { setShowPicker(true); return; } // 没有系统文件夹界面 ⇒ 退回浏览式
        if (!picked) return; // 用户在系统界面里取消了
        setCategory(picked);
        setShowPicker(false);
      };
      const close = () => { meeting.createOpen = false; meeting.createCategory = ''; emit(); };
      const create = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const body = { title: title.trim() || undefined, goal: goal.trim() || undefined, category: category || undefined };
          const data = await postJson('/rooms', body);
          const room = data && data.room;
          setTitle('');
          setGoal('');
          meeting.createOpen = false;
          meeting.createCategory = '';
          await loadRooms();
          if (room && room.id) openRoom(room.id);
          toast(`已创建会议室${room && room.title ? `：${room.title}` : ''}`, 'ok');
        } catch (error) {
          toast(`新建失败：${(error && error.message) || error}`, 'error');
        } finally {
          setBusy(false);
        }
      };
      return h('div', { style: { ...S.inner, paddingTop: 0 } },
        h('div', { style: S.box },
          h('div', { style: S.boxHead }, '新建会议室'),
          h('input', { style: S.inlineInput, placeholder: '会议室标题（留空自动生成）', value: title, onChange: (event) => setTitle(event.target.value) }),
          h('input', { style: S.inlineInput, placeholder: '会议目标（可选）', value: goal, onChange: (event) => setGoal(event.target.value) }),
          h('div', { style: S.row },
            h('span', { style: S.note, title: category }, category || '默认分类目录'),
            h('button', { type: 'button', style: S.btnTiny, onClick: () => { chooseCategory(); } }, showPicker ? '收起目录' : '换分类目录')),
          showPicker ? h(DirPicker, { value: category, pickLabel: '用这个目录', onPick: (picked) => { setCategory(picked); setShowPicker(false); } }) : null,
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: create }, busy ? '创建中…' : '创建'),
            h('button', { type: 'button', style: S.btn, onClick: close }, '取消'))));
    }

    function GroupBlock(props) {
      useStore();
      const group = props.group;
      const folded = isFolded(group.id);
      return h('div', { style: S.group },
        h('div', { style: S.groupHead, onClick: () => toggleFold(group.id) },
          h('span', { style: S.caret }, folded ? '▸' : '▾'),
          h('span', { style: S.groupName }, group.name),
          h('span', { style: S.groupCount }, `${group.rooms.length}`),
          group.category ? h('span', { style: S.groupPath, title: group.category }, group.category) : null,
          h('span', { style: S.spacer }),
          // v16④：直接在这个分组里新建会议室 —— 新房间的目录就建在该分组的文件夹下
          h('button', {
            type: 'button', style: S.btnTiny, title: `在这个分组里新建会议室（建在 ${group.category || group.name} 下）`,
            onClick: (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              meeting.createCategory = group.category || '';
              meeting.createOpen = true;
              emit();
            },
          }, '＋'),
          h('button', {
            type: 'button', style: S.btnTiny, title: '只在面板里看这个分类',
            onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); goInternal(group.id); },
          }, '只看这组')),
        folded ? null : h('div', { style: S.groupBody },
          group.rooms.length ? group.rooms.map((room) => h(RoomTreeRow, { key: room.id, room }))
            : h('div', { style: S.empty }, '（空）')));
    }

    function RoomTreeRow(props) {
      useStore();
      const room = props.room;
      const [menuOpen, setMenuOpen] = react.useState(false);
      const [mode, setMode] = react.useState('');
      const [name, setName] = react.useState(room.title);
      const [purge, setPurge] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const dim = room.archived || room.status === 'closed';

      const run = async (label, fn) => {
        if (busy) return;
        setBusy(true);
        try {
          await fn();
          await loadRooms();
        } catch (error) {
          toast(`${label}失败：${(error && error.message) || error}`, 'error');
        } finally {
          setBusy(false);
        }
      };

      const items = [
        { key: 'open', text: '打开', run: () => { setMenuOpen(false); openRoom(room.id); } },
        { key: 'rename', text: '重命名', run: () => { setName(room.title); setMode('rename'); setMenuOpen(false); } },
        // v16⑤：换分类目录也先走系统文件夹界面，拿不到才退回浏览式（和新建会议室的「换分类目录」一致）
        {
          key: 'move',
          text: '换分类目录',
          run: async () => {
            setMenuOpen(false);
            const picked = await pickSystemFolder();
            if (picked === undefined) { setMode('move'); return; }
            if (!picked) return;
            await run('换分类目录', async () => {
              await patchJson(`/rooms/${q(room.id)}`, { category: picked });
              toast(`已移动到 ${picked}`, 'ok');
            });
          },
        },
        { key: 'folder', text: '在文件夹中打开', run: () => { setMenuOpen(false); revealDirInOS(room.dir); } },
        {
          key: 'archive',
          text: room.archived ? '取消归档' : '归档',
          run: () => { setMenuOpen(false); run('归档', () => patchJson(`/rooms/${q(room.id)}`, { archived: !room.archived })); },
        },
        { key: 'delete', text: '删除', danger: true, run: () => { setPurge(false); setMode('delete'); setMenuOpen(false); } },
      ];

      return h('div', { style: dim ? S.roomRowDim : S.roomRow },
        h('span', { style: { ...S.dot, background: statusColor(room) }, title: room.archived ? '已归档' : (room.status === 'closed' ? '已结束' : '进行中') }),
        h('button', { type: 'button', style: S.roomMain, onClick: () => openRoom(room.id), title: room.title },
          h('span', { style: { ...S.roomName, flex: '1 1 auto' } }, room.title),
          h('span', { style: S.roomTime }, relTime(room.updatedAt))),
        room.activeGoalText ? h('span', { style: S.chip, title: room.activeGoalText }, firstLine(room.activeGoalText, 14)) : null,
        (room.resultCount || 0) > 0 ? h('span', { style: S.chipAccent, title: `${room.resultCount} 份会议结果` }, `${room.resultCount} 结果`) : null,
        h('span', { style: S.menuWrap },
          h('button', { type: 'button', style: S.iconBtn, title: '更多', onClick: () => setMenuOpen(!menuOpen) }, '⋯'),
          menuOpen ? h('div', { style: S.menu },
            items.map((item) => h('button', {
              key: item.key,
              type: 'button',
              style: item.danger ? { ...S.menuItem, color: DANGER } : S.menuItem,
              onClick: item.run,
            }, item.text))) : null),
        mode === 'rename' ? h('div', { style: { ...S.row, flexBasis: '100%' } },
          h('input', { style: S.inlineInput, value: name, autoFocus: true, onChange: (event) => setName(event.target.value) }),
          h('button', {
            type: 'button', style: S.btnPrimary, disabled: busy,
            onClick: () => run('重命名', async () => {
              const next = name.trim();
              if (!next) { toast('标题不能为空', 'error'); return; }
              await patchJson(`/rooms/${q(room.id)}`, { title: next });
              setMode('');
              toast('已重命名', 'ok');
            }),
          }, '保存'),
          h('button', { type: 'button', style: S.btn, onClick: () => setMode('') }, '取消')) : null,
        mode === 'move' ? h('div', { style: { flexBasis: '100%' } },
          h(DirPicker, {
            value: room.category || meeting.defaultCategory,
            pickLabel: '移到这个分类',
            onPick: (picked) => run('换分类目录', async () => {
              await patchJson(`/rooms/${q(room.id)}`, { category: picked });
              setMode('');
              toast(`已移动到 ${picked}`, 'ok');
            }),
            onCancel: () => setMode(''),
          })) : null,
        mode === 'delete' ? h('div', { style: { ...S.boxWarn, flexBasis: '100%' } },
          h('div', { style: S.boxHead }, `删除会议室「${room.title}」？`),
          h('div', { style: S.hint }, `登记信息会被删除${room.dir ? `；目录：${room.dir}` : ''}`),
          h('label', { style: { ...S.row, fontSize: 12 } },
            h('input', { type: 'checkbox', checked: purge, onChange: (event) => setPurge(event.target.checked) }),
            '同时删除会议文件目录（不可恢复）'),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.btnDanger, disabled: busy,
              onClick: () => run('删除', async () => {
                await deleteJson(`/rooms/${q(room.id)}${purge ? '?purge=1' : ''}`);
                setMode('');
                toast(purge ? '已删除会议室与文件' : '已删除会议室登记', 'ok');
              }),
            }, purge ? '删除登记并删文件' : '仅删除登记'),
            h('button', { type: 'button', style: S.btn, onClick: () => setMode('') }, '取消'))) : null);
    }

    // ── 全局设置页 ──────────────────────────────────────────────────────────────
    function SettingsPanel() {
      useStore();
      react.useEffect(() => {
        if (!meeting.settings) loadSettings();
      }, []);
      const settings = meeting.settings || {};
      const [category, setCategory] = react.useState(settings.category || meeting.defaultCategory || '');
      const [prompt, setPrompt] = react.useState(settings.prompt || '');
      const [showPicker, setShowPicker] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [dirty, setDirty] = react.useState(false);
      react.useEffect(() => {
        if (dirty) return;
        setCategory(settings.category || meeting.defaultCategory || '');
        setPrompt(settings.prompt || '');
      }, [meeting.settings]);

      const save = async () => {
        if (busy) return;
        setBusy(true);
        try {
          // v4：记录员是内置 AI，settings.recorder 恒 null、PATCH {recorder} 恒 400 → 只提交 category/prompt
          const body = { category: category || undefined, prompt: prompt };
          const data = await patchJson('/settings', body);
          meeting.settings = (data && data.settings) || meeting.settings;
          setDirty(false);
          await Promise.all([loadSettings(), loadRooms()]);
          toast('设置已保存', 'ok');
        } catch (error) {
          toast(`保存失败：${(error && error.message) || error}`, 'error');
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: S.root },
        h('div', { style: S.head },
          h('span', { style: S.title }, '设置'),
          h('span', { style: S.chip }, '全局默认'),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btn, onClick: () => goInternal(PANEL_ID) }, '返回会议室列表'),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存')),
        h('div', { style: S.scroll },
          h('div', { style: S.inner },
            h('div', { style: S.box },
              h('div', { style: S.boxHead }, '默认分类目录'),
              h('div', { style: S.row },
                h('span', { style: S.note, title: category }, category || '（未设置）'),
                h('span', { style: S.spacer }),
                h('button', { type: 'button', style: S.btnTiny, onClick: () => setShowPicker(!showPicker) }, showPicker ? '收起' : '选择目录')),
              showPicker ? h(DirPicker, {
                value: category || meeting.defaultCategory,
                pickLabel: '设为默认分类',
                onPick: (picked) => { setCategory(picked); setDirty(true); setShowPicker(false); },
              }) : null),
            h('div', { style: S.box },
              h('div', { style: S.boxHead }, '默认记录员提示词'),
              h('div', { style: S.hint }, '支持占位符 {{room}} / {{goal}} / {{goalId}}；房间级提示词会覆盖这里。'),
              h('textarea', {
                style: { ...S.textarea, minHeight: 140, fontFamily: MONO },
                value: prompt,
                onChange: (event) => { setPrompt(event.target.value); setDirty(true); },
              }),
              h('div', { style: S.row },
                h('button', {
                  type: 'button', style: S.btnTiny,
                  onClick: () => { setPrompt(settings.defaultPrompt || ''); setDirty(true); },
                }, '恢复出厂默认'))),
            h('div', { style: S.hint }, `状态根目录由宿主管理；分类目录默认 ${meeting.defaultCategory || '（未设置）'}`))),
        h(Toast));
    }

    // ── 会议室主体（聊天室） ────────────────────────────────────────────────────
    function roomIdOf() {
      const id = meeting.activePanelId || '';
      // 面板内部屏（新建/设置）不是房间：不能把 'new' 当 roomId，否则会 viewOf('new') 造出幽灵房间视图
      const internal = id === NEW_ID || id === SETTINGS_ID;
      if (!internal && id.startsWith(KEY_PREFIX) && !id.startsWith(`${KEY_PREFIX}result:`)) return id.slice(KEY_PREFIX.length);
      const active = meeting.activeRoom;
      if (active && active !== '__create__') return active;
      const first = meeting.rooms.find((room) => !room.archived) || meeting.rooms[0];
      return first ? first.id : '';
    }

    function RoomPanel(props) {
      useStore();
      const roomId = (props && props.roomId) || roomIdOf();
      const view = viewOf(roomId || '__none__');

      react.useEffect(() => {
        if (!roomId) return undefined;
        pullRoom(roomId);
        const timer = setInterval(() => pullRoom(roomId), POLL_MS);
        return () => clearInterval(timer);
      }, [roomId]);

      // v5②：滚到底只发生在「自己刚发完消息」和「房间首次加载完成」；
      // v13③：改成 DSH 会话那套「跟随意图」——只有读的人自己往上滚才停止跟随，
      // 轮询/新消息/自己的程序化滚动都不会把用户拽回底部；停在半路时给一个「跳到最新」按钮。
      const scrollRef = react.useRef(null);
      const programmatic = react.useRef(0);
      const [following, setFollowing] = react.useState(true);
      const [hasNew, setHasNew] = react.useState(false);
      const followingRef = react.useRef(true);
      const msgRefs = react.useRef([]);
      const bottomRef = react.useRef(null);
      const lastSeqRef = react.useRef(0);
      const setFollow = (value) => {
        followingRef.current = value;
        setFollowing(value);
        if (value) setHasNew(false);
      };
      const toBottom = (smooth) => {
        const el = scrollRef.current;
        if (!el) return;
        programmatic.current = Date.now();
        // 真浏览器走平滑滚动；假的/精简 DOM（自测 vm、老浏览器）没有 scrollTo 就退回直接定位
        if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        else el.scrollTop = el.scrollHeight;
      };
      const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        // 自己刚发起的滚动（首屏/发完消息/点「跳到最新」）不算「读的人动了」
        if (Date.now() - programmatic.current < 800) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 25;
        if (nearBottom !== followingRef.current) setFollow(nearBottom);
      };
      const lastSeq = view.log.length ? view.log[view.log.length - 1].seq : 0;
      // v13③：还在跟随 + 记录变长 ⇒ 直接贴到底（用户自己往上滚过就不再动他，只把「跳到最新」点亮）。
      // 用「记录条数」而不是「最新 seq」判定变长，首载（0 → N 条）与后续新消息都覆盖得到。
      const grewSeen = react.useRef(0);
      react.useEffect(() => {
        if (!view.loaded) return undefined;
        const grew = view.log.length > grewSeen.current;
        grewSeen.current = view.log.length;
        lastSeqRef.current = lastSeq;
        if (!grew) return undefined;
        if (!followingRef.current) { setHasNew(true); return undefined; }
        const timer = setTimeout(() => toBottom(false), 0);
        return () => clearTimeout(timer);
      }, [lastSeq, view.loaded, following]);

      const room = view.room || roomById(roomId) || null;

      const act = async (fn, okText) => {
        try {
          await fn();
          if (okText) toast(okText, 'ok');
        } catch (error) {
          toast((error && error.message) || String(error), 'error');
        }
        await refreshAll(roomId);
      };

      // v7①：发送即自动提醒 ⇒ 每条消息固定带 mode:'notice'（用户正文永不出会议室：宿主 notice 正文不含 text）；
      // to 缺省＝全体与会者，按需激活由宿主负责，用户不需要再手动提醒一次。
      const sendPost = async (text, files) => {
        const body = { text, mode: 'notice' };
        const targets = Object.keys(view.targets).filter((key) => view.targets[key]);
        if (targets.length) body.to = targets;
        if (files && files.length) body.files = files;
        await postJson(`/rooms/${q(roomId)}/post`, body);
        view.draft = '';
        view.targets = {};
        await refreshAll(roomId);
        setTimeout(toBottom, 0);   // v5②：发送后滚到底（等 DOM 更新完再滚）
      };

      const submit = async () => {
        const text = (view.draft || '').trim();
        if (!text) return;
        try {
          await sendPost(text, null);
        } catch (error) {
          toast(`发送失败：${(error && error.message) || error}`, 'error');
        }
      };

      const attach = (file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64 = String(reader.result || '').split(',')[1] || '';
            await postJson(`/rooms/${q(roomId)}/upload`, { name: file.name, base64 });
            await sendPost(`（上传了文件 ${file.name}）`, [file.name]);
          } catch (error) {
            toast(`上传失败：${(error && error.message) || error}`, 'error');
          }
        };
        reader.readAsDataURL(file);
      };

      if (!roomId) return h('div', { style: S.root }, h('div', { style: S.empty }, '没有可显示的会议室。'), h(Toast));

      return h('div', { style: S.cols },
        h('div', { style: S.root },
        h('div', { style: S.head },
          h('span', { style: S.title }, (room && room.title) || roomId),
          room ? h('span', { style: room.status === 'closed' ? S.chipOff : S.chipOn }, room.status === 'closed' ? '已结束' : '进行中') : null,
          room && room.archived ? h('span', { style: S.chipOff }, '已归档') : null,
          // v6④：删掉「N/M 人」在线人数 chip 与「记录员」chip（用户看不懂，信息在与会者区里）
          h('span', { style: S.spacer }),
          // ① 侧边栏已收敛成单入口：房间树只在面板内部，房间页必须自带回列表的路
          h('button', { type: 'button', style: S.btn, onClick: () => goInternal(PANEL_ID) }, '← 会议室列表'),
          h('button', { type: 'button', style: S.btnPrimary, onClick: () => { view.drawer = true; emit(); loadSessions(); } }, '策划会议'),
          // v15③：删掉与这个按钮重复的页头「会议文件 / 会议结果」两键（页签仍留在右栏里），
          //         并把「展开侧栏」直接叫「会议文件」
          h('button', { type: 'button', style: S.btn, onClick: () => { view.sideOpen = !view.sideOpen; emit(); } }, view.sideOpen ? '收起侧栏' : '会议文件')),
        view.error ? h('div', { style: S.banner }, `同步失败：${view.error}`) : null,
        room && room.reopenRequest ? h('div', { style: S.banner },
          h('span', null, `${room.reopenRequest.by || room.reopenRequest.label || '与会者'} 请求重开会议${room.reopenRequest.reason ? `：${room.reopenRequest.reason}` : ''}`),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btnPrimary, onClick: () => act(() => postJson(`/rooms/${q(roomId)}/reopen`, { reason: room.reopenRequest.reason }), '已重开') }, '批准重开'),
          h('button', { type: 'button', style: S.btn, onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { reopenRequest: null }), '已忽略') }, '忽略')) : null,
        // v17②：与会者卡在权限请求上时，直接在会议室里允许 / 拒绝（不必去它自己的对话窗口）
        Array.isArray(room && room.approvals) && room.approvals.length
          ? room.approvals.map((ask) => h('div', { key: `approval-${ask.callId}`, style: S.banner },
            h('span', null, `${ask.label || '与会者'} 请求使用「${ask.toolName}」${ask.reason ? `：${ask.reason}` : ''}`),
            h('span', { style: S.spacer }),
            h('button', {
              type: 'button', style: S.btnPrimary,
              onClick: () => act(() => postJson(`/rooms/${q(roomId)}/approvals`, { callId: ask.callId, decision: 'allow' }), '已允许一次'),
            }, '允许'),
            h('button', {
              type: 'button', style: S.btn,
              onClick: () => act(() => postJson(`/rooms/${q(roomId)}/approvals`, { callId: ask.callId, decision: 'deny' }), '已拒绝'),
            }, '拒绝'))) : null,
        room && room.status === 'closed' ? h('div', { style: S.banner },
          h('span', null, '会议已结束。'),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btn, onClick: () => act(() => postJson(`/rooms/${q(roomId)}/reopen`, {}), '已重开') }, '重开会议'),
          h('button', {
            type: 'button', style: S.btn,
            // 宿主没有 reopen-request 端点：POST /rooms/:id/reopen {by:'member'} 只写 reopenRequest（等用户批准），
            // 批准时再调一次不带 by 的 reopen 才真正重开（见 index.js case 'reopen'）。
            onClick: () => act(() => postJson(`/rooms/${q(roomId)}/reopen`, { by: 'member', reason: '会议结束后仍有事项要讨论' }), '已提交重开请求'),
          }, '以与会者身份请求重开')) : null,
        h('div', { style: S.scrollWrap },
          h('div', {
            ref: scrollRef,
            // v13③：跟随时用 DSH 的 overflow-anchor:none，新消息不会被浏览器锚定逻辑顶歪阅读位置
            style: following ? { ...S.scroll, ...S.scrollFollowing } : S.scroll,
            onScroll,
            'data-scroll': 'log',
          },
            h('div', { style: S.inner },
              view.members.length ? h('div', { style: S.row },
                view.members.map((member) => h('button', {
                  key: member.sessionId,
                  type: 'button',
                  style: view.targets[member.sessionId] ? S.memberOn : S.member,
                  title: view.targets[member.sessionId] ? '取消只发给它' : '只发给它',
                  onClick: () => { view.targets = { ...view.targets, [member.sessionId]: !view.targets[member.sessionId] }; emit(); },
                },
                  h('span', { style: member.live ? S.online : S.offline }),
                  h('span', { style: member.live ? null : S.dead }, member.label || shortId(member.sessionId)),
                member.role === 'recorder' ? h('span', { style: S.hint }, '记录员') : null))) : null,
            view.log.length ? h('div', { style: S.messages },
              view.log.map((message, index) => h('div', {
                key: message.seq,
                ref: (node) => { msgRefs.current[index] = node; },
                'data-seq': message.seq,
              }, h(MessageRow, { roomId, message }))))
              : h('div', { style: S.empty }, view.loaded ? '还没有消息。' : '加载中…'),
            // 内容底部哨兵：索引靠它量出「滚动内容总长」，好把横条按真实位置排开
            h('div', { ref: bottomRef, 'data-tail': '1', style: { height: 1 } }))),
          h(MessageRail, {
            log: view.log, scrollRef, roomId, loaded: view.loaded,
            boxes: msgRefs, tailRef: bottomRef,
            onJump: () => setFollow(false),
          }),
          // v16①：只要读的人自己滚上去了，「回到最底」图标就常驻（v13③ 只在「有新消息」时才出现）；
          // 真有新消息时用主题色点亮，一眼能看出「下面还有内容」。
          !following ? h('button', {
            type: 'button',
            style: hasNew ? { ...S.toBottom, ...S.toBottomNew } : S.toBottom,
            title: hasNew ? '有新消息，回到最底' : '回到最底',
            onClick: () => { setFollow(true); toBottom(true); },
          }, '↓') : null),
        h('div', { style: S.composer },
          h('div', { style: S.composerInner },
            h('textarea', {
              style: S.input,
              placeholder: '对会议室说点什么…（Enter 发送，Shift+Enter 换行）',
              value: view.draft || '',
              onChange: (event) => { view.draft = event.target.value; emit(); },
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
              },
            }),
            h('label', { style: S.btn, title: '上传文件' },
              '📎',
              h('input', {
                type: 'file', style: { display: 'none' },
                onChange: (event) => { const file = event.target.files && event.target.files[0]; event.target.value = ''; attach(file); },
              })),
            h('button', { type: 'button', style: S.send, onClick: submit }, '发送'))),
        // v17③：数据条从输入框上方挪到下方，顶掉原来那行长提示（用户 m05432③ 的选择：整条提示删掉）
        h(RoomStats, { members: view.members }),
        view.drawer ? h(PlannerDrawer, { roomId, view, room, act }) : null,
        view.dialog ? h(Dialog, { view }) : null,
        h(Toast)),
        view.sideOpen ? h(RoomSide, { roomId, view, room, act }) : null);
    }

    function MessageRow(props) {
      const message = props.message || {};
      const author = message.author || {};
      const targets = Array.isArray(message.targets) ? message.targets : [];
      const files = Array.isArray(message.files) ? message.files : [];
      const system = author.kind === 'system' || message.kind === 'system';
      const mine = !system && author.kind === 'user';
      const rowStyle = mine ? { ...S.msg, ...S.msgUser } : { ...S.msg, ...S.msgOther };
      const bubbleStyle = system ? S.bubbleSystem : (mine ? S.bubbleUser : S.bubbleOther);
      return h('div', { style: rowStyle },
        h('div', { style: S.meta },
          h('span', { style: whoStyle(author.kind, author.label || author.id) }, author.label || author.id || 'system'),
          h('span', null, stamp(message.at)),
          h('span', null, `#${message.seq}`),
          message.kind && message.kind !== 'chat' ? h('span', { style: S.chip }, message.kind) : null,
          targets.length ? h('span', { style: S.chipAccent }, `→ ${targets.length} 人`) : null),
        h('div', { style: bubbleStyle },
          h('div', { style: S.text }, message.text || ''),
          files.length ? h('div', { style: S.row },
            files.map((name) => h('a', {
              key: name, style: S.file,
              href: `${API}/rooms/${q(props.roomId)}/raw?name=${q(name)}`, target: '_blank', rel: 'noreferrer',
            }, `📄 ${name}`))) : null));
    }

    // v16⑦：token 数的显示口径（与 DSH 底栏一致：K/M/B 三位分级）
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
      return String(Math.round(value));
    }

    function memberStatLine(member) {
      const stats = member.stats;
      if (!stats) return `${member.label || shortId(member.sessionId)}：暂无数据`;
      const parts = [];
      if (typeof stats.turns === 'number') parts.push(`轮 ${stats.turns}`);
      if (typeof stats.steps === 'number') parts.push(`步 ${stats.steps}`);
      if (typeof stats.totalTokens === 'number') parts.push(`${formatTokens(stats.totalTokens)} tok`);
      if (typeof stats.cacheHitPercent === 'number') parts.push(`缓存命中 ${stats.cacheHitPercent}%`);
      if (typeof stats.contextPercent === 'number') parts.push(`上下文 ${stats.contextPercent}%`);
      return `${member.label || shortId(member.sessionId)}：${parts.join(' · ') || '暂无数据'}`;
    }

    /**
     * v16⑦：聊天底部的数据标识（仿 DSH 普通会话底栏）。
     * 数字全部由宿主从投影单元取（与会者各自的 sessionStats / tokenUsage / contextPressure），
     * 客户端只做汇总显示；一个都拿不到就整条不渲染，不占地方也不显示假数字。
     */
    function RoomStats(props) {
      const members = (Array.isArray(props.members) ? props.members : []).filter((m) => m && m.stats);
      if (!members.length) return null;
      const sum = (pick) => members.reduce((total, m) => total + (typeof pick(m.stats) === 'number' ? pick(m.stats) : 0), 0);
      const totalTokens = members.some((m) => typeof m.stats.totalTokens === 'number') ? sum((s) => s.totalTokens) : null;
      const steps = members.some((m) => typeof m.stats.steps === 'number') ? sum((s) => s.steps) : null;
      const turns = members.some((m) => typeof m.stats.turns === 'number')
        ? Math.max(...members.map((m) => (typeof m.stats.turns === 'number' ? m.stats.turns : 0))) : null;
      const hitMembers = members.filter((m) => typeof m.stats.cacheReadTokens === 'number');
      const cacheHit = hitMembers.length
        ? Math.round((hitMembers.reduce((t, m) => t + m.stats.cacheReadTokens, 0)
          / Math.max(1, hitMembers.reduce((t, m) => t + (m.stats.totalTokens ?? 0), 0)) * 1000)) / 10
        : null;
      const contextMembers = members.filter((m) => typeof m.stats.contextPercent === 'number');
      const contextWorst = contextMembers.length
        ? contextMembers.reduce((worst, m) => (m.stats.contextPercent > worst.stats.contextPercent ? m : worst)) : null;
      const title = members.map(memberStatLine).join('\n');
      const pill = (text, key) => h('span', { key, style: S.statPill }, text);
      return h('div', { style: S.stats, title },
        pill(`轮次 ${turns ?? '—'}`, 'turns'),
        pill(`步 ${steps ?? '—'}`, 'steps'),
        pill(`累计 ${formatTokens(totalTokens)} tok`, 'tok'),
        cacheHit === null ? null : pill(`缓存命中 ${cacheHit}%`, 'cache'),
        contextWorst
          ? pill(`上下文 ${contextWorst.stats.contextPercent}%（${contextWorst.label || shortId(contextWorst.sessionId)}）`, 'ctx')
          : null);
    }

    // v13④：索引里要显眼的「目标时间点」——目标被定下/达成时宿主写的系统行（kind='goal' / 'goal-complete'，
    // 与会者用 room_task_done 收尾的行也带 data.goalId）。
    function isGoalMark(message) {
      const message_ = message || {};
      if (message_.data && message_.data.goalId) return true;
      return typeof message_.kind === 'string' && message_.kind.indexOf('goal') === 0;
    }
    function markText(message) {
      const raw = String((message && message.text) || '').replace(/\s+/g, ' ').trim();
      return raw.length > 34 ? `${raw.slice(0, 34)}…` : raw;
    }
    // v14④：索引不再一条消息一个刻度，改成「一个轮次一个刻度」（普通会话的轮次轨道就是这么做的）——
    // 主持人（author.kind === 'user'）发言、目标时间点各算一轮的开头，两条之间与会者的发言都归进那一轮。
    function isTurnHead(message) {
      const message_ = message || {};
      const author = message_.author || null;
      return !!((author && author.kind === 'user') || isGoalMark(message_));
    }
    // v14③：刻度行的固定高度（与普通会话的 TURN_SPACING_PX = 10 一致）——等距排，不按消息真实位置摊开；
    // RAIL_TICK / RAIL_MAX_HEIGHT 声明在文件上方（样式区之前），这里只使用。

    /**
     * v13④ / v14③④：右侧轮次轨道（仿普通会话的 TurnNavigator：[一个轮次一个刻度]）。
     * - v14④：不再每条消息都标 —— 只有「轮次的开头」（isTurnHead：主持人发言、目标时间点）上索引，
     *   两条之间的与会者发言都归进那一轮；少于两个轮次整条不画（普通会话也是 items.length < 2 就不画）；
     * - v14③：刻度行固定 10px、等距排（不再按消息真实位置摊满整列），整条悬浮在右侧、离边 12px、
     *   垂直居中、最高 420px；刻度多于框高时轨道自己在框内滚，并把当前轮次滚到中间；
     * - 目标时间点用主题色加长加粗（v13④ 的「明显标记」，只在索引里体现）；
     * - 悬停出预览小卡（不占聊天区），点击平滑滚到那一轮的开头并停止自动跟随；
     * - 整条 pointerEvents:none（只有刻度按钮自己收事件）+ 右移 12px ⇒ 滚轮与滚动条拖动照常穿透。
     * - 滚动容器没有可滚长度（内容没溢出）时不画。
     */
    function MessageRail(props) {
      const log = props.log || [];
      const scrollRef = props.scrollRef;
      // pending = {w, h}：内容/视口尺寸（只用来判断「内容有没有溢出」）；boxes = 每条消息的 dom；tail = 内容底部哨兵
      const [pending, setPending] = react.useState(null);
      const fallbackBoxes = react.useRef([]);
      const boxes = props.boxes || fallbackBoxes;
      const railRef = react.useRef(null);
      const [activeSeq, setActiveSeq] = react.useState(0);
      const [hoverSeq, setHoverSeq] = react.useState(0);
      const [railScroll, setRailScroll] = react.useState(0);
      const total = log.length;
      // 依赖用 log 的序号串：条数或序号变了才重算（正文更新不用重算）
      const key = log.map((message) => message.seq).join(',');
      // v14④：一个轮次一个刻度
      const ticks = [];
      log.forEach((message, index) => { if (isTurnHead(message)) ticks.push({ message, index }); });
      const shown = ticks.length >= 2 ? ticks : [];
      // 当前轮次 = 最后一条落在阅读线以上的刻度
      let activeTick = 0;
      for (let i = 0; i < shown.length; i += 1) { if (shown[i].message.seq <= activeSeq) activeTick = i; }
      react.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const measure = () => {
          const at = boxes.current[0] ? boxes.current[0].parentNode : null;
          const tail = props.tailRef && props.tailRef.current ? props.tailRef.current : null;
          if (!at || !tail) { setPending({ w: el.clientWidth, h: el.clientHeight, up: 0, span: 0 }); return; }
          const base = at.parentNode ? at.offsetTop : 0;
          const top = at.offsetTop - base;
          const bottom = tail.offsetTop - base;
          setPending({ w: el.clientWidth, h: el.clientHeight, up: top, span: Math.max(0, bottom - top) });
        };
        measure();
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        if (ro) {
          ro.observe(el);
          if (boxes.current[0] && boxes.current[0].parentNode) ro.observe(boxes.current[0].parentNode);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', measure);
        return () => {
          if (ro) ro.disconnect();
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure);
        };
      }, [key, props.roomId, props.loaded]);
      // v13③：这条不是防抖，是「别自己滚了又自己判定用户滚了」——只认 scripted 滚动以外的滚动事件
      react.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        let raf = 0;
        const compute = () => {
          raf = 0;
          let current = 0;
          for (const box of boxes.current) {
            if (!box) continue;
            const top = box.getBoundingClientRect().top - el.getBoundingClientRect().top;
            if (top <= el.clientHeight * 0.4) current = Number(box.dataset.seq) || 0;
          }
          setActiveSeq(current);
        };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute); };
        if (typeof el.addEventListener !== 'function') return undefined;
        el.addEventListener('scroll', onScroll, { passive: true });
        compute();
        return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
      }, [key, props.roomId, props.loaded]);

      // v14③：把当前轮次滚到这一列的中间（刻度行固定 10px，刻度多于框高时这一列自己滚）
      react.useEffect(() => {
        const el = railRef.current;
        if (!el) return undefined;
        const want = Math.max(0, Math.round(activeTick * RAIL_TICK + RAIL_TICK / 2 - (el.clientHeight || 0) / 2));
        if (el.scrollTop !== want) el.scrollTop = want;
        if (railScroll !== want) setRailScroll(want);
        return undefined;
      }, [key, activeTick, props.loaded]);
      if (!pending || !total || !shown.length || pending.span <= 0 || pending.span <= pending.h + 4) return null;
      const hoverIndex = shown.findIndex((tick) => tick.message.seq === hoverSeq);
      const hoverTick = hoverIndex >= 0 ? shown[hoverIndex] : null;
      const listHeight = Math.min(shown.length * RAIL_TICK, RAIL_MAX_HEIGHT);
      const previewTop = hoverTick
        ? Math.max(0, Math.min(Math.max(0, listHeight - 24), hoverIndex * RAIL_TICK - railScroll + RAIL_TICK / 2 - 12))
        : 0;
      return h('div', { style: S.rail, 'data-rail': '1' },
        hoverTick ? h('div', {
          style: { ...S.railPreview, top: previewTop },
        }, `#${hoverTick.message.seq}　${markText(hoverTick.message)}`) : null,
        h('div', {
          ref: railRef,
          style: S.railList,
          'data-rail-list': '1',
          onScroll: (event) => setRailScroll(event.target.scrollTop),
          onMouseLeave: () => setHoverSeq(0),
        }, shown.map((tick, index) => h('button', {
          key: tick.message.seq,
          type: 'button',
          title: `#${tick.message.seq} ${markText(tick.message)}`,
          'aria-label': `跳到 #${tick.message.seq}`,
          style: S.mark,
          onMouseEnter: () => setHoverSeq(tick.message.seq),
          onClick: () => {
            const box = boxes.current[tick.index];
            if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
            if (props.onJump) props.onJump();
          },
        }, h('span', {
          'data-mark': isGoalMark(tick.message) ? 'goal' : 'turn',
          style: {
            ...S.markLine,
            ...(isGoalMark(tick.message) ? S.markGoal : null),
            ...(index === activeTick ? S.markView : null),
            ...(tick.message.seq === hoverSeq ? S.markOn : null),
          },
        })))));
    }

    // ── v9 右侧常驻栏：会议文件（栏内看正文）/ 会议结果（原聊天区内联盒搬进来） ──
    function RoomSide(props) {
      useStore();
      const { roomId, view, act } = props;
      const files = view.files || [];
      const results = view.results || [];
      const tab = view.sideTab === 'results' ? 'results' : 'files';
      const tabBtn = (key, label, count) => h('button', {
        key, type: 'button', style: tab === key ? S.tabBtnOn : S.tabBtn,
        onClick: () => { view.sideTab = key; emit(); },
      }, `${label} (${count})`);
      // 只在点文件名时取一次正文；轮询（refreshAll）不会重取，view.preview 也只存内存
      const loadPreview = async (name) => {
        view.fileSel = name;
        view.preview = { name, loading: true, error: '', kind: '', text: '', bytes: 0, truncated: false };
        emit();
        try {
          const data = await getJson(`/rooms/${q(roomId)}/file?name=${q(name)}`);
          view.preview = {
            name,
            loading: false,
            error: '',
            kind: data.kind === 'text' ? 'text' : 'binary',
            text: typeof data.text === 'string' ? data.text : '',
            bytes: Number(data.bytes) || 0,
            truncated: data.truncated === true,
          };
        } catch (error) {
          view.preview = { name, loading: false, error: (error && error.message) || String(error), kind: '', text: '', bytes: 0, truncated: false };
        }
        emit();
      };
      const preview = view.preview;
      return h('div', { style: S.side },
        h('div', { style: S.sideHead },
          tabBtn('files', '会议文件', files.length),
          tabBtn('results', '会议结果', results.length),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btnTiny, title: '收起右侧栏', onClick: () => { view.sideOpen = false; emit(); } }, '收起')),
        h('div', { style: S.sideBody },
          tab === 'files' ? h('div', { style: S.sideList },
            files.length ? files.map((file) => h('button', {
              key: file.name,
              type: 'button',
              style: view.fileSel === file.name ? S.fileItemOn : S.fileItem,
              title: file.name,
              onClick: () => { loadPreview(file.name); },
            },
              h('span', { style: S.fileName }, file.name),
              h('span', { style: S.hint }, byteSize(file.bytes))))
            : h('div', { style: S.empty }, '还没有会议文件。')) : null,
          tab === 'files' ? (preview
            ? h('div', { style: S.preview },
              h('div', { style: S.row },
                h('span', { style: S.fileName }, preview.name),
                h('a', { style: S.file, href: `${API}/rooms/${q(roomId)}/raw?name=${q(preview.name)}`, target: '_blank', rel: 'noreferrer' }, '原文件')),
              preview.loading ? h('div', { style: S.empty }, '加载中…')
                : preview.error ? h('div', { style: S.empty }, `读取失败：${preview.error}`)
                  : preview.kind === 'binary' ? h('div', { style: S.empty }, `二进制文件（${byteSize(preview.bytes)}），不能在侧栏预览，用「原文件」打开。`)
                    : h('div', null,
                      preview.truncated ? h('div', { style: S.hint }, `文件较大，只预览前 128 KB（共 ${byteSize(preview.bytes)}）`) : null,
                      h('pre', { style: S.pre }, preview.text)))
            : h('div', { style: S.empty }, '点上面的文件名，就在这里看正文。')) : null,
          tab === 'results' ? (results.length ? results.map((result) => h('div', { key: result.goalId || result.file, style: S.resRow },
            h('div', { style: S.row },
              h('span', { style: result.status === 'approved' ? S.chipOn : S.chipWarn }, result.status === 'approved' ? '已发布' : (result.status === 'draft' ? '待审核' : result.status)),
              h('span', { style: S.fileName, title: result.title || result.goalText || result.file }, result.title || result.goalText || result.file)),
            h('div', { style: S.row },
              h('button', { type: 'button', style: S.btnTiny, onClick: () => openResult(roomId, result.goalId) }, '看全文'),
              result.status !== 'approved' ? h('button', {
                type: 'button', style: S.btnTiny,
                onClick: () => act(() => postJson(`/rooms/${q(roomId)}/results/${q(result.goalId)}/approve`, { by: '我' }), '已通过并发布'),
              }, '通过并发布') : null,
              result.status !== 'approved' ? h('button', {
                type: 'button', style: S.btnDanger,
                onClick: () => askText(view, {
                  title: '驳回原因（必填）',
                  required: true,
                  confirmLabel: '驳回',
                  onOk: (note) => act(() => postJson(`/rooms/${q(roomId)}/results/${q(result.goalId)}/reject`, { note: note.trim(), by: '我' }), '已驳回'),
                }, emit),
              }, '驳回') : null)))
            : h('div', { style: S.empty }, '还没有会议结果。')) : null));
    }

    // ── 「策划会议」抽屉 ────────────────────────────────────────────────────────
    function PlannerDrawer(props) {
      useStore();
      const { roomId, view, room, act } = props;
      const close = () => { view.drawer = false; emit(); };
      return h('div', null,
        h('div', { style: S.overlay, onClick: close }),
        h('div', { style: S.sheet },
          h('div', { style: S.sheetHead },
            h('span', { style: S.title }, '策划会议'),
            h('span', { style: S.chip }, (room && room.title) || roomId),
            h('span', { style: S.spacer }),
            h('button', { type: 'button', style: S.btn, onClick: () => { close(); backToConversation(); } }, '返回会话'),
            h('button', { type: 'button', style: S.btn, onClick: close }, '关闭')),
          h('div', { style: S.sheetBody },
            h(DrawerGoals, { roomId, view, act }),
            h(DrawerMembers, { roomId, view, act }),
            h(DrawerRecorder, { roomId, view, room, act }),
            h(DrawerDelivery, { roomId, view, room, act }),
            h(DrawerFiles, { roomId, view, room, act }),
            h(DrawerControl, { roomId, view, room, act, close }))));
    }

    function DrawerGoals(props) {
      useStore();
      const { roomId, view, act } = props;
      const [text, setText] = react.useState('');
      const [renameId, setRenameId] = react.useState('');
      const [renameText, setRenameText] = react.useState('');
      const goals = view.goals || [];
      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '会议目标'),
        goals.length ? goals.map((goal) => h('div', { key: goal.id, style: S.row },
          h('span', { style: goal.id === (view.room && view.room.activeGoalId) ? S.chipAccent : (goal.status === 'done' ? S.chipOn : S.chip) },
            goal.id === (view.room && view.room.activeGoalId) ? '进行中' : (goal.status === 'done' ? '已达成' : goal.status)),
          renameId === goal.id
            ? h('input', { style: S.inlineInput, value: renameText, autoFocus: true, onChange: (event) => setRenameText(event.target.value) })
            : h('span', { style: S.grow }, goal.text),
          renameId === goal.id
            ? h('button', {
              type: 'button', style: S.btnTiny,
              onClick: () => act(async () => {
                const next = renameText.trim();
                if (!next) { toast('目标不能为空', 'error'); return; }
                await patchJson(`/rooms/${q(roomId)}/goals/${q(goal.id)}`, { text: next });
                setRenameId('');
              }, '已改名'),
            }, '保存')
            : h('button', {
              type: 'button', style: S.btnTiny,
              onClick: () => { setRenameId(goal.id); setRenameText(goal.text || ''); },
            }, '改名'),
          goal.id !== (view.room && view.room.activeGoalId) ? h('button', {
            type: 'button', style: S.btnTiny,
            // 宿主 goals/:gid 只认 {text?, status?}（status ∈ open|active|done），没有 active 布尔字段
            onClick: () => act(() => patchJson(`/rooms/${q(roomId)}/goals/${q(goal.id)}`, { status: 'active' }), '已设为当前目标'),
          }, '激活') : null,
          goal.status !== 'done' ? h('button', {
            type: 'button', style: S.btnTiny,
            onClick: () => act(async () => {
              // v12①：等记录员跑完这一轮（宿主看门狗 240s 会先抛中文 503），失败原因直接显示出来
              const data = await postJsonLong(`/rooms/${q(roomId)}/goals/${q(goal.id)}/complete`, {});
              const reason = String((data && data.reason) || '');
              if (data && data.failed && data.failed.length) toast(`完成但未生成草稿：${reason || '记录员未响应'}`, 'error');
              else if (reason) toast(`已标记达成；记录员没有重新生成：${reason}`, 'ok');
              else toast('已标记达成，记录员正在整理《会议结果》…', 'ok');
            }),
          }, '标记达成') : h('button', {
            type: 'button', style: S.btnTiny,
            onClick: () => askText(view, {
              title: '再议原因（可选）',
              confirmLabel: '再议',
              onOk: (reason) => act(() => postJson(`/rooms/${q(roomId)}/goals/${q(goal.id)}/reopen`, { reason: (reason || '').trim() || undefined }), '已重新打开目标'),
            }, emit),
          }, '再议'))) : h('div', { style: S.hint }, '还没有会议目标。'),
        h('div', { style: S.row },
          h('input', { style: S.inlineInput, placeholder: '新目标…', value: text, onChange: (event) => setText(event.target.value) }),
          h('button', {
            type: 'button', style: S.btnPrimary,
            onClick: () => act(async () => {
              const value = text.trim();
              if (!value) { toast('目标不能为空', 'error'); return; }
              await postJson(`/rooms/${q(roomId)}/goals`, { text: value });
              setText('');
            }, '已新建目标'),
          }, '新建目标')));
    }

    function DrawerMembers(props) {
      useStore();
      const { roomId, view, act } = props;
      const [showInvites, setShowInvites] = react.useState(false);
      const [busy, setBusy] = react.useState('');
      const members = view.members || [];
      const sessions = meeting.sessions || [];
      const openInvites = async () => {
        setShowInvites(true);
        setBusy('sessions');
        await loadSessions();
        setBusy('');
      };
      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '与会者'),
        h('div', { style: S.hint }, '点成员旁的下拉改「思考程度」；点名字右侧的 ✕ 踢人。'),
        members.length ? members.map((member) => h('div', { key: member.sessionId, style: S.row },
          h('span', { style: member.live ? S.online : S.offline }),
          h('span', { style: member.live ? S.grow : { ...S.grow, ...S.dead } }, member.label || shortId(member.sessionId)),
          member.role === 'recorder' ? h('span', { style: S.chipAccent }, '记录员') : null,
          h('select', {
            style: S.select,
            value: member.reasoning || 'inherit',
            onChange: (event) => act(
              () => patchJson(`/rooms/${q(roomId)}`, { reasoning: event.target.value, sessionId: member.sessionId }),
              '已更新思考程度'),
          }, REASONING_LEVELS.map((level) => h('option', { key: level, value: level }, REASONING_LABEL[level]))),
          h('button', {
            type: 'button', style: S.kick, title: '踢出会议室',
            // v7②：踢人不再问理由（用户明令禁止擅自加功能）⇒ 点了直接踢，不弹任何面板
            onClick: () => act(() => postJson(`/rooms/${q(roomId)}/kick`, { sessionId: member.sessionId, notify: true }), '已踢出'),
          }, '✕'))) : h('div', { style: S.hint }, '还没有与会者。'),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btn, onClick: openInvites }, showInvites ? '刷新邀请列表' : '邀请会话 AI')),
        busy === 'sessions' ? h('div', { style: S.hint }, '读取会话…') : null,
        showInvites ? h('div', { style: S.dirList },
          (() => {
            const meta = meeting.sessionMeta;
            if (!meta) return null;
            const shown = meta.total === null ? sessions.length : meta.total;
            const hidden = meta.filtered === null ? 0 : meta.filtered;
            return h('div', { style: S.hint },
              `只列顶层会话（子智能体/子会话已隐藏）：共 ${shown} 条，已隐藏 ${hidden} 条`);
          })(),
          sessions.length ? sessions.map((session) => {
            const joined = members.some((member) => member.sessionId === session.sessionId);
            const displayName = session.title || session.label || shortId(session.sessionId);
            return h('div', { key: session.sessionId, style: S.row },
              h('span', { style: session.live ? S.online : S.offline }),
              h('span', { style: { flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: displayName },
                displayName),
              session.cwd ? h('span', { style: S.hint, title: session.cwd }, baseName(session.cwd)) : null,
              !session.live ? h('span', { style: S.chipOff }, '离线') : null,
              joined
                ? h('span', { style: S.hint }, '已在房间')
                : h('button', {
                  type: 'button', style: S.btnTiny,
                  onClick: () => act(() => postJson(`/rooms/${q(roomId)}/join`, { sessionId: session.sessionId, label: displayName }), '已邀请'),
                }, '邀请'));
          }) : h('div', { style: S.hint }, '没有可邀请的顶层会话')) : null);
    }

    function DrawerRecorder(props) {
      useStore();
      const { roomId, room, act } = props;
      const settings = meeting.settings || {};
      const [prompt, setPrompt] = react.useState('');
      const [loadedFor, setLoadedFor] = react.useState('');
      react.useEffect(() => {
        if (!meeting.settings) loadSettings();
      }, []);
      const currentPrompt = (room && room.prompt) || settings.prompt || '';
      react.useEffect(() => {
        const tag = `${roomId}|${currentPrompt}`;
        if (loadedFor === tag) return;
        setPrompt(currentPrompt);
        setLoadedFor(tag);
      }, [roomId, currentPrompt]);

      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '记录员'),
        h('div', { style: S.row },
          h('span', { style: S.chip }, '记录员（内置 AI）')),
        h('div', { style: S.hint },
          '每个会议室自带内置记录员：会议目标达成时它会依据会议记录自动起草《会议结果》，由你审核发布；AI 与会者不能写结果。'),
        h('div', { style: S.field },
          h('span', { style: S.fieldLabel }, `记录员提示词${room && room.prompt ? '（本房间覆盖）' : '（继承默认）'}`),
          h('textarea', {
            style: { ...S.textarea, minHeight: 120, fontFamily: MONO },
            value: prompt,
            placeholder: '支持 {{room}} / {{goal}} / {{goalId}}',
            onChange: (event) => setPrompt(event.target.value),
          }),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.btnPrimary,
              onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { prompt }), '已保存本房间提示词'),
            }, '保存到本房间'),
            h('button', {
              type: 'button', style: S.btn,
              onClick: () => act(async () => {
                await patchJson('/settings', { prompt });
                await loadSettings();
              }, '已保存为默认提示词'),
            }, '保存为默认'),
            h('button', {
              type: 'button', style: S.btnTiny,
              onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { prompt: '' }), '已恢复继承默认提示词'),
            }, '清除房间覆盖'),
            h('button', {
              type: 'button', style: S.btnTiny,
              onClick: () => setPrompt(settings.defaultPrompt || ''),
            }, '填入出厂默认'))));
    }

    function DrawerDelivery(props) {
      useStore();
      const { roomId, view, room, act } = props;
      const reasoning = (room && room.reasoning) || view.reasoning || 'inherit';
      // v6①：没有「投递方式」档位了——用户正文永不进与会者会话，这里只说明固定行为
      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '你和与会者 AI 之间'),
        h('div', { style: S.hint }, '你发的消息只会写进会议室记录，不会出现在与会者的对话里。'),
        h('div', { style: S.hint }, '每次发送后，与会者会收到一行『会议室有新消息』提醒（不含你的正文），由他们自己来读。与会者之间的发言会自动接力（不设跳数上限，可一直往下走）；没人有新意见就自然停下。'),
        h('div', { style: S.boxHead }, '思考程度（房间默认）'),
        h('div', { style: S.seg },
          REASONING_LEVELS.map((level) => h('button', {
            key: level,
            type: 'button',
            style: reasoning === level ? S.btnOn : S.btn,
            onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { reasoning: level }), `房间思考程度改为「${REASONING_LABEL[level]}」`),
          }, REASONING_LABEL[level]))));
    }

    // v12③ / v14② / v15①：文件管理 —— 只回答两件事：会议产生的文件留不留、放在哪个文件夹。
    // v15① 把「文件夹」收成两个功能：**显示文件夹**（路径 + 在资源管理器里打开）、**选择文件夹**（弹系统
    // 文件夹界面，可在里面选或新建）；并且客户端**不再**拼 <文件夹>\<房间id> —— 选中的文件夹本身
    // 就是房间目录，其下固定分「记录/」「附件/」两个子文件夹。
    function DrawerFiles(props) {
      useStore();
      const { roomId, view, room, act } = props;
      const [pick, setPick] = react.useState(false);
      const saveMode = (room && room.saveMode) === 'recorder' ? 'recorder' : 'all';
      const dir = (room && room.dir) || '';
      const parent = dir.replace(/[\\/][^\\/]*$/, '');
      // v15①：优先弹系统文件夹界面；两条路都拿不到（纯浏览器 / 服务未注入）才退回房间内浏览式选目录
      const chooseFolder = async () => {
        const picked = await pickSystemFolder();
        if (picked === undefined) { setPick(true); return; } // 没有系统文件夹界面 ⇒ 退回房间内浏览式
        if (!picked) return; // 用户在系统界面里取消了
        await act(() => patchJson(`/rooms/${q(roomId)}`, { dir: picked }), '已换好文件夹');
      };
      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '文件管理'),
        h('div', { style: S.row },
          h('span', { style: S.fieldLabel }, '会议文件'),
          h('div', { style: S.seg },
            h('button', {
              type: 'button', style: saveMode === 'all' ? S.btnOn : S.btn,
              onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { saveMode: 'all' }), '会议文件改为：全部保存'),
            }, '全部保存'),
            h('button', {
              type: 'button', style: saveMode === 'recorder' ? S.btnOn : S.btn,
              onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { saveMode: 'recorder' }), '会议文件改为：只保存记录员的记录'),
            }, '只保存记录员的记录'))),
        saveMode === 'recorder'
          ? h('div', { style: S.hint }, '散会或《会议结果》发布时，「附件/」里参会人产生的文件全部删掉，只留「记录/」。')
          : h('div', { style: S.hint }, '会议产生的文件全部留在下面这个文件夹里，不删。'),
        h('div', { style: S.boxHead }, '文件夹'),
        h('div', { style: S.note, title: dir }, dir || '（未知）'),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btnTiny, onClick: () => revealDirInOS(dir) }, '打开文件夹'),
          h('button', { type: 'button', style: S.btnTiny, onClick: () => { chooseFolder(); } }, '选择文件夹')),
        pick ? h(DirPicker, {
          value: parent,
          pickLabel: '用这个文件夹',
          onPick: (picked) => act(async () => {
            await patchJson(`/rooms/${q(roomId)}`, { dir: picked });
            setPick(false);
          }, '已换好文件夹'),
          onCancel: () => setPick(false),
        }) : null,
        h('div', { style: S.hint }, '选中的文件夹就是这个会议室的文件夹：「记录/」放记录员的记录与《会议结果》，「附件/」放其它会议文件（含与会者写的材料）。换文件夹会把整个会议室一起搬过去。'));
    }

    function DrawerControl(props) {
      useStore();
      const { roomId, view, room, act, close } = props;
      const archived = !!(room && room.archived);
      const closed = !!(room && room.status === 'closed');
      const [confirm, setConfirm] = react.useState(false);
      const [purge, setPurge] = react.useState(false);
      return h('div', { style: S.box },
        h('div', { style: S.boxHead }, '会议控制'),
        h('div', { style: S.row },
          h('button', {
            type: 'button', style: S.btn, disabled: closed,
            onClick: () => askText(view, {
              title: '散会标题（可选）',
              value: '会议已散会',
              confirmLabel: '散会',
              onOk: (title) => act(async () => {
                // v12①：散会本身不失败（宿主 200），但要等记录员这一轮；失败原因在 HTTP 503 里
                const data = await postJsonLong(`/rooms/${q(roomId)}/close`, { title: title.trim() || undefined, body: '（由主持人散会）' });
                const reason = String((data && data.reason) || '');
                if (reason) toast(`已散会；记录员未能整理结果：${reason}`, 'error');
              }, '已散会'),
            }, emit),
          }, '散会'),
          h('button', {
            type: 'button', style: S.btn, disabled: !closed,
            onClick: () => act(() => postJson(`/rooms/${q(roomId)}/reopen`, {}), '已重开会议'),
          }, '重开'),
          h('button', {
            type: 'button', style: S.btn,
            onClick: () => act(() => patchJson(`/rooms/${q(roomId)}`, { archived: !archived }), archived ? '已取消归档' : '已归档'),
          }, archived ? '取消归档' : '归档'),
          h('button', {
            type: 'button', style: S.btnTiny,
            onClick: () => { close(); backToConversation(); },
          }, '返回会话')),
        h('div', { style: S.hint }, `分类目录：${(room && room.category) || '（未知）'}`),
        h('div', { style: S.note, title: (room && room.dir) || '' }, `会议文件目录：${(room && room.dir) || '（未知）'}`),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btnTiny, onClick: () => revealDir(room && room.dir) }, '在文件夹中打开'),
          // 宿主没有 transcript 端点：可读版记录在房间目录里，用 /raw?name= 取（必须带 name）。
          h('a', { style: S.file, href: `${API}/rooms/${q(roomId)}/raw?name=${q('transcript.md')}`, target: '_blank', rel: 'noreferrer' }, '查看 transcript.md')),
        confirm ? h('div', { style: S.boxWarn },
          h('div', { style: S.boxHead }, `确认删除会议室「${(room && room.title) || roomId}」？`),
          h('label', { style: { ...S.row, fontSize: 12 } },
            h('input', { type: 'checkbox', checked: purge, onChange: (event) => setPurge(event.target.checked) }),
            '连会议文件一起删除（不可恢复）'),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.btnDanger,
              onClick: () => act(async () => {
                await deleteJson(`/rooms/${q(roomId)}${purge ? '?purge=1' : ''}`);
                close();
                goInternal(PANEL_ID);
              }, purge ? '已删除会议室与文件' : '已删除会议室登记'),
            }, purge ? '删除登记并删文件' : '仅删除登记'),
            h('button', { type: 'button', style: S.btn, onClick: () => setConfirm(false) }, '取消'))) : null,
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.btnDanger, onClick: () => setConfirm(true) }, '删除会议室')));
    }

    // ── 《会议结果》页签 ────────────────────────────────────────────────────────
    function resultRef() {
      const raw = meeting.rightGoal || '';
      if (raw.includes('::')) {
        const [roomId, goalId] = raw.split('::');
        return { roomId, goalId: goalId || '' };
      }
      const roomId = roomIdOf();
      return { roomId, goalId: '' };
    }

    function ResultTab() {
      useStore();
      const ref = resultRef();
      const roomId = ref.roomId;
      const view = viewOf(roomId || '__none__');
      const [markdown, setMarkdown] = react.useState('');
      const [error, setError] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [draftOpen, setDraftOpen] = react.useState(false);
      const [draftTitle, setDraftTitle] = react.useState('');
      const [draftBody, setDraftBody] = react.useState('');
      const results = view.results || [];
      const current = results.find((item) => item.goalId === ref.goalId) || results[0] || null;
      const goalId = (current && current.goalId) || ref.goalId;

      react.useEffect(() => {
        if (!roomId) return;
        pullRoom(roomId);
      }, [roomId]);

      const load = react.useCallback(async () => {
        if (!roomId) return;
        setBusy(true);
        setError('');
        try {
          const text = await getText(`/rooms/${q(roomId)}/result${goalId ? `?goalId=${q(goalId)}` : ''}`);
          setMarkdown(text);
        } catch (err) {
          setMarkdown('');
          setError((err && err.message) || String(err));
        } finally {
          setBusy(false);
        }
      }, [roomId, goalId]);

      react.useEffect(() => { load(); }, [load]);

      const review = async (action, body) => {
        try {
          await postJson(`/rooms/${q(roomId)}/results/${q(goalId)}/${action}`, body);
          toast(action === 'approve' ? '已通过并发布' : '已驳回', 'ok');
          await refreshAll(roomId);
          await load();
        } catch (err) {
          toast((err && err.message) || String(err), 'error');
        }
      };

      // 写《会议结果》草稿：POST /rooms/:id/results/:gid/draft {title,body}
      // 刻意不传 by —— 宿主 index.js 的鉴权是「recorder 存在且 by 非空且 by 不匹配 → 403」，
      // 省略 by 时人类使用者也能代为撰写草稿（正式发布仍走 approve）。
      const saveDraft = async () => {
        const title = String(draftTitle || '').trim();
        const body = String(draftBody || '').trim();
        if (!title) { toast('标题不能为空（契约要求 draft 的 title 必填）', 'error'); return; }
        if (!body) { toast('正文不能为空（契约要求 draft 的 body 必填）', 'error'); return; }
        if (!goalId) { toast('没有可写草稿的目标', 'error'); return; }
        setBusy(true);
        try {
          await postJson(`/rooms/${q(roomId)}/results/${q(goalId)}/draft`, { title, body });
          toast('草稿已保存', 'ok');
          setDraftOpen(false);
          await refreshAll(roomId);
          await load();
        } catch (err) {
          toast((err && err.message) || String(err), 'error');
        } finally {
          setBusy(false);
        }
      };

      if (!roomId) return h('div', { style: S.tabRoot }, h('div', { style: S.empty }, '没有选中的会议室结果。'), h(Toast));

      return h('div', { style: S.tabRoot },
        h('div', { style: S.head },
          h('span', { style: S.title }, current ? (current.title || current.goalText || '会议结果') : '会议结果'),
          current ? h('span', { style: current.status === 'approved' ? S.chipOn : S.chipWarn }, current.status === 'approved' ? '已发布' : (current.status === 'draft' ? '待审核' : current.status)) : null,
          current && current.publishedAt ? h('span', { style: S.chip }, stamp(current.publishedAt)) : null,
          current && current.approvedBy ? h('span', { style: S.chip }, `发布人：${current.approvedBy}`) : null,
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.btn, onClick: () => { meeting.rightGoal = ''; openRoom(roomId); } }, '回会议室'),
          h('button', { type: 'button', style: S.btn, onClick: load }, busy ? '刷新中…' : '刷新'),
          goalId ? h('button', {
            type: 'button', style: S.btn,
            onClick: () => {
              const next = !draftOpen;
              setDraftOpen(next);
              if (next) {
                setDraftTitle((current && (current.title || current.goalText)) || '');
                setDraftBody(markdown || '');
              }
            },
          }, draftOpen ? '收起草稿' : '写/改草稿') : null,
          current && current.status !== 'approved' ? h('button', { type: 'button', style: S.btnPrimary, onClick: () => review('approve', { by: '我' }) }, '通过并发布') : null,
          current && current.status !== 'approved' ? h('button', {
            type: 'button', style: S.btnDanger,
            onClick: () => askText(view, {
              title: '驳回原因（必填）',
              required: true,
              confirmLabel: '驳回',
              onOk: (note) => review('reject', { note: note.trim(), by: '我' }),
            }, emit),
          }, '驳回') : null),
        results.length > 1 ? h('div', { style: S.bar },
          h('span', { style: S.barLabel }, '目标：'),
          results.map((item) => h('button', {
            key: item.goalId || item.file,
            type: 'button',
            style: (item.goalId === goalId) ? S.btnOn : S.btnTiny,
            onClick: () => { meeting.rightGoal = `${roomId}::${item.goalId || ''}`; emit(); },
          }, firstLine(item.title || item.goalText || item.file, 18)))) : null,
        error ? h('div', { style: S.banner }, error) : null,
        draftOpen ? h('div', { style: S.box },
          h('div', { style: S.boxHead }, `《会议结果》草稿${goalId ? `（目标 ${shortId(goalId)}）` : ''}`),
          h('input', {
            type: 'text', style: { ...S.inlineInput, flex: '0 0 auto' }, value: draftTitle, placeholder: '标题（必填）',
            onChange: (event) => setDraftTitle(event.target.value),
          }),
          // v16②：标题只占一行，正文编辑器放大（原来是 inlineInput 的 flex-basis 120px 把标题撑成一大块，
          // 正文 textarea 只有 8 行 —— 用户反馈「修改草稿太小、标题占比太大」）。
          h('textarea', {
            style: { ...S.textarea, flex: '1 1 auto', minHeight: 260, lineHeight: '18px' }, rows: 14, value: draftBody, placeholder: '正文（Markdown，必填）',
            onChange: (event) => setDraftBody(event.target.value),
          }),
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: saveDraft }, busy ? '保存中…' : '保存草稿'),
            h('span', { style: S.hint }, '保存后会进入「待审核」，正式发布请用右侧「通过并发布」。'))) : null,
        h('div', { style: S.scroll }, h('div', { style: S.inner }, h('pre', { style: S.pre }, markdown || (busy ? '读取中…' : '（没有内容）')))),
        view.dialog ? h(Dialog, { view }) : null,
        h(Toast));
    }

    // ── 应用入口 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      hostCtx = ctx;
      loadFold();
      watchPanelGestures(ctx);
      followActive(ctx);
      loadRooms();
      loadSettings();
      syncSlots();
      roomsState.timer = setInterval(() => { loadRooms(); }, POLL_MS);
      return () => {
        try { if (roomsState.timer) clearInterval(roomsState.timer); } catch { /* noop */ }
        for (const [, record] of [...rowDisposers]) { try { record.dispose(); } catch { /* noop */ } }
        rowDisposers.clear();
        for (const [, record] of [...mainDisposers]) { try { record.dispose(); } catch { /* noop */ } }
        mainDisposers.clear();
        for (const dispose of teardown) { try { dispose(); } catch { /* noop */ } }
      };
    }

    return { name: 'dsh-meeting-room', inject: ['slots', 'layout'], apply };
  },
});
