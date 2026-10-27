// 语言跟随验收：设置页切 English → 面板全英文单行；切回 中文 → 即时恢复
const { chromium } = require('playwright')

const URL = process.env.DSH_URL
const EXE = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

async function openSettings(page) {
  // 中英文界面下 aria-label 不同，两者都试
  const acct = page.locator('button[aria-label="账号菜单"], button[aria-label="Account menu"]').first()
  await acct.click()
  await page.waitForTimeout(500)
  await page.getByText(/^(设置|Settings)$/, { exact: true }).first().click()
  await page.waitForTimeout(900)
}

async function setLanguage(page, optionText) {
  // 语言行的下拉按钮：设置弹窗里文本为当前语言名的按钮（中文 / English）
  const btn = page.getByRole('button', { name: /^(中文|English)$/ }).first()
  await btn.click()
  await page.waitForTimeout(400)
  await page.getByText(optionText, { exact: true }).last().click()
  await page.waitForTimeout(900)
  return page.evaluate(() => document.documentElement.lang)
}

async function openPanel(page) {
  await page.keyboard.press('Escape') // 关设置
  await page.waitForTimeout(500)
  await page.locator('button.dmc-entry-btn').first().click()
  await page.waitForTimeout(900)
}

const panelState = (page) => page.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll('.dmc-tile'))
  const heights = tiles.map((t) => +t.getBoundingClientRect().height.toFixed(1))
  const entry = document.querySelector('button.dmc-entry-btn')
  return {
    entry: entry ? entry.getAttribute('aria-label') : null,
    subs: document.querySelectorAll('.dmc-tile-sub').length,
    heights,
    uniform: heights.length > 0 && Math.max(...heights) - Math.min(...heights) <= 0.5,
    actions: Array.from(document.querySelectorAll('[data-dmc-action] .dmc-tile-label')).map((n) => n.textContent),
    goal: (() => { const t = document.querySelector('[data-dmc-command="goal"] .dmc-tile-label'); return t ? t.textContent : null })(),
    hint: document.querySelector('.dmc-hint') ? document.querySelector('.dmc-hint').textContent : null,
  }
})

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: EXE })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(3500)

  // 恢复基线：上次运行可能遗留 English，先确保中文
  await openSettings(page)
  const curLangBtn = (await page.getByRole('button', { name: /^(中文|English)$/ }).first().textContent()) || ''
  if (/English/i.test(curLangBtn)) {
    await setLanguage(page, '中文')
  } else {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // 基线：中文
  await openPanel(page)
  const zh = await panelState(page)
  console.log('[zh]', JSON.stringify(zh))
  if (zh.entry !== '添加内容') throw new Error('中文入口文案不符: ' + zh.entry)
  if (zh.subs !== 0) throw new Error('中文下仍有第二行')
  if (!zh.uniform) throw new Error('中文下瓦片高度不一致: ' + JSON.stringify(zh.heights))
  if (zh.goal !== '目标') throw new Error('中文指令标签不符: ' + zh.goal)
  await page.screenshot({ path: 'tools/accept-lang-zh.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 切 English
  await openSettings(page)
  const lang1 = await setLanguage(page, 'English')
  console.log('[en] html lang =', lang1)
  if (!/^en/i.test(lang1)) throw new Error('切换 English 失败')

  await openPanel(page)
  const en = await panelState(page)
  console.log('[en]', JSON.stringify(en))
  if (en.entry !== 'Add content') throw new Error('英文入口文案不符: ' + en.entry)
  if (en.subs !== 0) throw new Error('英文下仍有第二行')
  if (!en.uniform) throw new Error('英文下瓦片高度不一致: ' + JSON.stringify(en.heights))
  if (!/^(Images)$/.test(en.actions[0]) || !/^(Files)$/.test(en.actions[1])) throw new Error('英文动作标签不符: ' + JSON.stringify(en.actions))
  if (!/^(Goal|goal)$/.test(en.goal || '')) throw new Error('英文指令标签不符: ' + en.goal)
  await page.screenshot({ path: 'tools/accept-lang-en.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 切回 中文（不刷新页面，验证 locale/change 即时生效）
  await openSettings(page)
  const lang2 = await setLanguage(page, '中文')
  console.log('[zh-restore] html lang =', lang2)
  if (!/^zh/i.test(lang2)) throw new Error('切回中文失败')

  await openPanel(page)
  const zh2 = await panelState(page)
  console.log('[zh-restore]', JSON.stringify(zh2))
  if (zh2.entry !== '添加内容') throw new Error('切回中文后入口文案未即时更新: ' + zh2.entry)
  if (zh2.goal !== '目标') throw new Error('切回中文后指令标签未即时更新: ' + zh2.goal)
  if (!zh2.uniform) throw new Error('切回中文后瓦片高度不一致')

  if (errs.length) throw new Error('页面异常：' + errs.join(' | '))
  await browser.close()
  console.log('LANG FOLLOW: ALL PASS')
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
