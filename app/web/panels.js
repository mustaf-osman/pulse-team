// 项目库 / 团队记忆 独立页面渲染 —— 全部图标为内联 SVG（无 emoji）
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

const SVG = {
  hex: '<path d="M12 2.6l8 4.5v9.8l-8 4.5-8-4.5V7.1z"/><circle cx="12" cy="12" r="2.4"/>',
  return: '<path d="M15 5l-7 7 7 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  moon: '<path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a7 7 0 0 0 11.1 11.1z"/>',
  folder: '<path d="M3 7.4A2 2 0 0 1 5 5.4h3.6l2 2.2H19a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.3M12 7.8h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4v4.9l3.1 1.9"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M22 20H2.5"/>',
  eye: '<path d="M2.4 12S6 6.2 12 6.2 21.6 12 21.6 12 18 17.8 12 17.8 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.7"/>',
  shield: '<path d="M12 3.2l7 2.9v5.1c0 4.7-3 7.7-7 9.6-4-1.9-7-4.9-7-9.6V6.1z"/><path d="M9 12.2l2.1 2.1 4-4.2"/>',
  git: '<circle cx="6.5" cy="6" r="2.4"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="17.5" cy="9" r="2.4"/><path d="M6.5 8.4v7.2M17.5 11.4c0 2.8-4.3 3-6.4 4.4"/>',
  box: '<path d="M12 3.2l8 4.4v8.8L12 20.8 4 16.4V7.6z"/><path d="M4 7.6l8 4.4 8-4.4M12 12v8.8"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 13h9l1-13"/>',
  none: '<path d="M3.5 5.5h17v13h-17z"/><path d="M3.5 9.5h17M7 5.5v13"/>',
  up: '<path d="M4 20V11M10 20V5M16 20v-6M22 20H2.5"/>',
}
const svg = (n, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24">${SVG[n]}</svg>`

// —— 主题：与主站共用 pt-theme（跨页联动）——
const themeBtn = $('#themebtn')
function paintThemeBtn() { if (themeBtn) themeBtn.innerHTML = svg(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun') }
if (themeBtn) {
  paintThemeBtn()
  themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('pt-theme', next) } catch {}
    paintThemeBtn()
  }
}

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e }
const badge = (icon, txt, cls) => {
  const s = el('span', 'badge' + (cls ? ' ' + cls : ''))
  if (icon) s.insertAdjacentHTML('beforeend', svg(icon))
  s.appendChild(document.createTextNode(txt))
  return s
}

const ROLE = { pm: ['项目经理', '#86909C'], req: ['需求分析师', '#4080E8'], des: ['方案设计', '#9B6CD9'], dev: ['编码开发', '#00B8C4'], qa: ['测试工程', '#F28C38'], doc: ['文档工程', '#86909C'] }

// ===================== 项目库 =====================
async function loadProjects() {
  const grid = $('#grid')
  const j = await fetch('/api/projects').then((r) => r.json()).catch(() => null)
  const list = (j && j.projects) || []
  const cnt = $('#count')
  if (cnt) cnt.textContent = list.length ? `共 ${list.length} 次交付` : ''
  grid.innerHTML = ''
  if (!list.length) { grid.appendChild(el('div', 'empty', '还没有项目 —— 去协作台开一次工')); return }

  // 成长曲线（独立区块，不压卡片）
  const growth = $('#growth')
  if (growth) {
    growth.innerHTML = ''
    const scored = list.slice().reverse().filter((p) => p.scores && p.scores.design != null)
    const cap = el('div', 'cap')
    cap.insertAdjacentHTML('beforeend', svg('chart'))
    const b = el('b', null, '设计分趋势')
    cap.appendChild(b)
    cap.appendChild(document.createTextNode(`　引擎实测（设计审计）· 共 ${scored.length} 次有分数记录 · 满分 100`))
    growth.appendChild(cap)
    const row = el('div', 'growrow')
    if (!scored.length) row.appendChild(el('span', 'none2', '还没有带分数的交付 —— 下一次开工就会出现在这里'))
    for (const p of scored.slice(-24)) {
      const d = el('div', 'bar')
      d.style.height = Math.max(5, Math.round((p.scores.design / 100) * 50)) + 'px'
      d.title = `${p.requirement.slice(0, 30)} · 设计 ${p.scores.design} 分`
      const em = el('em', null, String(p.scores.design))
      d.appendChild(em)
      row.appendChild(d)
    }
    growth.appendChild(row)
  }

  for (const p of list) {
    const card = el('div', 'card')
    // 预览区：有真截图就显示，没有再给线框留影区
    const th = el('a', 'thumb' + (p.thumb ? '' : ' none'))
    th.href = `/runs/${p.id}/artifacts/prototype/index.html`
    th.target = '_blank'
    th.title = '在新标签打开原型'
    const bar = el('div', 'tbar')
    for (let i = 0; i < 3; i++) bar.appendChild(el('i'))
    bar.appendChild(el('em', null, 'runs/' + p.id.slice(4) + '/prototype'))
    th.appendChild(bar)
    if (p.thumb) {
      const im = el('img'); im.src = p.thumb; im.alt = ''; im.loading = 'lazy'
      th.appendChild(im)
      th.appendChild(el('span', 'tag2', '原型预览'))
    } else {
      const ph = el('div', 'ph')
      ph.insertAdjacentHTML('beforeend', svg('none'))
      ph.appendChild(el('span', null, '本次交付没有截图'))
      th.appendChild(ph)
    }
    card.appendChild(th)

    const body = el('div', 'cbody')
    const t = el('div', 'ctitle', p.requirement)
    t.title = p.requirement
    body.appendChild(t)
    const meta = el('div', 'cmeta')
    if (p.at) meta.appendChild(badge('clock', p.at, 'dim'))
    if (p.durationMs) meta.appendChild(badge('clock', (p.durationMs / 1000).toFixed(0) + ' 秒', 'dim'))
    meta.appendChild(badge(null, p.approved === true ? '已交付' : p.stopped ? '已停止' : p.approved === false ? '被打回' : '进行中', p.approved === true ? 'ok' : p.stopped ? 'warn' : ''))
    if (p.scores) {
      if (p.scores.design != null) meta.appendChild(badge('chart', '设计 ' + p.scores.design, 'brand'))
      if (p.scores.quality != null) meta.appendChild(badge(null, '质量 ' + p.scores.quality))
      if (p.scores.coverage != null) meta.appendChild(badge(null, '覆盖 ' + (p.scores.coverage * 100).toFixed(0) + '%', p.scores.coverage >= 0.8 ? 'ok' : 'warn'))
    }
    if (p.files) meta.appendChild(badge('box', p.files + ' 件产出'))
    if (p.cert) meta.appendChild(badge('shield', '有证书', 'ok'))
    body.appendChild(meta)
    if (p.git && p.git.length) {
      for (const g of p.git.slice(0, 3)) {
        const line = el('div', 'gline')
        line.insertAdjacentHTML('beforeend', svg('git'))
        const dot = el('span', 'cd')
        dot.style.background = (ROLE[g.authorKey] || ['', '#86909C'])[1]
        line.appendChild(dot)
        line.appendChild(el('b', null, g.hash))
        line.appendChild(el('span', null, `${g.author} · ${g.msg.slice(0, 24)}`))
        body.appendChild(line)
      }
    }
    card.appendChild(body)

    const acts = el('div', 'cacts')
    const mk = (icon, txt, fn, cls) => {
      const b = el('button', cls || null)
      b.insertAdjacentHTML('beforeend', svg(icon))
      b.appendChild(document.createTextNode(txt))
      b.onclick = fn
      b.title = txt
      b.setAttribute('aria-label', txt)
      return b
    }
    acts.appendChild(mk('eye', '打开原型', () => window.open(`/runs/${p.id}/artifacts/prototype/index.html`, '_blank')))
    if (p.cert) acts.appendChild(mk('shield', '看证书', () => window.open(`/runs/${p.id}/artifacts/certificate.json`, '_blank')))
    card.appendChild(acts)
    grid.appendChild(card)
  }
}

// ===================== 团队记忆 =====================
async function loadMemory() {
  const grid = $('#grid')
  const j = await fetch('/api/memory').then((r) => r.json()).catch(() => null)
  if (!j) { grid.innerHTML = ''; grid.appendChild(el('div', 'empty', '读取失败')); return }
  const rc = Object.values(j.stats.roles || {}).reduce((a, b) => a + b, 0)
  const total = rc + (j.stats.project || 0)
  const cnt = $('#count')
  if (cnt) cnt.textContent = `共 ${total} 条 · 角色 ${rc} · 项目 ${j.stats.project || 0}`
  grid.innerHTML = ''
  const parse = (l) => {
    const s = String(l).replace(/^-\s*/, '')
    const m = s.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*)$/)
    return m ? { date: m[1], tag: m[2], text: m[3] } : { date: '', tag: '', text: s }
  }
  const card = (title, color, lines, scope, id) => {
    const c = el('div', 'mcard')
    const h = el('div', 'mhead')
    const d = el('span', 'cdot')
    d.style.background = color
    h.appendChild(d)
    h.appendChild(document.createTextNode(title))
    h.appendChild(el('span', 'n', lines.length ? lines.length + ' 条' : ''))
    c.appendChild(h)
    if (!lines.length) {
      const e2 = el('div', 'mempty')
      e2.insertAdjacentHTML('beforeend', svg('none'))
      e2.appendChild(el('span', null, '还没有记忆'))
      c.appendChild(e2)
      return c
    }
    for (const l of lines.slice().reverse()) {
      const { date, tag, text } = parse(l)
      const row = el('div', 'mrow')
      if (date || tag) {
        const pre = el('div', 'pre')
        if (date) { const b = el('b', null, date); pre.appendChild(b) }
        if (tag) pre.appendChild(el('span', null, tag))
        row.appendChild(pre)
      }
      row.appendChild(el('span', 'txt', text))
      const x = el('span', 'x')
      x.insertAdjacentHTML('beforeend', svg('trash'))
      x.title = '忘掉这条'
      x.onclick = async () => {
        x.style.opacity = '.3'
        const r = await fetch('/api/memory-forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, id, text: String(l).replace(/^-\s*/, '') }) }).then((z) => z.json()).catch(() => null)
        if (r && r.ok) loadMemory(); else x.style.opacity = '.85'
      }
      row.appendChild(x)
      c.appendChild(row)
    }
    return c
  }
  grid.appendChild(card('项目记忆 / 全局规范', 'var(--brand)', j.project || [], 'project', 'project'))
  for (const id of ['dev', 'qa', 'des', 'req', 'pm', 'doc']) grid.appendChild(card(ROLE[id][0], ROLE[id][1], (j.roles && j.roles[id]) || [], 'role', id))
}

const MODE = document.body.dataset.panel
if (MODE === 'projects') loadProjects()
else if (MODE === 'memory') loadMemory()
