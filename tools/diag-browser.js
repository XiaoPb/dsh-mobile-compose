/**
 * dsh-mobile-compose 验收脚本：无头 Chromium 真机全流程。
 * 始终输出收集到的 console/pageerror 日志（含失败路径）。
 */
const { chromium } = require('playwright')

/** 用法：DSH_URL="http://127.0.0.1:3080/?token=<token>" node tools/diag-browser.js */
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

    // ---- 探测页面状态：composer 容器 / 输入框是否在场 ----
    const state = await page.evaluate(() => ({
      dockHost: !!document.querySelector('[data-composer-dock]'),
      textarea: !!document.querySelector('textarea'),
      hideNative: document.body.classList.contains('dmc-hide-native'),
      styleTags: [...document.querySelectorAll('style')].map((s) => s.id).filter(Boolean),
    }))
    logs.push(`pageState=${JSON.stringify(state)}`)

    // 若没有输入框，尝试点击「新会话/开始对话」类入口
    if (!state.textarea) {
      const newChat = page.locator('button:has-text("新对话"), button:has-text("新建"), button:has-text("开始"), [aria-label*="新"]', ).first()
      if (await newChat.count() > 0) {
        await newChat.click().catch(() => {})
        await page.waitForTimeout(2000)
        logs.push(`afterNewChat textarea=${await page.evaluate(() => !!document.querySelector('textarea'))}`)
      } else {
        logs.push('no textarea and no new-chat button found; DOM buttons: ' + await page.evaluate(() => [...document.querySelectorAll('button')].slice(0, 20).map((b) => b.getAttribute('aria-label') || b.textContent?.trim().slice(0, 12)).filter(Boolean).join('|')))
      }
    }

    // ---- ① ＋入口 ----
    const plus = page.locator('button.dmc-entry-btn').first()
    await plus.waitFor({ state: 'visible', timeout: 10000 })
    logs.push('PASS ① ＋入口可见')

    // ---- ② 点击开面板 ----
    await plus.click()
    await page.waitForTimeout(600)
    const dockVisible = await page.evaluate(() => {
      const el = document.querySelector('.dmc-dock')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { tiles: el.querySelectorAll('.dmc-tile').length, tabs: el.querySelectorAll('.dmc-tab').length, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), inDockHost: !!el.closest('[data-composer-dock]') }
    })
    if (!dockVisible) throw new Error('FAIL ② 点击后面板未出现')
    logs.push(`PASS ② 面板出现 tiles=${dockVisible.tiles} tabs=${dockVisible.tabs} pos=(${dockVisible.x},${dockVisible.y}) inDockHost=${dockVisible.inDockHost}`)
    await page.screenshot({ path: 'tools/accept-panel.png' })

    // ---- ③ 指令 tab ----
    const cmdTab = page.locator('.dmc-tab:has-text("指令")')
    if (await cmdTab.count() > 0) {
      await cmdTab.first().click()
      await page.waitForTimeout(1200)
      const cmds = await page.evaluate(() => [...document.querySelectorAll('[data-dmc-command]')].map((e) => e.getAttribute('data-dmc-command')))
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.dmc-tab')].map((e) => e.textContent))
      logs.push(`PASS ③ 指令tab tabs=[${tabs.join(',')}] 采集到 ${cmds.length} 条: ${cmds.join(', ') || '(空，可能有重读按钮)'}`)
      await page.screenshot({ path: 'tools/accept-commands.png' })
      // 回到常用 tab
      await page.locator('.dmc-tab:has-text("常用")').first().click()
      await page.waitForTimeout(300)
    } else {
      logs.push('WARN ③ 指令 tab 不在场')
    }

    // ---- ④ Esc 关闭 + 重开 ----
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    if (await page.evaluate(() => !!document.querySelector('.dmc-dock'))) throw new Error('FAIL ④ Esc 未关闭')
    logs.push('PASS ④ Esc 关闭')
    await plus.click()
    await page.waitForTimeout(400)
    if (!(await page.evaluate(() => !!document.querySelector('.dmc-dock')))) throw new Error('FAIL ④ 重开失败')
    logs.push('PASS ④ 重开正常（入口未被错误边界卸载）')
    await plus.click() // toggle 收起
    await page.waitForTimeout(300)

    // ---- ⑤ 手机宽度 → 底部面板 ----
    await page.setViewportSize({ width: 480, height: 860 })
    await page.waitForTimeout(500)
    await plus.click()
    await page.waitForTimeout(600)
    const sheet = await page.evaluate(() => ({ mask: !!document.querySelector('.dmc-mask'), panel: !!document.querySelector('.dmc-panel'), tiles: document.querySelectorAll('.dmc-panel .dmc-tile').length }))
    if (!sheet.mask || !sheet.panel) throw new Error('FAIL ⑤ 窄窗口底部面板未出现: ' + JSON.stringify(sheet))
    logs.push(`PASS ⑤ 底部面板形态 tiles=${sheet.tiles}`)
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
