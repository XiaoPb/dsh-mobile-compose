'use strict'

/**
 * dsh-mobile-compose 设置页 namespace（`dsh-mobile-compose`）。
 *
 * 宿主端通过 ctx.settings.installSection(ctx, ns, schema, entry, hooks) 注册；
 * DSH 设置页（schema-form）按 schemastery schema 自动渲染表单 —— 客户端 UI
 * 零代码。用户在设置页的修改经 settings 服务落盘并触发 hooks.onChange，本插件
 * 把「当前生效值」作为 capabilities 路由的实时来源，客户端每次打开面板都重拉
 * capabilities，因此设置改动无需刷新页面即可生效。
 *
 * schemastery 缺失（异常安装）时 buildSettingsSchema 返回 null，宿主端跳过
 * namespace 注册，仅用插件装载配置 —— 全部路径宽容降级。
 */

let zCache
function getZ() {
  if (zCache !== undefined) return zCache
  try {
    // eslint-disable-next-line global-require
    zCache = require('@deepseek-ai/schemastery')
  } catch (_) {
    zCache = null
  }
  return zCache
}

/** 设置页 section 的形状（与插件配置的子集同形：不含 enabled）。 */
function buildSettingsSchema() {
  const z = getZ()
  if (!z || typeof z.object !== 'function') return null
  return z.object({
    hideNativeButtons: z.boolean().default(true),
    actions: z.object({
      'pick-image': z.boolean().default(true),
      'take-photo': z.boolean().default(true),
      'pick-file': z.boolean().default(true),
      command: z.boolean().default(true),
    }),
  })
}

module.exports = { buildSettingsSchema }
