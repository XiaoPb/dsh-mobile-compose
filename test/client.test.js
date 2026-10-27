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
  const imageInput = dockEl.querySelector('input[data-dmc-input="true"][multiple]')
  assert.ok(imageInput, '图片动作自带 input 在面板内')
  assert.equal(imageInput.getAttribute('accept'), IMAGE_ACCEPT, 'accept 为显式图片后缀')

  // pick-file：程序化点击官方 input（原始文件打开器，无过滤）
  await act(async () => {
    tiles.find((t) => t.getAttribute('data-dmc-action') === 'pick-file').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(nativeInputClicks, 1, 'pick-file 动作程序化点击官方 input')
  assert.ok(document.querySelector('.dmc-dock') === null, 'pick-file 后面板关闭')

  // 指令与常用动作同列（不区分 tab）：重开面板后指令瓦片出现在同一宫格
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const cmdTiles = Array.from(document.querySelectorAll('[data-dmc-command]'))
  const names = cmdTiles.map((b) => b.getAttribute('data-dmc-command'))
  assert.deepEqual(names, ['compact', 'export', 'plan'], '指令表已采集并渲染为选项瓦片')
  assert.ok(cmdTiles[0].querySelector('.dmc-tile-box svg'), '指令瓦片带图标')
  const allTiles = Array.from(document.querySelectorAll('.dmc-tile'))
  assert.deepEqual(allTiles.slice(0, 2).map((t) => t.getAttribute('data-dmc-action')), ['pick-image', 'pick-file'], '常用动作排在最前')

  // 执行指令：官方裁决通道（setDraft('/x') + submit），面板关闭
  await act(async () => {
    cmdTiles.find((b) => b.getAttribute('data-dmc-command') === 'export').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(draftWrites, ['/export'], '指令经官方 setDraft 写入')
  assert.equal(submits, 1, '指令经官方 submit 提交')
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

  // ---- ④ 底部面板形态（手机宽度） ----
  // jsdom 的 innerWidth 是原型 getter，直接赋值无效，用 defineProperty 覆盖。
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }) // 先收起当前开着的面板
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-mask'), '窄窗口出现蒙层')
  assert.ok(document.querySelector('.dmc-panel'), '底部面板形态在场')
  await act(async () => { document.querySelector('.dmc-mask').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.dmc-panel') === null, '蒙层点击关闭')
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

  await act(async () => { root.unmount() })
  dom.window.close()
})
