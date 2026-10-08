// Pulse 虚拟团队 · 红队对抗测试（专职把产出搞坏）
// "自己检查自己"容易共谋 —— 这里用**确定性攻击**打真浏览器：XSS、超长、连点、空提交、
// 极大值、键盘可达、窄屏溢出。打不穿才算过。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

const XSS = ['<img src=x onerror="window.__pwn=1">', '"><script>window.__pwn=1</script>', "'><svg onload=window.__pwn=1>"]

export async function redTeam(htmlPath) {
  const out = { ok: false, score: 100, attacks: [], issues: [], error: null }
  const attacks = []
  const add = (name, passed, detail, weight = 10) => {
    attacks.push({ name, passed, detail })
    if (!passed) out.score -= weight
  }
  let browser = null
  try {
    const src = fs.readFileSync(path.resolve(htmlPath), 'utf-8')
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 100)))
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + String(m.text()).slice(0, 90)) })
    await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(600)

    // ① XSS 注入：所有输入框塞攻击串并提交，看脚本是否被执行
    const inputs = await page.evaluate(() => document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea').length)
    if (inputs > 0) {
      const before = errs.length
      let fired = false
      for (const payload of XSS) {
        await page.evaluate((pl) => {
          document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea').forEach((el) => {
            el.focus(); el.value = pl
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          })
        }, payload)
        await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /提交|发送|保存|添加|确定|搜索|登录|注册|开始|计算|下单/.test(x.textContent || '')); if (b) b.click() })
        await page.waitForTimeout(220)
        fired = fired || (await page.evaluate(() => !!window.__pwn))
      }
      add('XSS 注入', !fired, fired ? '注入的脚本被执行了（可被 XSS）' : '三组攻击串均未执行', 20)
      add('XSS 后无崩溃', errs.length === before, errs.length > before ? '注入后报错：' + errs[before] : '未产生新报错', 8)
    } else add('XSS 注入', true, '页面无输入框，跳过', 0)

    // ② 超长输入 5000 字
    if (inputs > 0) {
      await page.evaluate(() => document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea').forEach((el) => { el.value = '超长'.repeat(2500); el.dispatchEvent(new Event('input', { bubbles: true })) }))
      await page.waitForTimeout(250)
      const ov = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 8)
      add('超长文本（5000 字）', !ov, ov ? '长文本把页面撑横向溢出了' : '未溢出', 10)
      const errOv = errs.filter((e) => /overflow|RangeError|Maximum/i.test(e))
      add('超长无异常', errOv.length === 0, errOv[0] || '正常', 6)
    }

    // ③ 连点 12 次（防重复提交）
    const before3 = errs.length
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /提交|发送|下单|添加|开始|确定/.test(x.textContent || '')); if (b) { for (let i = 0; i < 12; i++) b.click() } })
    await page.waitForTimeout(400)
    add('连续点击 12 次', errs.length === before3, errs.length > before3 ? '连点导致报错：' + errs[before3] : '无报错', 10)

    // ④ 空提交（应有校验提示而不是崩）
    const before4 = errs.length
    await page.evaluate(() => {
      document.querySelectorAll('input:not([type=checkbox]),textarea').forEach((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) })
      const b = [...document.querySelectorAll('button')].find((x) => /提交|发送|确定|保存|下单/.test(x.textContent || ''))
      if (b) b.click()
    })
    await page.waitForTimeout(300)
    add('空输入提交', errs.length === before4, errs.length > before4 ? '空提交报错：' + errs[before4] : '无报错', 8)

    // ⑤ 极端数值
    const before5 = errs.length
    await page.evaluate(() => {
      document.querySelectorAll('input[type=number],input[type=range]').forEach((el) => {
        for (const v of ['-1', '999999999', '0', '1e9']) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
      })
    })
    await page.waitForTimeout(250)
    add('极端数值（-1/1e9/0）', errs.length === before5, errs.length > before5 ? '极端值报错：' + errs[before5] : '无报错', 6)

    // ⑥ 键盘可达性
    const focusables = await page.evaluate(() => { let n = 0; for (let i = 0; i < 15; i++) { const el = document.activeElement; if (el && el !== document.body) n++ } return document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length })
    add('键盘可达元素 ≥3 个', focusables >= 3, `可聚焦元素 ${focusables} 个`, 6)

    // ⑦ 窄屏（390）不横向溢出
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await m.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
    await m.waitForTimeout(500)
    const mov = await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)
    add('390px 窄屏无横向溢出', !mov, mov ? '手机上横向溢出' : '正常', 10)
    await m.close()

    // ⑧ 危险模式（静态）
    const danger = []
    if (/eval\s*\(/.test(src)) danger.push('eval()')
    if (/document\.write\s*\(/.test(src)) danger.push('document.write()')
    if (/innerHTML\s*=\s*[`'"][^`'"]*\$\{/.test(src)) danger.push('innerHTML 拼接变量')
    if (/on\w+\s*=\s*["'][^"']*\$\{/.test(src)) danger.push('内联事件里插值')
    add('无危险模式', danger.length === 0, danger.length ? danger.join('、') : '未发现 eval/document.write/模板拼 innerHTML', 12)

    out.score = Math.max(0, Math.min(100, out.score))
    out.attacks = attacks
    out.issues = attacks.filter((a) => !a.passed).map((a) => ({ name: a.name, msg: a.detail }))
    out.ok = out.issues.length === 0
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 160)
  } finally { if (browser) await browser.close().catch(() => {}) }
  return out
}

// 生成"攻防记录"（确定性文本，不额外调模型）
export function redReportMarkdown(r, runId) {
  const lines = [
    `# 红队攻防记录 · ${runId}`,
    '',
    `> 由引擎对真实产出发起确定性攻击（不是自我评价）：**打不穿才算过**。`,
    '',
    `## 结论：${r.ok ? '全部攻击被挡住 ✅' : '被打穿 ' + r.issues.length + ' 处 ❌'} · 对抗分 ${r.score}/100`,
    '',
    '| 攻击 | 结果 | 说明 |',
    '|---|---|---|',
    ...r.attacks.map((a) => `| ${a.name} | ${a.passed ? '✅ 挡住' : '❌ 打穿'} | ${String(a.detail).replace(/\|/g, '/')} |`),
    '',
    '## 攻击清单（每次运行都跑）',
    '- XSS 注入（3 组 payload 写入全部输入框并提交）',
    '- 超长文本 5000 字（是否撑破布局 / 抛异常）',
    '- 连续点击 12 次（防重复提交）',
    '- 空输入提交（是否有校验而非崩）',
    '- 极端数值 -1 / 1e9 / 0',
    '- 键盘可达元素数量',
    '- 390px 窄屏横向溢出',
    '- 静态危险模式（eval / document.write / innerHTML 拼接）',
  ]
  return lines.join('\n')
}
