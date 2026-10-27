'use strict'

/**
 * config 归一化测试：宽容缺省、类型纠偏、动作开关透传。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeConfig, mergeSettingsSection } = require('../lib/config')

test('normalizeConfig：全缺省给内置默认', () => {
  const cfg = normalizeConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.hideNativeButtons, true)
  assert.deepEqual(cfg.actions, {
    'pick-image': true,
    'take-photo': true,
    'pick-file': true,
    command: true,
  })
})

test('normalizeConfig：enabled=false 生效', () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ enabled: true }).enabled, true)
})

test('normalizeConfig：hideNativeButtons=false 保留原生按钮', () => {
  assert.equal(normalizeConfig({ hideNativeButtons: false }).hideNativeButtons, false)
})

test('normalizeConfig：actions 局部覆盖，其余保持默认', () => {
  const cfg = normalizeConfig({ actions: { 'take-photo': false, 'bogus-action': false } })
  assert.equal(cfg.actions['take-photo'], false)
  assert.equal(cfg.actions['pick-image'], true)
  assert.ok(!('bogus-action' in cfg.actions), '未知动作 id 不应混入动作表')
})

test('normalizeConfig：hiddenCommands 默认剔除 /file，支持数组与逗号分隔字符串', () => {
  assert.deepEqual(normalizeConfig().hiddenCommands, ['file'])
  assert.deepEqual(normalizeConfig({ hiddenCommands: '/file, model' }).hiddenCommands, ['file', 'model'])
  assert.deepEqual(normalizeConfig({ hiddenCommands: ['FILE', '/Compact'] }).hiddenCommands, ['file', 'compact'])
  assert.deepEqual(normalizeConfig({ hiddenCommands: '' }).hiddenCommands, [], '空串 = 全部展示')
  assert.deepEqual(normalizeConfig({ hiddenCommands: [] }).hiddenCommands, [], '空数组 = 全部展示')
  assert.deepEqual(normalizeConfig({ hiddenCommands: 42 }).hiddenCommands, ['file'], '非法类型回落默认')
})

test('normalizeConfig：非法输入不抛错（宽容缺省契约）', () => {
  assert.doesNotThrow(() => normalizeConfig(null))
  assert.doesNotThrow(() => normalizeConfig('string'))
  assert.doesNotThrow(() => normalizeConfig({ actions: 'not-an-object' }))
  assert.doesNotThrow(() => normalizeConfig({ actions: [1, 2] }))
})

test('mergeSettingsSection：section 字段覆盖 base，enabled 保留 base', () => {
  const base = normalizeConfig({ hideNativeButtons: true, actions: { 'pick-image': true } })
  const merged = mergeSettingsSection(base, { hideNativeButtons: false, actions: { 'pick-image': false } })
  assert.equal(merged.enabled, true, 'enabled 只属于插件装载配置')
  assert.equal(merged.hideNativeButtons, false)
  assert.equal(merged.actions['pick-image'], false)
  assert.equal(merged.actions['pick-file'], true, '未覆盖的动作回落 base')
})

test('mergeSettingsSection：section 缺失/畸形时整体回落 base', () => {
  const base = normalizeConfig({ hideNativeButtons: false })
  for (const section of [undefined, null, 'x', 42]) {
    const merged = mergeSettingsSection(base, section)
    assert.equal(merged.hideNativeButtons, false)
    assert.deepEqual(merged.actions, base.actions)
  }
})

test('mergeSettingsSection：hiddenCommands 覆盖 base（设置页字符串）', () => {
  const base = normalizeConfig({})
  const merged = mergeSettingsSection(base, { hiddenCommands: 'file, model' })
  assert.deepEqual(merged.hiddenCommands, ['file', 'model'])
  const cleared = mergeSettingsSection(base, { hiddenCommands: '' })
  assert.deepEqual(cleared.hiddenCommands, [], '设置页清空 = 全部展示')
  const fallback = mergeSettingsSection(base, {})
  assert.deepEqual(fallback.hiddenCommands, ['file'], 'section 缺失回落 base')
})

test('mergeSettingsSection：部分字段缺失逐字段回落', () => {
  const base = normalizeConfig({})
  const merged = mergeSettingsSection(base, { actions: { command: false } })
  assert.equal(merged.hideNativeButtons, true, 'hideNativeButtons 缺失回落 base')
  assert.equal(merged.actions.command, false)
  assert.equal(merged.actions['pick-image'], true)
})
