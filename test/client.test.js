'use strict'

/**
 * 客户端 bundle 实测：在 jsdom 里真实执行 lib/client.js ——
 *   ① __ModuleLoader__ 加载契约（id / factory(require) / exports 形状）；
 *   ② apply 接线：双插槽注册（入口 + dock 面板）、样式注入、能力协商、hideNative 开关；
 *   ③ 渲染 + 交互：加号入口、tab（常用/指令）、宫格、指令接管（采集原生菜单
 *      → 官方 setDraft+submit 执行）、关闭路径（外部点击 / Esc / 返回键）、卸载清理。
 *
 * react / react-dom / jsdom 为 devDependencies（与 DSH 运行时注入的同源契约）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')
const React = require('react')
const { createRoot } = require('react-dom/client')
const reactAct = require('react-dom/test-utils')

const act = typeof React.act === 'function' ? React.act : reactAct.act

const CAPS_BODY = {
  version: 1,
  plugin: 'dsh-mobile-compose',
  platform: { android: false, web: true },
  client: { hideNativeButtons: false },
  actions: [
    { id: 'pick-image', source: 'gallery', label: '图片', enabled: true, routed: 'web' },
    { id: 'take-photo', source: 'camera', label: '拍照', enabled: true, routed: 'web' },
    { id: 'pick-file', source: 'document', label: '文件', enabled: true, routed: 'web' },
    { id: 'command', source: 'internal', label: '指令', enabled: true, routed: 'web' },
  ],
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif'

/** 伪 remote.commands.list 返回值：20 条（超出单页容量，验证自动分页）。 */
const COMMANDS = Array.from({ length: 20 }, (_, i) => ({
  name: 'cmd' + i,
  description: '演示指令 ' + i,
}))

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://dsh.local/' })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  global.window = dom.window
  global.document = dom.window.document
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  global.Event = dom.window.Event
  global.HTMLElement = dom.window.HTMLElement
  global.MouseEvent = dom.window.MouseEvent
  global.KeyboardEvent = dom.window.KeyboardEvent
  // DataTransfer 在 jsdom 不可构造：给最小 shim（items.add / files）。
  class DataTransferShim {
    constructor() {
      this._files = []
      this.items = { add: (f) => this._files.push(f) }
    }
    get files() { return this._files }
  }
  global.DataTransfer = DataTransferShim
  global.history = dom.window.history
  return dom
}

function loadClient({ fetchImpl } = {}) {
  let loaded = null
  global.window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      const requireShim = (spec) => {
        if (spec === 'react') return React
        if (spec === 'react-dom') return require('react-dom')
        throw new Error(`unexpected client require: ${spec}`)
      }
      loaded = { id, mod: factory(requireShim) }
    },
  }
  global.fetch = fetchImpl || (async () => ({ ok: true, json: async () => CAPS_BODY }))
  // node:test 下 require 会缓存模块：每次装载前清缓存，保证 factory 重新执行。
  delete require.cache[require.resolve('../lib/client.js')]
  require('../lib/client.js')
  assert.ok(loaded, 'client 必须经 __ModuleLoader__.load 装载')
  return loaded
}

/** 伪 cordis ctx：slots 服务记录注册；动态 inject 记录订阅；effect 收集卸载器。 */
function mockCtx() {
  const state = { injectCalls: [], registered: [], effectFns: [], dynamicInjects: [] }
  const ctx = {
    state,
    logger: { info() {}, warn() {}, debug() {} },
    get() { return undefined },
    inject(names, cb) {
      state.dynamicInjects.push({ names, cb })
    },
    slots: {
      inject(name, factory) {
        state.injectCalls.push(name)
        return factory()
      },
      register(meta, comp) {
        state.registered.push({ meta, comp })
        return () => {}
      },
    },
    effect(fn) {
      state.effectFns.push(fn)
      return () => {}
    },
  }
  return ctx
}

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 伪官方指令菜单（0.2.1 结构：listbox + button[role=option]，span = [svg空, 中文标签, 别名, 描述]）。 */
function installFakeNativeMenu() {
  const popup = document.createElement('div')
  popup.setAttribute('role', 'listbox')
  const makeOption = (label, name, desc) => {
    const item = document.createElement('button')
    item.setAttribute('role', 'option')
    for (const text of ['', label, name, desc]) {
      const s = document.createElement('span')
      s.textContent = text
      item.appendChild(s)
    }
    return item
  }
  popup.appendChild(makeOption('压缩', 'compact', 'Compact older conversation history'))
  popup.appendChild(makeOption('下载日志', 'export', 'Download this Session log as a ZIP archive'))
  popup.appendChild(makeOption('计划', 'plan', 'Enter or leave plan mode'))
  document.body.appendChild(popup)
  const onKey = (event) => {
    if (event.key === 'Escape') popup.remove()
  }
  document.addEventListener('keydown', onKey)
  return { popup, dispose: () => { document.removeEventListener('keydown', onKey); popup.remove() } }
}

test('client bundle：加载契约 + apply 接线 + 渲染交互 + 指令接管 + 卸载清理', async () => {
  const dom = setupDom()
  const loaded = loadClient()

  // ---- ① 加载契约 ----
  assert.equal(loaded.id, '@xiaopb/dsh-mobile-compose')
  assert.equal(loaded.mod.inject.join(','), 'slots')
  assert.equal(typeof loaded.mod.apply, 'function')

  const ctx = mockCtx()
  loaded.mod.apply(ctx)

  // ---- ② apply 接线：单插槽（面板由入口组件内渲染，不依赖 composer.dock 插槽）----
  assert.deepEqual(ctx.state.injectCalls, ['conversation.input.left'])
  assert.equal(ctx.state.registered.length, 1)
  const plus = ctx.state.registered.find((r) => r.meta.id === 'dsh-mobile-compose-plus')
  assert.equal(plus.meta.name, 'conversation.input.left')
  assert.ok(document.getElementById('dsh-mobile-compose-style'), '面板样式已注入')
  assert.ok(document.getElementById('dsh-mobile-compose-hide'), 'hideNative 样式已注入')
  assert.ok(document.getElementById('dsh-mobile-compose-style').textContent.includes('order:-1'), '＋按钮站到工具行最左（原位替换）')
  assert.ok(document.body.classList.contains('dmc-hide-native'), '默认（拉取前）隐藏原生按钮')
  await flush() // 能力协商 fetch 落地
  assert.ok(!document.body.classList.contains('dmc-hide-native'), 'caps hideNativeButtons=false → 关闭隐藏')
  assert.ok(!document.querySelector('.dmc-dock'), '未点击时面板不渲染')

  // ---- ③ 渲染：官方 input / 官方指令按钮 / 官方指令菜单（fixture） ----
  const container = document.createElement('div')
  document.body.appendChild(container)
  const nativeInput = document.createElement('input')
  nativeInput.setAttribute('type', 'file')
  nativeInput.setAttribute('multiple', '')
  nativeInput.setAttribute('hidden', '')
  let nativeInputClicks = 0
  nativeInput.addEventListener('click', () => { nativeInputClicks += 1 })
  document.body.appendChild(nativeInput)

  const commandButton = document.createElement('button')
  commandButton.setAttribute('aria-haspopup', 'listbox')
  let commandClicks = 0
  commandButton.addEventListener('click', () => { commandClicks += 1 })
  document.body.appendChild(commandButton)

  const fakeMenu = installFakeNativeMenu()

  // 官方 dock 容器（面板 portal 目标；hero / composer 两态都存在）
  const dockHost = document.createElement('div')
  dockHost.setAttribute('data-composer-dock', '')
  document.body.appendChild(dockHost)

  // 官方 session 标准件（指令执行通道）
  const draftWrites = []
  let submits = 0
  const inputActions = {
    setDraft: (text) => draftWrites.push(text),
    submit: () => { submits += 1 },
  }

  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(plus.comp, { inputActions, sessionId: 'session-test' }))
  })
  await flush()

  const entry = document.querySelector('button[aria-label="添加内容"]')
  assert.ok(entry, '加号入口已渲染')

  // 打开面板（宽窗口 → dock 形态：文档流内、不浮动）
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const dockEl = document.querySelector('.dmc-dock')
  assert.ok(dockEl, 'dock 面板已打开（对话框下方文档流内）')
  // caps 后 take-photo 在非安卓隐藏 → 2 个动作瓦片（指令不再是动作瓦片，与指令同列）
  const tiles = Array.from(dockEl.querySelectorAll('.dmc-tile'))
  assert.deepEqual(tiles.map((t) => t.getAttribute('data-dmc-action')), ['pick-image', 'pick-file'])
  assert.ok(global.history.state && global.history.state['dsh-mobile-compose'], 'open 时压入 history 标记')

  // 打开即加载指令（无 remote → DOM 采集兜底）
  await flush(420) // 采集轮询 + dismiss 收尾（60+140ms）
  assert.equal(commandClicks, 1, '打开面板即自动隐蔽采集（点原生按钮）')

  // 桌面端图片过滤：自带 input 用显式图片后缀（原始文件打开器按扩展名过滤）
  const imageInput = dockEl.querySelector('input[data-dmc-role="pick-image"]')
  assert.ok(imageInput, '图片动作自带 input 在面板内')
  assert.equal(imageInput.getAttribute('accept'), IMAGE_ACCEPT, 'accept 为显式图片后缀')

  // 文件动作 = 原始 file：自带 input 不限后缀（accept 留空）
  const fileInput = dockEl.querySelector('input[data-dmc-role="pick-file"]')
  assert.ok(fileInput, '文件动作自带 input 在面板内')
  assert.equal(fileInput.getAttribute('accept'), null, '文件动作不限后缀（= 原始 file）')

  // pick-file：打开自带 input（不限后缀），选择期间面板保持挂载
  let pickFileClicks = 0
  fileInput.addEventListener('click', () => { pickFileClicks += 1 })
  await act(async () => {
    tiles.find((t) => t.getAttribute('data-dmc-action') === 'pick-file').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(pickFileClicks, 1, 'pick-file 动作打开自带 input（全部后缀）')
  assert.equal(nativeInputClicks, 0, '选择阶段不碰官方 input（回流时才注入）')
  assert.ok(document.querySelector('.dmc-dock') !== null, '选择期间面板保持打开（卸载会取消文件对话框）')

  // 面板仍开着：先收起再重开（入口按钮是开合开关）
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-dock') === null, '再次点击入口收起面板')

  // 指令与常用动作同列（不区分 tab）：重开面板后指令瓦片出现在同一宫格
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const cmdTiles = Array.from(document.querySelectorAll('[data-dmc-command]'))
  const names = cmdTiles.map((b) => b.getAttribute('data-dmc-command'))
  assert.deepEqual(names, ['compact', 'export', 'plan'], '指令表已采集并渲染为选项瓦片')
  assert.ok(cmdTiles[0].querySelector('.dmc-tile-box svg'), '指令瓦片带图标')
  assert.equal(cmdTiles[0].querySelector('.dmc-tile-label').textContent, '压缩', '指令瓦片主标签为中文')
  assert.equal(cmdTiles[0].querySelector('.dmc-tile-sub').textContent, '/compact', '斜杠别名为次行小字')
  const allTiles = Array.from(document.querySelectorAll('.dmc-tile'))
  assert.deepEqual(allTiles.slice(0, 2).map((t) => t.getAttribute('data-dmc-action')), ['pick-image', 'pick-file'], '常用动作排在最前')

  // 执行指令：采集来源没有 input 信息 → 一律按 claim 写草稿（不代发），面板关闭
  await act(async () => {
    cmdTiles.find((b) => b.getAttribute('data-dmc-command') === 'export').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(draftWrites, ['/export '], '指令写入草稿（claim，不代发）')
  assert.equal(submits, 0, '采集来源的指令绝不直接提交')
  assert.ok(document.querySelector('.dmc-dock') === null, '指令执行后面板关闭')
  assert.ok(!document.querySelector('[role="listbox"]'), '原生菜单已收起（无残留）')

  // 点击外部关闭（dock 形态）
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-dock'), '重新打开')
  await act(async () => { document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-dock') === null, '点击面板外关闭')

  // Escape 关闭
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.ok(document.querySelector('.dmc-dock') === null, 'Escape 关闭')

  // 关闭后回到「常用」tab
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-tile[data-dmc-action="pick-image"]'), '重开默认在常用 tab')

  // ---- ④ 窄窗口：统一 dock 形态（所有宽度一致，不再有底部面板） ----
  // jsdom 的 innerWidth 是原型 getter，直接赋值无效，用 defineProperty 覆盖。
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }) // 先收起当前开着的面板
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const dockNarrow = document.querySelector('.dmc-dock')
  assert.ok(dockNarrow, '窄窗口同样是 dock 形态（插在输入框正下方）')
  assert.ok(document.querySelector('.dmc-mask') === null && document.querySelector('.dmc-panel') === null, '蒙层/底部面板已移除')
  assert.ok(/^\d+(\.\d+)?px$/.test(dockNarrow.style.width || ''), '窄窗口下宽度仍按输入框实测')
  await act(async () => { document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-dock') === null, '窄窗口点击面板外关闭')
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })

  // ---- ⑤ 卸载清理 ----
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  for (const makeDispose of ctx.state.effectFns) {
    const dispose = makeDispose()
    if (typeof dispose === 'function') dispose()
  }
  assert.ok(!document.getElementById('dsh-mobile-compose-style'), '样式标签已移除')
  assert.ok(!document.getElementById('dsh-mobile-compose-hide'), 'hideNative 样式已移除')
  assert.ok(!document.body.classList.contains('dmc-hide-native'), 'body 开关类已移除')

  await act(async () => { root.unmount() })
  fakeMenu.dispose()
  dom.window.close()
})

test('client bundle：能力协商失败时走内置默认集（不抛错、全动作可见）', async () => {
  const dom = setupDom()
  const loaded = loadClient({ fetchImpl: async () => { throw new Error('network down') } })
  const ctx = mockCtx()
  loaded.mod.apply(ctx)
  await flush()
  assert.ok(document.body.classList.contains('dmc-hide-native'), '默认 hideNative=true')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dockHost2 = document.createElement('div')
  dockHost2.setAttribute('data-composer-dock', '')
  document.body.appendChild(dockHost2)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ctx.state.registered.find((r) => r.meta.id === 'dsh-mobile-compose-plus').comp, { sessionId: 'session-test' }))
  })
  await act(async () => {
    document.querySelector('button[aria-label="添加内容"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  // 拉取失败 → caps.ready=false → 全部 4 个动作按内置默认展示
  assert.equal(document.querySelectorAll('.dmc-tile').length, 4)
  await act(async () => { root.unmount() })
  dom.window.close()
})

test('client bundle：remote.commands.list 拉全量指令，超出容量自动分页（页码点）', async () => {
  const dom = setupDom()
  const loaded = loadClient()
  const ctx = mockCtx()
  const listed = []
  loaded.mod.apply(ctx)

  // 模拟官方 remote.commands 服务就绪：触发动态注入回调
  const inject = ctx.state.dynamicInjects.find((d) => d.names.includes('remote.commands'))
  assert.ok(inject, '声明了 remote.commands 动态注入')
  inject.cb({
    remote: { commands: { list: async (sid) => { listed.push(sid); return { ok: true, value: COMMANDS } } } },
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dockHost = document.createElement('div')
  dockHost.setAttribute('data-composer-dock', '')
  document.body.appendChild(dockHost)

  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ctx.state.registered[0].comp, { sessionId: 'session-test' }))
  })
  await act(async () => {
    document.querySelector('button[aria-label="添加内容"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush(120)

  assert.deepEqual(listed, ['session-test'], '用 slot props 的 sessionId 调用官方 list RPC')
  const tiles = Array.from(document.querySelectorAll('[data-dmc-command]'))
  assert.ok(tiles.length > 0, '指令来自 RPC 全量表')
  const pager = document.querySelector('.dmc-pager')
  assert.ok(pager, '条目超出单页容量 → 出现页码点')
  assert.ok(pager.querySelectorAll('.dmc-dot').length >= 2, '至少 2 页')
  const page1 = tiles.map((t) => t.getAttribute('data-dmc-command'))
  await act(async () => { pager.querySelectorAll('.dmc-dot')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const page2 = Array.from(document.querySelectorAll('[data-dmc-command]')).map((t) => t.getAttribute('data-dmc-command'))
  assert.ok(page2.length > 0, '第 2 页有指令瓦片')
  assert.notDeepEqual(page1, page2, '两页内容不同')

  // ---- 换页交互：移动端左右滑 / 桌面端滚轮 ----
  const fireTouch = (el, type, x, y) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true })
    const point = { clientX: x, clientY: y, identifier: 1, target: el }
    const list = type === 'touchend' || type === 'touchcancel' ? [] : [point]
    Object.defineProperty(ev, 'touches', { value: list })
    Object.defineProperty(ev, 'changedTouches', { value: [point] })
    el.dispatchEvent(ev)
  }
  const fireWheel = (el, deltaY, deltaX = 0) => {
    const ev = new window.WheelEvent('wheel', { deltaY, deltaX, deltaMode: 0, bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const names = () => Array.from(document.querySelectorAll('[data-dmc-command]')).map((t) => t.getAttribute('data-dmc-command'))
  const dock = document.querySelector('.dmc-dock')
  assert.ok(dock.classList.contains('dmc-swipe'), '多页时接管横向手势（touch-action:pan-y）')

  // 纵向滑动不翻页（交还给页面滚动）
  await act(async () => {
    fireTouch(dock, 'touchstart', 200, 320)
    fireTouch(dock, 'touchend', 210, 200)
  })
  assert.deepEqual(names(), page2, '纵向滑动不翻页')

  // 右滑 → 第 1 页；左滑 → 第 2 页
  await act(async () => {
    fireTouch(dock, 'touchstart', 200, 300)
    fireTouch(dock, 'touchend', 320, 306)
  })
  assert.deepEqual(names(), page1, '右滑 → 上一页')
  await act(async () => {
    fireTouch(dock, 'touchstart', 320, 300)
    fireTouch(dock, 'touchend', 190, 298)
  })
  assert.deepEqual(names(), page2, '左滑 → 下一页')

  // 桌面滚轮：向上 → 上一页（并阻止页面滚动）
  let prevented = false
  await act(async () => { prevented = fireWheel(dock, -120) })
  assert.deepEqual(names(), page1, '滚轮向上 → 上一页')
  assert.ok(prevented, '滚轮翻页时阻止页面滚动')
  // 冷却窗口内连续滚轮不连翻
  await act(async () => { fireWheel(dock, -120) })
  assert.deepEqual(names(), page1, '冷却窗口内不重复翻页')
  // 冷却后再向下 → 下一页
  await act(async () => { await new Promise((r) => setTimeout(r, 320)) })
  await act(async () => { fireWheel(dock, 120) })
  assert.deepEqual(names(), page2, '滚轮向下 → 下一页')

  await act(async () => { root.unmount() })
  dom.window.close()
})

test('client bundle：指令执行决策表（input→claim 不代发；裸指令→submit）+ 默认隐藏 /file + locale 中文', async () => {
  const dom = setupDom()
  const loaded = loadClient()
  const ctx = mockCtx()
  loaded.mod.apply(ctx)

  // 官方 locale（command namespace）：内置指令的中文标签与 claim token
  const localeInject = ctx.state.dynamicInjects.find((d) => d.names.includes('locale'))
  assert.ok(localeInject, '声明了 locale 动态注入')
  const zhDict = { 'label.goal': '目标', 'label.compact': '压缩', 'token.goal': '目标' }
  localeInject.cb({ locale: { bind: (ns) => (key) => (ns === 'command' && key in zhDict ? zhDict[key] : key) } })

  const inject = ctx.state.dynamicInjects.find((d) => d.names.includes('remote.commands'))
  inject.cb({
    remote: {
      commands: {
        list: async () => ({
          ok: true,
          value: [
            { name: 'file', description: '文件（官方添加文件指令，与动作瓦片重复）' },
            { name: 'goal', description: 'Set or view the goal', input: { hint: '目标内容' } },
            { name: 'compact', description: 'Compact older conversation history' },
          ],
        }),
      },
    },
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dockHost = document.createElement('div')
  dockHost.setAttribute('data-composer-dock', '')
  document.body.appendChild(dockHost)

  const draftWrites = []
  let submits = 0
  const inputActions = { setDraft: (t) => draftWrites.push(t), submit: () => { submits += 1 } }

  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ctx.state.registered[0].comp, { inputActions, sessionId: 'session-test' }))
  })
  await act(async () => {
    document.querySelector('button[aria-label="添加内容"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush(120)

  // /file 与内置 图片/文件 瓦片同义 → 默认剔除，不渲染
  assert.equal(document.querySelector('[data-dmc-command="file"]'), null, '默认隐藏 /file（与图片/文件动作重复）')

  // 带 input 的指令 → claim：本地化 token 写入草稿，不提交（与原生菜单一致）
  const goalTile = document.querySelector('[data-dmc-command="goal"]')
  assert.equal(goalTile.querySelector('.dmc-tile-label').textContent, '目标', 'locale 中文标签')
  assert.equal(goalTile.querySelector('.dmc-tile-sub').textContent, '/goal', '斜杠别名为次行小字')
  await act(async () => { goalTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(draftWrites, ['/目标 '], 'claim 写入本地化 token（与原生菜单拼写一致）')
  assert.equal(submits, 0, '带 input 的指令不代发')
  assert.equal(document.querySelector('.dmc-dock'), null, '面板已关闭')

  // 裸指令 → Enter 通道：setDraft('/x') + submit（官方分离执行）
  await act(async () => {
    document.querySelector('button[aria-label="添加内容"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  const compactTile = document.querySelector('[data-dmc-command="compact"]')
  assert.equal(compactTile.querySelector('.dmc-tile-label').textContent, '压缩', 'locale 中文标签（compact）')
  await act(async () => { compactTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(draftWrites, ['/目标 ', '/compact'], '裸指令按裸 token 提交')
  assert.equal(submits, 1, '裸指令经官方 submit 分离执行')

  await act(async () => { root.unmount() })
  dom.window.close()
})
