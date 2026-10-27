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
    const SHEET_Z = 9000;

    // ---------------------------------------------------------------------
    // 能力协商（模块级轻量 pub/sub）
    // ---------------------------------------------------------------------

    const caps = {
      ready: false,
      android: false,
      hideNativeButtons: true,
      enabled: new Set(['pick-image', 'take-photo', 'pick-file', 'command']),
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
      inputActions: null,   // 官方 session 标准件（setDraft/submit），dock 组件挂载时登记
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

    // 桌面端策略：动作直接对接**原始文件打开器**（同一 OS 对话框）——
    //   pick-image 自带 input 的 accept 用显式图片后缀，桌面 Chromium 的
    //   「打开文件」对话框即按图片类型过滤（安卓选择器同理）；pick-file 则
    //   程序化点击官方 input（无过滤，完整官方路径）。
    const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif';

    /**
     * kind:
     *   'own-input'   用本面板自带的 input[accept][capture] 选择文件，随后经
     *                 DataTransfer 注入官方隐藏 input（桌面 + 当前安卓 WebView）。
     *   'native-pick' 直接程序化点击官方隐藏 input（完全官方路径）。
     *   'command'     程序化点击官方「调用指令」按钮打开指令菜单。
     * 未来安卓原生路由：cap 响应里 routed:'native' 时，exec 改为调 App 桥，
     * 本注册表形状不变（见 docs/android-bridge.md）。
     */
    const ACTIONS = [
      { id: 'pick-image', source: 'gallery', label: '图片', kind: 'own-input', accept: IMAGE_ACCEPT, multiple: true, accent: '#378ADD' },
      { id: 'take-photo', source: 'camera', label: '拍照', kind: 'own-input', accept: IMAGE_ACCEPT, capture: 'environment', multiple: false, accent: '#639922' },
      { id: 'pick-file', source: 'document', label: '文件', kind: 'native-pick', accent: '#BA7517' },
      { id: 'command', source: 'internal', label: '指令', kind: 'command', accent: '#7F77DD' },
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
      .dmc-mask{position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:${SHEET_Z}}
      .dmc-dock{box-sizing:border-box;margin-top:8px;padding:12px 12px 10px;background:#fff;color:#1f2329;border:.5px solid rgba(0,0,0,.08);border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.10);animation:dmc-drop .16s ease-out}
      .dmc-pager{display:flex;gap:6px;justify-content:center;align-items:center;margin:0 0 10px;min-height:8px}
      .dmc-dot{width:6px;height:6px;padding:0;border:none;border-radius:3px;background:rgba(127,127,127,.35);cursor:pointer;transition:width .15s ease,background .15s ease}
      .dmc-dot.dmc-active{width:14px;background:currentColor}
      /* 宫格：固定 2 行，列数由面板宽度与条目数决定（行内样式注入） */
      .dmc-grid{display:grid;gap:16px 8px;margin:0;padding:0;list-style:none}
      .dmc-tile{display:flex;flex-direction:column;align-items:center;gap:6px;background:transparent;border:none;padding:0;cursor:pointer;min-width:44px;min-height:44px;font:inherit;max-width:100%}
      .dmc-tile:active .dmc-tile-box{transform:scale(.94)}
      .dmc-tile-box{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:#f1f2f4;transition:transform .12s ease;flex:none}
      .dmc-tile-label{font-size:12px;line-height:1.2;color:#1f2329;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
      .dmc-hint{margin:8px 4px 0;font-size:11px;color:#8a8f99;text-align:left}
      /* 底部面板形态（手机宽度）：fixed 底部滑出 */
      .dmc-panel{position:fixed;background:#fff;color:#1f2329;border-radius:16px 16px 0 0;box-shadow:0 8px 32px rgba(0,0,0,.22);z-index:${SHEET_Z + 1};padding:12px 10px 10px;box-sizing:border-box;left:0;right:0;bottom:0;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));animation:dmc-rise .18s ease-out}
      @keyframes dmc-drop{from{transform:translateY(-6px);opacity:.4}to{transform:translateY(0);opacity:1}}
      @keyframes dmc-rise{from{transform:translateY(24%);opacity:.4}to{transform:translateY(0);opacity:1}}
      @media (prefers-reduced-motion: reduce){.dmc-dock,.dmc-panel{animation:none}}
      @media (prefers-color-scheme: dark){
        .dmc-dock{background:#26282e;color:#e8eaed;border-color:rgba(255,255,255,.08)}
        .dmc-panel{background:#26282e;color:#e8eaed}
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

    function isSheetPresentation() {
      try {
        return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;
      } catch (_) {
        return window.innerWidth < 700;
      }
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

    function runAction(action) {
      haptic(8);
      if (action.kind === 'command') return; // 指令瓦片走 runCommand，不经此路径
      const scope = composerScope(panelState.triggerEl);
      if (action.kind === 'native-pick') {
        const native = findNativeFileInput(scope);
        if (native) {
          closePanel();
          native.click();
        } else {
          warnMissing('官方文件选择 input');
        }
        return;
      }
      // own-input：打开自带 input；关闭动作延后到 onChange（面板若在选择器
      // 打开期间被卸载，部分浏览器会直接取消文件选择对话框）。
    }

    function ownInputChange(event, imgInputRef, photoInputRef) {
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
                if (c.label && c.label !== c.name) hit.label = c.label;
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
            label: (hit && hit.label) || c.label || c.name,
            desc: (hit && hit.desc) || c.description || '',
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

    /** 执行指令：优先官方裁决通道（setDraft('/x') + submit），失败回退原生菜单点选。 */
    function runCommand(cmd) {
      haptic(8);
      const ia = panelState.inputActions;
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

    function renderOwnInputs(imgInputRef, photoInputRef) {
      const imageAction = ACTIONS.find((a) => a.id === 'pick-image');
      const photoAction = ACTIONS.find((a) => a.id === 'take-photo');
      return [
        h('input', {
          key: 'pick-image', ref: imgInputRef, type: 'file', accept: imageAction ? imageAction.accept : 'image/*', multiple: true,
          hidden: true, 'data-dmc-input': 'true', onChange: (e) => ownInputChange(e, imgInputRef, photoInputRef),
        }),
        h('input', {
          key: 'take-photo', ref: photoInputRef, type: 'file', accept: photoAction ? photoAction.accept : 'image/*', capture: 'environment',
          multiple: false, hidden: true, 'data-dmc-input': 'true', onChange: (e) => ownInputChange(e, imgInputRef, photoInputRef),
        }),
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
          'aria-label': '添加内容',
          'aria-haspopup': 'menu',
          'aria-expanded': panelState.open,
          title: '添加内容（图片 / 文件 / 指令）',
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
      const [page, setPage] = useState(panelState.pageIndex);
      const touchStartX = useRef(null);

      // 登记官方 session 标准件 + sessionId，并加载全量指令表
      // （RPC 优先，DOM 采集兜底/补标签）。
      useEffect(() => {
        if (props && props.inputActions) panelState.inputActions = props.inputActions;
        if (props && props.sessionId) panelState.sessionId = props.sessionId;
        loadCommands(panelState.sessionId);
      }, []);

      const switchPage = useCallback((next) => {
        panelState.pageIndex = next;
        setPage(next);
      }, []);

      const open = panelState.open;
      const sheet = isSheetPresentation();

      // 关闭路径在 closePanel() 统一重置页码（面板随开随卸，卸载后 effect 不跑）。

      // 开合期副作用：返回键关闭（两端形态共用）+ Esc / 点击外部关闭（dock 形态；
      // sheet 形态由蒙层接管）。采集期间不因 outside-click 误关。
      useEffect(() => {
        if (!open) return;
        try { window.history.pushState({ 'dsh-mobile-compose': Date.now() }, ''); } catch (_) { /* 静默 */ }
        const onPop = () => setPanelOpen(false);
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
      }, [open]);

      useEffect(() => {
        if (!open || sheet) return;
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
      }, [open, sheet]);

      if (!open) return null;

      // ---- 布局：面板与聊天框等宽，固定 2 行，列数按宽度自动计算 ----

      // 聊天框宽度：从「＋」按钮向上找同时包含输入框的卡片容器。
      function composerWidth() {
        let el = panelState.triggerEl;
        for (let hop = 0; el && hop < 10; hop++) {
          if (el.clientWidth >= 320 && el.clientWidth <= window.innerWidth - 32) return el.clientWidth;
          el = el.parentElement;
        }
        const host = document.querySelector('[data-composer-dock]');
        return host && host.clientWidth >= 320 ? host.clientWidth : Math.min(560, window.innerWidth - 24);
      }
      const width = sheet ? 0 : composerWidth();
      // 单列最小 88px：按面板宽度算出列数上限（2-6 列）。
      const maxCols = width > 0 ? Math.max(2, Math.min(6, Math.floor(width / 88))) : 4;

      // ---- 单一列表：常用动作在前，指令紧随其后；超出容量自动分页 ----
      const mains = visibleActions().filter((a) => a.kind !== 'command');
      const commandsOn = caps.enabled.has('command');
      const commands = commandsOn && Array.isArray(panelState.commands) ? panelState.commands : [];
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

      // 多页左右滑：触摸横向滑动 ≥40px 切换相邻页。
      const onTouchStart = (event) => {
        const touch = event.touches && event.touches[0];
        touchStartX.current = touch ? touch.clientX : null;
      };
      const onTouchEnd = (event) => {
        if (touchStartX.current === null) return;
        const touch = event.changedTouches && event.changedTouches[0];
        const deltaX = touch ? touch.clientX - touchStartX.current : 0;
        touchStartX.current = null;
        if (Math.abs(deltaX) < 40) return;
        const next = safePage + (deltaX < 0 ? 1 : -1);
        if (next >= 0 && next < pages.length) switchPage(next);
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
              'aria-label': `第 ${i + 1} 页`,
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
            h('span', { className: 'dmc-tile-label' }, action.label),
          );
        }
        if (entry.kind === 'reload') {
          return h('button', {
            key: entry.key,
            type: 'button',
            className: 'dmc-tile',
            'data-dmc-command': '__reload',
            onClick: () => { panelState.commands = null; harvestCommands(); },
          },
            h('span', { className: 'dmc-tile-box' }, ICONS.reload('#8a8f99')),
            h('span', { className: 'dmc-tile-label' }, '重读指令'),
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
        return h('button', {
          key: entry.key,
          type: 'button',
          className: 'dmc-tile dmc-tile-cmd',
          'data-dmc-command': cmd.name,
          title: '/' + cmd.name + (cmd.desc ? ' — ' + cmd.desc : ''),
          onClick: () => runCommand(cmd),
        },
          h('span', { className: 'dmc-tile-box' }, (ICONS[CMD_ICON[cmd.name]] || ICONS.command)('#7F77DD')),
          h('span', { className: 'dmc-tile-label' }, cmd.label || ('/' + cmd.name)),
        );
      };

      const body = h('div', null,
        h('div', { className: 'dmc-grid', style: gridStyle }, pageEntries.map(renderEntry)),
        panelState.harvesting
          ? h('div', { className: 'dmc-hint' }, '正在读取指令…')
          : h('div', { className: 'dmc-hint' }, '选中的文件走官方上传通道'),
      );

      if (sheet) {
        return createPortal(h('div', null,
          h('div', { className: 'dmc-mask', onClick: closePanel }),
          h('div', { className: 'dmc-panel', role: 'menu', 'aria-label': '添加内容', onTouchStart, onTouchEnd },
            tabsBar,
            body,
            renderOwnInputs(imgInputRef, photoInputRef),
          ),
        ), document.body);
      }

      // dock 形态：portal 到官方 dock 容器（对话框正下方、文档流内），
      // 宽度与聊天框等宽。hero 态与 composer 态该容器都存在；意外缺席时兜底 body。
      const dockHost = document.querySelector('[data-composer-dock]') || document.body;
      return createPortal(
        h('div', { ref: dockRef, className: 'dmc-dock', role: 'menu', 'aria-label': '添加内容', onTouchStart, onTouchEnd, style: width > 0 ? { width: width + 'px', maxWidth: '100%' } : undefined },
          tabsBar,
          body,
          renderOwnInputs(imgInputRef, photoInputRef),
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

      // 指令表变更（插件注册/注销指令）→ 失效缓存并重拉。
      // 客户端 cordis 要求先声明注入才能访问 remote.* 命名空间（否则
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
