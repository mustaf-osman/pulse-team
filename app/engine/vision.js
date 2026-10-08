// Pulse 虚拟团队 · 视觉评审（给团队装"眼睛"）
// 团队以前只有"量"（DOM 断言），没有"看"。这里用 qwen-vl 真的看图，输出结构化批评，
// 再喂给编码角色返工 —— 对应人做设计时的"截图自检 → 改"。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'
const ENV_FILE = process.env.PT_ENV || 'G:/pulse-team/.env'
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODELS = ['qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct']

function readKey() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)\s*$/)
      if (m && m[1] === 'DASHSCOPE_API_KEY') return m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return process.env.DASHSCOPE_API_KEY || null
}

const REVIEW_PROMPT = `你是资深 UI/UX 评审。看这张网页截图，以"能不能交付给真实用户"为标准挑问题。
只输出 JSON，不要任何解释文字，格式：
{"score":0-100的整数,"verdict":"一句话总评(20字内)","issues":["具体问题1","具体问题2"],"highlights":["做得好的地方1"]}
挑问题按优先级：① 一眼看出是半成品/骨架/没上样式 ② 版式失衡(内容挤在中间窄柱/两侧大空白/元素重叠/错位) ③ 文字层级混乱或看不清 ④ 空白过多内容单薄 ⑤ 颜色脏、配色廉价 ⑥ 按钮/卡片等缺少层次。最多 6 条，每条不超过 30 字，必须具体(指出哪个区域)。`

function extractJson(s) {
  const t = String(s || '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch { return null }
}

// 截图（桌面 + 手机）→ 视觉评审
export async function visualReview(htmlPath, run, { timeoutMs = 90000 } = {}) {
  const out = { ok: false, score: null, verdict: '', issues: [], highlights: [], shots: [], model: null, error: null }
  let browser = null
  try {
    const abs = path.resolve(htmlPath)
    const dir = path.join(run.artifactsDir, 'prototype')
    fs.mkdirSync(dir, { recursive: true })
    const desktop = path.join(dir, '视觉评审-桌面.png')
    const mobile = path.join(dir, '视觉评审-手机.png')
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    for (const [w, h, file] of [[1440, 950, desktop], [390, 844, mobile]]) {
      const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
      await p.goto('file:///' + abs.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
      await p.waitForTimeout(900)
      await p.screenshot({ path: file })
      await p.close()
      out.shots.push(file)
    }
  } catch (e) { out.error = 'screenshot: ' + String((e && e.message) || e) }
  finally { if (browser) await browser.close().catch(() => {}) }
  if (!out.shots.length) return out

  const key = readKey()
  if (!key) { out.error = '缺少 DASHSCOPE_API_KEY（视觉评审跳过）'; return out }
  try {
    const OpenAI = require('openai')
    const client = new OpenAI({ apiKey: key, baseURL: BASE, timeout: timeoutMs })
    const b64 = fs.readFileSync(out.shots[0]).toString('base64')
    for (const model of MODELS) {
      try {
        const r = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
            { type: 'text', text: REVIEW_PROMPT },
          ] }],
          max_tokens: 900,
        })
        const j = extractJson(r.choices[0].message.content)
        if (j) {
          out.ok = true; out.model = model
          out.score = Number.isFinite(j.score) ? j.score : null
          out.verdict = String(j.verdict || '').slice(0, 60)
          out.issues = (Array.isArray(j.issues) ? j.issues : []).map((x) => String(x).slice(0, 120)).slice(0, 6)
          out.highlights = (Array.isArray(j.highlights) ? j.highlights : []).map((x) => String(x).slice(0, 80)).slice(0, 3)
          return out
        }
      } catch (e) { out.error = String((e && e.message) || e).slice(0, 160) }
    }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 160) }
  return out
}

export function visionLine(v) {
  if (!v || !v.ok) return `视觉评审未完成${v && v.error ? '：' + v.error.slice(0, 70) : ''}`
  const head = `视觉评审 ${v.score == null ? '—' : v.score} 分 · ${v.verdict || '（无总评）'}`
  if (!v.issues.length) return head + ' · 未发现明显问题 ✅'
  return head + ` · ${v.issues.length} 条意见：` + v.issues.slice(0, 2).join('；')
}
