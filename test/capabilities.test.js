'use strict'

/**
 * capabilities 测试：payload 形状（版本/平台/动作/客户端开关）、WebRoute 形状、
 * handler 直接应答（伪 req/res，供 smoke 复用）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCapabilitiesPayload, createCapabilitiesRoute, createCapabilitiesHandler } = require('../lib/capabilities')

test('payload：默认全动作启用、hideNativeButtons=true、version=1', () => {
  const body = buildCapabilitiesPayload({})
  assert.equal(body.version, 1)
  assert.equal(body.plugin, 'dsh-mobile-compose')
  assert.equal(body.platform.web, true)
  assert.equal(body.client.hideNativeButtons, true)
  assert.equal(body.actions.length, 4)
  for (const a of body.actions) {
    assert.equal(a.enabled, true, `${a.id} 默认启用`)
    assert.equal(a.routed, 'web', 'v0.1.0 一律 web 路由（原生路由留缝未接）')
  }
  const ids = body.actions.map((a) => a.id)
  assert.deepEqual(ids, ['pick-image', 'take-photo', 'pick-file', 'command'])
  const sources = body.actions.map((a) => a.source)
  assert.deepEqual(sources, ['gallery', 'camera', 'document', 'internal'], '来源细分（安卓路由的缝）')
})

test('payload：actions 开关透传、hideNativeButtons=false 透传', () => {
  const body = buildCapabilitiesPayload({
    hideNativeButtons: false,
    actions: { 'pick-image': false },
  })
  assert.equal(body.client.hideNativeButtons, false)
  const pickImage = body.actions.find((a) => a.id === 'pick-image')
  const takePhoto = body.actions.find((a) => a.id === 'take-photo')
  assert.equal(pickImage.enabled, false)
  assert.equal(takePhoto.enabled, true)
})

test('WebRoute 形状：exact + 官方 /api 路径族 + handler 函数', () => {
  const route = createCapabilitiesRoute({})
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/api/dsh-mobile-compose/capabilities')
  assert.equal(typeof route.handler, 'function')
})

/** 伪 ServerResponse：聚合 writeHead/end 供断言。 */
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

test('handler：200 + JSON + no-store，content-length 与 body 一致', async () => {
  const handler = createCapabilitiesHandler({})
  const res = mockRes()
  await handler({ headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Content-Type'] || '', /application\/json/)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(Number(res.headers['Content-Length']), Buffer.byteLength(res.body))
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.version, 1)
})
