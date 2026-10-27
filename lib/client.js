/**
 * dsh-mobile-compose 浏览器端（client half）。
 *
 * 产物形状与 dsh-hardssh 的 tsdown client bundle 完全一致：__ModuleLoader__
 * closure factory —— `load({id, factory(require)})`，外部依赖经注入的 require
 * 从平台模块表解析（react / react-dom / 平台包不在 bundle 内）。本文件为手写
 * 产物（规模不需要 TS 工具链），与官方加载器契约逐字段一致。
 *
 * 职责（v0.3.0，按桌面端真机反馈修正）：
 *   1. 「＋」入口：注册在官方插槽 `conversation.input.left`，并用 flex order
 *      站到**原生两键的原位置**（工具行最左）——不是后增在行尾。
 *   2. 动作面板（QQ 式宫格）双形态，由「＋」入口组件内渲染（**不依赖
 *      composer.dock 插槽**——该插槽在 hero 态（新建/空会话）下官方不渲染）：
 *      - 桌面（宽窗口 / 细指针）：portal 到官方 `[data-composer-dock]` 容器
 *        —— **插在对话框卡片正下方的文档流内**（hero / composer 两态都有该容器）；
 *      - 手机（窄窗口 / 粗指针）：底部动作面板（蒙层 + 上滑动画 + 返回键关闭）。
 *   3. 动作注册表（文件来源细分，为安卓专门路由留缝）：
 *      - pick-image  图片选择器（显式图片后缀过滤 → 桌面原始文件打开器按类型过滤）
 *      - take-photo  拍照（input[capture=environment]，仅能力协商放行时展示）
 *      - pick-file   通用文件（直接复用原生隐藏 input[type=file] 的官方路径）
 *      - command     调用指令（程序化触发原生指令菜单按钮）
 *   4. 文件回流：自选 input 拿到 File 后，经 DataTransfer 注入官方隐藏
 *      input[type=file] 并派发 change —— 官方 onPickFiles → addFiles 校验、
 *      上传、附件预览全链路原样生效，本插件不造上传。
 *   5. 能力协商：装载时 + 每次打开面板时拉取 GET /api/dsh-mobile-compose/
 *      capabilities（DSH 设置页改动实时生效），失败走内置默认集。
 *   6. hideNativeButtons（可协商关闭）：作用域样式隐藏原生「添加文件 / 调用
 *      指令」两个小按钮 —— 回滚即恢复，零 DOM 改动。
 *
 * 失败策略：与 hardssh 客户端一致 —— DOM 查找失败只 console.warn，绝不上抛
 * （web shell 会在插件 apply 抛错时令整个启动失败）。
 */
window.__ModuleLoader__.load({
  id: '@xiaopb/dsh-mobile-compose',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { createElement: h, useCallback, useEffect, useRef, useState } = react;
    const { createPortal } = require('react-dom');

    const PLUGIN_ID = 'dsh-mobile-compose';
    const SLOT_ENTRY = 'conversation.input.left';
    const ENTRY_ID = 'dsh-mobile-compose-plus';
    const CAPS_PATH = '/api/dsh-mobile-compose/capabilities';

    /** 蒙层/底部面板层级：高于 shell 常规层级。 */

    // ---------------------------------------------------------------------
    // 能力协商（模块级轻量 pub/sub）
    // ---------------------------------------------------------------------

    /**
     * 与内置动作同义的指令名 —— 默认从指令列表里剔除。
     * `/file` 是官方 ui-conversation 注册的客户端指令（label 文件，run →
     * pickFiles），语义与「图片 / 文件」两个瓦片完全重叠；不剔除就会在面板里
     * 出现同名重复项。可用设置页 hiddenCommands 覆盖（逗号分隔的指令名）。
     */
    const DEFAULT_HIDDEN_COMMANDS = ['file'];

    const caps = {
      ready: false,
      android: false,
      hideNativeButtons: true,
      enabled: new Set(['pick-image', 'take-photo', 'pick-file', 'command']),
      hiddenCommands: new Set(DEFAULT_HIDDEN_COMMANDS),
    };
    const capsListeners = new Set();

    function setCaps(next) {
      Object.assign(caps, next);
      caps.ready = true;
      // 订阅是持久的（syncHide / 组件 tick），只通知、不清空；单个订阅者
      // 异常互不影响。
      for (const listener of Array.from(capsListeners)) {
        try { listener(); } catch (_) { /* 订阅者异常互不影响 */ }
      }
    }

    function normalizeHidden(list, fallback) {
      const out = new Set();
      const source = Array.isArray(list)
        ? list
        : typeof list === 'string'
          ? list.split(/[,\s]+/)
          : null;
      if (!source) return new Set(fallback);
      for (const item of source) {
        if (typeof item !== 'string') continue;
        const name = item.trim().replace(/^\//, '').toLowerCase();
        if (name) out.add(name);
      }
      return out;
    }

    function fetchCaps() {
      fetch(CAPS_PATH)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!body || typeof body !== 'object') return;
          const enabled = new Set(caps.enabled);
          if (Array.isArray(body.actions)) {
            for (const a of body.actions) {
              if (a && typeof a.id === 'string') {
                if (a.enabled === false) enabled.delete(a.id); else enabled.add(a.id);
              }
            }
          }
          setCaps({
            ready: true,
            android: body.platform?.android === true,
            hideNativeButtons: body.client?.hideNativeButtons !== false,
            enabled,
            hiddenCommands: normalizeHidden(body.commands?.hidden, DEFAULT_HIDDEN_COMMANDS),
          });
        })
        .catch(() => { /* 拉取失败：保持内置默认集 */ });
    }

    // ---------------------------------------------------------------------
    // 面板开合状态（「＋」入口与 dock 面板两个插槽组件共享）
    // ---------------------------------------------------------------------

    const panelState = {
      open: false,
      listeners: new Set(),
      triggerEl: null,
      sessionId: null,       // 官方 slot props 提供，用于 remote.commands.list
      pageIndex: 0,         // 0 起：单一列表分页
      commands: null,       // [{name, label, desc}]；null=未加载
      skills: null,         // [{name, desc, userOnly}]；null=未加载
      commandsFromRemote: false,
      loadingCommands: false,
      labelsEnriched: false,// 是否已用原生菜单补全过中文标签
      harvesting: false,    // 采集进行中（抑制 outside-click 关闭与重复触发）
      swallowClickUntil: 0, // 手势翻页后的 click 抑制截止时间（吞掉误触）
      inputActions: null,   // 官方 session 标准件（setDraft/submit），dock 组件挂载时登记
      ownInputs: null,      // 面板自带的 input[type=file]（面板挂载时登记，点击由动作触发）
    };

    function setPanelOpen(open) {
      if (panelState.open === open) return;
      panelState.open = open;
      for (const listener of Array.from(panelState.listeners)) {
        try { listener(); } catch (_) { /* 订阅者异常互不影响 */ }
      }
    }

    function subscribePanel(listener) {
      panelState.listeners.add(listener);
      return () => { panelState.listeners.delete(listener); };
    }

    /** 订阅 caps + 面板开合的小 hook（两个插槽组件共用）。 */
    function useExternalState() {
      const [, forceTick] = useState(0);
      useEffect(() => {
        const onCaps = () => forceTick((n) => n + 1);
        const onPanel = () => forceTick((n) => n + 1);
        capsListeners.add(onCaps);
        const off = subscribePanel(onPanel);
        return () => {
          capsListeners.delete(onCaps);
          off();
        };
      }, []);
    }

    // ---------------------------------------------------------------------
    // 动作注册表（文件来源细分 —— 安卓专门路由的缝）
    // ---------------------------------------------------------------------

    // 桌面端策略：**图片 / 文件 都是同一个 file 输入的两个视图**——
    //   pick-image 只处理图片后缀（accept 显式列出图片 mime + 后缀，桌面
    //   Chromium / 安卓系统选择器都按此过滤）；
    //   pick-file 不限后缀（accept 留空 = 全部文件），即通用的 file。
    //   两者拿到 File 后走同一条回流通道（DataTransfer → 官方隐藏 input）。
    const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';

    /**
     * kind:
     *   'own-input'   用本面板自带的 input[accept][capture] 选择文件，随后经
     *                 DataTransfer 注入官方隐藏 input（桌面 + 当前安卓 WebView）。
     *   'command'     本瓦片不直接执行，走指令表（runCommand / runSkill）。
     * 未来安卓原生路由：cap 响应里 routed:'native' 时，exec 改为调 App 桥，
     * 本注册表形状不变（见 docs/android-bridge.md）。
     *
     * accept 空字符串 = 不限类型（= 原始 file，处理全部后缀）。
     */
    const ACTIONS = [
      { id: 'pick-image', source: 'gallery', kind: 'own-input', accept: IMAGE_ACCEPT, multiple: true, accent: '#378ADD' },
      { id: 'take-photo', source: 'camera', kind: 'own-input', accept: IMAGE_ACCEPT, capture: 'environment', multiple: false, accent: '#639922' },
      { id: 'pick-file', source: 'document', kind: 'own-input', accept: '', multiple: true, accent: '#BA7517' },
      { id: 'command', source: 'internal', kind: 'command', accent: '#7F77DD' },
    ];

    // ---------------------------------------------------------------------
    // DOM 查找与文件回流（官方通道）
    // ---------------------------------------------------------------------

    const OFFICIAL_FILE_INPUT = 'input[type="file"][multiple][hidden]:not([data-dmc-input])';

    /** 从「＋」按钮向上找包含官方隐藏 input 的容器（工具行）；兜底 document。 */
    function composerScope(triggerEl) {
      let el = triggerEl;
      for (let hop = 0; hop < 8 && el && el !== document; hop++) {
        if (el.querySelector && el.querySelector(OFFICIAL_FILE_INPUT)) return el;
        el = el.parentElement;
      }
      return document;
    }

    function findNativeFileInput(scope) {
      return (scope || document).querySelector(OFFICIAL_FILE_INPUT);
    }

    function findCommandButton(scope) {
      return (scope || document).querySelector('button[aria-haspopup="listbox"]');
    }
    /**
     * 把 File 列表注入官方隐藏 input 并派发 change（React 合成 onChange 会
     * 收到）。置空 _valueTracker 规避 React 值追踪对同值 change 的去重。
     */
    function injectFilesIntoNativeInput(input, files) {
      if (!input || typeof DataTransfer === 'undefined') return false;
      try {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        input.files = dt.files;
        const tracker = input._valueTracker;
        if (tracker && typeof tracker.setValue === 'function') tracker.setValue('');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (error) {
        console.warn('[dsh-mobile-compose] 文件注入官方通道失败：', error);
        return false;
      }
    }

    function warnMissing(what) {
      console.warn(`[dsh-mobile-compose] 未找到${what}（DOM 结构随官方版本漂移时需更新选择器）`);
    }

    // ---------------------------------------------------------------------
    // 样式（作用域前缀 dmc-；hideNative 由 body 类开关）
    // ---------------------------------------------------------------------

    const CSS_TEXT = `
      .dmc-entry-btn{order:-1;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;padding:0;flex:none}
      .dmc-entry-btn:hover{background:rgba(127,127,127,.18)}
      .dmc-entry-btn:active{background:rgba(127,127,127,.28)}
      .dmc-entry-btn svg{display:block}
      .dmc-swipe{touch-action:pan-y}
      .dmc-dock-slot{order:-1;display:flex;justify-content:center;width:100%;flex-basis:100%;min-width:0;max-width:100%}
      .dmc-dock{box-sizing:border-box;margin-top:8px;padding:12px 12px 10px;background:#fff;color:#1f2329;border:.5px solid rgba(0,0,0,.08);border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.10);animation:dmc-drop .16s ease-out;flex:0 0 auto}
      .dmc-pager{display:flex;gap:6px;justify-content:center;align-items:center;margin:0 0 10px;min-height:8px}
      .dmc-dot{width:6px;height:6px;padding:0;border:none;border-radius:3px;background:rgba(127,127,127,.35);cursor:pointer;transition:width .15s ease,background .15s ease}
      .dmc-dot.dmc-active{width:14px;background:currentColor}
      /* 宫格：固定 2 行，列数由面板宽度与条目数决定（行内样式注入） */
      .dmc-grid{display:grid;gap:16px 8px;margin:0;padding:0;list-style:none}
      .dmc-tile{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;background:transparent;border:none;padding:0;cursor:pointer;min-width:44px;height:84px;font:inherit;max-width:100%}
      .dmc-tile:active .dmc-tile-box{transform:scale(.94)}
      .dmc-tile-box{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:#f1f2f4;transition:transform .12s ease;flex:none}
      .dmc-tile-label{font-size:12px;line-height:1.2;color:#1f2329;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
      .dmc-hint{margin:8px 4px 0;font-size:11px;color:#8a8f99;text-align:left}
      /* 底部面板形态（手机宽度）：fixed 底部滑出 */
      @keyframes dmc-drop{from{transform:translateY(-6px);opacity:.4}to{transform:translateY(0);opacity:1}}
      @media (prefers-reduced-motion: reduce){.dmc-dock{animation:none}}
      @media (prefers-color-scheme: dark){
        .dmc-dock{background:#26282e;color:#e8eaed;border-color:rgba(255,255,255,.08)}
        .dmc-tile-box{background:#33363d}
        .dmc-tile-label{color:#e8eaed}
        .dmc-hint{color:#9aa0a8}
      }
    `;

    /** 隐藏原生小按钮的规则（body.dmc-hide-native 开关，capabilities 可关）。 */
    const HIDE_CSS = `
      body.dmc-hide-native button[aria-haspopup="listbox"]{display:none!important}
      body.dmc-hide-native button:has(+ input[type="file"][multiple][hidden]:not([data-dmc-input])){display:none!important}
    `;

    function ensureStyleTag(id, text) {
      let tag = document.getElementById(id);
      if (tag) return tag;
      tag = document.createElement('style');
      tag.id = id;
      tag.setAttribute('data-plugin', PLUGIN_ID);
      tag.textContent = text;
      document.head.appendChild(tag);
      return tag;
    }

    // ---------------------------------------------------------------------
    // 文案：跟随 DSH 语言（locale 服务 snapshot.active）。
    // 插件自有文案（动作名 / 提示 / 无障碍标签）走本表；指令标签来自官方
    // locale + 原生菜单采集，本身已是当前语言，不再经过本表。
    // ---------------------------------------------------------------------
    let uiLang = 'zh';

    const TEXT = {
      'entry.label': { zh: '添加内容', en: 'Add content' },
      'entry.title': { zh: '添加内容（图片 / 文件 / 指令）', en: 'Add content (images / files / commands)' },
      'panel.label': { zh: '添加内容', en: 'Add content' },
      'action.pick-image': { zh: '图片', en: 'Images' },
      'action.take-photo': { zh: '拍照', en: 'Camera' },
      'action.pick-file': { zh: '文件', en: 'Files' },
      'action.command': { zh: '指令', en: 'Commands' },
      'page.label': { zh: '第 {n} 页', en: 'Page {n}' },
      'tile.reload': { zh: '重读指令', en: 'Reload' },
      'hint.loading': { zh: '正在读取指令…', en: 'Loading commands…' },
      'hint.upload': { zh: '选中的文件走官方上传通道', en: 'Picked files use the official upload path' },
    };

    function t(key, vars) {
      const entry = TEXT[key];
      let text = entry ? (entry[uiLang] || entry.zh) : key;
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
      }
      return text;
    }

    /** 当前语言：locale 服务快照优先，其次 <html lang>，最后 zh。 */
    function detectLang(locale) {
      let active = '';
      try {
        const snap = (locale && typeof locale.getSnapshot === 'function' && locale.getSnapshot())
          || (locale && typeof locale.getLocale === 'function' && locale.getLocale());
        if (snap && typeof snap.active === 'string') active = snap.active;
      } catch (_) { /* 静默 */ }
      if (!active && typeof document !== 'undefined' && document.documentElement) active = document.documentElement.lang || '';
      return /^zh/i.test(active) ? 'zh' : (active ? 'en' : 'zh');
    }

    function haptic(ms) {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
      } catch (_) { /* 静默 */ }
    }

    // ---------------------------------------------------------------------
    // 图标（16 viewBox 内联 SVG）
    // ---------------------------------------------------------------------

    function icon(paths, opts) {
      const { size = 22, color = 'currentColor', fill = 'none' } = opts || {};
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill,
        stroke: color, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, paths.map((d, i) => h('path', { d, key: i })));
    }

    const ICONS = {
      plus: () => icon(['M8 3.5v9', 'M3.5 8h9'], { size: 14 }),
      image: (accent) => icon([
        'M2.5 3.5h11v9h-11z', 'M2.5 10.5l3-3 3.5 3.5', 'M9 9.5l2-2 2.5 2.5',
        'M6 6.2a.7.7 0 1 1-.01 0', 'M2.5 12.5h11',
      ], { color: accent }),
      camera: (accent) => icon([
        'M2.5 5.5h2l1.2-1.6h4.6L11.5 5.5h2v7.5h-11z', 'M8 7a2.4 2.4 0 1 1-.01 0',
      ], { color: accent }),
      file: (accent) => icon([
        'M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3', 'M6 8.5h4', 'M6 11h4',
      ], { color: accent }),
      command: (accent) => icon([
        'M2.5 3.5h11v9h-11z', 'M5 6.5L7 8l-2 1.5', 'M8.5 10h3',
      ], { color: accent }),
      skill: (accent) => icon([
        'M3 12.5l6-6', 'M9.5 4.2l2.3 2.3', 'M4.6 9.9l1.5 1.5', 'M11 2.6l2.4 2.4',
        'M2.6 13.4l1.2-1.2',
      ], { color: accent }),
      // ---- 指令专属图标（按指令名映射，未知指令回退 command）----
      target: (accent) => icon(['M8 2.5a5.5 5.5 0 1 1-.01 0', 'M8 5.5a2.5 2.5 0 1 1-.01 0', 'M8 8v0.01'], { color: accent }),
      plan: (accent) => icon(['M3 4.2h2', 'M3 8h2', 'M3 11.8h2', 'M7 4.2h6', 'M7 8h6', 'M7 11.8h4'], { color: accent }),
      feedback: (accent) => icon(['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z', 'M5.5 7h5'], { color: accent }),
      compact: (accent) => icon(['M4.5 2.5v11', 'M11.5 2.5v11', 'M6.5 6L8 7.5 9.5 6', 'M6.5 10L8 8.5 9.5 10'], { color: accent }),
      shield: (accent) => icon(['M8 2.5l5 2v4c0 3-2.2 4.8-5 5.5-2.8-.7-5-2.5-5-5.5v-4z', 'M6 8l1.5 1.5L10.5 6.5'], { color: accent }),
      model: (accent) => icon(['M4.5 4.5h7v7h-7z', 'M6.5 2.5v2', 'M9.5 2.5v2', 'M6.5 11.5v2', 'M9.5 11.5v2', 'M2.5 6.5h2', 'M2.5 9.5h2', 'M11.5 6.5h2', 'M11.5 9.5h2'], { color: accent }),
      download: (accent) => icon(['M8 2.5v7.5', 'M5 7l3 3 3-3', 'M3 12.5h10'], { color: accent }),
      reload: (accent) => icon(['M12.8 6.4A5 5 0 1 0 13 9.5', 'M13.4 3.2v3.4h-3.4'], { color: accent }),
    };

    /** 指令名 → 专属图标 key（未知指令回退通用 command 图标）。 */
    const CMD_ICON = {
      file: 'file',
      goal: 'target',
      plan: 'plan',
      feedback: 'feedback',
      compact: 'compact',
      permission: 'shield',
      model: 'model',
      export: 'download',
      reload: 'reload',
    };

    // ---------------------------------------------------------------------
    // 动作执行（「＋」入口与 dock 面板共用）
    // ---------------------------------------------------------------------

    function closePanel() {
      setPanelOpen(false);
      // 关闭后回到「常用」页（下次打开的默认落点）；面板随开随卸，
      // 重置必须放在模块级状态上而不是组件卸载 effect 里。
      panelState.pageIndex = 0;
      try {
        // 返回键手势占用的 history 位只在还有效时回退。
        if (window.history.state && window.history.state['dsh-mobile-compose']) window.history.back();
      } catch (_) { /* 静默 */ }
    }

    function openPanel() {
      haptic(8);
      // 每次打开都重拉能力协商：DSH 设置页改动（动作开关 / 隐藏原生按钮）
      // 无需刷新页面即可生效；拉取失败不影响本次打开（沿用上次/默认集）。
      fetchCaps();
      setPanelOpen(true);
    }

    /** 手势翻页后的短窗口内忽略派生 click（防止翻页顺手触发瓦片）。 */
    function swallowDerivedClick() {
      return panelState.swallowClickUntil > Date.now();
    }

    function runAction(action) {
      if (swallowDerivedClick()) return;
      haptic(8);
      if (action.kind !== 'own-input') return; // 指令瓦片走 runCommand / runSkill
      const input = panelState.ownInputs ? panelState.ownInputs[action.id] : null;
      if (!input) {
        warnMissing('面板文件 input');
        return;
      }
      // 面板保持挂载直到 onChange：选择器打开期间卸载 input 会让部分浏览器
      // 直接取消文件对话框（关闭动作放在 ownInputChange 里）。
      try {
        input.value = '';
        input.click();
      } catch (error) {
        console.warn('[dsh-mobile-compose] 打开文件选择器失败：', error);
      }
    }

    function ownInputChange(event) {
      const inputEl = event.currentTarget;
      const files = Array.from(inputEl.files || []);
      inputEl.value = '';
      if (files.length === 0) return;
      const native = findNativeFileInput(composerScope(panelState.triggerEl));
      if (!native) { warnMissing('官方文件选择 input'); return; }
      if (!injectFilesIntoNativeInput(native, files)) return;
      haptic(12);
      closePanel();
    }

    function visibleActions() {
      // 拍照动作仅安卓运行时展示（桌面 input[capture] 会被忽略、退化为普通
      // 文件选择，徒增困惑）；能力协商未就绪时按内置默认展示。
      const photoVisible = !caps.ready || caps.android === true;
      return ACTIONS.filter((a) => caps.enabled.has(a.id) && (a.id !== 'take-photo' || photoVisible));
    }

    // ---------------------------------------------------------------------
    // 指令接管：从原生指令菜单采集列表 + 官方裁决通道执行
    // ---------------------------------------------------------------------

    function findNativePopup() {
      // 0.2.1 的指令菜单根是 [role="listbox"] 且内含 [role="option"]；
      // 页面上可能有其他空 listbox（选择器/树组件），取**含 option 项**的那个。
      const boxes = document.querySelectorAll('[role="listbox"]');
      for (const lb of boxes) {
        if (lb.querySelector('[role="option"]')) return lb;
      }
      return null;
    }

    /**
     * 从原生菜单 option 元素解析 {name, label, desc}。
     * 0.2.1 option 结构：span(svg) + span(中文标签) + span(别名) [+ span(描述)]，
     * 例如 压缩/compact/压缩以上对话内容。name 取斜杠别名（/compact），label
     * 取中文标签，desc 取描述。
     */
    function parseCommandOption(item) {
      const spans = Array.from(item.querySelectorAll('span'))
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean);
      if (spans.length === 0) return null;
      const aliasRe = /^[a-z0-9_:-]+$/i;
      const label = spans[0];
      let name = label;
      let desc = '';
      if (spans.length >= 2 && aliasRe.test(spans[1])) {
        name = spans[1];
        desc = spans.length >= 3 ? spans[spans.length - 1] : '';
      } else {
        desc = spans.length >= 2 ? spans[spans.length - 1] : '';
      }
      if (!desc || desc === name) desc = label !== name ? label : '';
      return { name, label, desc };
    }

    /**
     * 采集后收尾：恢复可见性并关掉原生菜单。注意顺序——**必须等原生菜单
     * 关闭动作全部派发完才把 harvesting 置回 false**，否则我们派发的 Escape
     * 会被自己的面板 handler 收到导致面板关闭。
     */
    function dismissNativeMenu(popupEl, btn) {
      try {
        if (popupEl) popupEl.style.visibility = '';
      } catch (_) { /* 静默 */ }
      try {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (_) { /* 静默 */ }
      setTimeout(() => {
        try {
          if (findNativePopup()) {
            // Escape 未生效（焦点不在菜单）→ 再点一次触发按钮做 toggle 关闭。
            if (btn && document.contains(btn)) btn.click();
          }
        } catch (_) { /* 静默 */ }
        setTimeout(() => {
          try {
            const rest = findNativePopup();
            if (rest) {
              // 兜底：直接藏掉浮层（官方菜单自身状态可能已收起，仅残留 DOM）。
              const wrapper = rest.closest('[data-radix-popper-content-wrapper]') || rest;
              wrapper.style.display = 'none';
            }
          } catch (_) { /* 静默 */ }
          panelState.harvesting = false;
          notifyPanel();
        }, 140);
      }, 60);
    }

    /**
     * 采集指令表：程序化打开原生菜单 → 轮询等浮层渲染 → 隐蔽读取 option
     * 列表 → 关掉原生菜单。采集期间 panelState.harvesting=true（抑制面板的
     * outside-click / Escape 关闭）。
     */
    function harvestCommands() {
      if (panelState.harvesting) return;
      const btn = findCommandButton(document);
      if (!btn) {
        warnMissing('官方调用指令按钮');
        // 已有表（通常来自 RPC 全量）不覆写；仅在从未加载过时标记为空。
        if (!Array.isArray(panelState.commands)) panelState.commands = [];
        notifyPanel();
        return;
      }
      panelState.harvesting = true;
      notifyPanel();
      let popupEl = null;
      try {
        btn.click();
      } catch (error) {
        console.warn('[dsh-mobile-compose] 打开原生指令菜单失败：', error);
        panelState.harvesting = false;
        notifyPanel();
        return;
      }
      const finishRead = (popup) => {
        try {
          const items = (popup || document).querySelectorAll('[role="option"]');
          const collected = [];
          for (const item of items) {
            const parsed = parseCommandOption(item);
            if (parsed && parsed.name) collected.push(parsed);
          }
          if (Array.isArray(panelState.commands) && panelState.commands.length > 0) {
            // RPC 全量已在场：用 DOM 顺序（官方菜单顺序）+ 中文标签重排；
            // RPC 里有、菜单里没有的条目追加在后。
            const byName = new Map(panelState.commands.map((c) => [c.name, c]));
            const ordered = [];
            for (const c of collected) {
              const hit = byName.get(c.name);
              if (hit) {
                // locale 已有权威标签（内置指令）时不覆写；其余用菜单里的中文。
                if (c.label && c.label !== c.name && !localizedCommandLabel(c.name)) hit.label = c.label;
                if (c.desc) hit.desc = c.desc;
                ordered.push(hit);
                byName.delete(c.name);
              } else {
                ordered.push(c);
              }
            }
            panelState.commands = ordered.concat(Array.from(byName.values()));
            panelState.labelsEnriched = true;
          } else {
            panelState.commands = collected;
          }
        } catch (error) {
          console.warn('[dsh-mobile-compose] 指令列表采集失败：', error);
          if (!Array.isArray(panelState.commands)) panelState.commands = null;
        }
        dismissNativeMenu(popupEl, btn);
      };
      // popup 渲染是异步的：轮询至多 1.6s，出现含 option 的 listbox 即读。
      const started = Date.now();
      const poll = () => {
        const popup = findNativePopup();
        if (popup) {
          if (popupEl !== popup) {
            popupEl = popup;
            try { popup.style.visibility = 'hidden'; } catch (_) { /* 静默 */ } // 采集不闪原生菜单
          }
          if (popup.querySelectorAll('[role="option"]').length > 0) { finishRead(popup); return; }
        }
        if (Date.now() - started < 1600) setTimeout(poll, 80);
        else finishRead(popupEl);
      };
      setTimeout(poll, 50);
    }

    function notifyPanel() {
      for (const listener of Array.from(panelState.listeners)) {
        try { listener(); } catch (_) { /* 静默 */ }
      }
    }

    // ---------------------------------------------------------------------
    // 指令表来源：官方 RPC remote.commands.list(sessionId) 为全量权威来源；
    // 原生菜单 DOM 采集仅作兜底 + 中文标签补全（菜单是上下文过滤的 UI，
    // 只能看到前若干项）。
    // ---------------------------------------------------------------------

    let clientCtxRef = null;
    let remoteCommandsRef = null;
    let remoteSkillsRef = null;
    let sessionsRef = null;

    // ---------------------------------------------------------------------
    // 中文标签：官方客户端 locale（`command` namespace）是内置指令标签的权威
    // 来源（label.goal → 目标 / label.compact → 压缩 …）。RPC `commands.list`
    // 只给英文 description，没有 label，所以缺了 locale 就只能显示斜杠别名。
    // 非内置指令（/model、插件贡献的指令）由原生菜单采集补全。
    // ---------------------------------------------------------------------

    let commandLabelT = null;

    function localizedCommandLabel(name) {
      if (!commandLabelT || typeof name !== 'string' || !name) return '';
      try {
        const key = `label.${name}`;
        const text = commandLabelT(key);
        return typeof text === 'string' && text !== key ? text : '';
      } catch (_) {
        return '';
      }
    }

    /** 用 locale 覆盖已知的内置指令标签（locale 切换 / 注入就绪时幂等重跑）。 */
    function relabelCommands() {
      const list = panelState.commands;
      if (!Array.isArray(list) || list.length === 0) return;
      let changed = false;
      for (const cmd of list) {
        const label = localizedCommandLabel(cmd.name);
        if (label && cmd.label !== label) {
          cmd.label = label;
          changed = true;
        }
      }
      if (changed) notifyPanel();
    }

    /**
     * 官方 RPC 需在会话保留上下文内调用（与官方 ui-commands / ui-skill 一致：
     * sessions.using(sessionId, {source}, fn)）。服务缺席时直接调用。
     */
    async function withSession(sessionId, source, fn) {
      const sessions = sessionsRef;
      if (!sessions || typeof sessions.using !== 'function') return fn();
      return sessions.using(sessionId, { source }, async (reference) => {
        const state = reference && reference.binding && reference.binding.session.getSnapshot();
        if (state && state.openState !== 'open') throw state.openError || new Error('session not open');
        return fn();
      });
    }

    /** 拉全量指令表。成功返回 true 并写入 panelState.commands。 */
    async function fetchCommandsFromRemote(sessionId) {
      const commands = remoteCommandsRef;
      if (!commands || typeof commands.list !== 'function' || !sessionId) return false;
      try {
        const result = await withSession(sessionId, 'mobileComposeCommands', () => commands.list(sessionId));
        if (!result || result.ok !== true || !Array.isArray(result.value)) return false;
        const prev = new Map((panelState.commands || []).map((c) => [c.name, c]));
        panelState.commands = result.value.map((c) => {
          const hit = prev.get(c.name);
          return {
            name: c.name,
            label: localizedCommandLabel(c.name) || (hit && hit.label) || c.label || c.name,
            desc: (hit && hit.desc) || c.description || '',
            // 官方 dispatch 决策表的依据：descriptor.input 存在 → 菜单点选走
            // claim（写草稿等参数）；缺失 → 裸指令（Enter 通道分离执行）。
            hasInput: c.input !== void 0,
            hint: (c.input && c.input.hint) || '',
          };
        });
        panelState.commandsFromRemote = true;
        notifyPanel();
        return true;
      } catch (_) {
        return false;
      }
    }

    /** 技能目录：remote.skills.list({sessionId}) → [{name, description, modelInvocable}]。 */
    async function fetchSkillsFromRemote(sessionId) {
      const skills = remoteSkillsRef;
      if (!skills || typeof skills.list !== 'function' || !sessionId) return false;
      try {
        const result = await withSession(sessionId, 'mobileComposeSkills', () => skills.list({ sessionId }));
        if (!result || result.ok !== true || !result.value || !Array.isArray(result.value.skills)) return false;
        panelState.skills = result.value.skills.map((s) => ({
          name: s.name,
          desc: s.description || '',
          userOnly: s.modelInvocable === false,
        }));
        notifyPanel();
        return true;
      } catch (_) {
        return false;
      }
    }
    /** 指令 + 技能加载入口：RPC 优先，失败降级 DOM 采集。 */
    function loadCommands(sessionId) {
      const sid = sessionId || panelState.sessionId;
      // sessionId 尚未由 slot props 带来：等面板挂载时再加载。
      if (!sid) return;
      if (panelState.loadingCommands) return;
      panelState.loadingCommands = true;
      Promise.all([
        fetchCommandsFromRemote(sid),
        fetchSkillsFromRemote(sid),
      ]).then(([ok]) => {
        panelState.loadingCommands = false;
        // 两者都拿不到（老版本/子会话）→ DOM 采集兜底。
        const anyRemote = ok || Array.isArray(panelState.skills);
        if (!ok && panelState.commands === null && !panelState.harvesting) harvestCommands();
        // RPC 成功时仍做一次隐蔽采集，仅用于补全中文标签（不改变列表）。
        else if (anyRemote && !panelState.harvesting && !panelState.labelsEnriched) harvestCommands();
      });
    }

    /** 官方 claim 用的本地化 token（token.goal → 目标 …）；无翻译时回退指令名。 */
    function commandToken(name) {
      if (!commandLabelT || typeof name !== 'string' || !name) return name;
      try {
        const key = `token.${name}`;
        const text = commandLabelT(key);
        return typeof text === 'string' && text !== key ? text : name;
      } catch (_) {
        return name;
      }
    }

    /**
     * 执行指令 —— 与官方「/ 菜单点选」决策表保持一致（ui-commands dispatch）：
     *   - 带 input 的宿主指令 → claim：只把 `/token `（本地化拼写）写进草稿，
     *     用户补完参数后自行发送（**绝不代发**）；
     *   - 裸指令 / 客户端贡献（popupSelect 等）→ Enter 通道：setDraft('/x') +
     *     submit()，由官方输入机按裸 token 裁决（分离执行 / 打开弹层）。
     * 表来源缺失（纯 DOM 采集）时一律按 claim 处理，宁可让用户手动发送。
     */
    function runCommand(cmd) {
      if (swallowDerivedClick()) return;
      haptic(8);
      const ia = panelState.inputActions;
      if (cmd.hasInput !== false) {
        closePanel();
        if (ia && typeof ia.setDraft === 'function') {
          try {
            ia.setDraft('/' + commandToken(cmd.name) + ' ');
            return;
          } catch (error) {
            console.warn('[dsh-mobile-compose] 指令写入草稿失败：', error);
          }
        }
        warnMissing('官方草稿通道（setDraft）');
        return;
      }
      if (ia && typeof ia.setDraft === 'function' && typeof ia.submit === 'function') {
        closePanel();
        try {
          ia.setDraft('/' + cmd.name);
          ia.submit();
        } catch (error) {
          console.warn('[dsh-mobile-compose] 指令提交失败：', error);
        }
        return;
      }
      fallbackNativeCommand(cmd);
    }

    /**
     * 执行技能：与官方 `/` 菜单一致 —— 只把 `/name ` 写进草稿（不提交），
     * 用户可继续补参数后自行发送。
     */
    function runSkill(skill) {
      if (swallowDerivedClick()) return;
      haptic(8);
      const ia = panelState.inputActions;
      closePanel();
      if (ia && typeof ia.setDraft === 'function') {
        try {
          ia.setDraft('/' + skill.name + ' ');
          return;
        } catch (error) {
          console.warn('[dsh-mobile-compose] 技能写入草稿失败：', error);
        }
      }
      warnMissing('官方草稿通道（setDraft）');
    }

    /** 回退：原生菜单点选（开菜单 → 找到同名 option → 点击）。 */
    function fallbackNativeCommand(cmd) {
      const btn = findCommandButton(document);
      if (!btn) { warnMissing('官方调用指令按钮'); return; }
      closePanel();
      try {
        btn.click();
      } catch (_) { return; }
      setTimeout(() => {
        try {
          const items = document.querySelectorAll('[role="option"]');
          for (const item of items) {
            const parsed = parseCommandOption(item);
            if (parsed && parsed.name === cmd.name) {
              item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return;
            }
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (_) { /* 静默 */ }
      }, 60);
    }

    /** ⌈n/2⌉：固定 2 行时所需的列数。 */
    function ceil2(n) { return Math.ceil(n / 2); }

    /** 动作 id → 图标 key（历史命名差异：pick-image vs image 等）。 */
    const ICON_KEY = { 'pick-image': 'image', 'take-photo': 'camera', 'pick-file': 'file', command: 'command' };

    /**
     * 面板自带的三个 file 输入 —— 都是同一个 file 通道的不同视图：
     *   pick-image  仅图片后缀（accept 过滤）
     *   take-photo  拍照（capture=environment，仅安卓展示）
     *   pick-file   全部后缀（accept 留空）
     * 选择结果统一由 ownInputChange 注入官方隐藏 input。
     */
    function renderOwnInputs(refs) {
      const action = (id) => ACTIONS.find((a) => a.id === id) || {};
      const make = (id, extra) => h('input', {
        key: id,
        ref: refs[id],
        type: 'file',
        accept: action(id).accept || undefined,
        multiple: action(id).multiple !== false,
        hidden: true,
        'data-dmc-input': 'true',
        'data-dmc-role': id,
        onChange: ownInputChange,
        ...extra,
      });
      return [
        make('pick-image'),
        make('take-photo', { multiple: false, capture: 'environment' }),
        make('pick-file'),
      ];
    }

    // ---------------------------------------------------------------------
    // 插槽组件 1：「＋」入口（conversation.input.left，占原生两键原位置）
    // ---------------------------------------------------------------------

    function PlusEntry(props) {
      useExternalState();
      const triggerRef = useRef(null);

      // 把触发元素登记到模块级状态：dock 面板的「点击外部关闭」用它排除
      // 点击自己；文件回流的作用域查找也从这里出发。
      useEffect(() => {
        panelState.triggerEl = triggerRef.current;
        if (props && props.sessionId) panelState.sessionId = props.sessionId;
        return () => {
          if (panelState.triggerEl === triggerRef.current) panelState.triggerEl = null;
        };
      }, []);

      return h(react.Fragment, null,
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dmc-entry-btn',
          'aria-label': t('entry.label'),
          'data-dmc-entry': 'true',
          'aria-haspopup': 'menu',
          'aria-expanded': panelState.open,
          title: t('entry.title'),
          onClick: () => (panelState.open ? closePanel() : openPanel()),
        }, ICONS.plus()),
        // 面板由入口组件自己渲染（见 ComposeDockEntry 注释：不依赖
        // composer.dock 插槽——hero 态下该插槽不渲染）。官方标准 props
        // （inputActions / useInput）透传给面板用于指令执行。
        panelState.open ? h(ComposeDockEntry, props) : null,
      );
    }

    // ---------------------------------------------------------------------
    // 插槽组件 2：动作面板（由「＋」入口组件内渲染；不依赖 composer.dock 插槽——
    // 该插槽只在 variant==="composer" 时渲染，新建/空会话的 hero 态下官方不渲染，
    // 会导致点「＋」无反应。dock 形态 portal 到官方 [data-composer-dock] 容器，
    // 该容器两种 variant 都存在，且天然在文档流内、位于对话框正下方。）
    // ---------------------------------------------------------------------

    function ComposeDockEntry(props) {
      useExternalState();
      const dockRef = useRef(null);
      const imgInputRef = useRef(null);
      const photoInputRef = useRef(null);
      const fileInputRef = useRef(null);
      const ownInputs = { 'pick-image': imgInputRef, 'take-photo': photoInputRef, 'pick-file': fileInputRef };
      const [page, setPage] = useState(panelState.pageIndex);
      const touchStart = useRef(null);
      // 桌面端滚轮：累积增量 + 冷却锁，避免一次滚动连翻多页。
      const wheelState = useRef({ acc: 0, lockUntil: 0, node: null });
      const wheelHandler = useRef(null);
      // 稳定的原生监听函数（每次 render 更新 handler，监听器身份不变）。
      const wheelListener = useRef((event) => {
        const fn = wheelHandler.current;
        if (fn) fn(event);
      });
      // 仅用于「输入框尺寸变化（窗口缩放 / 侧栏开合 / 切换会话）」时强制重算
      // 面板宽度，保证与输入框始终等宽。
      const [layoutTick, setLayoutTick] = useState(0);

      // 登记官方 session 标准件 + sessionId，并加载全量指令表
      // （RPC 优先，DOM 采集兜底/补标签）。
      useEffect(() => {
        if (props && props.inputActions) panelState.inputActions = props.inputActions;
        if (props && props.sessionId) panelState.sessionId = props.sessionId;
        loadCommands(panelState.sessionId);
        // 自带 file 输入登记到模块级状态：动作瓦片点击时按 id 取对应 input
        // （面板随开随卸，卸载即注销）。
        panelState.ownInputs = {
          'pick-image': imgInputRef.current,
          'take-photo': photoInputRef.current,
          'pick-file': fileInputRef.current,
        };
        return () => { panelState.ownInputs = null; };
      }, []);

      const switchPage = useCallback((next) => {
        panelState.pageIndex = next;
        setPage(next);
      }, []);

      const open = panelState.open;

      // 关闭路径在 closePanel() 统一重置页码（面板随开随卸，卸载后 effect 不跑）。

      // 开合期副作用：返回键关闭 + Esc / 点击面板外关闭。采集期间不因 outside-click 误关。
      useEffect(() => {
        if (!open) return;
        try { window.history.pushState({ 'dsh-mobile-compose': Date.now() }, ''); } catch (_) { /* 静默 */ }
        const onPop = () => setPanelOpen(false);
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
      }, [open]);

      useEffect(() => {
        if (!open) return;
        const bump = () => setLayoutTick((n) => n + 1);
        window.addEventListener('resize', bump);
        let ro = null;
        const trigger = panelState.triggerEl;
        const card = trigger && typeof trigger.closest === 'function'
          ? trigger.closest('[data-composer-card]')
          : null;
        if (card && typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(bump);
          try { ro.observe(card); } catch (_) { /* 静默 */ }
        }
        return () => {
          window.removeEventListener('resize', bump);
          if (ro) { try { ro.disconnect(); } catch (_) { /* 静默 */ } }
        };
      }, [open]);

      useEffect(() => {
        if (!open) return;
        // 官方 dock 容器是 flex row：会话进度等其他插件条目会和本面板挤在
        // 同一行互相压挤。开启期间让容器允许换行 + 面板独占一行（flex-basis
        // 100%、order -1 排最前）→ 面板在第一行，进度等条目换行到最后一行。
        const host = document.querySelector('[data-composer-dock]');
        if (!host) return;
        const prevWrap = host.style.flexWrap || '';
        host.style.flexWrap = 'wrap';
        return () => { host.style.flexWrap = prevWrap; };
      }, [open]);

      useEffect(() => {
        if (!open) return;
        const onDown = (event) => {
          if (panelState.harvesting) return;
          const target = event.target;
          if (dockRef.current?.contains?.(target)) return;
          if (panelState.triggerEl?.contains?.(target)) return;
          closePanel();
        };
        const onKey = (event) => { if (event.key === 'Escape' && !panelState.harvesting) closePanel(); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      if (!open) return null;

      // ---- 布局：面板与聊天框等宽，固定 2 行，列数按宽度自动计算 ----

      // 聊天框宽度：**以官方输入卡片 `[data-composer-card]` 的外框为准**，
      // 保证面板与输入框严格等宽、左右边缘对齐（而不是量某个祖先容器——那个
      // 容器含 side-clearance 内边距，比卡片宽，会把面板撑大）。
      // 兜底：向上找一个宽度合理的祖先；再兜底给定值。
      function composerWidth() {
        const trigger = panelState.triggerEl;
        const card = trigger && typeof trigger.closest === 'function'
          ? trigger.closest('[data-composer-card]')
          : null;
        let w = 0;
        if (card) {
          const rect = card.getBoundingClientRect();
          if (rect.width >= 200) w = rect.width;
        }
        if (!w) {
          let el = trigger;
          for (let hop = 0; el && hop < 10; hop++) {
            if (el.clientWidth >= 320 && el.clientWidth <= window.innerWidth - 32) { w = el.clientWidth; break; }
            el = el.parentElement;
          }
        }
        if (!w) {
          const host = document.querySelector('[data-composer-dock]');
          w = host && host.clientWidth >= 320 ? host.clientWidth : Math.min(560, window.innerWidth - 24);
        }
        // 只做窗口级兜底：**不能**用 dock 容器的宽度做上限——容器的宽度本身
        // 由面板内容撑开（flex 收缩到内容宽），拿它当上限会和面板宽度互相
        // 锁死（窗口放大后面板永远停在旧宽度）。
        return Math.round(Math.max(200, Math.min(w, window.innerWidth - 16)));
      }
      void layoutTick; // 尺寸变化的重渲染触发点
      const width = composerWidth();
      // 单列最小 88px：按面板宽度算出列数上限（2-6 列）。
      const maxCols = width > 0 ? Math.max(2, Math.min(6, Math.floor(width / 88))) : 4;

      // ---- 单一列表：常用动作在前，指令紧随其后；超出容量自动分页 ----
      const mains = visibleActions().filter((a) => a.kind !== 'command');
      const commandsOn = caps.enabled.has('command');
      const allCommands = commandsOn && Array.isArray(panelState.commands) ? panelState.commands : [];
      // 剔除与内置动作同义的指令（默认 /file —— 图片 / 文件 已覆盖）。
      const commands = allCommands.filter((c) => !caps.hiddenCommands.has(c.name));
      // 单页容量 = maxCols × 2 行（固定 2 行）。
      const capacity = maxCols * 2;
      const entries = [
        ...mains.map((a) => ({ kind: 'action', key: a.id, action: a })),
        ...commands.map((c) => ({ kind: 'command', key: 'cmd:' + c.name, cmd: c })),
        ...(commandsOn && Array.isArray(panelState.skills)
          ? panelState.skills.map((s) => ({ kind: 'skill', key: 'skill:' + s.name, skill: s }))
          : []),
      ];
      // 采集未完成/为空时，末尾给一个「读取/重读指令」入口（不占满整页）。
      if (commandsOn && !panelState.harvesting && panelState.commands !== null && commands.length === 0) {
        entries.push({ kind: 'reload', key: 'cmd:reload' });
      }
      const pages = [];
      for (let i = 0; i < Math.max(1, entries.length); i += capacity) {
        pages.push(entries.slice(i, i + capacity));
      }
      const safePage = Math.min(page, pages.length - 1);
      const pageEntries = pages[safePage] || [];

      // ---- 换页交互：移动端左右滑，桌面端滚轮 ----
      // 移动端：横向位移 ≥40px 且明显大于纵向位移（斜向滚动不误翻页）。
      // 纵向手势不接管：`.dmc-swipe{touch-action:pan-y}` 把纵向留给页面滚动。
      const SWIPE_X = 40;
      const onTouchStart = (event) => {
        const touch = event.touches && event.touches[0];
        touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      };
      const onTouchCancel = () => { touchStart.current = null; };
      const onTouchEnd = (event) => {
        const start = touchStart.current;
        touchStart.current = null;
        const touch = event.changedTouches && event.changedTouches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        const absX = Math.abs(dx);
        if (absX < SWIPE_X || absX <= Math.abs(dy)) return;
        const next = safePage + (dx < 0 ? 1 : -1);
        if (next < 0 || next >= pages.length) return;
        // 同一次触摸可能在 touchend 后继续派发 click（部分 WebView）：
        // 短窗口内吞掉瓦片点击，避免「翻页顺手执行了一条指令」。
        panelState.swallowClickUntil = Date.now() + 350;
        haptic(6);
        switchPage(next);
      };

      // 桌面端：滚轮向下 = 下一页，向上 = 上一页；触控板横向 deltaX 也认。
      // React 的 onWheel 是 passive，拦不住页面滚动，所以走 ref 回调绑的原生
      // 非 passive wheel（bindWheel）。累积 40 像素翻一页，翻页后冷却 260ms。
      const WHEEL_STEP = 40;
      wheelHandler.current = (event) => {
        if (pages.length <= 1) return;
        event.preventDefault();
        const now = Date.now();
        if (now < wheelState.current.lockUntil) return;
        // deltaMode：0=像素，1=行，2=页 → 统一折算成像素。
        const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
        const dx = (event.deltaX || 0) * unit;
        const dy = (event.deltaY || 0) * unit;
        const raw = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (!raw) return;
        wheelState.current.acc += raw;
        if (Math.abs(wheelState.current.acc) < WHEEL_STEP) return;
        const next = safePage + (wheelState.current.acc > 0 ? 1 : -1);
        wheelState.current.acc = 0;
        wheelState.current.lockUntil = now + 260;
        if (next < 0 || next >= pages.length) return;
        panelState.swallowClickUntil = Date.now() + 250;
        switchPage(next);
      };
      const bindWheel = (node) => {
        const prev = wheelState.current.node;
        if (prev && prev !== node) prev.removeEventListener('wheel', wheelListener.current);
        if (node && node !== prev) node.addEventListener('wheel', wheelListener.current, { passive: false });
        wheelState.current.node = node || null;
      };

      // 固定 2 行：列数 = min(⌈条目数/2⌉, 宽度允许的上限)，瓦片水平居中。
      const cols = Math.max(2, Math.min(ceil2(pageEntries.length), maxCols));
      const gridStyle = {
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(72px, 96px))`,
        gridTemplateRows: 'repeat(2, auto)',
        justifyContent: 'center',
      };

      // 分页指示（仅多页时出现；不区分常用/指令，只标页码）。
      const tabsBar = pages.length > 1
        ? h('div', { className: 'dmc-pager', role: 'tablist' },
            pages.map((_, i) => h('button', {
              key: 'page-' + i,
              type: 'button',
              role: 'tab',
              'aria-selected': i === safePage,
              'aria-label': t('page.label', { n: i + 1 }),
              className: 'dmc-dot' + (i === safePage ? ' dmc-active' : ''),
              onClick: () => switchPage(i),
            })),
          )
        : null;

      const renderEntry = (entry, idx) => {
        if (entry.kind === 'action') {
          const action = entry.action;
          return h('button', {
            key: entry.key,
            type: 'button',
            className: 'dmc-tile',
            'data-dmc-action': action.id,
            'data-dmc-source': action.source,
            onClick: () => runAction(action),
          },
            h('span', { className: 'dmc-tile-box' }, ICONS[ICON_KEY[action.id]] ? ICONS[ICON_KEY[action.id]](action.accent) : null),
            h('span', { className: 'dmc-tile-label' }, t('action.' + action.id)),
          );
        }
        if (entry.kind === 'reload') {
          return h('button', {
            key: entry.key,
            type: 'button',
            className: 'dmc-tile',
            'data-dmc-command': '__reload',
            onClick: () => { if (swallowDerivedClick()) return; panelState.commands = null; harvestCommands(); },
          },
            h('span', { className: 'dmc-tile-box' }, ICONS.reload('#8a8f99')),
            h('span', { className: 'dmc-tile-label' }, t('tile.reload')),
          );
        }
        if (entry.kind === 'skill') {
          const skill = entry.skill;
          return h('button', {
            key: entry.key,
            type: 'button',
            className: 'dmc-tile dmc-tile-cmd',
            'data-dmc-skill': skill.name,
            title: '/' + skill.name + (skill.desc ? ' — ' + skill.desc : ''),
            onClick: () => runSkill(skill),
          },
            h('span', { className: 'dmc-tile-box' }, ICONS.skill('#1E9E6A')),
            h('span', { className: 'dmc-tile-label' }, skill.name),
          );
        }
        const cmd = entry.cmd;
        // 单行标签：当前语言下的名字（官方 locale / 菜单采集已是当前语言），
        // 取不到就退回指令名。斜杠别名与描述只留在 title 里（不占行、不撑高）。
        const label = cmd.label && cmd.label !== cmd.name ? cmd.label : cmd.name;
        return h('button', {
          key: entry.key,
          type: 'button',
          className: 'dmc-tile dmc-tile-cmd',
          'data-dmc-command': cmd.name,
          title: '/' + cmd.name + (label !== cmd.name ? ' · ' + label : '') + (cmd.desc ? ' — ' + cmd.desc : ''),
          onClick: () => runCommand(cmd),
        },
          h('span', { className: 'dmc-tile-box' }, (ICONS[CMD_ICON[cmd.name]] || ICONS.command)('#7F77DD')),
          h('span', { className: 'dmc-tile-label' }, label),
        );
      };

      const body = h('div', null,
        h('div', { className: 'dmc-grid', style: gridStyle }, pageEntries.map(renderEntry)),
        panelState.harvesting
          ? h('div', { className: 'dmc-hint' }, t('hint.loading'))
          : h('div', { className: 'dmc-hint' }, t('hint.upload')),
      );

      // dock 形态（唯一形态，所有宽度一致）：portal 到官方 dock 容器（对话框
      // 正下方、文档流内），宽度与聊天框等宽。hero 态与 composer 态该容器都
      // 存在；意外缺席时兜底 body。
      const dockHost = document.querySelector('[data-composer-dock]') || document.body;
      // 外层 slot 占满一整行（强制换行，进度等条目落到下一行），内层卡片用
      // **输入框的实测宽度**（不是容器的 100%——宽窗口下容器比卡片宽，会让
      // 面板比输入框大）。
      return createPortal(
        h('div', { className: 'dmc-dock-slot' },
          h('div', { ref: (node) => { dockRef.current = node; bindWheel(node); }, className: 'dmc-dock' + (pages.length > 1 ? ' dmc-swipe' : ''), role: 'menu', 'aria-label': t('panel.label'), onTouchStart, onTouchEnd, onTouchCancel, style: { width: width > 0 ? width + 'px' : '100%', maxWidth: '100%' } },
            tabsBar,
            body,
            renderOwnInputs(ownInputs),
          ),
        ),
        dockHost,
      );
    }

    // ---------------------------------------------------------------------
    // apply：注册两个插槽入口 + 样式 + 能力协商
    // ---------------------------------------------------------------------

    function apply(ctx) {
      clientCtxRef = ctx;
      const styleTag = ensureStyleTag('dsh-mobile-compose-style', CSS_TEXT);
      const hideTag = ensureStyleTag('dsh-mobile-compose-hide', HIDE_CSS);

      const syncHide = () => {
        try {
          document.body.classList.toggle('dmc-hide-native', caps.hideNativeButtons === true);
        } catch (_) { /* 静默 */ }
      };
      capsListeners.add(syncHide);
      syncHide();
      fetchCaps();

      // 内置指令的中文标签 / claim token 来自官方 locale 的 `command`
      // namespace（与原生菜单同源）：注入就绪即覆盖 RPC 拿到的英文名；
      // locale 切换时幂等重算。
      try {
        ctx.inject(['locale'], (scoped) => {
          const locale = scoped && scoped.locale;
          if (!locale) return;
          const applyLocale = () => {
            const next = detectLang(locale);
            const langChanged = next !== uiLang;
            uiLang = next;
            if (typeof locale.bind === 'function') commandLabelT = locale.bind('command');
            relabelCommands();
            if (langChanged) notifyPanel();
          };
          applyLocale();
          if (typeof scoped.on === 'function') scoped.on('locale/change', applyLocale);
        });
      } catch (_) { /* locale 不可用：退回原生菜单采集的中文标签 */ }

      // 指令表变更（插件注册/注销指令）→ 失效缓存并重拉。      // 客户端 cordis 要求先声明注入才能访问 remote.* 命名空间（否则
      // "cannot get property remote.commands without inject"）。
      try {
        ctx.inject(['remote', 'remote.commands', 'sessions'], (scoped) => {
          remoteCommandsRef = scoped.remote.commands;
          sessionsRef = scoped.sessions;
          if (panelState.sessionId) loadCommands(panelState.sessionId);
        });
      } catch (_) { /* 注入通道不可用：保留 DOM 采集兜底 */ }
      try {
        ctx.inject(['remote', 'remote.skills', 'sessions'], (scoped) => {
          remoteSkillsRef = scoped.remote.skills;
          sessionsRef = scoped.sessions;
          if (panelState.sessionId) loadCommands(panelState.sessionId);
        });
      } catch (_) { /* 技能通道不可用：面板只显示指令 */ }
      try {
        ctx.inject(['remote'], (scoped) => {
          if (typeof scoped.remote.$on !== 'function') return;
          const refresh = () => {
            panelState.commands = null;
            panelState.skills = null;
            panelState.labelsEnriched = false;
            if (panelState.sessionId) loadCommands(panelState.sessionId);
            else notifyPanel();
          };
          scoped.remote.$on('commands/change', refresh);
          scoped.remote.$on('plugin-manager/changed', refresh);
        });
      } catch (_) { /* 事件通道不可用：忽略 */ }

      let registered = 0;
      try {
        ctx.slots.inject(SLOT_ENTRY, () => ctx.slots.register(
          { name: SLOT_ENTRY, id: ENTRY_ID, order: 20 },
          PlusEntry,
        ));
        registered += 1;
      } catch (error) {
        console.warn('[dsh-mobile-compose] 入口插槽注册失败（面板不可用，原生按钮不受影响）：', error);
      }
      // 面板不再注册 composer.dock 插槽：该插槽在 hero 态（新建/空会话）下
      // 官方不渲染，会导致点「＋」无反应。面板由 PlusEntry 内渲染并 portal
      // 到官方 [data-composer-dock] 容器（两种 variant 都存在）。

      ctx.effect(() => () => {
        capsListeners.delete(syncHide);
        try { document.body.classList.remove('dmc-hide-native'); } catch (_) { /* 静默 */ }
        for (const tag of [styleTag, hideTag]) {
          try { tag.remove(); } catch (_) { /* 静默 */ }
        }
      }, 'dsh-mobile-compose: wiring');
    }

    const inject = ['slots'];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
