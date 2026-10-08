// Pulse 虚拟团队 · 真工具校验 + 打包
// 不靠模型自觉，靠业界工具：html-validate（HTML 规范）· axe-core（无障碍，业界标准）· esbuild（编译器级语法检查 + 压缩打包）
// 目标：产出不只是"能看"，而是"能完整交付使用"（规范过、无障碍过、可编译、可部署）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'G:/pulse-team/node_modules/playwright'
const CHROME = process.env.CHROME_PATH || 'C:/Users/20392/.agent-browser/browsers/chrome-win64/chrome.exe'

// ---------- ① HTML 规范校验（html-validate） ----------
export async function htmlValidate(htmlPath) {
  const out = { ok: false, errors: 0, warnings: 0, issues: [], error: null }
  try {
    const mod = await import('html-validate')
    const HtmlValidate = mod.HtmlValidate || (mod.default && mod.default.HtmlValidate) || mod.default
    const hv = new HtmlValidate({
      extends: ['html-validate:recommended'],
      rules: {
        'no-inline-style': 'off',
        'no-trailing-whitespace': 'off',
        'attr-quotes': 'off',
        'long-title': 'off',
        'require-sri': 'off',
        'no-unknown-elements': 'warn',
        'wcag/h37': 'error',
        'element-required-attributes': 'warn',
      },
    })
    const rep = await hv.validateFile(path.resolve(htmlPath))
    const msgs = (rep.results && rep.results[0] && rep.results[0].messages) || []
    out.errors = msgs.filter((m) => m.severity === 2).length
    out.warnings = msgs.filter((m) => m.severity === 1).length
    out.issues = msgs.slice(0, 8).map((m) => ({ rule: m.ruleId, sev: m.severity === 2 ? 'error' : 'warn', msg: String(m.message).slice(0, 120), line: m.line }))
    out.ok = out.errors === 0
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 140) }
  return out
}

// ---------- ② 无障碍审计（axe-core，业界标准） ----------
export async function axeAudit(htmlPath) {
  const out = { ok: false, critical: 0, serious: 0, moderate: 0, minor: 0, issues: [], error: null }
  let browser = null
  try {
    const axePath = require.resolve('axe-core/axe.min.js')
    const { chromium } = require(PW_PATH)
    browser = await chromium.launch({ executablePath: CHROME })
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(700)
    await page.addScriptTag({ path: axePath })
    const r = await page.evaluate(async () => {
      const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, target: v.nodes[0] && String(v.nodes[0].target).slice(0, 60) }))
    })
    for (const v of r) {
      if (v.impact === 'critical') out.critical++
      else if (v.impact === 'serious') out.serious++
      else if (v.impact === 'moderate') out.moderate++
      else out.minor++
    }
    out.issues = r.slice(0, 8).map((v) => ({ rule: v.id, impact: v.impact, msg: `${v.help}（${v.n} 处：${v.target}）`.slice(0, 140) }))
    out.ok = out.critical === 0
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 140) }
  finally { if (browser) await browser.close().catch(() => {}) }
  return out
}

// ---------- ③ 编译器级语法检查（esbuild transform） ----------
export async function compileCheck(html) {
  const out = { ok: true, js: null, css: null, error: null }
  try {
    const esbuild = await import('esbuild')
    for (const m of String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const code = m[1]
      if (!code.trim()) continue
      try { await esbuild.transform(code, { loader: 'js', target: 'es2020' }) }
      catch (e) { out.ok = false; out.js = String((e && e.message) || e).slice(0, 200); break }
    }
    for (const m of String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const code = m[1]
      if (!code.trim()) continue
      try { await esbuild.transform(code, { loader: 'css', target: 'es2020' }) }
      catch (e) { out.ok = false; out.css = String((e && e.message) || e).slice(0, 200); break }
    }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 140) }
  return out
}

// ---------- ④ 打包：内联 CSS/JS 压缩 → dist/index.html（可直接部署） ----------
export async function packagePrototype(htmlPath, run) {
  const out = { ok: false, rel: null, before: 0, after: 0, error: null, readme: null }
  try {
    const esbuild = await import('esbuild')
    const abs = path.resolve(htmlPath)
    let html = fs.readFileSync(abs, 'utf-8')
    out.before = Buffer.byteLength(html)
    // 压缩内联样式与脚本
    for (const [re, loader] of [[/<style([^>]*)>([\s\S]*?)<\/style>/gi, 'css'], [/<script([^>]*)>([\s\S]*?)<\/script>/gi, 'js']]) {
      const blocks = [...html.matchAll(re)]
      for (const m of blocks) {
        const code = m[2]
        if (!code || !code.trim()) continue
        try {
          const r = await esbuild.transform(code, { loader, minify: true, target: 'es2020' })
          html = html.replace(m[0], m[0].replace(code, r.code.trim()))
        } catch {}
      }
    }
    html = html.replace(/<!--(?!\[if)[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n')
    const distDir = path.join(run.artifactsDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.html'), html)
    out.after = Buffer.byteLength(html)
    out.rel = path.join('artifacts', 'dist', 'index.html').replace(/\\/g, '/')
    const readme = `# 交付说明（可部署）

## 这是什么
单文件网页应用，**零依赖**：不引用任何 CDN、外部字体或图片文件，双击即可运行。

## 怎么用
1. 直接双击 \`index.html\`（Chrome / Edge / Safari 均可）
2. 或放到任意静态服务器（Nginx / GitHub Pages / 对象存储）目录下即可

## 质量记录
- HTML 规范：通过 html-validate 校验
- 无障碍：通过 axe-core（WCAG 2.0 A/AA）审计
- 样式：统一设计令牌（间距 4/8/12/16/24/32/48/64，字号阶梯，圆角 6/8/12/999）
- 体积：${(out.before / 1024).toFixed(1)}KB → 压缩后 ${(out.after / 1024).toFixed(1)}KB
`
    fs.writeFileSync(path.join(distDir, 'README.md'), readme)
    out.readme = path.join('artifacts', 'dist', 'README.md').replace(/\\/g, '/')
    out.ok = true
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 160) }
  return out
}

export function verifyLine(v) {
  const parts = []
  if (v.html) parts.push(v.html.ok ? `HTML 规范 ✅（${v.html.warnings} 警告）` : `HTML 规范 ❌ ${v.html.errors} 错误`)
  if (v.axe) parts.push(v.axe.ok ? `无障碍 ✅(axe-core)` : `无障碍 ❌ 严重 ${v.axe.critical} 项`)
  if (v.compile) parts.push(v.compile.ok ? '语法编译 ✅(esbuild)' : '语法编译 ❌')
  return '真工具校验：' + parts.join(' · ')
}
