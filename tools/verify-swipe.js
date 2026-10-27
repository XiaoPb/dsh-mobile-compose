// 临时验收：上滑 / 下滑手势翻页（真机 Chromium，CDP 真实触摸事件）
const { chromium } = require('playwright')

const URL = process.env.DSH_URL
const EXE = process.env.LOCALAPPDATA + '\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

async function swipe(cdp, x, y0, y1, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, radiusX: 8, radiusY: 8, force: 1 }] })
  for (let i = 1; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] })
    await new Promise((r) => setTimeout(r, 12))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function state(page) {
  return page.evaluate(() => {
    const dots = Array.from(document.querySelectorAll('.dmc-dot'))
    const active = dots.findIndex((d) => d.className.includes('dmc-active'))
    const sel = document.querySelector('.dmc-dock') || document.querySelector('.dmc-panel')
    return {
      present: !!sel,
      kind: document.querySelector('.dmc-dock') ? 'dock' : document.querySelector('.dmc-panel') ? 'sheet' : 'none',
      swipeClass: sel ? sel.className.includes('dmc-swipe') : false,
      dots: dots.length,
      active,
      scrollY: window.scrollY,
      first: (document.querySelector('[data-dmc-command]') || {}).getAttribute
        ? document.querySelector('[data-dmc-command]').getAttribute('data-dmc-command')
        : null,
      tiles: document.querySelectorAll('.dmc-tile').length,
    }
  })
}

async function run(name, viewport, mobile) {
  const browser = await chromium.launch({ headless: true, executablePath: EXE })
  const ctx = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(4000)

  await page.locator('button.dmc-entry-btn').first().click({ force: true })
  await page.waitForTimeout(900)
  const s0 = await state(page)
  if (!s0.present) throw new Error(`${name}: 面板未出现`)

  const box = await page.evaluate(() => {
    const el = document.querySelector('.dmc-dock') || document.querySelector('.dmc-panel')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom, h: r.height }
  })
  const cdp = await ctx.newCDPSession(page)
  const cx = Math.round(box.x)
  const y0 = Math.round(box.bottom - 24)
  const y1 = Math.round(box.top + 24)
  console.log(`${name} open: kind=${s0.kind} dots=${s0.dots} active=${s0.active} swipeClass=${s0.swipeClass} tiles=${s0.tiles} box.h=${box.h.toFixed(0)}`)

  // 上滑 → 下一页
  await swipe(cdp, cx, y0, y1)
  await page.waitForTimeout(400)
  const s1 = await state(page)
  console.log(`${name} 上滑: active=${s1.active} first=${s1.first} scrollY=${s1.scrollY}`)
  if (s0.dots > 1 && s1.dots > 1) {
    if (s1.active !== s0.active + 1) throw new Error(`${name}: 上滑未切到下一页 (${s0.active}→${s1.active})`)
  }
  if (s1.scrollY !== s0.scrollY) console.log(`  ! 页面被滚动了 ${s0.scrollY}→${s1.scrollY}`)

  // 下滑 → 上一页
  await swipe(cdp, cx, y1, y0)
  await page.waitForTimeout(400)
  const s2 = await state(page)
  console.log(`${name} 下滑: active=${s2.active} first=${s2.first}`)
  if (s2.active !== s0.active) throw new Error(`${name}: 下滑未回到上一页 (${s1.active}→${s2.active})`)

  // 左滑仍可用
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 80), y: Math.round((box.top + box.bottom) / 2) }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(box.x - 80), y: Math.round((box.top + box.bottom) / 2) }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(400)
  const s3 = await state(page)
  console.log(`${name} 左滑: active=${s3.active}`)
  if (s0.dots > 1 && s3.active !== s0.active + 1) throw new Error(`${name}: 左滑失效`)

  if (errs.length) throw new Error(`${name}: 页面异常 ${errs.join(' | ')}`)
  await browser.close()
  console.log(`${name}: PASS`)
}

async function main() {
  await run('[mobile 390x844]', { width: 390, height: 844 }, true)
  await run('[desktop 1280x900]', { width: 1280, height: 900 }, false)
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
