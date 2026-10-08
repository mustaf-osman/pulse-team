// Pulse 虚拟团队 · 代码/内容/安全/性能体检（quality）
// 代码质量 = 交付物能不能被别人接手；产品质量 = 用户用起来会不会翻车。
// 全部确定性检查：源码扫描 + 真浏览器运行时测量 + 一次真实交互压力测试。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

const PLACEHOLDER = /(这里放|这里写|此处放|待补充|待完善|示例文本|占位符|请填写|lorem\s*ipsum|(?<![a-z])todo(?![a-z])|(?<![a-z])fixme(?![a-z])|undefined|NaN|\[object Object\])/i

export async function qualityAudit(htmlPath) {
  const out = { ok: false, score: 0, grade: 'E', issues: [], metrics: null, error: null }
  let browser = null
  try {
    const src = fs.readFileSync(path.resolve(htmlPath), 'utf-8')
    const sizeKB = +(Buffer.byteLength(src) / 1024).toFixed(1)
    const placeholders = [...new Set((src.match(PLACEHOLDER) || []).map(String))].slice(0, 5)
    // 安全扫描（生成物常见坑）
    const sec = []
    if (/innerHTML\s*=\s*[`'"][^`'"]*\$\{/.test(src)) sec.push('innerHTML 直接拼接变量（XSS 风险）')
    if (/\beval\s*\(/.test(src)) sec.push('使用了 eval()')
    if (/new\s+Function\s*\(/.test(src)) sec.push('使用了 new Function()')
    if (/document\.write\s*\(/.test(src)) sec.push('使用了 document.write()')
    const ext = [...new Set((src.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || []))].slice(0, 4)
    if (ext.length) sec.push(`引用了外部资源 ${ext.length} 处（应零依赖）：${ext[0].slice(0, 60)}`)
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + String(m.text()).slice(0, 100)) })
    const t0 = Date.now()
    await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
    const loadMs = Date.now() - t0
    await page.waitForTimeout(600)
    const m = await page.evaluate(() => {
      const inter = [...document.querySelectorAll('button,a[href],input,select,textarea,[role=button]')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4
      })
      const smallTaps = inter.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 36 || r.width < 36 }).length
      const smallInputs = [...document.querySelectorAll('input,textarea,select')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length
      const noTypeBtns = [...document.querySelectorAll('button')].filter((b) => !b.getAttribute('type')).length
      const placeholdersInText = (document.body.innerText || '').match(/这里放|待补充|示例文本|lorem ipsum|TODO|undefined|NaN/g)
      return {
        dom: document.querySelectorAll('*').length,
        textLen: (document.body.innerText || '').trim().length,
        interactive: inter.length,
        smallTaps, smallInputs, noTypeBtns,
        dupIds: (() => { const seen = {}, dup = []; for (const e of document.querySelectorAll('[id]')) { if (seen[e.id]) dup.push(e.id); seen[e.id] = 1 } return dup.slice(0, 5) })(),
        visiblePlaceholder: placeholdersInText ? [...new Set(placeholdersInText)].slice(0, 4) : [],
        longTasks: 0, bodyOverflowX: document.documentElement.scrollWidth > innerWidth + 2,
        imgNoAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
        empties: [...document.querySelectorAll('input,textarea')].filter((e) => e.required && !e.value).length,
      }
    })
    // 真实交互压力：往第一个输入框灌 300 字 + 特殊字符，点主按钮，看会不会翻车
    let stress = { ok: true, note: '' }
    try {
      const hasInput = await page.evaluate(() => !!document.querySelector('input,textarea'))
      if (hasInput) {
        const before = errs.length
        await page.evaluate(() => {
          const el = document.querySelector('input:not([type=hidden]),textarea')
          if (!el) return
          el.focus()
          el.value = '压力测试'.repeat(40) + ' <script>alert(1)</script> & "quote" 100%'
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await page.waitForTimeout(250)
        const overflowed = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 8)
        const btn = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /提交|确定|添加|保存|计算|开始|发送|下单|搜索|登录|注册/.test(x.textContent || ''))
          return b ? true : false
        })
        if (btn) { await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /提交|确定|添加|保存|计算|开始|发送|下单|搜索|登录|注册/.test(x.textContent || '')); if (b) b.click() }); await page.waitForTimeout(300) }
        if (errs.length > before) stress = { ok: false, note: '长文本/特殊字符输入或点击后报错：' + errs[before] }
        else if (overflowed) stress = { ok: false, note: '长文本输入后页面横向溢出（未做长文本兜底）' }
      }
    } catch (e) { stress = { ok: false, note: '交互压力测试失败：' + String((e && e.message) || e).slice(0, 80) } }

    const issues = []
    let score = 100
    const visPh = [...new Set([...placeholders, ...m.visiblePlaceholder])]
    if (visPh.length) { score -= 10; issues.push({ level: 'high', msg: `页面残留占位词/未完成标记：${visPh.slice(0, 3).join('、')}` }) }
    for (const s of sec) { score -= 8; issues.push({ level: 'high', msg: '安全：' + s }) }
    if (errs.length) { score -= 12; issues.push({ level: 'high', msg: `运行时报错 ${errs.length} 条：${errs[0]}` }) }
    if (!stress.ok) { score -= 10; issues.push({ level: 'high', msg: '健壮性：' + stress.note }) }
    if (m.dupIds.length) { score -= 6; issues.push({ level: 'mid', msg: `重复 id：${m.dupIds.join(', ')}` }) }
    if (m.smallInputs > 0) { score -= 5; issues.push({ level: 'mid', msg: `${m.smallInputs} 个输入框字号 <16px（手机上聚焦会缩放）` }) }
    if (m.smallTaps > 0) { score -= 5; issues.push({ level: 'mid', msg: `${m.smallTaps} 个可点元素小于 36px（手指点不准）` }) }
    if (m.noTypeBtns > 0) { score -= 4; issues.push({ level: 'low', msg: `${m.noTypeBtns} 个 <button> 没写 type（表单里会误提交）` }) }
    if (m.imgNoAlt > 0) { score -= 4; issues.push({ level: 'low', msg: `${m.imgNoAlt} 张图片没有 alt` }) }
    if (m.interactive < 3) { score -= 10; issues.push({ level: 'high', msg: `可交互元素只有 ${m.interactive} 个，页面像静态图` }) }
    if (m.dom > 1600) { score -= 5; issues.push({ level: 'low', msg: `DOM 节点 ${m.dom} 个（>1600 偏重）` }) }
    if (loadMs > 1500) { score -= 5; issues.push({ level: 'low', msg: `首屏加载 ${loadMs}ms 偏慢` }) }
    if (sizeKB > 400) { score -= 4; issues.push({ level: 'low', msg: `单文件 ${sizeKB}KB 偏大` }) }
    if (m.textLen < 500) { score -= 10; issues.push({ level: 'high', msg: `正文只有 ${m.textLen} 字，内容太薄` }) }
    score = Math.max(0, Math.min(100, score))
    out.ok = score >= 70 && errs.length === 0
    out.score = score
    out.grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'E'
    out.issues = issues
    out.metrics = { sizeKB, dom: m.dom, loadMs, interactive: m.interactive, textLen: m.textLen, smallTaps: m.smallTaps, smallInputs: m.smallInputs, errs: errs.slice(0, 4), stress: stress.note || 'ok', dupIds: m.dupIds, sec }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 160) }
  finally { if (browser) await browser.close().catch(() => {}) }
  return out
}

export function qualityLine(q) {
  if (!q || q.error) return `质量体检未完成${q && q.error ? '：' + q.error.slice(0, 60) : ''}`
  const m = q.metrics || {}
  const head = `质量体检 ${q.score} 分（${q.grade}）· 单文件 ${m.sizeKB}KB · 加载 ${m.loadMs}ms · 可交互 ${m.interactive} 个 · 正文 ${m.textLen} 字`
  if (!q.issues.length) return head + ' · 无问题 ✅'
  return head + ` · ${q.issues.length} 项：` + q.issues.slice(0, 3).map((i) => i.msg).join('；')
}
