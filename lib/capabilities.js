'use strict'

/**
 * capabilities 路由族：GET /api/dsh-mobile-compose/capabilities
 *
 * 客户端装载时拉取一次，按响应决定：
 *   - 动作宫格里渲染哪些项（actions[].enabled）；
 *   - 是否隐藏原生「添加文件 / 调用指令」按钮（client.hideNativeButtons）。
 *
 * 拉取失败（未启用 / headless profile / 旧版本引擎）时客户端走内置默认集，
 * 所以本路由是**能力协商的增强路径，不是功能门槛**。
 *
 * platform.android：Node 在 Android App 内运行时仍报 linux，由 ANDROID_DATA /
 * DSH_ANDROID_USER_DATA 环境变量（以及 /system/build.prop 兜底探测）显式区分
 * ——与 dsh-hardssh 的 platform.ts 同一约定。安卓端将来把 take-photo 等动作
 * 路由到原生 Intent 时，就是在这个响应里把 routed:'native' 声明出来，客户端
 * 据此改走 App 桥而不是浏览器 input[capture]。
 */

const http = require('node:http')

/** Android 运行时探测（与 dsh-hardssh/src/platform.ts 同语义）。 */
function isAndroidRuntime() {
  if (process.env.ANDROID_DATA !== undefined) return true
  if (process.env.DSH_ANDROID_USER_DATA !== undefined) return true
  try {
    return require('node:fs').existsSync('/system/build.prop')
  } catch (_) {
    return false
  }
}

/** 动作注册表（宿主侧单一事实来源；客户端另有一份形状相同的内置默认）。 */
const ACTION_DEFS = [
  { id: 'pick-image', source: 'gallery', label: '图片' },
  { id: 'take-photo', source: 'camera', label: '拍照' },
  { id: 'pick-file', source: 'document', label: '文件' },
  { id: 'command', source: 'internal', label: '指令' },
]

function buildCapabilitiesPayload(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const actions = typeof cfg.actions === 'object' && cfg.actions !== null ? cfg.actions : {}
  const hidden = Array.isArray(cfg.hiddenCommands) ? cfg.hiddenCommands : []
  const android = isAndroidRuntime()
  return {
    version: 1,
    plugin: 'dsh-mobile-compose',
    platform: { android, web: true },
    client: { hideNativeButtons: cfg.hideNativeButtons !== false },
    // 与内置动作同义、默认不展示的指令（客户端可再叠加自己的默认集）。
    commands: { hidden },
    actions: ACTION_DEFS.map((def) => ({
      ...def,
      enabled: actions[def.id] !== false,
      // 安卓原生路由（相机 / 相册 Intent）尚未接入：桌面与安卓当前都走
      // 浏览器 input[accept][capture] 方案，routed 一律 'web'。
      routed: 'web',
    })),
  }
}

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (_) {
    try {
      res.destroy()
    } catch (_2) {
      /* 静默降级 */
    }
  }
}

/**
 * 构造 capabilities 路由（WebRoute 形状：{kind, path, handler}）。
 *
 * @param configOrSource - 归一化配置对象，或返回该对象的 thunk（设置页实时
 *   来源：用户在 DSH 设置页改动后，下一次请求即拿到新值，无需重载插件）。
 */
function createCapabilitiesRoute(configOrSource) {
  const getConfig = typeof configOrSource === 'function' ? configOrSource : () => configOrSource
  return {
    kind: 'exact',
    path: '/api/dsh-mobile-compose/capabilities',
    handler: function handler(_req, res) {
      let cfg
      try {
        cfg = getConfig()
      } catch (_) {
        cfg = {}
      }
      sendJson(res, 200, buildCapabilitiesPayload(cfg))
    },
  }
}

/** 独立可用：node:test 与 smoke 直接调用 handler（伪 req/res）。 */
function createCapabilitiesHandler(configOrSource) {
  return createCapabilitiesRoute(configOrSource).handler
}

module.exports = { createCapabilitiesRoute, createCapabilitiesHandler, buildCapabilitiesPayload, isAndroidRuntime, ACTION_DEFS, sendJson }
