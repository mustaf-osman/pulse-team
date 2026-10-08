// Pulse 虚拟团队 · 设计审计（丑不丑，量出来）
// 提示词管不住审美，那就用真浏览器把"排版/一致性/可读性"变成数字 —— 分数 + 具体问题清单。
// 输出：{ score, grade, issues[{level,msg,fixable}], metrics }，供编排器决定"自动修 / 喂给编码重做 / 通过"。
import path from 'node:path'
import { createRequire } from 'node:module'
import { normalizeCss, injectUikit } from './uikit.js'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

// 在页面里量一批"审美指标"（全部可量化，不靠模型主观判断）
const MEASURE = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 3 && r.height > 3
  }
  const parseColor = (c) => {
    const s = String(c)
    let m = s.match(/^rgba?\(([^)]+)\)/)
    if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 } }
    m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] ? +m[4] : 1 }
    if (s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, a: 0 }
    return null
  }
  const lumC = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
  const ratio = (a, b) => { const l1 = Math.max(a, b) + 0.05, l2 = Math.min(a, b) + 0.05; return l1 / l2 }
  const vw = innerWidth
  // 阅读列宽：所有可见文本块的最小左边界 ↔ 最大右边界（"两边大空白"的真实指标）
  let minL = Infinity, maxR = -Infinity
  for (const el of document.body.querySelectorAll('p,li,td,h1,h2,h3,h4,label,span,button,a,div,blockquote')) {
    if (!vis(el)) continue
    const t = (el.innerText || '').trim()
    if (t.length < 2 || el.children.length) continue
    const r = el.getBoundingClientRect()
    if (r.width < 8) continue
    if (r.left < minL) minL = r.left
    if (r.right > maxR) maxR = r.right
  }
  const colW = maxR > minL ? maxR - minL : vw
  // 另一路参考：最宽的、含多个区块的容器
  let mainEl = document.body, best = 0
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el)) continue
    const r = el.getBoundingClientRect()
    if (el.querySelectorAll('section,article,div,ul,table').length >= 3 && r.width > best) { best = r.width; mainEl = el }
  }
  const sizes = {}, radii = {}, gaps = new Set()
  let hoverRules = 0, transitions = 0, shadows = 0, emojiIcons = 0, tappable = 0
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el)) continue
    const cs = getComputedStyle(el)
    if (((el.innerText || '').trim().length > 0)) sizes[cs.fontSize] = (sizes[cs.fontSize] || 0) + 1
    const br = parseFloat(cs.borderTopLeftRadius); if (br) radii[br] = (radii[br] || 0) + 1
    if (cs.gap && cs.gap !== 'normal') gaps.add(cs.gap)
    if (cs.transitionDuration && cs.transitionDuration !== '0s') transitions++
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows++
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || cs.cursor === 'pointer') tappable++
  }
  // CSS ↔ HTML 接线检查：模型常"写了一套样式，但类名和它生成的 HTML 对不上" → 样式全部落空，页面等于没上样式
  const htmlClasses = new Set()
  for (const el of document.body.querySelectorAll('*')) {
    if (el.classList) el.classList.forEach((c) => htmlClasses.add(c))
  }
  const cssClasses = new Set()
  const isEngineSheet = (sh) => { const n = sh.ownerNode; return !!n && (n.id === 'pt-uikit' || n.id === 'pt-fix') }
  for (const sh of document.styleSheets) {
    if (isEngineSheet(sh)) continue
    try {
      for (const r of sh.cssRules) {
        const sel = r.selectorText
        if (sel) {
          for (const m of sel.matchAll(/\.([a-zA-Z_][\w-]*)/g)) cssClasses.add(m[1])
          if (/:hover/.test(sel)) hoverRules++
        }
      }
    } catch {}
  }
  const missingClasses = [...cssClasses].filter((c) => !htmlClasses.has(c))
  const wiring = {
    cssClasses: cssClasses.size,
    matched: cssClasses.size - missingClasses.length,
    rate: cssClasses.size ? +((cssClasses.size - missingClasses.length) / cssClasses.size).toFixed(3) : 1,
    missing: missingClasses.slice(0, 12),
  }
  const EMO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u
  for (const el of document.body.querySelectorAll('button,span,i,label,li,td')) {
    const t = (el.textContent || '').trim()
    if (t && t.length <= 3 && EMO.test(t)) emojiIcons++
  }
  // 对比度：真实解析 rgba/srgb，逐级向上找第一个不透明背景；
  // 祖先链上有渐变/图片背景时无法判定 → 返回 null 跳过（避免把"白字+渐变 hero"误判成对比度 1:1）
  const solidBg = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null
      const c = parseColor(cs.backgroundColor)
      if (c && c.a > 0.06) return c
      n = n.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  let worst = 99, worstTag = ''
  for (const el of document.body.querySelectorAll('p,span,li,td,h1,h2,h3,a,label,div')) {
    const t = (el.innerText || '').trim()
    if (t.length < 8 || el.children.length) continue
    const cs = getComputedStyle(el)
    const fg = parseColor(cs.color); if (!fg || fg.a < 0.5) continue
    const bg = solidBg(el); if (!bg) continue
    const cr = ratio(lumC(fg), lumC(bg))
    if (cr < worst) { worst = cr; worstTag = el.tagName + '.' + String(el.className).slice(0, 18) }
  }
  return {
    vw, vh: innerHeight,
    column: { width: Math.round(colW), ratio: +(colW / vw).toFixed(3), left: Math.round(minL === Infinity ? 0 : minL), right: Math.round(maxR === -Infinity ? vw : maxR) },
    container: { width: Math.round(best), ratio: +(best / vw).toFixed(3), tag: mainEl.tagName + '.' + String(mainEl.className).slice(0, 24) },
    fontSizes: Object.entries(sizes).map(([k, v]) => [parseFloat(k), v]).sort((a, b) => b[0] - a[0]),
    radii: Object.entries(radii).map(([k, v]) => [parseFloat(k), v]),
    gaps: [...gaps],
    hoverRules, transitions, shadows, emojiIcons, tappable, wiring,
    textLen: ((document.body && document.body.innerText) || '').trim().length,
    overflowX: document.documentElement.scrollWidth > vw + 2,
    scrollW: document.documentElement.scrollWidth,
    pageH: Math.round(document.body.getBoundingClientRect().height),
    contrast: { worst: +worst.toFixed(2), tag: worstTag },
    fontFamily: getComputedStyle(document.body).fontFamily.slice(0, 80),
    hasViewportMeta: !!document.querySelector('meta[name=viewport]'),
  }
}

// 在页面里找出低对比度文字并算出"达标色"（向黑/白逼近到 ≥4.5:1）
const CONTRAST_FIX = (target = 4.6) => {
  const parse = (c) => {
    const m = String(c).match(/^rgba?\(([^)]+)\)/)
    if (m) { const p = m[1].split(',').map(Number); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 } }
    const s = String(c).match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
    if (s) return { r: +s[1] * 255, g: +s[2] * 255, b: +s[3] * 255, a: s[4] ? +s[4] : 1 }
    return null
  }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  const ratio = (a, b) => { const x = Math.max(a, b) + 0.05, y = Math.min(a, b) + 0.05; return x / y }
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  const out = [], seen = new Set()
  for (const el of document.body.querySelectorAll('p,span,li,td,a,label,div,h1,h2,h3,h4,strong,em')) {
    const t = (el.innerText || '').trim()
    if (t.length < 6 || el.children.length) continue
    const cs = getComputedStyle(el)
    const fg = parse(cs.color); if (!fg || fg.a < 0.5) continue
    let n = el, bg = null
    while (n && n !== document.documentElement) {
      const s = getComputedStyle(n)
      if (s.backgroundImage && s.backgroundImage !== 'none') { bg = null; break }
      const b = parse(s.backgroundColor)
      if (b && b.a > 0.6) { bg = b; break }
      n = n.parentElement
    }
    if (!bg) continue
    const cr = ratio(L(fg), L(bg))
    if (cr >= 4.5) continue
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : el.tagName.toLowerCase()
    if (seen.has(cls)) continue
    seen.add(cls)
    const toDark = L(bg) > 0.5
    let cand = null
    for (let k = 0; k <= 20; k++) {
      const p = k / 20
      const c = toDark
        ? { r: fg.r * (1 - p), g: fg.g * (1 - p), b: fg.b * (1 - p) }
        : { r: fg.r + (255 - fg.r) * p, g: fg.g + (255 - fg.g) * p, b: fg.b + (255 - fg.b) * p }
      if (ratio(L(c), L(bg)) >= target) { cand = c; break }
    }
    if (!cand) continue
    out.push({ sel: cls, from: cs.color, to: hex(cand), was: +cr.toFixed(2) })
    if (out.length >= 8) break
  }
  return out
}

export function scoreDesign(m) {
  const issues = []
  let score = 100
  // ⓪ 接线检查（最致命的一条）：CSS 描述的类在 HTML 里大都不存在 → 样式全落空，等于没上样式
  const w = m.wiring
  if (w && w.cssClasses > 25 && w.rate < 0.35) {
    score -= 26
    issues.push({ level: 'high', fixable: false, msg: `样式与结构对不上：CSS 里定义了 ${w.cssClasses} 个类，其中 ${w.cssClasses - w.matched} 个在页面里不存在（如 .${w.missing[0] || '?'}）——样式基本没命中，页面等于没上样式` })
  } else if (w && w.cssClasses > 25 && w.rate < 0.6) {
    score -= 10
    issues.push({ level: 'mid', fixable: false, msg: `CSS 类名命中率只有 ${(w.rate * 100).toFixed(0)}%，约 ${w.cssClasses - w.matched} 个样式规则没生效` })
  }
  // ① 版式宽度（桌面最痛的问题：内容挤成一根窄柱 + 两侧大空白）
  const col = m.column || m.container
  if (col.ratio < 0.62) { score -= 22; issues.push({ level: 'high', fixable: true, msg: `内容列只占视口 ${(col.ratio * 100).toFixed(0)}%（${col.width}px / ${m.vw}px）——桌面两侧大空白` }) }
  else if (col.ratio < 0.75) { score -= 8; issues.push({ level: 'mid', fixable: true, msg: `内容列占视口 ${(col.ratio * 100).toFixed(0)}%，略窄` }) }
  // ② 字号层级
  const fs = m.fontSizes.map((x) => x[0])
  if (fs.length < 4) { score -= 10; issues.push({ level: 'mid', fixable: false, msg: `只有 ${fs.length} 级字号，标题/正文/辅助层级不足` }) }
  else if (fs.length > 10) { score -= 8; issues.push({ level: 'low', fixable: true, msg: `${fs.length} 级字号过于零碎，层级不清晰` }) }
  // ③ 圆角一致性
  const rs = m.radii.filter((x) => x[0] < 900).map((x) => x[0])
  if (rs.length > 4) { score -= 8; issues.push({ level: 'low', fixable: true, msg: `圆角有 ${rs.length} 种取值（${rs.slice(0, 6).join('/')}），视觉不统一` }) }
  // ④ 对比度
  if (m.contrast.worst < 3) { score -= 16; issues.push({ level: 'high', fixable: false, msg: `最差文字对比度 ${m.contrast.worst}:1（${m.contrast.tag}），几乎读不清` }) }
  else if (m.contrast.worst < 4.5) { score -= 7; issues.push({ level: 'mid', fixable: false, msg: `最差文字对比度 ${m.contrast.worst}:1，低于 WCAG 4.5` }) }
  // ⑤ 交互反馈
  if (m.hoverRules < 3) { score -= 8; issues.push({ level: 'mid', fixable: true, msg: `只有 ${m.hoverRules} 条 hover 规则，点了没反馈` }) }
  if (m.transitions < 4) { score -= 6; issues.push({ level: 'low', fixable: true, msg: `只有 ${m.transitions} 个元素有过渡动效` }) }
  // ⑥ 质感层次
  if (m.shadows < 2) { score -= 5; issues.push({ level: 'low', fixable: false, msg: '几乎没有阴影层次，卡片是平的' }) }
  // ⑦ 内容密度（空壳感）
  if (m.textLen < 600) { score -= 14; issues.push({ level: 'high', fixable: false, msg: `正文只有 ${m.textLen} 字，像空壳` }) }
  else if (m.textLen < 1200) { score -= 6; issues.push({ level: 'mid', fixable: false, msg: `正文 ${m.textLen} 字，内容偏单薄` }) }
  if (m.pageH < m.vh * 1.2) { score -= 8; issues.push({ level: 'mid', fixable: false, msg: '整页高度还不到一屏半，缺少完整信息层级' }) }
  // ⑧ 硬伤
  if (m.overflowX) { score -= 12; issues.push({ level: 'high', fixable: true, msg: `页面横向溢出（scrollWidth ${m.scrollW} > ${m.vw}）` }) }
  if (m.emojiIcons > 0) { score -= 5; issues.push({ level: 'low', fixable: false, msg: `用 emoji 当图标 ${m.emojiIcons} 处，观感廉价` }) }
  if (!m.hasViewportMeta) { score -= 6; issues.push({ level: 'mid', fixable: true, msg: '缺 viewport meta，手机上会缩成一团' }) }
  if (!/PingFang|system-ui|YaHei|Segoe|Hiragino/i.test(m.fontFamily)) { score -= 6; issues.push({ level: 'mid', fixable: true, msg: '正文字体不是系统中文字体栈，中文渲染会很难看' }) }
  score = Math.max(0, Math.min(100, score))
  return { score, issues, grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'E' }
}

// 审计一个 HTML 文件；autoFix=true 时会先把修正版（uikit + 机械统一）落回文件再量
export async function designAudit(htmlPath, { autoFix = true, write = null } = {}) {
  const fs = require('node:fs')
  let applied = []
  if (autoFix) {
    try {
      const raw = fs.readFileSync(htmlPath, 'utf-8')
      const { html, notes } = injectUikit(raw)
      if (notes.length || html !== raw) { fs.writeFileSync(htmlPath, html); applied = notes }
    } catch {}
  }
  const out = { ok: false, score: 0, grade: 'E', issues: [], metrics: null, applied, error: null }
  let browser = null
  try {
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const url = 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/')
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(900)
    let m = await page.evaluate(MEASURE)
    // 低对比度文字 → 自动算达标的颜色并注入（引擎级修正，不靠模型自觉）
    if (autoFix && m.contrast.worst < 4.5) {
      try {
        // 深浅两个主题各算一遍，规则按主题作用域注入 —— 否则「加深字色」修好浅色、毁掉暗色
        const origTheme = await page.evaluate(() => { try { return document.documentElement.dataset.theme || '' } catch { return '' } })
        const scoped = []
        for (const th of ['dark', 'light']) {
          try { await page.evaluate((t) => { document.documentElement.dataset.theme = t }, th) } catch {}
          await page.waitForTimeout(160)
          const fx = await page.evaluate(CONTRAST_FIX)
          for (const f of fx) scoped.push({ th, sel: f.sel, to: f.to, was: f.was })
        }
        try { await page.evaluate((t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme }, origTheme) } catch {}
        if (scoped.length) {
          const css = '/* pt-fix：引擎自动修正的低对比度文字（按主题作用域，避免修好一个主题毁掉另一个）*/\n' +
            scoped.map((f) => `html[data-theme="${f.th}"] ${f.sel}{color:${f.to} !important} /* ${f.th} ${f.was}:1 → ≥4.5:1 */`).join('\n')
          await page.addStyleTag({ content: css })
          await page.waitForTimeout(200)
          m = await page.evaluate(MEASURE)
          let html = fs.readFileSync(htmlPath, 'utf-8')
          const tag = `<style id="pt-fix">\n${css}\n</style>`
          if (html.includes('id="pt-fix"')) html = html.replace(/<style id="pt-fix">[\s\S]*?<\/style>/i, () => tag)
          else html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tag + '\n</head>') : html + '\n' + tag
          fs.writeFileSync(htmlPath, html)
          applied = [...applied, ...scoped.map((f) => `对比度（${f.th}）${f.was}:1 → 达标（${f.sel}）`)]
        }
      } catch {}
    }
    const r = scoreDesign(m)
    out.ok = true; out.score = r.score; out.grade = r.grade; out.issues = r.issues; out.metrics = m
    if (typeof write === 'function') write(out)
  } catch (e) {
    out.error = String((e && e.message) || e)
  } finally { if (browser) await browser.close().catch(() => {}) }
  return out
}

// 把审计结论说成一句人话（进事件流 / 消息面板）
export function designLine(a) {
  if (!a || !a.ok) return `设计审计未完成${a && a.error ? '：' + a.error.slice(0, 60) : ''}`
  const highs = a.issues.filter((i) => i.level === 'high')
  const head = `设计审计 ${a.score} 分（${a.grade}）· 内容列占比 ${(((a.metrics.column || a.metrics.container).ratio) * 100).toFixed(0)}% · 字号 ${a.metrics.fontSizes.length} 级 · hover ${a.metrics.hoverRules} 条`
  if (!a.issues.length) return head + ' · 无问题 ✅'
  return head + ` · ${a.issues.length} 项待改${highs.length ? '（含 ' + highs.length + ' 项严重）' : ''}：` + a.issues.slice(0, 3).map((i) => i.msg).join('；')
}
