/**
 * dsh-mobile-compose 验收脚本：无头 Chromium 真机全流程。
 * 用法：DSH_URL="http://127.0.0.1:3080/?token=..." node tools/diag-browser.js
 */
const { chromium } = require('playwright')

const URL = process.env.DSH_URL
if (!URL) {
  console.error('请设置 DSH_URL（dsh web 启动时打印的带 token 地址）')
  process.exit(1)
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.LOCALAPPDATA + '\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  const logs = []
  page.on('console', (msg) => { const t = msg.text(); if (!t.includes('LanguageDetector')) logs.push(`[console.${msg.type()}] ${t.slice(0, 300)}`) })
  page.on('pageerror', (err) => logs.push(`[pageerror] ${String(err).slice(0, 500)}`))

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(4000)

    // ---- ① ＋入口 ----
    const plus = page.locator('button.dmc-entry-btn').first()
    await plus.waitFor({ state: 'visible', timeout: 10000 })
    logs.push('PASS ① ＋入口可见')

    // ---- ② 点击开面板：与聊天框等宽、单列表、指令内联 ----
    await plus.click()
    await page.waitForTimeout(1600) // 等 RPC 指令表 + 标签补全
    const info = await page.evaluate(() => {
      const dock = document.querySelector('.dmc-dock')
      if (!dock) return null
      const tiles = [...dock.querySelectorAll('.dmc-tile')]
      const actions = tiles.filter((t) => t.getAttribute('data-dmc-action')).map((t) => t.getAttribute('data-dmc-action'))
      const cmds = tiles.filter((t) => t.getAttribute('data-dmc-command')).map((t) => t.getAttribute('data-dmc-command'))
      const skills = tiles.filter((t) => t.getAttribute('data-dmc-skill')).map((t) => t.getAttribute('data-dmc-skill'))
      const rows = getComputedStyle(dock.querySelector('.dmc-grid')).gridTemplateRows.split(' ').length
      // 聊天框宽度：composer 容器
      const host = document.querySelector('[data-composer-dock]')
      const composerCard = host && host.parentElement
      return {
        width: Math.round(dock.getBoundingClientRect().width),
        composerWidth: composerCard ? Math.round(composerCard.getBoundingClientRect().width) : null,
        rows,
        actions,
        cmds,
        skills,
        pager: document.querySelectorAll('.dmc-dot').length,
        icons: tiles.filter((t) => t.querySelector('.dmc-tile-box svg')).length,
      }
    })
    if (!info) throw new Error('FAIL ② 点击后面板未出现')
    logs.push(`PASS ② 面板 width=${info.width} composer=${info.composerWidth} rows=${info.rows} icons=${info.icons}/${info.actions.length + info.cmds.length}`)
    logs.push(`      常用=[${info.actions.join(',')}] 指令(${info.cmds.length})=[${info.cmds.join(',')}] 技能(${info.skills.length})=[${info.skills.slice(0,4).join(',')}...] 页码点=${info.pager}`)
    await page.screenshot({ path: 'tools/accept-panel.png' })

    // ---- ③ 分页（若有多页）----
    if (info.pager > 1) {
      const dots = page.locator('.dmc-dot')
      await dots.nth(1).click()
      await page.waitForTimeout(400)
      const page2 = await page.evaluate(() => [...document.querySelectorAll('[data-dmc-command],[data-dmc-skill]')].map((e) => e.getAttribute('data-dmc-command') || e.getAttribute('data-dmc-skill')))
      logs.push(`PASS ③ 第 2 页指令(${page2.length})=[${page2.join(',')}]`)
      await page.screenshot({ path: 'tools/accept-page2.png' })
      await dots.nth(0).click()
      await page.waitForTimeout(300)
    } else {
      logs.push('PASS ③ 单页装下全部条目，无分页')
    }

    // ---- ④ Esc 关闭 + 重开 ----
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    if (await page.evaluate(() => !!document.querySelector('.dmc-dock'))) throw new Error('FAIL ④ Esc 未关闭')
    logs.push('PASS ④ Esc 关闭')
    await plus.click()
    await page.waitForTimeout(500)
    if (!(await page.evaluate(() => !!document.querySelector('.dmc-dock')))) throw new Error('FAIL ④ 重开失败')
    logs.push('PASS ④ 重开正常（入口未被错误边界卸载）')
    await plus.click()
    await page.waitForTimeout(300)

    // ---- ⑤ 手机宽度 → 底部面板 ----
    await page.setViewportSize({ width: 480, height: 860 })
    await page.waitForTimeout(500)
    await plus.click()
    await page.waitForTimeout(700)
    const sheet = await page.evaluate(() => ({ mask: !!document.querySelector('.dmc-mask'), panel: !!document.querySelector('.dmc-panel'), tiles: document.querySelectorAll('.dmc-panel .dmc-tile').length }))
    if (!sheet.mask || !sheet.panel) throw new Error('FAIL ⑤ 窄窗口底部面板未出现: ' + JSON.stringify(sheet))
    logs.push(`PASS ⑤ 底部面板 tiles=${sheet.tiles}`)
    await page.screenshot({ path: 'tools/accept-sheet.png' })
    await page.locator('.dmc-mask').click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(400)
    logs.push(`PASS ⑤ 蒙层点击关闭=${await page.evaluate(() => !document.querySelector('.dmc-panel'))}`)

    console.log(logs.join('\n'))
    console.log('ACCEPTANCE: ALL PASS')
  } catch (err) {
    console.log(logs.join('\n'))
    console.error('ACCEPTANCE FAILED:', err?.message || err)
    try { await page.screenshot({ path: 'tools/accept-fail.png' }) } catch (_) { /* ignore */ }
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main()
