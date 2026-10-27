/**
 * 一次性验证：① 指令瓦片中文标签；② /goal 只写草稿不发送（原生 claim 流程）；
 * ③ dock 面板独占一行（flex-wrap + order:-1，不与进度条挤兑）。
 */
const { chromium } = require('playwright')
const { launchOptions } = require('./lib/browser')

const URL = process.env.DSH_URL
if (!URL) { console.error('请设置 DSH_URL'); process.exit(1) }

async function main() {
  const browser = await chromium.launch(launchOptions())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const logs = []
  page.on('pageerror', (err) => logs.push(`[pageerror] ${String(err).slice(0, 300)}`))
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(4000)

  const plus = page.locator('button.dmc-entry-btn').first()
  await plus.waitFor({ state: 'visible', timeout: 10000 })
  await plus.click()
  await page.waitForTimeout(1800)

  // ① 中文标签 + 次行别名
  const labels = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-dmc-command]')].map((t) => ({
      name: t.getAttribute('data-dmc-command'),
      label: t.querySelector('.dmc-tile-label')?.textContent || '',
      sub: t.querySelector('.dmc-tile-sub')?.textContent || '',
    }))
  })
  console.log('指令瓦片标签：', JSON.stringify(labels, null, 0))

  // ③ dock 布局：容器允许换行、面板独占一行
  const layout = await page.evaluate(() => {
    const host = document.querySelector('[data-composer-dock]')
    const dock = document.querySelector('.dmc-dock')
    if (!host || !dock) return null
    const hs = getComputedStyle(host)
    const ds = getComputedStyle(dock)
    return {
      hostWrap: hs.flexWrap,
      dockOrder: ds.order,
      dockBasis: ds.flexBasis,
      dockTop: Math.round(dock.getBoundingClientRect().top),
      hostChildren: [...host.children].map((c) => ({
        cls: (c.className || '').toString().slice(0, 30),
        top: Math.round(c.getBoundingClientRect().top),
        width: Math.round(c.getBoundingClientRect().width),
      })),
    }
  })
  console.log('dock 布局：', JSON.stringify(layout))

  // ② 点 /goal → 只写草稿，不发送
  const goalTile = page.locator('[data-dmc-command="goal"]').first()
  const before = await page.evaluate(() => document.querySelectorAll('[data-message-id],article,[data-role="message"]').length)
  await goalTile.click()
  await page.waitForTimeout(600)
  const draftInfo = await page.evaluate(() => {
    const editor = document.querySelector('[data-composer-card] [contenteditable="true"], [role="textbox"]')
    return { draft: editor ? editor.textContent : null }
  })
  const after = await page.evaluate(() => document.querySelectorAll('[data-message-id],article,[data-role="message"]').length)
  console.log('点击 /goal 后草稿：', JSON.stringify(draftInfo.draft), '消息数 before/after =', before, '/', after)
  // 清理草稿，保持会话干净
  await page.evaluate(() => {
    const editor = document.querySelector('[data-composer-card] [contenteditable="true"], [role="textbox"]')
    if (editor) {
      editor.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('delete', false, null)
    }
  })
  if (logs.length) console.log('页面错误：', logs)
  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
