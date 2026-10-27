#!/usr/bin/env node
'use strict'

/**
 * E2E 冒烟：把 capabilities handler 挂上真实 node:http 服务，走一次完整
 * HTTP 往返（与 webServer.register 的 handler 契约相同形状），断言响应体；
 * 同时做客户端产物的静态形状校验（__ModuleLoader__ wrapper + 关键插槽名）。
 *
 *   node tools/smoke-e2e.mjs
 */

import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const http = require('node:http')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createCapabilitiesHandler } = require('../lib/capabilities')

async function main() {
  // ---- ① 真实 HTTP 往返 ----
  const handler = createCapabilitiesHandler({})
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const res = await fetch(`http://127.0.0.1:${port}/api/dsh-mobile-compose/capabilities`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.version, 1)
    assert.equal(body.plugin, 'dsh-mobile-compose')
    assert.ok(Array.isArray(body.actions) && body.actions.length === 4)
    console.log('[smoke] ① HTTP 往返 OK：', body.actions.map((a) => `${a.id}=${a.enabled}`).join(' '))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // ---- ② 客户端产物形状校验（加载器契约） ----
  const clientPath = path.join(__dirname, '..', 'lib', 'client.js')
  const clientSrc = fs.readFileSync(clientPath, 'utf8')
  assert.ok(clientSrc.includes('window.__ModuleLoader__.load'), 'client 必须是 __ModuleLoader__ closure factory')
  assert.ok(clientSrc.includes("id: '@xiaopb/dsh-mobile-compose'"), '加载 id 与包名一致')
  assert.ok(clientSrc.includes("'conversation.input.left'"), '注册官方输入行左侧插槽')
  assert.ok(clientSrc.includes("[data-composer-dock]"), '面板 portal 到官方 dock 容器（hero/composer 两态都在，不重叠）')
  assert.ok(clientSrc.includes('order:-1'), '＋按钮站到工具行最左（原位替换）')
  assert.ok(clientSrc.includes('dmc-cmds'), '指令 tab 接管（原生命令列表内嵌）')
  assert.ok(clientSrc.includes("inject = ['slots']"), '声明 slots 服务依赖')
  assert.ok(clientSrc.includes('DataTransfer'), '文件回流走 DataTransfer 注入官方通道')
  assert.ok(clientSrc.includes('dmc-hide-native'), 'hideNative 开关样式在场')
  assert.ok(clientSrc.includes('image/png,image/jpeg'), '图片动作为显式图片后缀过滤（桌面原始文件打开器）')
  console.log('[smoke] ② 客户端产物形状 OK')

  // ---- ③ bundle patch 形状校验 ----
  const patchPath = path.join(__dirname, '..', 'cordis.patch.yml')
  const patchSrc = fs.readFileSync(patchPath, 'utf8')
  assert.ok(patchSrc.includes("@xiaopb/dsh-mobile-compose"), 'roster 插行指向本包')
  assert.ok(patchSrc.includes('insert'), 'patch 为 insert 形态（不禁用任何官方服务）')
  console.log('[smoke] ③ bundle patch 形状 OK')

  console.log('[smoke] 全部通过')
}

main().catch((error) => {
  console.error('[smoke] 失败：', error)
  process.exit(1)
})
