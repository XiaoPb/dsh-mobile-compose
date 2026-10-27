'use strict'

/**
 * 验收脚本共用的浏览器启动参数。
 *
 * 本机（Windows）默认用 Playwright 缓存里的 chrome-headless-shell：这里显式拼
 * 路径是因为该缓存目录不在标准位置时 Playwright 自带的查找会失败；路径不存在
 * 就返回 undefined，交回 Playwright 自己解析。
 *
 * CI（Linux）不需要特殊路径：装好 `npx playwright install chromium` 后直接让
 * Playwright 用自带浏览器即可。需要指定时用 DSH_CHROMIUM 覆盖。
 */

const fs = require('node:fs')
const path = require('node:path')

function chromiumExecutable() {
  if (process.env.DSH_CHROMIUM) return process.env.DSH_CHROMIUM
  const local = process.env.LOCALAPPDATA
  if (!local) return undefined
  const candidates = [
    path.join(local, 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join(local, 'ms-playwright', 'chromium-1200', 'chrome-win', 'chrome.exe'),
  ]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file
    } catch (_) { /* 忽略 */ }
  }
  return undefined
}

/** Chromium 启动选项：显式路径可用就用，否则交给 Playwright。 */
function launchOptions(extra) {
  const executablePath = chromiumExecutable()
  return { headless: true, ...(executablePath ? { executablePath } : {}), ...(extra || {}) }
}

module.exports = { chromiumExecutable, launchOptions }
