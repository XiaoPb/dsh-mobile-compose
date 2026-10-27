'use strict'

/**
 * 宿主接线测试：apply(ctx) 在 webServer 服务出现时注册 capabilities 路由；
 * enabled=false 零路由；webServer 缺席（headless）不抛错。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const plugin = require('../lib/index')

/** 伪 cordis ctx：记录动态 inject 订阅与 settings namespace 安装，手动派发服务。 */
function mockCtx({ settingsService } = {}) {
  const injectSubs = []
  const installedSections = []
  const logs = []
  return {
    ctx: {
      logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), debug: (...a) => logs.push(['debug', ...a]) },
      get(name) {
        return name === 'settings' ? settingsService : undefined
      },
      inject(names, cb) {
        injectSubs.push({ names, cb })
      },
      effect() {
        return () => {}
      },
    },
    installedSections,
    /** 模拟 webServer 服务出现。 */
    provideWebServer(registered) {
      const webServer = { register: (route) => { registered.push(route); return () => {} } }
      const scoped = { webServer }
      for (const sub of injectSubs.splice(0)) {
        if (sub.names.join(',') === 'webServer') {
          const disposer = sub.cb(scoped)
          if (typeof disposer === 'function') this.routeDisposer = disposer
        }
      }
    },
    injectSubs,
    logs,
    routeDisposer: null,
  }
}

test('apply：默认配置下订阅 webServer 并注册 capabilities 路由', () => {
  const m = mockCtx()
  const dispose = plugin.apply(m.ctx, {})
  assert.equal(typeof dispose, 'function')
  assert.equal(m.injectSubs.length, 1)
  assert.deepEqual(m.injectSubs[0].names, ['webServer'])

  const registered = []
  m.provideWebServer(registered)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, '/api/dsh-mobile-compose/capabilities')
})

test('apply：enabled=false 时零订阅零路由', () => {
  const m = mockCtx()
  const dispose = plugin.apply(m.ctx, { enabled: false })
  assert.equal(typeof dispose, 'function')
  assert.equal(m.injectSubs.length, 0)
  dispose()
})

test('apply：webServer 永不出现（headless）不抛错，dispose 安全', () => {
  const m = mockCtx()
  const dispose = plugin.apply(m.ctx, {})
  assert.doesNotThrow(dispose)
})

test('apply：webServer.register 抛错不上抛（降级为日志）', () => {
  const m = mockCtx()
  plugin.apply(m.ctx, {})
  const webServer = { register: () => { throw new Error('boom') } }
  assert.doesNotThrow(() => {
    for (const sub of m.injectSubs) sub.cb({ webServer })
  })
  assert.ok(m.logs.some(([level]) => level === 'warn'), '降级应有 warn 日志')
})

test('apply：settings 服务在场时安装设置页 namespace（schema 为 schemastery 形状）', () => {
  const z = require('@deepseek-ai/schemastery')
  const installed = []
  const settingsService = {
    installSection(owner, ns, schema, entry, hooks) {
      installed.push({ owner, ns, schema, entry, hooks })
    },
  }
  const m = mockCtx({ settingsService })
  plugin.apply(m.ctx, {})
  assert.equal(installed.length, 1)
  assert.equal(installed[0].ns, 'dsh-mobile-compose')
  assert.equal(installed[0].entry.hideNativeButtons, true)
  assert.equal(typeof installed[0].hooks.setSource, 'function')
  assert.ok(installed[0].schema, 'schemastery 已安装 → schema 非 null')
  assert.equal(typeof z.object, 'function')
})

test('apply：设置页改动经 setSource 实时反映到 capabilities 响应', async () => {
  let section = { hideNativeButtons: true, actions: { 'pick-image': true, 'take-photo': true, 'pick-file': true, command: true } }
  const settingsService = {
    installSection(owner, ns, schema, entry, hooks) {
      hooks.setSource(() => section)
    },
  }
  const m = mockCtx({ settingsService })
  plugin.apply(m.ctx, {})

  const registered = []
  m.provideWebServer(registered)
  const route = registered[0]

  const res1 = mockRes()
  await route.handler({}, res1)
  assert.equal(JSON.parse(res1.body).client.hideNativeButtons, true)

  // 用户在设置页关闭 pick-image、隐藏原生按钮
  section = { hideNativeButtons: false, actions: { 'pick-image': false } }
  const res2 = mockRes()
  await route.handler({}, res2)
  const body2 = JSON.parse(res2.body)
  assert.equal(body2.client.hideNativeButtons, false)
  assert.equal(body2.actions.find((a) => a.id === 'pick-image').enabled, false)
  assert.equal(body2.actions.find((a) => a.id === 'pick-file').enabled, true, '未改动的动作保持启用')
})

test('apply：settings 服务缺席（headless）不安装 namespace，capabilities 用插件配置', async () => {
  const m = mockCtx({})
  plugin.apply(m.ctx, { hideNativeButtons: false, actions: { command: false } })
  assert.equal(m.installedSections.length, 0)
  const registered = []
  m.provideWebServer(registered)
  const res = mockRes()
  await registered[0].handler({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.client.hideNativeButtons, false)
  assert.equal(body.actions.find((a) => a.id === 'command').enabled, false)
})

/** 伪 ServerResponse：聚合 writeHead/end 供断言（与 capabilities.test 同形）。 */
function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk) this.body += chunk
    },
    destroy() {},
  }
}
