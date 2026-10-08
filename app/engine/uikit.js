// Pulse 虚拟团队 · UI 保证层（uikit）
// 信仰：模型会写功能，但审美不稳定；**可交付质量必须由管线保证，不能写在提示词里求它遵守**。
//
// 这一层做三件事（全部确定性、零 LLM）：
//   ① 注入一套强制设计系统（令牌 + 基础排版 + 组件库），模型可以覆盖细节，但底色/字体/骨架先是对的
//   ② 机械修正模型常见的"丑"：容器过窄（桌面只剩一根柱子）、圆角乱、字号乱、缺视口 meta
//   ③ 供审计层量测（审计在浏览器里跑，见 designaudit.js）

// ---------- 设计令牌与组件（全宽友好：内容居中但不做窄柱） ----------
export const UIKIT_CSS = `
:root{
  --pt-max:1200px; --pt-gutter:clamp(16px,4vw,40px);
  --pt-bg:#f7f8fb; --pt-surface:#fff; --pt-surface-2:#f2f4f8; --pt-text:#12161f; --pt-muted:#5b667a; --pt-line:#e4e7ee;
  --pt-brand:#2f6bff; --pt-brand-ink:#fff; --pt-ok:#12a150; --pt-warn:#e08700; --pt-danger:#d92d20;
  --pt-1:4px; --pt-2:8px; --pt-3:12px; --pt-4:16px; --pt-5:24px; --pt-6:32px; --pt-7:48px; --pt-8:64px; --pt-9:96px;
  --pt-r-sm:6px; --pt-r-md:8px; --pt-r-lg:12px;
  --pt-sh-1:0 1px 2px rgba(16,24,40,.05); --pt-sh-2:0 4px 16px rgba(16,24,40,.08); --pt-sh-3:0 18px 48px rgba(16,24,40,.14);
  --pt-f-display:clamp(34px,5.2vw,60px); --pt-f-h1:clamp(26px,3.2vw,38px); --pt-f-h2:24px; --pt-f-h3:18px;
  --pt-f-body:16px; --pt-f-sm:14px; --pt-f-xs:12px;
  --pt-font:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--pt-bg:#0f1218;--pt-surface:#161a22;--pt-surface-2:#1c212b;--pt-text:#eef1f6;--pt-muted:#a6b0c0;--pt-line:#272d38;--pt-brand:#5b8dff;--pt-sh-1:0 1px 2px rgba(0,0,0,.4);--pt-sh-2:0 6px 20px rgba(0,0,0,.45);--pt-sh-3:0 20px 52px rgba(0,0,0,.55)}
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font-family:var(--pt-font);font-size:var(--pt-f-body);line-height:1.7;color:var(--pt-text);background:var(--pt-bg);-webkit-font-smoothing:antialiased}
h1,h2,h3,h4,p,figure,ul,ol{margin:0}
h1{font-size:var(--pt-f-h1);line-height:1.25;letter-spacing:-.02em;font-weight:700}
h2{font-size:var(--pt-f-h2);line-height:1.3;letter-spacing:-.01em;font-weight:650}
h3{font-size:var(--pt-f-h3);line-height:1.4;font-weight:600}
p{color:var(--pt-muted)}
a{color:inherit;text-decoration:none}
img,svg,video,canvas{max-width:100%;height:auto;display:block}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;border:0;background:none}
table{border-collapse:collapse;width:100%}
:focus-visible{outline:2px solid var(--pt-brand);outline-offset:2px}
::selection{background:color-mix(in srgb,var(--pt-brand) 22%,transparent)}
/* 版式骨架：全出血分区 + 居中内容，宽度由 --pt-max 控制（不要给 body 设窄 max-width） */
.pt-page{display:block;width:100%}
.pt-wrap{width:100%;max-width:var(--pt-max);margin-inline:auto;padding-inline:var(--pt-gutter)}
.pt-bleed{width:100%}
.pt-section{padding-block:clamp(48px,7vw,96px)}
.pt-section--tight{padding-block:clamp(28px,4vw,56px)}
.pt-grid{display:grid;gap:var(--pt-5);grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.pt-grid--2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.pt-row{display:flex;align-items:center;gap:var(--pt-3);flex-wrap:wrap}
.pt-stack{display:flex;flex-direction:column;gap:var(--pt-4)}
.pt-head{display:flex;align-items:center;gap:var(--pt-4);padding-block:var(--pt-3)}
.pt-lead{font-size:calc(var(--pt-f-body) + 2px);color:var(--pt-muted);max-width:62ch}
.pt-eyebrow{font-size:var(--pt-f-xs);letter-spacing:.12em;text-transform:uppercase;color:var(--pt-brand);font-weight:600}
.pt-muted{color:var(--pt-muted)}
.pt-center{text-align:center;margin-inline:auto}
/* 组件 */
.pt-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--pt-2);height:42px;padding:0 20px;border-radius:var(--pt-r-md);
  background:var(--pt-surface);border:1px solid var(--pt-line);font-size:var(--pt-f-sm);font-weight:600;color:var(--pt-text);
  transition:transform .16s ease,box-shadow .2s ease,background .2s ease,border-color .2s ease}
.pt-btn:hover{transform:translateY(-1px);box-shadow:var(--pt-sh-2);border-color:color-mix(in srgb,var(--pt-brand) 45%,var(--pt-line))}
.pt-btn:active{transform:translateY(1px) scale(.99)}
.pt-btn--primary{background:var(--pt-brand);border-color:transparent;color:var(--pt-brand-ink);box-shadow:0 6px 18px color-mix(in srgb,var(--pt-brand) 32%,transparent)}
.pt-btn--primary:hover{background:color-mix(in srgb,var(--pt-brand) 88%,#000)}
.pt-btn--ghost{background:transparent}
.pt-btn--danger{background:var(--pt-danger);border-color:transparent;color:#fff}
.pt-btn--sm{height:34px;padding:0 14px;font-size:var(--pt-f-xs)}
.pt-btn--lg{height:50px;padding:0 28px;font-size:var(--pt-f-body)}
.pt-card{background:var(--pt-surface);border:1px solid var(--pt-line);border-radius:var(--pt-r-lg);padding:var(--pt-5);box-shadow:var(--pt-sh-1);
  transition:transform .18s ease,box-shadow .22s ease,border-color .18s ease}
.pt-card:hover{transform:translateY(-3px);box-shadow:var(--pt-sh-3);border-color:color-mix(in srgb,var(--pt-brand) 35%,var(--pt-line))}
.pt-card--flat:hover{transform:none;box-shadow:var(--pt-sh-1)}
.pt-panel{background:var(--pt-surface);border:1px solid var(--pt-line);border-radius:var(--pt-r-lg);padding:var(--pt-5)}
.pt-hero{position:relative;overflow:hidden;border-radius:var(--pt-r-lg);padding:clamp(40px,7vw,88px) var(--pt-6);
  background:linear-gradient(135deg,color-mix(in srgb,var(--pt-brand) 12%,var(--pt-surface)),var(--pt-surface) 62%)}
.pt-hero::after{content:"";position:absolute;inset:-40% -10% auto auto;width:52%;aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle,color-mix(in srgb,var(--pt-brand) 30%,transparent),transparent 70%);filter:blur(8px);pointer-events:none}
.pt-badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:var(--pt-f-xs);font-weight:600;
  background:color-mix(in srgb,var(--pt-brand) 12%,transparent);color:color-mix(in srgb,var(--pt-brand) 82%,#000)}
.pt-badge--ok{background:color-mix(in srgb,var(--pt-ok) 14%,transparent);color:var(--pt-ok)}
.pt-badge--warn{background:color-mix(in srgb,var(--pt-warn) 16%,transparent);color:var(--pt-warn)}
.pt-badge--danger{background:color-mix(in srgb,var(--pt-danger) 14%,transparent);color:var(--pt-danger)}
.pt-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--pt-line);border-radius:var(--pt-r-sm);
  font-size:var(--pt-f-xs);color:var(--pt-muted);background:var(--pt-surface);transition:background .16s,border-color .16s,color .16s}
.pt-chip:hover,.pt-chip[aria-selected=true]{border-color:var(--pt-brand);color:var(--pt-brand);background:color-mix(in srgb,var(--pt-brand) 8%,transparent)}
.pt-input,.pt-select,.pt-textarea{width:100%;height:42px;padding:0 14px;border:1px solid var(--pt-line);border-radius:var(--pt-r-md);
  background:var(--pt-surface);transition:border-color .16s,box-shadow .16s}
.pt-textarea{height:auto;min-height:96px;padding:12px 14px;line-height:1.6}
.pt-input:focus,.pt-select:focus,.pt-textarea:focus{border-color:var(--pt-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--pt-brand) 18%,transparent);outline:none}
.pt-label{display:block;font-size:var(--pt-f-xs);font-weight:600;color:var(--pt-muted);margin-bottom:6px}
.pt-table th,.pt-table td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--pt-line);font-size:var(--pt-f-sm)}
.pt-table th{font-size:var(--pt-f-xs);color:var(--pt-muted);font-weight:600;letter-spacing:.02em}
.pt-table tr:hover td{background:color-mix(in srgb,var(--pt-brand) 4%,transparent)}
.pt-list{list-style:none;padding:0;display:flex;flex-direction:column}
.pt-list li{padding:12px 0;border-bottom:1px solid var(--pt-line);display:flex;gap:var(--pt-3);align-items:center}
.pt-list li:last-child{border-bottom:0}
.pt-divider{height:1px;background:var(--pt-line);border:0;margin:var(--pt-5) 0}
.pt-stat{font-size:34px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.pt-avatar{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,var(--pt-brand) 14%,transparent);color:var(--pt-brand);font-weight:700;font-size:var(--pt-f-sm);flex:0 0 auto}
.pt-empty{display:flex;flex-direction:column;align-items:center;gap:var(--pt-3);padding:var(--pt-7) var(--pt-5);color:var(--pt-muted);
  border:1px solid var(--pt-line);border-radius:var(--pt-r-lg);background:var(--pt-surface-2);text-align:center}
.pt-footer{border-top:1px solid var(--pt-line);padding-block:var(--pt-6);color:var(--pt-muted);font-size:var(--pt-f-sm)}
.pt-link{color:var(--pt-brand);font-weight:600}
.pt-link:hover{text-decoration:underline}
@media (max-width:640px){h1{font-size:clamp(24px,7vw,30px)}.pt-section{padding-block:40px}}
`

// ---------- 机械修正 ----------
const RADIUS_SCALE = [0, 6, 8, 12, 16, 999]
const FONT_SCALE = [11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 44, 52, 64]
const snap = (v, scale) => scale.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), scale[0])

// 页面级容器的选择器特征（只有这些才把 max-width 提到 1200，别把 400px 的小对话框/正文列也改了）
const PAGE_CONTAINER = /(^|[^a-z])(wrap|container|page|shell|layout|inner|main|root|app)([^a-z]|$)/i
// 正文文本列（保持窄才好看），绝不撑宽
const TEXT_COLUMN = /(prose|text|copy|lead|desc|intro|article-body|excerpt|quote|body)/i

// 容器宽度变量的名字特征（模型常写 --container:600px 再 max-width:var(--container)）
const CONTAINER_VAR = /--([a-z0-9-]*(container|wrap|shell|layout|page)[a-z0-9-]*|max-?w[ a-z0-9-]*|content-w[a-z0-9-]*)\s*:\s*(\d+)px/gi

export function normalizeCss(css) {
  const notes = []
  let out = css
  // ① 圆角统一到 0/6/8/12/16/999
  out = out.replace(/border-radius\s*:\s*([\d.]+)px/g, (m, n) => {
    const v = parseFloat(n); if (!isFinite(v) || v >= 999) return m
    const s = snap(v, RADIUS_SCALE); if (s !== v) notes.push(`圆角 ${v}px→${s}px`)
    return `border-radius:${s}px`
  })
  // ② 字号统一到字阶（避免 13.5/15.5/17/22 这类随手值把层级打散）
  out = out.replace(/font-size\s*:\s*([\d.]+)px/g, (m, n) => {
    const v = parseFloat(n); if (!isFinite(v)) return m
    const s = snap(v, FONT_SCALE); if (s !== v) notes.push(`字号 ${v}px→${s}px`)
    return `font-size:${s}px`
  })
  // ③ 容器宽度变量（--container:620px 这类）提到 1200
  out = out.replace(CONTAINER_VAR, (m, name, key, n) => {
    const v = parseInt(n, 10)
    if (v >= 1100 || v < 520) return m
    notes.push(`容器变量 ${m.trim()} → 1200px`)
    return `--${name}:1200px`
  })
  // ④ 页面级容器的字面量 max-width → var(--pt-max)
  out = out.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
    if (!/max-width\s*:\s*(\d+)px/.test(body)) return m
    if (TEXT_COLUMN.test(sel)) return m
    const PAGEISH = /margin[^;]*auto/i.test(body) || PAGE_CONTAINER.test(sel)
    if (!PAGEISH) return m
    return m.replace(/max-width\s*:\s*(\d+)px/g, (mm, n) => {
      const v = parseInt(n, 10)
      if (v >= 1100 || v < 520) return mm
      notes.push(`容器 max-width ${v}px→1200px`)
      return 'max-width:var(--pt-max,1200px)'
    })
  })
  // ⑤ body 若被设成窄容器也一并放开
  out = out.replace(/(^|\})\s*body\s*\{([^{}]*)\}/g, (m, pre, body) => {
    if (!/max-width\s*:\s*(\d+)px/.test(body)) return m
    return pre + ' body{' + body.replace(/max-width\s*:\s*\d+px/g, 'max-width:none') + '}'
  })
  return { css: out, notes: [...new Set(notes)].slice(0, 24) }
}

// 把设计系统 + 修正后的模型 CSS 注入 HTML（uikit 在前，模型样式在后 → 模型仍可覆盖细节）
export function injectUikit(raw) {
  let html = String(raw == null ? '' : raw)
  const notes = []
  // 视口 meta
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    if (/<head[^>]*>/i.test(html)) html = html.replace(/(<head[^>]*>)/i, '$1\n<meta name="viewport" content="width=device-width,initial-scale=1">')
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/(<html[^>]*>)/i, '$1\n<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>')
    else html = '<meta name="viewport" content="width=device-width,initial-scale=1">\n' + html
    notes.push('补 viewport meta')
  }
  // 模型自己的 <style> 先做机械修正
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    const r = normalizeCss(css)
    r.notes.forEach((n) => notes.push(n))
    return open + r.css + close
  })
  // 注入设计系统
  const tag = `<style id="pt-uikit">${UIKIT_CSS}</style>`
  if (html.includes('id="pt-uikit"')) return { html, notes }
  if (/<head[^>]*>/i.test(html)) html = html.replace(/(<head[^>]*>)/i, '$1\n' + tag)
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/(<html[^>]*>)/i, '$1\n<head>' + tag + '</head>')
  else html = tag + '\n' + html
  notes.push('注入 UI 保证层（pt-uikit）')
  return { html, notes: [...new Set(notes)] }
}
