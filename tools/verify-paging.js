// 换页交互验收：移动端左右滑 / 桌面端滚轮（真机 Chromium）
const { chromium } = require('playwright')

const URL = process.env.DSH_URL
const EXE = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

async function drag(cdp, x0, y0, x1, y1, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }],
    })
    await new Promise((r) => setTimeout(r, 12))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const read = (page) => page.evaluate(() => {
  const sel = document.querySelector('.dmc-dock') || document.querySelector('.dmc-panel')
  const dots = Array.from(document.querySelectorAll('.dmc-dot'))
  return {
    kind: document.querySelector('.dmc-dock') ? 'dock' : document.querySelector('.dmc-panel') ? 'sheet' : 'none',
    dots: dots.length,
    active: dots.findIndex((d) => d.className.includes('dmc-active')),
    swipeClass: !!sel && sel.className.includes('dmc-swipe'),
    scrollY: Math.round(window.scrollY),
    first: (() => {
      const t = document.querySelector('.dmc-tile')
      return t ? (t.getAttribute('data-dmc-command') || t.getAttribute('data-dmc-skill') || t.getAttribute('data-dmc-action')) : null
    })(),
  }
})

async function openPanel(page) {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(4000)
  await page.locator('button.dmc-entry-btn').first().click({ force: true })
  await page.waitForTimeout(900)
}

async function mobile(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
  await openPanel(page)
  const s0 = await read(page)
  if (s0.kind !== 'dock') throw new Error(`移动端期望 dock 形态（与桌面一致），实为 ${s0.kind}`)
  const box = await page.evaluate(() => {
    const r = document.querySelector('.dmc-dock').getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })
  const cdp = await ctx.newCDPSession(page)
  console.log(`[mobile] open active=${s0.active}/${s0.dots} swipeClass=${s0.swipeClass}`)

  // 左滑 → 下一页
  await drag(cdp, box.cx + 90, box.cy, box.cx - 90, box.cy + 4)
  await page.waitForTimeout(350)
  const s1 = await read(page)
  console.log(`[mobile] 左滑 active=${s1.active} first=${s1.first}`)
  if (s1.active !== s0.active + 1) throw new Error(`左滑未翻页 ${s0.active}→${s1.active}`)

  // 右滑 → 上一页
  await drag(cdp, box.cx - 90, box.cy, box.cx + 90, box.cy - 4)
  await page.waitForTimeout(350)
  const s2 = await read(page)
  console.log(`[mobile] 右滑 active=${s2.active}`)
  if (s2.active !== s0.active) throw new Error(`右滑未回退 ${s1.active}→${s2.active}`)

  // 纵向滑动：不翻页（交还页面滚动）
  await drag(cdp, box.cx, box.cy + 60, box.cx + 4, box.cy - 60)
  await page.waitForTimeout(350)
  const s3 = await read(page)
  console.log(`[mobile] 纵向滑动 active=${s3.active} scrollY=${s2.scrollY}→${s3.scrollY}`)
  if (s3.active !== s2.active) throw new Error('纵向滑动不应翻页')

  if (errs.length) throw new Error(`移动端页面异常：${errs.join(' | ')}`)
  await ctx.close()
  console.log('[mobile] PASS')
}

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
  await openPanel(page)
  const s0 = await read(page)
  if (s0.kind !== 'dock') throw new Error(`桌面端期望 dock 形态，实为 ${s0.kind}`)
  const box = await page.evaluate(() => {
    const r = document.querySelector('.dmc-dock').getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })
  console.log(`[desktop] open active=${s0.active}/${s0.dots} scrollY=${s0.scrollY}`)
  await page.mouse.move(box.cx, box.cy)

  // 滚轮向下 → 下一页
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(400)
  const s1 = await read(page)
  console.log(`[desktop] 滚轮向下 active=${s1.active} first=${s1.first} scrollY=${s1.scrollY}`)
  if (s1.active !== s0.active + 1) throw new Error(`滚轮向下未翻页 ${s0.active}→${s1.active}`)
  if (s1.scrollY !== s0.scrollY) throw new Error(`滚轮翻页时页面被滚动 ${s0.scrollY}→${s1.scrollY}`)

  // 滚轮向上 → 上一页
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(400)
  const s2 = await read(page)
  console.log(`[desktop] 滚轮向上 active=${s2.active}`)
  if (s2.active !== s0.active) throw new Error(`滚轮向上未回退 ${s1.active}→${s2.active}`)

  // 触控板横向滚动（deltaX）同样翻页
  await page.mouse.wheel(120, 0)
  await page.waitForTimeout(400)
  const s3 = await read(page)
  console.log(`[desktop] 横向滚轮 active=${s3.active}`)
  if (s3.active !== s0.active + 1) throw new Error('横向滚轮未翻页')

  if (errs.length) throw new Error(`桌面端页面异常：${errs.join(' | ')}`)
  await ctx.close()
  console.log('[desktop] PASS')
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: EXE })
  await mobile(browser)
  await desktop(browser)
  await browser.close()
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
