'use strict'

/**
 * dsh-mobile-compose 配置归一化：apply 对缺省配置宽容，不抛错。
 *
 *   - enabled：false 时装载但零路由、零行为（客户端拿到 404 后走内置默认）。
 *   - hideNativeButtons：隐藏输入框左下角原生的「添加文件」「调用指令」两个
 *     小按钮（由加号面板统一承载）。默认 true；关掉后原生按钮保留，面板作为
 *     额外入口并存。
 *   - actions：动作开关表，键为动作 id（pick-image / take-photo / pick-file /
 *     command），值为 true/false。宿主端只负责把开关透传给客户端做能力协商；
 *     客户端自身还有一层桌面端硬约束（桌面没有相机路由时 take-photo 自动禁用）。
 *   - hiddenCommands：从指令列表里剔除的指令名（与内置动作同义的指令，如
 *     /file —— 图片 / 文件 瓦片已覆盖）。数组或逗号/空白分隔字符串，默认
 *     ['file']；空数组/空串 = 全部展示。
 */

const DEFAULT_ACTIONS = {
  'pick-image': true,
  'take-photo': true,
  'pick-file': true,
  command: true,
}

const DEFAULT_HIDDEN_COMMANDS = ['file']

/** 指令名归一：去斜杠、小写、去空白；数组或逗号/空白分隔字符串均可。 */
function normalizeHiddenCommands(raw) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : null
  if (source === null) return null
  const out = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const name = item.trim().replace(/^\//, '').toLowerCase()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}

  const enabled = raw.enabled !== false

  const hideNativeButtons = raw.hideNativeButtons !== false

  const actionsSource = raw.actions && typeof raw.actions === 'object' ? raw.actions : {}
  const actions = {}
  for (const key of Object.keys(DEFAULT_ACTIONS)) {
    const v = actionsSource[key]
    actions[key] = typeof v === 'boolean' ? v : DEFAULT_ACTIONS[key]
  }

  // hiddenCommands：显式给出（含空串/空数组 = 全部展示）才生效；缺省或类型
  // 非法（非字符串/数组）回落默认集。
  const hiddenCommands = normalizeHiddenCommands(raw.hiddenCommands)
  const hasHiddenKey = raw !== null && typeof raw === 'object' && raw.hiddenCommands !== undefined

  return {
    enabled,
    hideNativeButtons,
    actions,
    hiddenCommands: hasHiddenKey && hiddenCommands !== null
      ? hiddenCommands
      : DEFAULT_HIDDEN_COMMANDS.slice(),
  }
}

/**
 * 设置页 section → 生效配置的合并：
 *   - `enabled` 只属于插件装载配置（base），设置页不暴露（改它要重装插件）；
 *   - `hideNativeButtons` / `actions` 以设置页 section 为准（用户层覆盖），
 *     section 缺字段时回落 base 值。
 * 宽容缺省：section 非对象 / 字段缺失都不抛错。
 */
function mergeSettingsSection(base, section) {
  const b = normalizeConfig(base)
  const raw = section && typeof section === 'object' ? section : {}
  return normalizeConfig({
    enabled: b.enabled,
    hideNativeButtons: typeof raw.hideNativeButtons === 'boolean' ? raw.hideNativeButtons : b.hideNativeButtons,
    actions: raw.actions && typeof raw.actions === 'object'
      ? { ...b.actions, ...raw.actions }
      : b.actions,
    hiddenCommands: raw.hiddenCommands !== undefined ? raw.hiddenCommands : b.hiddenCommands,
  })
}

module.exports = { normalizeConfig, mergeSettingsSection, normalizeHiddenCommands, DEFAULT_ACTIONS, DEFAULT_HIDDEN_COMMANDS }
