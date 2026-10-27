'use strict'

/**
 * dsh-mobile-compose v0.2.0 宿主端入口：cordis 插件（inject + apply）。
 *
 * 定位：**手机端输入体验**。客户端（lib/client.js，随 web GUI 加载）做全部
 * UI 工作 —— 输入框左下角加号入口、QQ 式动作面板（图片 / 拍照 / 文件 / 指令）、
 * 隐藏原生小按钮，并把选中的文件送回官方 addFiles 通道。宿主端提供两件事：
 *
 *   1. GET /api/dsh-mobile-compose/capabilities —— 动作能力协商（capabilities.js）。
 *      来源是「设置页实时值」：用户在 DSH 设置页改动后，客户端下一次拉取即生效。
 *   2. `dsh-mobile-compose` 设置页 namespace —— schemastery schema 经
 *      ctx.settings.installSection 注册，DSH 设置页自动渲染表单（settings.js）。
 *      settings 服务缺席（headless / 异常安装）时静默跳过，仅用插件装载配置。
 *
 * 契约：inject 恒为 []（webServer / settings 都是可选服务，动态获取，缺席即
 * 降级）；apply(ctx, config) 装载，返回卸载函数；所有失败路径绝不上抛。
 */

const { normalizeConfig, mergeSettingsSection } = require('./config')
const { createCapabilitiesRoute } = require('./capabilities')
const { buildSettingsSchema } = require('./settings')

const SETTINGS_NAMESPACE = 'dsh-mobile-compose'

function apply(ctx, config) {
  const base = normalizeConfig(config)

  const log = (level, ...args) => {
    try {
      const lg = ctx && ctx.logger
      if (lg && typeof lg[level] === 'function') lg[level](`[dsh-mobile-compose]`, ...args)
    } catch (_) {
      /* 日志丢失不影响主流程 */
    }
  }

  if (base.enabled === false) {
    log('info', 'disabled (enabled=false)，装载但零路由')
    return function dispose() {}
  }

  // ---- 设置页 namespace（可选服务）----
  // current 恒为「当前生效配置」的 thunk：初始为插件配置；settings 服务把它
  // 换成实时来源（attach 时与 detach 时都会回调 setSource）。
  let current = () => base
  try {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    const schema = buildSettingsSchema()
    if (settings && typeof settings.installSection === 'function' && schema) {
      const entry = {
        hideNativeButtons: base.hideNativeButtons,
        actions: { ...base.actions },
        hiddenCommands: base.hiddenCommands.join(','),
      }
      settings.installSection(ctx, SETTINGS_NAMESPACE, schema, entry, {
        setSource: (source) => {
          current = () => mergeSettingsSection(base, typeof source === 'function' ? source() : source)
        },
        onChange: () => {
          log('info', '设置页配置已更新，capabilities 下一次拉取即生效')
        },
      })
    } else {
      log('debug', 'settings 服务或 schema 不可用，仅用插件装载配置')
    }
  } catch (error) {
    log('warn', '设置页 namespace 注册失败（不影响 capabilities，仅少一处 UI 配置入口）：', error instanceof Error ? error.message : String(error))
  }

  // ---- capabilities 路由（可选服务）----
  // webServer 是可选服务（headless profile 没有它）：动态 inject 保证本插件
  // 在任何 profile 都可装载，服务出现时才挂路由。
  ctx.inject(['webServer'], (scoped) => {
    try {
      const route = createCapabilitiesRoute(() => current())
      const dispose = scoped.webServer.register(route)
      log('info', `capabilities 路由已挂载：${route.path}`)
      return function disposeRoutes() {
        try {
          dispose()
        } catch (_) {
          /* 静默 */
        }
      }
    } catch (error) {
      log('warn', 'capabilities 路由挂载失败（客户端将走内置默认动作集）：', error instanceof Error ? error.message : String(error))
      return undefined
    }
  })

  return function dispose() {
    // 路由与 namespace 的注销由各自动态注入的返回函数托管（fiber unload 级联）。
  }
}

module.exports = { inject: [], apply, SETTINGS_NAMESPACE }
