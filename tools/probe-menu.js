/** 探测 0.2.1 原生指令菜单的真实 DOM 结构（程序化点击，绕过可见性检查）。 */
const { chromium } = require('playwright')
const URL = process.env.DSH_URL || 'http://127.0.0.1:3080/?token=Gs2-5f2IydDQY0hUT95ivSCb_6J2lQi9sahuLgAw8YI'

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.LOCALAPPDATA + '\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(4000)

  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-haspopup="listbox"]')
    if (!btn) throw new Error('native button missing')
    btn.click()
  })

  // 轮询等浮层出现
  let dumped = null
  for (let i = 0; i < 20 && !dumped; i++) {
    await page.waitForTimeout(100)
    dumped = await page.evaluate(() => {
      // 找含「压缩」文本的浅层元素，向上找到浮层根
      const walker = [...document.querySelectorAll('div,ul,ol,section')]
      for (const el of walker) {
        const t = el.textContent || ''
        if (/compact|压缩/.test(t) && t.length < 600 && el.querySelectorAll('button,[role]').length >= 3) {
          const roles = [...el.querySelectorAll('[role]')].slice(0, 12).map((n) => `${n.tagName.toLowerCase()}[${n.getAttribute('role')}]${(n.textContent || '').trim().slice(0, 14)}`)
          const btns = [...el.querySelectorAll('button')].slice(0, 12).map((n) => `${n.tagName.toLowerCase()}${n.getAttribute('role') ? `[${n.getAttribute('role')}]` : ''} cls=${(n.className || '').toString().slice(0, 30)} text=${(n.textContent || '').trim().slice(0, 12)}`)
          let chain = ''
          let p = el
          for (let k = 0; k < 6 && p && p !== document.body; k++) { chain += ` <${p.tagName.toLowerCase()} role=${p.getAttribute('role')} cls=${(p.className || '').toString().slice(0, 36)}>`; p = p.parentElement }
          return { hostCls: (el.className || '').toString().slice(0, 60), roles, btns, chain }
        }
      }
      return null
    })
  }
  console.log(dumped ? JSON.stringify(dumped, null, 1) : 'POPUP NOT FOUND after 2s')
  // 收尾：关掉菜单
  await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  await browser.close()
}
main().catch((e) => { console.error('PROBE FAILED', e?.message || e); process.exit(1) })
