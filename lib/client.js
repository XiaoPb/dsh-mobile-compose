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
      pageIndex: 0,         // 0=常用，1..n=指令分页
      commands: null,       // 从原生指令菜单采集的 [{name, label, desc}]；null=未采集
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
      .dmc-tabs{display:flex;gap:14px;margin:0 0 10px;padding:0;list-style:none}
      .dmc-tab{border:none;background:transparent;padding:2px 1px;font:inherit;font-size:13px;color:#8a8f99;cursor:pointer;border-bottom:2px solid transparent}
      .dmc-tab.dmc-active{color:inherit;border-bottom-color:currentColor;font-weight:500}
      /* 宫格：随面板实际宽度自动增列（默认 ~4 列起步，行数随内容） */
      .dmc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:16px 8px;margin:0;padding:0;list-style:none}
      .dmc-tile{display:flex;flex-direction:column;align-items:center;gap:6px;background:transparent;border:none;padding:0;cursor:pointer;min-width:44px;min-height:44px;font:inherit}
      .dmc-tile:active .dmc-tile-box{transform:scale(.94)}
      .dmc-tile-box{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:#f1f2f4;transition:transform .12s ease}
      .dmc-tile-label{font-size:12px;line-height:1.2;color:#1f2329}
      /* 指令 tab：接管原生命令菜单的列表形态 */
      .dmc-cmds{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;margin:0;padding:0;list-style:none}
      .dmc-cmd{display:flex;gap:10px;align-items:baseline;padding:7px 10px;border:none;background:transparent;border-radius:8px;cursor:pointer;text-align:left;font:inherit;min-height:36px}
      .dmc-cmd:hover{background:rgba(127,127,127,.12)}
      .dmc-cmd:active{background:rgba(127,127,127,.2)}
      .dmc-cmd-name{font-size:13px;font-weight:500;color:inherit;flex:none}
      .dmc-cmd-desc{font-size:12px;color:#8a8f99;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
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
        .dmc-cmd:hover{background:rgba(255,255,255,.1)}
        .dmc-hint,.dmc-tab,.dmc-cmd-desc{color:#9aa0a8}
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

    function runAction(action, goCommands) {
      haptic(8);
      if (action.kind === 'command') {
        // 指令动作 = 切到面板内的指令页（接管原生菜单，不弹原生列表）。
        goCommands();
        return;
      }
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
      if (!btn) { warnMissing('官方调用指令按钮'); panelState.commands = []; notifyPanel(); return; }
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
          const commands = [];
          for (const item of items) {
            const parsed = parseCommandOption(item);
            if (parsed && parsed.name) commands.push(parsed);
          }
          panelState.commands = commands;
        } catch (error) {
          console.warn('[dsh-mobile-compose] 指令列表采集失败：', error);
          panelState.commands = null;
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

    function renderTiles(mains, goCommands) {
      return mains.map((action) => h('button', {
        key: action.id,
        type: 'button',
        className: 'dmc-tile',
        'data-dmc-action': action.id,
        'data-dmc-source': action.source,
        onClick: () => runAction(action, goCommands),
      },
        h('span', { className: 'dmc-tile-box' }, ICONS[ICON_KEY[action.id]] ? ICONS[ICON_KEY[action.id]](action.accent) : null),
        h('span', { className: 'dmc-tile-label' }, action.label),
      ));
    }

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

      // 登记官方 session 标准件（指令执行走 setDraft+submit 裁决通道）。
      useEffect(() => {
        if (props && props.inputActions) panelState.inputActions = props.inputActions;
      }, [props]);

      // 打开即预取指令表（采集是隐蔽的异步动作，用户切到指令页时已就绪）。
      useEffect(() => {
        if (panelState.commands === null && !panelState.harvesting) harvestCommands();
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

      // ---- 分页：常用 1 页 + 指令自动多页（每页容量 = maxCols × 2 行） ----
      const mains = visibleActions();
      const commands = panelState.commands;
      const cmdCapacity = maxCols * 2;
      const commandPages = [];
      if (Array.isArray(commands)) {
        for (let i = 0; i < commands.length; i += cmdCapacity) {
          commandPages.push(commands.slice(i, i + cmdCapacity));
        }
      }
      const pages = [
        { id: 'main', label: '常用' },
        ...commandPages.map((_, i) => ({ id: 'commands-' + i, label: i === 0 ? '指令' : '指令·' + (i + 1) })),
      ];
      const safePage = Math.min(page, pages.length - 1);
      const activePage = pages[safePage] ? pages[safePage].id : 'main';

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
      const gridStyle = (count) => {
        const cols = Math.max(2, Math.min(ceil2(count), maxCols));
        return { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(72px, 96px))`, justifyContent: 'center' };
      };

      const tabsBar = h('div', { className: 'dmc-tabs', role: 'tablist' },
        pages.map((p, i) => h('button', {
          key: p.id,
          type: 'button',
          role: 'tab',
          'aria-selected': i === safePage,
          className: 'dmc-tab' + (i === safePage ? ' dmc-active' : ''),
          onClick: () => switchPage(i),
        }, p.label)),
      );

      const mainBody = h('div', null,
        h('div', { className: 'dmc-grid', style: gridStyle(mains.length) },
          renderTiles(mains, () => switchPage(1)),
        ),
        h('div', { className: 'dmc-hint' }, '选中的文件走官方上传通道'),
      );

      const commandsBody = h('div', null,
        panelState.harvesting
          ? h('div', { className: 'dmc-hint' }, '正在读取指令…')
          : (!commands || commands.length === 0)
            ? h('button', {
                type: 'button', className: 'dmc-cmd',
                onClick: () => { panelState.commands = null; harvestCommands(); },
              },
                h('span', { className: 'dmc-cmd-name' }, '重新读取指令列表'),
              )
            : h('div', { className: 'dmc-grid', style: gridStyle(commandPages[safePage - 1] ? commandPages[safePage - 1].length : 0) },
                (commandPages[safePage - 1] || []).map((cmd) => h('button', {
                  key: cmd.name,
                  type: 'button',
                  className: 'dmc-tile dmc-tile-cmd',
                  'data-dmc-command': cmd.name,
                  title: '/' + cmd.name + (cmd.desc ? ' — ' + cmd.desc : ''),
                  onClick: () => runCommand(cmd),
                },
                  h('span', { className: 'dmc-tile-box' }, ICONS.command('#7F77DD')),
                  h('span', { className: 'dmc-tile-label' }, cmd.label || ('/' + cmd.name)),
                )),
              ),
      );

      const body = activePage === 'main' ? mainBody : commandsBody;

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
