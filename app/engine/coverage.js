// Pulse 虚拟团队 · 需求覆盖矩阵
// 产品最致命的缺陷不是"不好看"，而是"需求没做完"。团队写了 FR 清单，却从没人回头逐条对账。
// 这里把 PRD 里的功能点抽出来，逐条到真实页面里找落点，输出覆盖率 + 缺口清单。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

// 从需求文档里抽功能点：优先 FR-x / F1 / 1. 这类编号条目，其次"功能"小节下的列表
export function extractFRs(prdText) {
  const out = []
  const src = String(prdText || '')
  const lines = src.split(/\r?\n/)
  for (const raw of lines) {
    // 兼容 markdown 装饰：**FR-1：xxx** / - FR-1 xxx / | FR-1 | xxx | / ### 3.1 xxx
    let line = String(raw).trim()
    line = line.replace(/^[|>*#\-\s]+/, '').replace(/\|+$/, '').replace(/\*+/g, '').trim()
    if (line.length < 6 || line.length > 220) continue
    const m = line.match(/^(FR[-–—_\s]?\d+|功能\s*\d+|[A-Z]\d+|F\d+)[\s:：.、-]+(.{4,160})/)
    if (!m) continue
    const title = m[2].replace(/\*\*/g, '').replace(/[（(].{0,30}?[）)]/g, '').trim()
    if (!title || /^[\s\-—]+$/.test(title)) continue
    if (/^(需求|文档|说明|版本|日期|目录|概述|背景|范围|目标|验收)/.test(title)) continue
    out.push({ id: m[1].replace(/\s+/g, ''), title })
    if (out.length >= 24) break
  }
  return out
}

const tokens = (s) => {
  const zh = String(s).match(/[\u4e00-\u9fa5]{2,}/g) || []
  const bigrams = []
  for (const w of zh) for (let i = 0; i + 2 <= w.length; i++) bigrams.push(w.slice(i, i + 2))
  const en = (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  const stop = /^(功能|需求|页面|用户|系统|支持|可以|能够|以及|进行|实现|模块|中心|管理)$/
  return { all: [...new Set([...bigrams, ...en].filter((t) => !stop.test(t)))], first: (bigrams[0] || en[0] || '') }
}

// 逐条 FR 到页面里对账
export async function coverageAudit(htmlPath, prdText) {
  const frs = extractFRs(prdText)
  const out = { total: frs.length, covered: 0, rate: 1, missing: [], ok: true, error: null, frs: [] }
  if (!frs.length) { out.error = '没有从需求文档里抽到功能点'; return out }
  let browser = null
  try {
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(700)
    const hay = await page.evaluate(() => {
      const txt = (document.body && document.body.innerText) || ''
      const attrs = [...document.querySelectorAll('[placeholder],[aria-label],[title],[alt],[value]')]
        .map((e) => e.getAttribute('placeholder') + ' ' + e.getAttribute('aria-label') + ' ' + e.getAttribute('title') + ' ' + e.getAttribute('alt') + ' ' + e.getAttribute('value'))
        .join(' ')
      const ids = [...document.querySelectorAll('[id],[name]')].map((e) => e.id + ' ' + (e.getAttribute && e.getAttribute('name') || '')).join(' ')
      const script = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join(' ').slice(0, 40000)
      return (txt + ' ' + attrs + ' ' + ids + ' ' + script).toLowerCase()
    })
    for (const fr of frs) {
      const tk = tokens(fr.title)
      if (!tk.all.length) { out.covered++; continue }
      // 中文标题第一个词就是主题词（如"搜索功能"→搜索）：主题词不在页面里，基本就是没做
      const firstHit = tk.first ? hay.includes(tk.first.toLowerCase()) : true
      const hit = tk.all.filter((t) => hay.includes(t.toLowerCase())).length
      const rate = hit / tk.all.length
      const covered = firstHit && rate >= 0.34
      out.frs.push({ id: fr.id, title: fr.title.slice(0, 40), hit, total: tk.all.length, rate: +rate.toFixed(2), firstHit, covered })
      if (covered) out.covered++
      else out.missing.push(`${fr.id} ${fr.title.slice(0, 34)}`)
    }
    out.rate = +(out.covered / frs.length).toFixed(2)
    out.ok = out.rate >= 0.8
    out.missing = out.missing.slice(0, 8)
    out.hayLen = hay.length
    out.sample = hay.slice(0, 120)
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 160)
  } finally { if (browser) await browser.close().catch(() => {}) }
  return out
}

export function coverageLine(c) {
  if (!c || c.error) return `需求覆盖对账未完成${c && c.error ? '：' + c.error.slice(0, 60) : ''}`
  if (!c.total) return '需求覆盖对账：需求文档里没有可对账的编号条目'
  const head = `需求覆盖 ${c.covered}/${c.total}（${(c.rate * 100).toFixed(0)}%）`
  if (!c.missing.length) return head + ' · 每条功能都有落点 ✅'
  return head + ` · 缺口：${c.missing.slice(0, 3).join('；')}`
}
