// Pulse 虚拟团队 · 真实浏览器测试（桌面 + 手机 + 点测冒烟）
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

export async function runWebTest(htmlPath, run) {
  const result = {
    ok: false,
    consoleErrors: [],
    clickIssues: [],
    clicked: 0,
    rendered: false,
    elems: 0,
    textLen: 0,
    title: '',
    shotRel: null,
    mobile: { ok: false, elems: 0, overflow: false, shotRel: null },
    reason: null,
  }
  let browser = null
  try {
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(String(m.text()).slice(0, 200)) })
    page.on('pageerror', (e) => result.consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)))
    const url = 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/')
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(1000)

    const info = await page.evaluate(() => ({
      title: document.title || '',
      elems: document.querySelectorAll('*').length,
      textLen: ((document.body && document.body.innerText) || '').trim().length,
      compat: document.compatMode,
      visible: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().width > 4 && e.getBoundingClientRect().height > 4).length,
    }))
    result.title = info.title
    result.elems = info.elems
    result.textLen = info.textLen
    result.compat = info.compat
    result.visible = info.visible
    result.rendered = info.elems > 40 && info.textLen > 120 && info.visible > 25

    // ---- 冒烟点测：真点前 8 个可用按钮，记录点击引发的报错
    try {
      const btnCount = await page.evaluate(() => document.querySelectorAll('button:not([disabled]), [role="button"]').length)
      const maxClick = Math.min(btnCount, 8)
      for (let i = 0; i < maxClick; i++) {
        const before = result.consoleErrors.length
        let label = ''
        try {
          label = await page.evaluate((idx) => {
            const els = document.querySelectorAll('button:not([disabled]), [role="button"]')
            const el = els[idx]
            if (!el) return ''
            const t = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16)
            el.click()
            return t
          }, i)
        } catch {}
        result.clicked++
        await page.waitForTimeout(160)
        if (result.consoleErrors.length > before) {
          result.clickIssues.push(`点击「${label || '按钮' + (i + 1)}」后出现报错`)
        }
      }
    } catch {}

    // 回到原始页面再截图（点测可能改变了页面状态）
    await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(run.dir, '测试证据.png') })
    result.shotRel = '测试证据.png'

    // ---- 手机尺寸检查（390×844）
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload({ waitUntil: 'load', timeout: 30000 })
      await page.waitForTimeout(800)
      const minfo = await page.evaluate(() => ({
        elems: document.querySelectorAll('*').length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 8,
      }))
      result.mobile.elems = minfo.elems
      result.mobile.overflow = minfo.overflow
      result.mobile.ok = !minfo.overflow && minfo.elems > 20
      await page.screenshot({ path: path.join(run.dir, '测试证据-手机.png') })
      result.mobile.shotRel = '测试证据-手机.png'
    } catch {}

    result.ok = result.rendered && result.consoleErrors.length === 0 && result.clickIssues.length === 0 && result.compat === 'CSS1Compat'
    if (result.compat && result.compat !== 'CSS1Compat') result.reason = '页面处于怪异模式（BackCompat）——文件开头有非 HTML 文本（模型输出带了说明文字或代码围栏），已按规范剥除'
    else if (result.consoleErrors.length) result.reason = `存在 ${result.consoleErrors.length} 个控制台错误：${result.consoleErrors.slice(0, 2).join('；')}`
    else if (result.clickIssues.length) result.reason = `点测发现 ${result.clickIssues.length} 个交互问题：${result.clickIssues.slice(0, 2).join('；')}`
    else if (!result.rendered) result.reason = `页面正文未渲染（${result.elems} 个元素、${result.textLen} 字符文本、可见元素 ${result.visible || 0}）——疑似 JS 启动即崩、或 HTML 引用与结构不一致`
  } catch (e) {
    result.reason = '测试执行失败：' + String(e.message || e).slice(0, 200)
    result.consoleErrors.push(result.reason)
  } finally {
    try { if (browser) await browser.close() } catch {}
  }
  return result
}
