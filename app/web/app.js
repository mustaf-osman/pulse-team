// Pulse 虚拟团队 · 协作台（实时版前端）
// 数据源：真实引擎事件流（SSE /events + /api/state）
// 功能：输入需求开工 / 实时直播六个角色的状态与往来 / 产出物可点开 / 人工审批批复 / 历史回放
window.__errs = [];
addEventListener('error', (e) => window.__errs.push(String((e && e.message) || e)));
addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e && e.reason)));

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), wires = $('#wires'), drawer = $('#drawer'), dock = $('#dock');
const SVGNS = 'http://www.w3.org/2000/svg';
let msgs = 0, rejs = 0, running = false, replaying = false;
let clockBase = 0, clockFrozen = 0;
const per = { pm: 0, req: 0, des: 0, dev: 0, qa: 0, doc: 0 };
let lastPrototypeUrl = null
let appliedRun = null
let lastApplied = 0
// 事件去重：按 runId#seq#ts 记账（带上时间戳 → 历史文件里 seq 重复的旧事件也能区分开）。
// 不能用 seq 与 state 的最大值比大小：bus 的 seq 每轮重置，运行结束后的聊天/改稿事件 seq 更小，会被误杀。
const seenKeys = new Set()
function evKey(ev) { return (ev && ev.runId ? ev.runId : '') + '#' + (ev && ev.seq) + '#' + (ev && ev.ts) }
function markSeen(list) { for (const ev of list || []) seenKeys.add(evKey(ev)) }
let hist = []
let viewingPast = false
let lastRunId = null
let lastStats = null
const metrics = { calls: 0, chars: 0, tokens: 0 }
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
const STEP_ORDER = ['req', 'des', 'dev', 'qa', 'doc', 'deliver']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const maxSeq = (list) => { let m = 0; for (const e of list || []) { if (e.seq > m) m = e.seq } return m };
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const extOf = (n) => { const p = String(n || '').split('.'); return p.length > 1 ? p.pop().toUpperCase() : 'FILE' };
const NS = (t, at) => { const e = document.createElementNS(SVGNS, t); for (const k in at) e.setAttribute(k, at[k]); return e };

const N = {}; ['pm', 'req', 'des', 'dev', 'qa', 'doc'].forEach((k) => { N[k] = $('#n-' + k); });
const NAME = { pm: '项目经理', req: '需求分析师', des: '方案设计', dev: '编码开发', qa: '测试工程', doc: '文档工程', user: '我' }
const COLOR = { pm: '#86909C', req: '#4080E8', des: '#9B6CD9', dev: '#00B8C4', qa: '#F28C38', doc: '#86909C', user: '#9FB4D8' }
// 圆点色规则（标签体系）：全部=品牌青 · 项目经理=灰 · 其余=角色色
const DOTC = { all: '#00B8C4', pm: '#86909C', req: '#4080E8', des: '#9B6CD9', dev: '#00B8C4', qa: '#F28C38', doc: '#86909C' }
const LBL = { idle: '待命', think: '思考中', work: '执行中', wait: '等待批复', done: '已完成' };

function st(k, s, act) {
  const n = N[k]; if (!n) return
  if (n.dataset.st !== s) { n.classList.add('ping'); setTimeout(() => n.classList.remove('ping'), 760) }
  n.dataset.st = s
  n.querySelector('.act').textContent = act || LBL[s] || ''
  if (s !== 'work') { const b = n.querySelector('.bar i'); b.getAnimations().forEach((a) => a.cancel()); b.style.width = '0%' }
  stats()
}
function workBar(k, act) { st(k, 'work', act); const b = N[k].querySelector('.bar i'); b.getAnimations().forEach((a) => a.cancel()); b.animate([{ width: '0%' }, { width: '92%' }], { duration: 30000, easing: 'linear', fill: 'forwards' }) }
function flashRej(k) { const n = N[k]; n.classList.add('rej'); setTimeout(() => n.classList.remove('rej'), 1100) }
function step(id, s) { const el = $('#st-' + id); if (!el) return; el.classList.remove('act', 'done'); if (s) el.classList.add(s); tlProgress() }
function tlProgress() {
  const done = STEP_ORDER.filter((i) => $('#st-' + i).classList.contains('done')).length
  const act = STEP_ORDER.some((i) => $('#st-' + i).classList.contains('act')) ? 0.5 : 0
  $('#tlfill').style.width = Math.min(100, ((done + act) / STEP_ORDER.length) * 100) + '%'
}
function bump(id, v) {
  const el = $('#' + id); if (!el) return
  if (el.textContent === String(v)) return
  const from = parseInt(el.textContent, 10)
  const to = typeof v === 'number' ? v : parseInt(v, 10)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || Math.abs(to - from) > 999) { el.textContent = v; flashBox(el); return }
  const t0 = performance.now(), dur = 430
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur)
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)))
    if (k < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  flashBox(el)
}
function flashBox(el) {
  const box = el.closest('.mchip') || el.closest('.v') || el
  box.classList.remove('flash', 'bump'); void box.offsetWidth; box.classList.add('flash', 'bump')
}
// 开工时画布扫过一道光
function scanStage() {
  document.body.classList.remove('goscan'); void document.body.offsetWidth
  document.body.classList.add('goscan')
  setTimeout(() => document.body.classList.remove('goscan'), 1300)
}
// 点击涟漪：所有按钮/标签/卡片都有一圈扩散反馈
document.addEventListener('pointerdown', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('button,.dchip,.histbtn,.chatlink,.dcard,.acard,.hrow,.fororow,.step,.setnav button') : null
  if (!el) return
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return
  const d = Math.max(r.width, r.height) * 1.15
  const s = document.createElement('span'); s.className = 'rp'
  s.style.width = s.style.height = d + 'px'
  s.style.left = (e.clientX - r.left - d / 2) + 'px'
  s.style.top = (e.clientY - r.top - d / 2) + 'px'
  el.appendChild(s)
  setTimeout(() => { if (s.parentNode) s.remove() }, 700)
})
// 光标跟随光晕
{
  let raf = 0
  addEventListener('pointermove', (e) => {
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; const st = document.documentElement.style; st.setProperty('--mx', e.clientX + 'px'); st.setProperty('--my', e.clientY + 'px') })
  }, { passive: true })
}
function stats() {
  bump('s-msg', msgs)
  bump('s-par', Object.values(N).filter((n) => ['think', 'work'].includes(n.dataset.st)).length)
  bump('s-rej', rejs)
}
function say(k, text, count = true) {
  if (count) { msgs++; per[k] = (per[k] || 0) + 1; $('#msgcnt').textContent = msgs }
  const m = document.createElement('div'); m.className = 'msg'; m.dataset.k = k; m.style.setProperty('--c', COLOR[k])
  const b = document.createElement('b'); b.textContent = NAME[k]
  const s = document.createElement('span'); s.textContent = text
  m.appendChild(b); m.appendChild(s); drawer.appendChild(m); drawer.scrollTop = drawer.scrollHeight; stats()
}
function toast(t) { const el = $('#toast'); const m = $('#toastmsg'); if (m) m.textContent = t; else el.textContent = t; el.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('on'), 3200) }
{ const tx = $('#toastx'); if (tx) tx.onclick = () => $('#toast').classList.remove('on') }

// ===== 全局 Tooltip：任何带 data-tip 的元素 hover 出统一样式气泡 =====
;(function initTip() {
  const tip = document.getElementById('gtip'); if (!tip) return
  let cur = null
  const hide = () => { cur = null; tip.classList.remove('on') }
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null
    if (!el) { hide(); return }
    if (el === cur) return
    cur = el
    tip.textContent = el.getAttribute('data-tip') || ''
    tip.classList.add('on')
    const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect()
    const left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - tr.width - 10))
    let top = r.bottom + 8
    if (top + tr.height > innerHeight - 8) top = Math.max(8, r.top - tr.height - 8)
    tip.style.left = left + 'px'; tip.style.top = top + 'px'
  })
  document.addEventListener('mouseout', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null
    if (el && el === cur) hide()
  })
  document.addEventListener('scroll', hide, true)
})()

// ===== 通用二次确认弹窗（高危操作统一走这里）=====
let cfmFn = null
function askConfirm(title, text, yesLabel, fn) {
  const t = $('#cfm-title'), x = $('#cfm-text'), y = $('#cfm-yes')
  if (t) t.textContent = title
  if (x) x.textContent = text
  if (y) y.textContent = yesLabel || '确定'
  cfmFn = fn
  $('#cfm').classList.add('on')
}
{ const no = $('#cfm-no'); if (no) no.onclick = () => { cfmFn = null; $('#cfm').classList.remove('on') } }
{ const yes = $('#cfm-yes'); if (yes) yes.onclick = async () => { $('#cfm').classList.remove('on'); const f = cfmFn; cfmFn = null; if (f) await f() } }

function center(k, el) { const r = (el || N[k].querySelector('.avatar')).getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 } }
const arcD = (a, b, lift) => 'M ' + a.x + ' ' + a.y + ' Q ' + ((a.x + b.x) / 2) + ' ' + ((a.y + b.y) / 2 + lift) + ' ' + b.x + ' ' + b.y;

const PAIRS = [['pm', 'req', -30], ['pm', 'des', -30], ['pm', 'dev', -30], ['pm', 'qa', -30], ['pm', 'doc', -30], ['req', 'des', -72], ['des', 'dev', -72], ['dev', 'qa', -72], ['qa', 'doc', -72], ['qa', 'dev', 86]];
const wireEl = {};
PAIRS.forEach(([a, b, l]) => { const p = NS('path', { fill: 'none', class: 'wire' }); p.dataset.a = a; p.dataset.b = b; p.dataset.l = l; wires.appendChild(p); wireEl[a + '>' + b] = p });
function layout() { PAIRS.forEach(([a, b]) => { wireEl[a + '>' + b].setAttribute('d', arcD(center(a), center(b), Number(wireEl[a + '>' + b].dataset.l))) }) }
addEventListener('resize', layout);

function litWire(a, b, color) { const p = wireEl[a + '>' + b]; if (!p) return; p.style.stroke = color; p.style.color = color; p.classList.add('lit'); clearTimeout(p._t); p._t = setTimeout(() => { p.classList.remove('lit'); p.style.stroke = '' }, 1600) }

function fly(fromK, toK, opt) {
  opt = opt || {}
  return new Promise((res) => {
    const a = center(fromK), b = opt.to || center(toK), lift = opt.lift !== undefined ? opt.lift : -72, color = opt.color || '#4dd7c4', dur = opt.dur || 900, label = opt.label
    const p = NS('path', { d: arcD(a, b, lift), fill: 'none', stroke: 'none' }); wires.appendChild(p)
    if (opt.lit !== false && toK) litWire(fromK, toK, color)
    const L = p.getTotalLength()
    const g = NS('circle', { r: 7, fill: color, opacity: .2, filter: 'url(#blur)' }); wires.appendChild(g)
    const c = NS('circle', { r: 3.4, fill: color, filter: 'url(#glow)' }); wires.appendChild(c)
    let lb = null
    if (label) {
      lb = document.createElement('div'); lb.className = 'flabel'; lb.textContent = label
      if (opt.warn) { lb.style.borderColor = 'rgba(255,92,92,.55)'; lb.style.color = '#ffc9c9' }
      lb.style.left = ((a.x + b.x) / 2) + 'px'; lb.style.top = ((a.y + b.y) / 2 + lift * .55) + 'px'; lb.style.opacity = 0; stage.appendChild(lb)
      lb.animate([{ opacity: 0, transform: 'translate(-50%,-50%) translateY(4px)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], { duration: 240, fill: 'forwards' })
    }
    const t0 = performance.now()
    ;(function frame(now) {
      const t = Math.min(1, (now - t0) / dur), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, pt = p.getPointAtLength(L * e)
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); g.setAttribute('cx', pt.x); g.setAttribute('cy', pt.y)
      if (t < 1) requestAnimationFrame(frame)
      else { p.remove(); g.remove(); c.remove(); if (lb) { lb.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => lb.remove()) } res() }
    })(t0)
  })
}

function flyCard(fromK, toK, text, color, dur, delay) {
  dur = dur || 720; delay = delay || 0
  return new Promise((res) => {
    const a = center(fromK), b = center(toK), ty = b.y + 52
    const el = document.createElement('div'); el.className = 'fcard'
    const dot = document.createElement('i'); dot.style.background = color
    el.appendChild(dot); el.appendChild(document.createTextNode(text))
    el.style.left = b.x + 'px'; el.style.top = ty + 'px'; stage.appendChild(el)
    const dx = a.x - b.x, dy = a.y - ty
    const an = el.animate([{ transform: 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(.5)', opacity: 0 }, { opacity: 1, offset: .18 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }], { duration: dur, delay: delay, easing: 'cubic-bezier(.22,.8,.3,1)' })
    an.finished.then(() => { setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 340) }, 1100) }).catch(() => el.remove())
    setTimeout(res, Math.min(dur + delay, 400))
  })
}

function artifact(k, name, ext, url) {
  const el = document.createElement('div'); el.className = 'acard'
  el.dataset.tip = name + (url ? '（点击打开）' : '')
  const ex = document.createElement('span'); ex.className = 'ext'; ex.textContent = ext
  const box = document.createElement('div')
  const fn = document.createElement('div'); fn.className = 'fn'; fn.textContent = name
  const au = document.createElement('div'); au.className = 'au'; au.style.setProperty('--c', COLOR[k] || '#9fb4d8'); au.textContent = NAME[k] || k
  box.appendChild(fn); box.appendChild(au); el.appendChild(ex); el.appendChild(box)
  if (url) el.onclick = () => window.open(url, '_blank')
  dock.appendChild(el); $('#dcount').textContent = dock.children.length
  updateDcards()
}

// ===== 审批门（真实：批复发给引擎） =====
function renderGateMeta(summary) {
  const box = $('#gmeta'); if (!box) return
  const s = String(summary || '等待批复')
  const parts = s.split('·').map((x) => x.trim()).filter(Boolean)
  const rid = parts.find((p) => /^run-/.test(p)) || ''
  const rest = parts.filter((p) => p !== rid).join(' · ') || (rid ? '' : s)
  box.innerHTML = ''
  const row1 = document.createElement('div'); row1.className = 'gm-row'
  const k1 = document.createElement('span'); k1.className = 'gm-k'; k1.textContent = 'RUN'
  const v1 = document.createElement('span'); v1.textContent = rid || '—'
  row1.appendChild(k1); row1.appendChild(v1)
  if (rid) {
    const cp = document.createElement('button'); cp.className = 'cpbtn'; cp.textContent = '复制'
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(rid); cp.textContent = '已复制'; setTimeout(() => (cp.textContent = '复制'), 1200) }
      catch { toast('复制失败') }
    }
    row1.appendChild(cp)
  }
  const row2 = document.createElement('div'); row2.className = 'gm-row'
  const k2 = document.createElement('span'); k2.className = 'gm-k'; k2.textContent = '快照'
  const v2 = document.createElement('span'); v2.textContent = rest || '产出校验中…'
  row2.appendChild(k2); row2.appendChild(v2)
  box.appendChild(row1); box.appendChild(row2)
}
function openGate(summary) {
  return new Promise((res) => {
    const gate = $('#gate'); gate.classList.add('on')
    renderGateMeta(summary)
    const ni = $('#g-note')
    if (ni) {
      ni.value = ''; ni.style.height = 'auto'
      ni.oninput = () => { ni.style.height = 'auto'; ni.style.height = Math.min(150, ni.scrollHeight) + 'px' }
    }
    const close = (v) => { gate.classList.remove('on'); $('#g-ok').onclick = null; $('#g-no').onclick = null; res(v) }
    $('#g-ok').onclick = async () => { await post('/api/gate', { approve: true }); toast('已批复：通过 ✓'); close(true) }
    setTimeout(() => { const b0 = $('#g-ok'); if (b0) b0.focus() }, 120)
    $('#g-no').onclick = async () => {
      const note = ni ? ni.value.trim() : ''
      await post('/api/gate', { approve: false, note })
      toast(note ? '已打回并要求修改：' + note.slice(0, 20) + (note.length > 20 ? '…' : '') : '已批复：打回')
      close(false)
    }
  })
}

function showSettle(st) {
  const s = st || {}
  $('#z-time').textContent = fmt((s.durationMs || clockFrozen || 0) / 1000)
  $('#z-msg').textContent = s.msgs != null ? s.msgs : msgs
  $('#z-rej').textContent = s.retries != null ? s.retries : rejs
  $('#z-art').textContent = s.artifacts != null ? s.artifacts : dock.children.length
  const max = Math.max(...Object.values(per), 1)
  $('#contrib').innerHTML = Object.keys(per).map((k) => '<div class="crow"><span class="cn">' + NAME[k] + '</span><span class="cb"><i style="width:' + (per[k] / max * 100) + '%;background:' + COLOR[k] + '"></i></span><span class="cp">' + per[k] + '</span></div>').join('')
  const econ = $('#econ')
  if (econ) {
    const d = Math.round((s.durationMs || clockFrozen || 0) / 1000)
    const tok = metrics.tokens
    const cost = tok > 0 ? (tok / 1000000 * 3) : 0
    const pad2 = (n) => String(n).padStart(2, '0')
    const timeStr = Math.floor(d / 60) + ':' + pad2(d % 60)
    const ai = '<div class="ecard2 ai"><div class="et">⚡ AI 虚拟团队</div><div class="ev">' + timeStr + '</div><div class="es">' + metrics.calls + ' 次调用' + (tok > 0 ? (' · ' + fmtK(tok) + ' token · 成本约 ¥' + cost.toFixed(2)) : '') + '</div></div>'
    const human = '<div class="ecard2"><div class="et">👷 人工团队（等效交付）</div><div class="ev">≈ 2 人天</div><div class="es">≈ ¥2,000+ · 需求→设计→开发→测试→文档</div></div>'
    econ.innerHTML = ai + human
  }
  const op = $('#openProto')
  if (lastPrototypeUrl) { op.style.display = ''; op.onclick = openProto } else { op.style.display = 'none' }
  const rb = $('#revealBtn'); if (rb) rb.onclick = () => { if (lastRunId) post('/api/reveal', { runId: lastRunId }) }
  const rp = $('#reportBtn'); if (rp) rp.onclick = () => { if (lastRunId) window.open('/api/runs/' + encodeURIComponent(lastRunId) + '/report', '_blank') }
  $('#settle').classList.add('on')
}

function resetBoard(requirement) {
  runClear(); msgs = 0; rejs = 0; Object.keys(per).forEach((k) => { per[k] = 0 })
  drawer.innerHTML = ''; dock.innerHTML = ''; $('#dcount').textContent = '0'
  updateDcards()
  lastPrototypeUrl = null
  Object.keys(N).forEach((k) => st(k, 'idle', '待命'))
  STEP_ORDER.forEach((id) => step(id, null))
  wires.querySelectorAll('path.wire').forEach((p) => { p.classList.remove('lit'); p.style.stroke = '' })
  $('#settle').classList.remove('on'); $('#gate').classList.remove('on')
  if (requirement != null) $('#reqinput').value = requirement
  stats()
}
function runClear() { stage.querySelectorAll('.fcard,.flabel').forEach((e) => e.remove()); wires.querySelectorAll('circle').forEach((e) => e.remove()) }

function clockStart(base) { clockBase = base || Date.now(); clockFrozen = 0 }
function clockFreeze(ms) { clockFrozen = ms || 0 }
;(function tick() {
  const ms = clockFrozen || (clockBase ? Date.now() - clockBase : 0)
  $('#s-time').textContent = fmt(ms / 1000); $('#tltime').textContent = fmt(ms / 1000)
  requestAnimationFrame(tick)
})()

// ===== 事件应用 =====
function applyEvent(ev, instant) {
  switch (ev.type) {
    case 'run_start': {
      lastRunId = ev.runId || lastRunId
      if (!ev.resumed) {
        scanStage()
        resetBoard(ev.requirement || null)
        metrics.calls = 0; metrics.chars = 0; metrics.tokens = 0; updateMetricsUI()
        viewingPast = false; const tv0 = $('#tllive'); if (tv0) tv0.style.display = 'none'
      } else if (!instant) toast('已从检查点恢复，继续跑…')
      running = true; clockStart(ev.ts || Date.now())
      setInputEnabled(false); replayBtnState()
      if (!instant && !ev.resumed) toast('任务已启动：' + (ev.runId || ''))
      break
    }
    case 'agent': {
      st(ev.agent, ev.st, ev.action)
      if (ev.st === 'work') { step(ev.agent, 'act'); workBar(ev.agent, ev.action) }
      if (ev.st === 'done') step(ev.agent, 'done')
      break
    }
    case 'msg': say(ev.agent, ev.text || ''); break
    case 'plan': {
      const tasks = ev.tasks || []
      tasks.forEach((c, i) => flyCard('pm', c.agent, c.title, COLOR[c.agent] || '#cdd9ee', instant ? 1 : 720, instant ? 0 : 230 * i))
      break
    }
    case 'handoff': if (!instant) fly(ev.from, ev.to, { label: ev.label }); else litWire(ev.from, ev.to, '#4dd7c4'); break
    case 'reject': {
      rejs++; stats(); flashRej(ev.from)
      if (!instant) fly(ev.from, ev.to, { color: '#ff5c5c', lift: 86, label: ev.label, dur: 1100, warn: true })
      break
    }
    case 'artifact': {
      if (String(ev.rel || '').includes('prototype/') && ev.url) { lastPrototypeUrl = ev.url; updateProtoBtn() }
      artifact(ev.agent, ev.name || '产出', extOf(ev.name), ev.url)
      break
    }
    case 'test': if (!ev.ok && !instant) toast('自动化检查未通过：' + (ev.reason || String((ev.errors && ev.errors.length) || 0) + ' 个问题')); break
    case 'metrics': {
      metrics.calls += 1
      metrics.chars += ev.chars || 0
      metrics.tokens += ev.tokens || 0
      updateMetricsUI()
      break
    }
    case 'failover': {
      if (!instant) toast('⚠ ' + (ev.from || '主模型') + ' 异常，已自动切换 ' + (ev.to || '备用模型') + '，团队继续跑')
      break
    }
    case 'chat': {
      if (ev.from === 'user') {
        removeTyping(ev.agent)
        const m = document.createElement('div'); m.className = 'msg'; m.dataset.k = 'user'; m.style.setProperty('--c', COLOR.user)
        const b = document.createElement('b'); b.textContent = '我'
        const s = document.createElement('span'); s.textContent = (ev.to ? '@' + (NAME[ev.to] || ev.to) + ' ' : '') + (ev.text || '')
        m.appendChild(b); m.appendChild(s); drawer.appendChild(m); drawer.scrollTop = drawer.scrollHeight
        addTyping(ev.agent)
      } else if (ev.from === 'agent') {
        removeTyping(ev.agent)
        say(ev.agent, ev.text || '', false)
      }
      break
    }
    case 'gate': if (ev.kind === 'approval' && !instant && !replaying) openGate(ev.summary); break
    case 'run_done': {
      running = false; setInputEnabled(true); replayBtnState()
      clockFreeze((ev.stats && ev.stats.durationMs) || 0)
      step('deliver', 'done')
      if (ev.approved === false) { if (!instant) toast('本轮在审批门被打回') }
      else {
        lastStats = ev.stats || null
        updateSettleBtn()
        if (!instant) {
          if (replaying) showSettle(ev.stats || null)
          else {
            const d = Math.round(((ev.stats && ev.stats.durationMs) || 0) / 1000)
            toast('✅ 交付完成：' + ((ev.stats && ev.stats.artifacts) || 0) + ' 件产出 · 用时 ' + Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0') + '（点「成果」看总结）')
            const b = $('#tlsettle'); if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 2600) }
          }
        }
      }
      updateProtoBtn()
      break
    }
    case 'run_stop': {
      running = false; setInputEnabled(true); replayBtnState()
      if (!instant) toast(ev.message || (ev.paused ? '任务已暂停（断点已保存）' : '任务已停止（断点已保存，可恢复）'))
      refreshResume()
      break
    }
    case 'run_error': { running = false; setInputEnabled(true); replayBtnState(); toast('运行出错：' + (ev.message || '')); refreshResume(); break }
  }
}

// ===== 与服务端通信 =====
async function post(url, body) {
  try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return await r.json() } catch (e) { return { error: String(e && e.message || e) } }
}
function setConn(ok) { const el = $('#conn'); el.textContent = ok ? 'LIVE · 真实引擎' : '连接断开 · 重连中…'; el.classList.toggle('live', !!ok) }
function setInputEnabled(b) {
  $('#reqinput').disabled = !b; $('#runbtn').disabled = !b; document.body.classList.toggle('running', !b)
  const sb = $('#stopbtn'); if (sb) sb.disabled = b          // 运行时才可点"停止"
}
// ===== 停止 / 结束任务 =====
let stopAsked = 0
{ const sb = $('#stopbtn'); if (sb) sb.onclick = () => {
  const force = Date.now() - stopAsked < 20000      // 20 秒内点第二次 = 强制结束
  stopAsked = Date.now()
  const run = async () => {
    const r = await post('/api/stop', { force })
    if (r && r.ok) toast(force ? '已强制结束任务（界面状态已复位）' : '已请求停止…引擎会在当前步骤结束后停下（再点一次可强制结束）')
    else toast('停止失败：' + ((r && r.error) || '未知'))
  }
  if (force) askConfirm('强制结束任务？', '引擎可能已经不认得这次运行了，强制结束只会复位界面与状态，不会杀正在跑的模型调用。', '强制结束', run)
  else run()
} }
let replayBtnState = () => {}

const reqinput = $('#reqinput')
async function startRun() {
  if (running || replaying) { toast('当前有任务在跑，稍等'); return }
  const v = reqinput.value.trim()
  if (!v) { toast('先写一句需求，例如：做一个奶茶店点单页'); reqinput.focus(); return }
  setInputEnabled(false)
  const r = await post('/api/run', { requirement: v, polish: !$('#polishck') || $('#polishck').checked })
  if (r && r.error) { toast(r.error); setInputEnabled(true); return }
  toast('已下达需求，团队开工…')
}
$('#runbtn').onclick = startRun
reqinput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startRun() })
$('#sclose').onclick = () => $('#settle').classList.remove('on')
$('#again').onclick = () => { $('#settle').classList.remove('on'); setInputEnabled(!running); reqinput.focus() }
replayBtnState = () => { $('#replay').disabled = running || replaying || viewingPast }

// ===== 与角色对话（@点名） =====
const CHAT_ALIAS = { 项目经理: 'pm', 总: 'pm', pm: 'pm', 需求分析师: 'req', 需求: 'req', 需: 'req', req: 'req', 方案设计: 'des', 设计: 'des', 设: 'des', des: 'des', 编码开发: 'dev', 编码: 'dev', 码: 'dev', dev: 'dev', 测试工程: 'qa', 测试: 'qa', 测: 'qa', qa: 'qa', 文档工程: 'doc', 文档: 'doc', 档: 'doc', doc: 'doc' }
function addTyping(agentId) {
  removeTyping(agentId)
  const el = document.createElement('div'); el.className = 'typing'; el.id = 'typing-' + agentId; el.dataset.k = agentId
  el.style.setProperty('--c', COLOR[agentId] || '#9fb4d8')
  const b = document.createElement('b'); b.textContent = NAME[agentId] || agentId; b.style.color = COLOR[agentId] || '#9fb4d8'
  const s = document.createElement('span'); s.textContent = ' 正在输入…'
  el.appendChild(b); el.appendChild(s)
  drawer.appendChild(el); drawer.scrollTop = drawer.scrollHeight
}
function removeTyping(agentId) { const el = $('#typing-' + agentId); if (el) el.remove() }

const chatInput = $('#chat-input')
function buildChips() {
  const wrap = $('#chips'); if (!wrap) return
  for (const k of ['pm', 'req', 'des', 'dev', 'qa', 'doc']) {
    const b = document.createElement('button'); b.className = 'dchip'; b.style.setProperty('--c', DOTC[k] || COLOR[k])
    const dot = document.createElement('i'); dot.style.setProperty('--c', DOTC[k] || COLOR[k])
    b.appendChild(dot); b.appendChild(document.createTextNode(NAME[k]))
    b.onclick = () => { chatInput.value = '@' + NAME[k] + ' ' + chatInput.value.replace(/^\s*@\S+\s*/, ''); chatInput.focus() }
    wrap.appendChild(b)
  }
}
async function sendChat() {
  const raw = chatInput.value.trim()
  if (!raw) return
  let agent = 'pm'
  let body = raw
  const m = raw.match(/^\s*@([^\s，,：:]+)[\s，,：:]*([\s\S]*)$/)
  if (m) {
    agent = CHAT_ALIAS[m[1]] || CHAT_ALIAS[m[1].toLowerCase()] || null
    if (!agent) { toast('没有这个角色。可用：@项目经理 @需求分析师 @方案设计 @编码开发 @测试工程 @文档工程'); return }
    body = (m[2] || '').trim()
    if (!body) { toast('想说什么？写在 @' + m[1] + ' 后面'); return }
  }
  chatInput.value = ''
  chatInput.style.height = 'auto'
  { const sb = $('#chat-send'); if (sb) sb.disabled = true }
  const r = await post('/api/chat', { agent, text: body })
  if (r && r.error) { toast(r.error); chatInput.value = raw; { const sb = $('#chat-send'); if (sb) sb.disabled = false } }
}
$('#chat-send').onclick = sendChat
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } })
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto'
  chatInput.style.height = Math.min(120, chatInput.scrollHeight) + 'px'
  const sb = $('#chat-send'); if (sb) sb.disabled = !chatInput.value.trim()
})
buildChips()

// ===== 角色筛选（协作消息面板）=====
let msgFilter = 'all'
function buildFilter() {
  const wrap = $('#dfilter'); if (!wrap) return
  const mk = (k, label) => {
    const b = document.createElement('button'); b.className = 'dchip'; b.dataset.k = k
    const dot = document.createElement('i'); dot.style.setProperty('--c', DOTC[k] || 'var(--mut)'); b.appendChild(dot)
    b.appendChild(document.createTextNode(label))
    if (k === msgFilter) b.classList.add('on')
    b.onclick = () => { msgFilter = k; for (const el of wrap.children) el.classList.toggle('on', el.dataset.k === k); applyFilter() }
    wrap.appendChild(b)
  }
  mk('all', '全部')
  for (const k of ['pm', 'req', 'des', 'dev', 'qa', 'doc']) mk(k, NAME[k])
}
function applyFilter() {
  const body = $('#drawer'); if (!body) return
  for (const el of body.querySelectorAll('.msg,.typing')) {
    const k = el.dataset.k || ''
    el.style.display = (msgFilter === 'all' || k === msgFilter) ? '' : 'none'
  }
}
buildFilter()
{ const body = $('#drawer'); if (body) new MutationObserver(() => applyFilter()).observe(body, { childList: true }) }

// ===== 原型预览（全屏浮层） =====
function openProto(u) {
  const src = (typeof u === 'string' && u) ? u : lastPrototypeUrl
  if (!src) { toast('还没有原型产物'); return }
  $('#pframe').src = src
  $('#purl').textContent = src.split('/').slice(-2).join('/')
  $('#popen').href = src
  $('#proto').classList.add('on')
}
$('#pclose').onclick = () => { $('#proto').classList.remove('on'); setTimeout(() => { $('#pframe').src = 'about:blank' }, 300) }

// ===== 常驻原型预览按钮（结算弹窗之外的入口） =====
function updateProtoBtn() {
  const el = $('#tlproto'); if (!el) return
  if (lastPrototypeUrl) { el.style.display = ''; el.onclick = openProto } else { el.style.display = 'none' }
}
// ===== 常驻「成果」按钮（结算永不自动弹，收进按钮） =====
function updateSettleBtn() {
  const el = $('#tlsettle'); if (!el) return
  if (lastStats) { el.style.display = ''; el.onclick = () => showSettle(lastStats) } else { el.style.display = 'none' }
}
// ===== 产出物卡片行「可滑动」提示 =====
function updateDcards() {
  const dc = $('#dock'); const hint = $('#dhint'); if (!dc || !hint) return
  const more = dc.scrollWidth - dc.clientWidth - dc.scrollLeft > 10
  hint.classList.toggle('on', more)
  const panel = dc.closest('.panel')
  if (panel) panel.classList.toggle('scrollable', dc.scrollWidth - dc.clientWidth - dc.scrollLeft > 6)
}
$('#dhint').onclick = () => { const dc = $('#dock'); if (dc) dc.scrollBy({ left: 260, behavior: 'smooth' }) }
{ const dcEl = $('#dock'); if (dcEl) dcEl.addEventListener('scroll', updateDcards) }
addEventListener('resize', () => updateDcards())

// ===== 设置面板 v2（左导航 + 右内容） =====
let setData = null
let setTab = 'pool'
function setPaneTitle(pane, title, sub, actionBtn) {
  const head = document.createElement('div'); head.className = 'pghead'
  const col = document.createElement('div')
  const t = document.createElement('div'); t.className = 'pgtitle'; t.textContent = title
  const s = document.createElement('div'); s.className = 'pgsub'; s.textContent = sub
  col.appendChild(t); col.appendChild(s)
  head.appendChild(col)
  if (actionBtn) head.appendChild(actionBtn)
  pane.appendChild(head)
}
function setTile(k, v, dotCls) {
  const d = document.createElement('div'); d.className = 'hl'
  const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k
  const vv = document.createElement('div'); vv.className = 'v'
  if (dotCls) { const dot = document.createElement('span'); dot.className = 'dot2 ' + dotCls; vv.appendChild(dot) }
  const vt = document.createElement('span'); vt.textContent = v; vv.appendChild(vt)
  d.appendChild(kk); d.appendChild(vv)
  return d
}
function hexA(hex, a) {
  const h = String(hex || '').replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(n.slice(0, 2), 16) || 0, g = parseInt(n.slice(2, 4), 16) || 0, b = parseInt(n.slice(4, 6), 16) || 0
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
}
function setKV(parent, k, v, err) {
  const row = document.createElement('div'); row.className = 'kv'
  const kk = document.createElement('div'); kk.className = 'kk'; kk.textContent = k
  const vv = document.createElement('div'); vv.className = 'vv' + (err ? ' err' : ''); vv.textContent = v
  vv.dataset.tip = String(v == null ? '' : v)
  row.appendChild(kk); row.appendChild(vv); parent.appendChild(row)
  return row
}
function reasonLabel(reason) {
  const r = String(reason || '')
  if (/insufficient balance|余额/.test(r)) return '账户余额不足'
  if (/401|403|Authentication|api key/i.test(r)) return '认证失败'
  if (/timeout|ETIMEDOUT|timed out/i.test(r)) return '请求超时'
  if (/429|rate limit/i.test(r)) return '触发限流'
  return r.slice(0, 60) || '未知原因'
}
function renderSetNav() {
  const nav = $('#setnav'); nav.innerHTML = ''
  const bad = setData.providers.filter((p) => p.stats && p.stats.ok === false).length
  const tabs = [
    ['pool', '⬡', '模型池', bad ? '⚠ ' + bad : ''],
    ['roles', '◈', '团队分工', String(setData.roles.length)],
    ['fail', '⇄', '容灾路由', String(setData.failovers.length)],
    ['env', '⌘', '运行环境', ''],
    ['theme', '◐', '外观', ''],
  ]
  for (const [id, ico, label, badge] of tabs) {
    const b = document.createElement('button'); if (setTab === id) b.className = 'on'
    const i = document.createElement('span'); i.className = 'navico'; i.textContent = ico
    b.appendChild(i); b.appendChild(document.createTextNode(label))
    if (badge) { const bd = document.createElement('span'); bd.className = 'navbadge'; bd.textContent = badge; b.appendChild(bd) }
    b.onclick = () => { setTab = id; renderSetAll() }
    nav.appendChild(b)
  }
}
function applySelftest(pv, r) {
  if (!r) return
  pv.stats = pv.stats || {}
  pv.stats.ok = !!r.ok
  pv.stats.lastMs = r.ms
  pv.stats.lastAt = new Date().toLocaleString('zh-CN', { hour12: false })
  pv.stats.lastErr = r.ok ? null : String(r.error || '').slice(0, 160)
  if (r.ok) pv.stats.okCount = (pv.stats.okCount || 0) + 1
  else pv.stats.errCount = (pv.stats.errCount || 0) + 1
}
function renderPanePool(pane) {
  const d = setData
  const all = document.createElement('button'); all.className = 'sbtn'; all.textContent = '全部自检'
  all.onclick = async () => {
    all.disabled = true; all.classList.add('loading'); all.textContent = '检测中…'
    for (const pv of d.providers) { const r = await post('/api/selftest', { provider: pv.name }); applySelftest(pv, r) }
    all.disabled = false; all.classList.remove('loading'); all.textContent = '全部自检'
    toast('自检完成')
    renderSetAll()
  }
  setPaneTitle(pane, '模型池', '角色的调用按「团队分工」路由到对应提供商；任一家异常时自动切备用（见「容灾路由」）。自检只测原始连通性，不触发切换。', all)
  const online = d.providers.filter((p) => p.stats && p.stats.ok === true).length
  const keyed = d.providers.filter((p) => p.hasKey).length
  const hr = document.createElement('div'); hr.className = 'healthrow'
  const t1 = setTile('在线模型', online + ' / ' + d.providers.length, online === d.providers.length ? 'ok' : 'bad')
  t1.title = '在线模型数量：' + online + ' 个 / 共 ' + d.providers.length + ' 家（点「自检」刷新状态）'
  hr.appendChild(t1)
  hr.appendChild(setTile('已配钥匙', keyed + ' / ' + d.providers.length))
  hr.appendChild(setTile('容灾切换', d.failovers.length + ' 次'))
  hr.appendChild(setTile('历史运行', d.runs.count + ' 个'))
  pane.appendChild(hr)
  const grid = document.createElement('div'); grid.className = 'pvgrid'
  for (const pv of d.providers) {
    const st = pv.stats || null
    const state = st && st.ok === true ? 'ok' : (st && st.ok === false ? 'bad' : '')
    const card = document.createElement('div'); card.className = 'pvcard ' + state
    const head = document.createElement('div'); head.className = 'pvhead'
    const dot = document.createElement('span'); dot.className = 'dot2 ' + state
    const nm = document.createElement('span'); nm.className = 'pvname'; nm.textContent = (pv.label && pv.label !== pv.name) ? (pv.label + ' · ' + pv.name) : pv.name
    const chip = document.createElement('span'); chip.className = 'pvstate'
    chip.textContent = !pv.hasKey ? '未配置' : (st ? (st.ok === true ? '正常' : '异常') : '未检测')
    if (!pv.hasKey) chip.classList.add('plain')
    head.appendChild(dot); head.appendChild(nm); head.appendChild(chip)
    card.appendChild(head)
    const body = document.createElement('div'); body.className = 'pvbody'
    setKV(body, '模型', pv.model || '-')
    setKV(body, '端点', pv.endpoint || '-')
    const keyRow = setKV(body, '密钥', pv.hasKey ? pv.keyMasked : '缺失', !pv.hasKey)
    if (pv.hasKey && keyRow) {
      const cp = document.createElement('button'); cp.className = 'cpbtn'; cp.textContent = '⧉'
      cp.title = '复制密钥（掩码显示，出于安全不回显完整密钥）'
      cp.onclick = async () => {
        try { await navigator.clipboard.writeText(pv.keyMasked); cp.classList.add('ok'); toast('已复制掩码密钥'); setTimeout(() => cp.classList.remove('ok'), 900) }
        catch { toast('复制失败（浏览器未授权剪贴板）') }
      }
      keyRow.appendChild(cp)
    }
    setKV(body, '最近调用', st && st.lastAt ? st.lastAt : '尚未调用')
    setKV(body, '调用统计', st ? ('成功 ' + (st.okCount || 0) + ' · 失败 ' + (st.errCount || 0) + (st.lastMs ? (' · 最近 ' + st.lastMs + 'ms') : '')) : '—')
    if (st && st.ok === false && st.lastErr) setKV(body, '最近错误', st.lastErr, true)
    if (!pv.hasKey) {
      const krow = document.createElement('div'); krow.className = 'kv'
      const kk2 = document.createElement('div'); kk2.className = 'kk warn'; kk2.textContent = '密钥缺失'
      const wrap2 = document.createElement('div'); wrap2.style.cssText = 'flex:1;display:flex;gap:6px;min-width:0'
      const inp = document.createElement('input'); inp.type = 'password'; inp.className = 'keyin'; inp.placeholder = '粘贴 ' + (pv.label || pv.name) + ' API Key'; inp.autocomplete = 'off'
      const sv = document.createElement('button'); sv.className = 'sbtn'; sv.textContent = '保存'; sv.style.padding = '5px 12px'
      sv.onclick = async () => {
        sv.disabled = true; sv.textContent = '…'
        const rr = await post('/api/provider-key', { provider: pv.name, key: inp.value })
        sv.disabled = false; sv.textContent = '保存'
        if (rr && rr.ok) {
          toast('已保存 ' + pv.name + ' 密钥')
          const d2 = await fetch('/api/system').then((x) => x.json()).catch(() => null)
          if (d2) { setData = d2; renderSetAll() }
        } else toast('保存失败：' + ((rr && rr.error) || ''))
      }
      wrap2.appendChild(inp); wrap2.appendChild(sv)
      krow.appendChild(kk2); krow.appendChild(wrap2)
      body.appendChild(krow)
    }
    card.appendChild(body)
    const foot = document.createElement('div'); foot.className = 'pvfoot'
    const btn = document.createElement('button'); btn.className = 'sbtn'; btn.textContent = '自检'
    btn.onclick = async () => {
      btn.disabled = true; btn.classList.add('loading'); btn.textContent = '检测中'
      const r = await post('/api/selftest', { provider: pv.name })
      btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '自检'
      applySelftest(pv, r)
      toast(r && r.ok ? ('✅ ' + pv.name + ' 在线（' + r.ms + 'ms）') : ('❌ ' + pv.name + '：' + String((r && r.error) || '失败').slice(0, 50)))
      renderSetAll()
    }
    foot.appendChild(btn)
    card.appendChild(foot)
    grid.appendChild(card)
  }
  pane.appendChild(grid)
}
function renderPaneRoles(pane) {
  const d = setData
  setPaneTitle(pane, '团队分工', '给每个角色指定模型；「主模型」= config.json 里的默认提供商。改完下一轮运行生效，正在跑的轮次不受影响。')
  const table = document.createElement('div'); table.className = 'roletable'
  const head = document.createElement('div'); head.className = 'rtrow rthead'
  for (const t of ['角色', '当前模型', '切换模型']) { const c = document.createElement('span'); c.textContent = t; head.appendChild(c) }
  table.appendChild(head)
  for (const r of d.roles) {
    const row = document.createElement('div'); row.className = 'rtrow'
    const nm = document.createElement('div'); nm.className = 'rtname'
    const dot = document.createElement('span'); dot.className = 'dot2'; dot.style.background = r.color; dot.style.boxShadow = '0 0 7px ' + r.color
    const tx = document.createElement('span'); tx.textContent = r.name
    nm.appendChild(dot); nm.appendChild(tx)
    const cur = document.createElement('span'); cur.className = 'mbadge'
    cur.textContent = r.provider ? ((d.providers.find((p) => p.name === r.provider) || {}).label || r.provider) : '主模型'
    cur.style.color = r.color
    cur.style.borderColor = hexA(r.color, 0.4)
    cur.style.background = hexA(r.color, 0.1)
    const selWrap = document.createElement('div')
    const sel = document.createElement('select'); sel.className = 'rtsel'
    const opts = [['default', '主模型（默认）']].concat(d.providers.map((p) => [p.name, (p.label || p.name) + (p.hasKey ? '' : '（未配置）')]))
    for (const opt of opts) { const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sel.appendChild(o) }
    sel.value = r.provider || 'default'
    sel.onchange = async () => {
      const rr = await post('/api/role-assign', { id: r.id, provider: sel.value })
      if (rr && rr.ok) { r.provider = sel.value === 'default' ? null : sel.value; toast('已改：' + r.name + ' → ' + (sel.value === 'default' ? '主模型' : sel.value) + '（下轮生效）'); renderSetAll() }
      else toast('改失败：' + ((rr && rr.error) || ''))
    }
    selWrap.appendChild(sel)
    row.appendChild(nm); row.appendChild(cur); row.appendChild(selWrap)
    table.appendChild(row)
  }
  pane.appendChild(table)
}
// ===== 容错路由配置弹窗（新增 / 编辑共用）=====
let fmIndex = null
function openRouteModal(index, routes, triggers) {
  const d = setData || {}
  const provs = (d.providers || []).map((p) => p.name)
  const label = (n) => ((d.providers || []).find((p) => p.name === n) || {}).label || n
  const fromSel = $('#fmfrom'), toSel = $('#fmto')
  if (fromSel && !fromSel.options.length) {
    for (const n of provs) {
      const o = document.createElement('option'); o.value = n; o.textContent = label(n)
      fromSel.appendChild(o)
      toSel.appendChild(o.cloneNode(true))
    }
  }
  const cur = (index != null && routes && routes[index]) ? routes[index] : null
  fmIndex = cur ? index : null
  $('#fmtitle').textContent = cur ? '编辑容错路由' : '新增容错路由'
  if (fromSel) fromSel.value = cur ? cur.from : (provs[0] || '')
  if (toSel) toSel.value = cur ? cur.to : (provs[1] || provs[0] || '')
  $('#fmpri').value = cur ? cur.priority : ((routes && routes.length) + 1)
  const tw = $('#fmtrigs'); tw.innerHTML = ''
  for (const t of (triggers || ['超时', '限流', '认证', '余额'])) {
    const lb = document.createElement('label'); lb.className = 'trig'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = t
    const on = !cur || (cur.triggers || []).includes(t)
    cb.checked = on; if (on) lb.classList.add('on')
    cb.onchange = () => lb.classList.toggle('on', cb.checked)
    lb.appendChild(cb); lb.appendChild(document.createTextNode(t))
    tw.appendChild(lb)
  }
  $('#fmo').classList.add('on')
}
{ const x = $('#fmclose'); if (x) x.onclick = () => $('#fmo').classList.remove('on') }
{ const c = $('#fmcancel'); if (c) c.onclick = () => $('#fmo').classList.remove('on') }
{
  const s = $('#fmsave')
  if (s) s.onclick = async () => {
    const trigs = [...document.querySelectorAll('#fmtrigs input:checked')].map((i) => i.value)
    if (!trigs.length) { toast('至少选一种触发失败类型'); return }
    s.disabled = true; s.textContent = '保存中…'
    const r = await post('/api/routes', { index: fmIndex, route: { from: $('#fmfrom').value, to: $('#fmto').value, priority: Number($('#fmpri').value) || 1, triggers: trigs } })
    s.disabled = false; s.textContent = '保存路由'
    if (r && r.ok) {
      $('#fmo').classList.remove('on')
      toast(fmIndex == null ? '已新增容错路由' : '已保存修改')
      const d2 = await fetch('/api/system').then((x2) => x2.json()).catch(() => null)
      if (d2) { setData = d2; renderSetAll() }
    } else toast('保存失败：' + ((r && r.error) || '未知'))
  }
}

function renderPaneFail(pane) {
  const d = setData
  const addBtn = document.createElement('button'); addBtn.className = 'sbtn primary'; addBtn.textContent = '＋ 新增容错路由'
  addBtn.onclick = async () => { const r = await fetch('/api/routes').then((x) => x.json()).catch(() => null); openRouteModal(null, (r && r.routes) || [], (r && r.triggers) || null) }
  setPaneTitle(pane, '容灾路由', '', addBtn)
  // 顶部说明：ⓘ 图标 + 拆两行，降低阅读压力
  const info = document.createElement('div'); info.className = 'hinfo pginfo'
  const ii = document.createElement('span'); ii.className = 'ic'; ii.textContent = 'ⓘ'
  const iw = document.createElement('div')
  const l1 = document.createElement('div'); l1.className = 't1'
  l1.textContent = '任一模型调用失败（超时/限流/认证/余额）时，自动切换备用模型重试本次请求'
  const l2 = document.createElement('div'); l2.className = 't2'
  l2.textContent = '切换记录写入事件流，全程可审计，保障业务不中断'
  iw.appendChild(l1); iw.appendChild(l2)
  info.appendChild(ii); info.appendChild(iw)
  pane.appendChild(info)
  const flow = document.createElement('div'); flow.className = 'foflow'
  const mk = (name) => {
    const n = document.createElement('div'); n.className = 'fonode'
    const pv = d.providers.find((p) => p.name === name)
    const dt = document.createElement('span'); dt.className = 'dot2 ' + (pv && pv.stats ? (pv.stats.ok ? 'ok' : 'bad') : '')
    if (pv && pv.stats && !pv.stats.ok) n.classList.add('dead')
    const tx = document.createElement('span'); tx.textContent = name
    n.appendChild(dt); n.appendChild(tx)
    return n
  }
  const ar = document.createElement('div'); ar.className = 'foarrow'; ar.textContent = '⇄'
  flow.appendChild(mk('minimax')); flow.appendChild(ar); flow.appendChild(mk('deepseek'))
  const recent = (d.failovers || []).some((fo) => fo.ts && (Date.now() - fo.ts) < 90000)
  if (recent) flow.classList.add('active')
  pane.appendChild(flow)
  const fhint = document.createElement('div'); fhint.className = 'fohint'
  fhint.textContent = '路由预览（仅展示，不可直接编辑；编辑请点右上角「＋ 新增容错路由」）'
  pane.appendChild(fhint)
  const groups = new Map()
  for (const fo of d.failovers) {
    const rl = reasonLabel(fo.reason)
    const key = fo.from + '→' + fo.to + '|' + rl
    const g = groups.get(key) || { from: fo.from, to: fo.to, reason: rl, n: 0, ts: 0 }
    g.n++
    if (fo.ts && fo.ts > g.ts) g.ts = fo.ts
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 6)
  const log = document.createElement('div'); log.className = 'folog'
  if (!list.length) {
    const em = document.createElement('div'); em.className = 'foempty'
    const ic = document.createElement('span'); ic.className = 'ico'; ic.textContent = '◎'
    const t1 = document.createElement('div'); t1.textContent = '还没有发生切换 —— 主模型健康'
    const t2 = document.createElement('div'); t2.className = 'sub'
    t2.textContent = '当任一模型调用失败（超时 / 限流 / 余额 / 认证）时会自动切到备用模型，切换记录会实时出现在这里'
    em.appendChild(ic); em.appendChild(t1); em.appendChild(t2)
    pane.appendChild(em)
  } else {
    const g = document.createElement('div'); g.className = 'forogroup'
    const gh = document.createElement('div'); gh.className = 'fghead'
    const gd = document.createElement('span'); gd.className = 'dot2 bad'
    const gt = document.createElement('span'); gt.textContent = '切换记录 · 按「来源 → 目标 · 原因」聚合'
    const gn = document.createElement('span'); gn.className = 'fgnum'; gn.textContent = '共 ' + d.failovers.length + ' 次'
    gh.appendChild(gd); gh.appendChild(gt); gh.appendChild(gn); g.appendChild(gh)
    for (const gg of list) {
      const row = document.createElement('div'); row.className = 'frow'
      const tt = document.createElement('span'); tt.className = 'ft'
      tt.textContent = gg.ts ? new Date(gg.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'
      const tx = document.createElement('span'); tx.className = 'fm'; tx.textContent = gg.from + ' → ' + gg.to + '：' + gg.reason
      const c = document.createElement('span'); c.className = 'focount'; c.textContent = '× ' + gg.n
      row.appendChild(tt); row.appendChild(tx); row.appendChild(c)
      g.appendChild(row)
    }
    pane.appendChild(g)
  }
  // 已保存的自定义路由：按优先级升序，可编辑/删除（点击条目进编辑）
  fetch('/api/routes').then((x) => x.json()).then((r) => {
    const list = (r && r.routes) || []
    const s = document.createElement('div'); s.className = 'hdsec'; s.textContent = '已保存的自定义路由 · ' + list.length + ' 条'
    pane.appendChild(s)
    if (!list.length) {
      const em = document.createElement('div'); em.className = 'foempty'
      const ic = document.createElement('span'); ic.className = 'ico'; ic.textContent = '⇄'
      const t1 = document.createElement('div'); t1.textContent = '还没有自定义容错路由'
      const t2 = document.createElement('div'); t2.className = 'sub'
      t2.textContent = '点右上角「＋ 新增容错路由」创建第一条：设定主模型、备用模型、优先级与触发失败类型，主模型异常时按优先级自动切换。'
      const gb = document.createElement('button'); gb.className = 'sbtn primary'; gb.style.marginTop = '6px'
      gb.textContent = '＋ 新增第一条路由'
      gb.onclick = () => openRouteModal(null, list, (r && r.triggers) || null)
      em.appendChild(ic); em.appendChild(t1); em.appendChild(t2); em.appendChild(gb)
      pane.appendChild(em)
      return
    }
    const grp = document.createElement('div'); grp.className = 'forogroup'
    list.forEach((rt, idx) => {
      const row = document.createElement('div'); row.className = 'fororow'
      const ro = document.createElement('div'); ro.className = 'ro'
      const dd = document.createElement('span'); dd.className = 'dot2 ' + (rt.to === 'deepseek' ? 'ok' : 'ok')
      const tx = document.createElement('span'); tx.textContent = rt.from + ' → ' + rt.to
      ro.appendChild(dd); ro.appendChild(tx)
      const meta = document.createElement('div'); meta.className = 'rmeta'
      meta.textContent = '触发：' + ((rt.triggers || []).join(' / ') || '全部') + '（写进 config.json，下轮运行生效）'
      const pri = document.createElement('span'); pri.className = 'pri'; pri.textContent = 'P' + rt.priority
      const acts = document.createElement('div'); acts.className = 'ract'
      const be = document.createElement('button'); be.textContent = '编辑'
      be.onclick = (ev) => { ev.stopPropagation(); openRouteModal(idx, list, (r && r.triggers) || null) }
      const bd = document.createElement('button'); bd.className = 'del'; bd.textContent = '删除'
      bd.onclick = (ev) => {
        ev.stopPropagation()
        askConfirm('确定删除这条容错路由？', rt.from + ' → ' + rt.to + ' 将被移除，主模型异常时将按剩余路由的优先级切换。', '确定删除', async () => {
          const rr = await post('/api/routes-delete', { index: idx })
          if (rr && rr.ok) { toast('已删除路由'); const d2 = await fetch('/api/system').then((x2) => x2.json()).catch(() => null); if (d2) { setData = d2; renderSetAll() } }
          else toast('删除失败：' + ((rr && rr.error) || '未知'))
        })
      }
      acts.appendChild(be); acts.appendChild(bd)
      row.appendChild(ro); row.appendChild(pri); row.appendChild(meta); row.appendChild(acts)
      row.onclick = () => openRouteModal(idx, list, (r && r.triggers) || null)
      grp.appendChild(row)
    })
    pane.appendChild(grp)
  }).catch(() => {})
}
function renderPaneEnv(pane) {
  const d = setData
  setPaneTitle(pane, '运行环境', '本机单进程引擎（零依赖 node:http + SSE）；运行数据全部是文件，天然可审计、可迁移。')
  const grid = document.createElement('div'); grid.className = 'envgrid'
  grid.appendChild(setTile('Node', d.node))
  grid.appendChild(setTile('服务端口', '3722'))
  grid.appendChild(setTile('已运行', Math.round(d.uptimeS / 60) + ' 分钟'))
  grid.appendChild(setTile('历史运行', d.runs.count + ' 个'))
  grid.appendChild(setTile('磁盘占用', d.runs.sizeMB + ' MB'))
  pane.appendChild(grid)
  const note = document.createElement('div'); note.className = 'pgsub'; note.style.marginTop = '16px'
  note.textContent = '引擎：角色=数据（加角色零代码）· 事件溯源留痕 · 检查点断点续跑 · 删除=回收站（runs-trash 可捞回）'
  pane.appendChild(note)
}
function renderSetAll() {
  if (!setData) return
  renderSetNav()
  const pane = $('#setpane'); pane.innerHTML = ''
  if (setTab === 'pool') renderPanePool(pane)
  else if (setTab === 'roles') renderPaneRoles(pane)
  else if (setTab === 'fail') renderPaneFail(pane)
  else if (setTab === 'theme') renderPaneTheme(pane)
  else renderPaneEnv(pane)
  // 顶部说明过长 → 折叠（次要灰字 + 展开/收起）
  for (const sub of pane.querySelectorAll('.pgsub')) {
    if (String(sub.textContent || '').length <= 40) continue
    sub.classList.add('clamped')
    const tg = document.createElement('button'); tg.className = 'pgtoggle'; tg.textContent = '展开'
    tg.onclick = () => { const c = sub.classList.toggle('clamped'); tg.textContent = c ? '展开' : '收起' }
    sub.insertAdjacentElement('afterend', tg)
  }
}
// —— 主题 ——
const THEMES = [
  ['dark', '深空黑', '默认 · 深色宇宙感，现场投屏首选', '#05080e', '#4dd7c4'],
  ['mid', '石墨灰', '提亮一档 · 长时间盯着不累', '#10141c', '#4dd7c4'],
  ['light', '浅雾白', '亮色模式 · 白天办公 / 亮环境投影', '#eef1f6', '#0fa89a'],
]
function applyTheme(t) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem('pt-theme', t) } catch {}
}
function renderPaneTheme(pane) {
  const cur = document.documentElement.dataset.theme || 'dark'
  setPaneTitle(pane, '外观', '主题即时生效并记住选择（刷新不丢）。')
  const grid = document.createElement('div'); grid.className = 'pvgrid'
  for (const [id, name, desc, bg, acc] of THEMES) {
    const card = document.createElement('div'); card.className = 'pvcard' + (cur === id ? ' ok' : '')
    card.style.cursor = 'pointer'
    const head = document.createElement('div'); head.className = 'pvhead'
    const sw = document.createElement('span'); sw.style.cssText = 'width:22px;height:22px;border-radius:7px;border:2px solid ' + acc + ';background:' + bg + ';flex:0 0 auto'
    const nm = document.createElement('span'); nm.className = 'pvname'; nm.textContent = name
    const chip = document.createElement('span'); chip.className = 'pvstate'; chip.textContent = cur === id ? '使用中' : '点击切换'
    head.appendChild(sw); head.appendChild(nm); head.appendChild(chip)
    card.appendChild(head)
    const body = document.createElement('div'); body.className = 'pvbody'
    setKV(body, '风格', desc)
    card.appendChild(body)
    card.onclick = () => { applyTheme(id); toast('主题已切换：' + name); renderSetAll() }
    grid.appendChild(card)
  }
  pane.appendChild(grid)
}
async function openSettings() {
  $('#setov').classList.add('on')
  const pane = $('#setpane')
  pane.innerHTML = ''
  const load = document.createElement('div'); load.className = 'pgsub'; load.textContent = '读取系统信息…'
  pane.appendChild(load)
  const d = await fetch('/api/system').then((x) => x.json()).catch(() => null)
  if (!d) { pane.innerHTML = ''; const e = document.createElement('div'); e.className = 'pgsub'; e.textContent = '读不到系统信息（服务端可能未更新，重启一次即可）'; pane.appendChild(e); return }
  setData = d
  renderSetAll()
}
$('#setbtn').onclick = openSettings
$('#setclose').onclick = () => $('#setov').classList.remove('on')
$('#themebtn').onclick = () => {
  const order = THEMES.map((t) => t[0])
  const cur = document.documentElement.dataset.theme || 'dark'
  const next = order[(order.indexOf(cur) + 1) % order.length]
  applyTheme(next)
  const meta = THEMES.find((t) => t[0] === next)
  toast('主题：' + (meta ? meta[1] : next) + '（再点循环切换）')
}

// ===== 观测 HUD =====
function updateMetricsUI() {
  bump('s-call', metrics.calls)
  const t = $('#s-tok'); if (t) { const v = fmtK(metrics.tokens); if (t.textContent !== v) { t.textContent = v; flashBox(t) } }
}

// ===== 断点恢复横幅 =====
// 规则：① 手动停止的运行不打扰（去历史运行页手动恢复）② 同一次运行忽略/继续过一次就不再出现
function showResume(r) {
  const el = $('#resume'); if (!el || !r) return
  let muted = ''
  try { muted = localStorage.getItem('pt-resume-muted') || '' } catch {}
  const key = r.runId || r.dir || ''
  if (r.stopped) return
  if (muted && key && muted === key) return
  $('#rtext').textContent = '上次运行中断在「' + (r.stage || '进行中') + '」：' + String(r.requirement || '').slice(0, 28)
  el.dataset.key = key
  el.classList.add('on')
}
function muteResume() {
  const el = $('#resume')
  try { if (el && el.dataset.key) localStorage.setItem('pt-resume-muted', el.dataset.key) } catch {}
  if (el) el.classList.remove('on')
}
async function refreshResume() {
  try {
    const stt = await (await fetch('/api/state')).json()
    if (stt.resumable) showResume(stt.resumable)
  } catch {}
}
$('#rgo').onclick = async () => {
  muteResume()
  const r = await post('/api/resume', {})
  if (r && r.error) { toast(r.error); return }
  toast('已从断点恢复运行')
}
$('#rno').onclick = () => muteResume()

// ===== 历史运行 =====
let selRunId = null
async function openHist() {
  const r = await fetch('/api/runs').then((x) => x.json()).catch(() => null)
  const list = (r && r.runs) || []
  const box = $('#hlist'); box.innerHTML = ''
  $('#hdetail').classList.remove('on'); box.style.display = ''
  // 顶部轻提示条（紧贴标题下方，不再是独立大白框）
  const hb = $('#hbar')
  if (hb) {
    hb.innerHTML = ''
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = 'ⓘ'
    const wrap = document.createElement('div')
    const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = '共 ' + list.length + ' 条记录'
    const t2 = document.createElement('div'); t2.className = 't2'
    t2.appendChild(document.createTextNode('删除为软删除，可在 runs-trash 目录恢复；清理全部操作'))
    const b = document.createElement('b'); b.textContent = '保留正在运行中的任务'
    t2.appendChild(b)
    wrap.appendChild(t1); wrap.appendChild(t2)
    hb.appendChild(ic); hb.appendChild(wrap)
    hb.style.display = list.length ? '' : 'none'
  }
  if (!list.length) {
    const em = document.createElement('div'); em.className = 'hempty'
    const ic = document.createElement('span'); ic.className = 'ico'; ic.textContent = '◎'
    const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = '还没有历史运行'
    const t2 = document.createElement('div'); t2.className = 't2'
    t2.textContent = '在协作台输入一句需求点「开工」，跑完一轮后这里会留下完整留痕：协作消息、产出物、打回记录，可回放、可导出报告。'
    const gb = document.createElement('button'); gb.className = 'sbtn primary gb'; gb.textContent = '回到协作台开工 ▶'
    gb.onclick = () => $('#hist').classList.remove('on')
    em.appendChild(ic); em.appendChild(t1); em.appendChild(t2); em.appendChild(gb)
    box.appendChild(em)
  }
  for (const it of list) {
    const row = document.createElement('div'); row.className = 'hrow' + (it.id === selRunId ? ' sel' : '')
    const t1 = document.createElement('div'); t1.className = 'ht1'
    t1.textContent = (it.requirement || '(无需求记录)').slice(0, 60)
    const tags = document.createElement('div'); tags.className = 'htags'
    const mkTag = (ico, label, cls) => {
      const s = document.createElement('span'); s.className = 'htag' + (cls ? ' ' + cls : '')
      const i = document.createElement('span'); i.className = 'ico'; i.textContent = ico
      s.appendChild(i); s.appendChild(document.createTextNode(label))
      tags.appendChild(s)
    }
    if (it.interrupted) mkTag('⚠', '中断·可恢复', 'warn')
    mkTag('🕒', it.finishedAt ? new Date(it.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '未完成')
    if (it.stats) {
      mkTag('⏱', Math.round((it.stats.durationMs || 0) / 1000) + 's')
      mkTag('📦', '产出 ' + it.stats.artifacts + ' 件')
      mkTag('↩', '打回 ' + it.stats.retries + ' 次', it.stats.retries ? 'warn' : '')
    }
    mkTag(it.approved ? '✓' : (it.finishedAt ? '✕' : '●'), it.approved ? '已通过' : (it.finishedAt ? '未通过' : '进行中'), it.approved ? 'ok' : (it.finishedAt ? 'bad' : ''))
    row.appendChild(t1); row.appendChild(tags)
    row.onclick = () => { selRunId = it.id; for (const el of box.querySelectorAll('.hrow')) el.classList.toggle('sel', el === row); openRunDetail(it) }
    box.appendChild(row)
  }
  const hc = $('#hclear'); if (hc) hc.style.display = list.length ? '' : 'none'
  if (hc) hc.onclick = () => askConfirm('确定清理全部历史记录？', '将已完成的任务移入回收站（runs-trash），正在运行的任务不受影响。该操作不可撤销，但可从目录恢复。', '确定清理', async () => {
    const rr = await post('/api/runs-clear', {})
    toast(rr && rr.ok ? ('已清理 ' + rr.deleted + ' 条历史（可在 runs-trash 恢复）') : ('清理失败：' + ((rr && rr.error) || '未知')))
    setTimeout(openHist, 400)
  })
  $('#hist').classList.add('on')
}
// 两段式确认：第一次点击变成"再点一下确认"，3 秒后自动恢复
function confirmThen(el, fn) {
  if (el.dataset.confirm === '1') { el.dataset.confirm = ''; fn(); return }
  el.dataset.confirm = '1'
  if (el.tagName === 'BUTTON') {
    const old = el.textContent
    el.classList.add('confirm'); el.textContent = '再点一次确认！'
    setTimeout(() => { if (el.dataset.confirm === '1') { el.dataset.confirm = ''; el.classList.remove('confirm'); el.textContent = old } }, 3200)
  } else {
    el.style.borderColor = 'rgba(255,92,92,.7)'
    const t = el.querySelector('.ht2'); const old = t ? t.textContent : ''
    if (t) t.textContent = '再点一下确认！'
    setTimeout(() => { if (el.dataset.confirm === '1') { el.dataset.confirm = ''; el.style.borderColor = ''; if (t) t.textContent = old } }, 3200)
  }
}
// 详情面板：点开一条历史 → 看内容（产物/消息/打回），不是直接重放
async function openRunDetail(it) {
  const d = await fetch('/api/runs/' + encodeURIComponent(it.id)).then((x) => x.json()).catch(() => null)
  if (!d || !d.history) { toast('读不到这个运行'); return }
  const box = $('#hdetail'); box.innerHTML = ''
  const back = document.createElement('button'); back.className = 'hdback'; back.textContent = '← 返回列表'
  back.onclick = () => { box.classList.remove('on'); $('#hlist').style.display = '' }
  box.appendChild(back)
  const title = document.createElement('div'); title.className = 'hdtitle'
  title.textContent = (d.meta && d.meta.requirement) || it.requirement || '(无需求记录)'
  const stt = (d.meta && d.meta.stats) || {}
  const head = document.createElement('div'); head.className = 'hdhead'
  head.appendChild(title)
  const meta = document.createElement('div'); meta.className = 'hdmeta'
  const dchip = (label, val, mono) => {
    const s = document.createElement('span'); s.className = 'hdchip' + (mono ? ' mono' : '')
    const b = document.createElement('b'); b.textContent = label
    s.appendChild(b); s.appendChild(document.createTextNode(val))
    return s
  }
  const when = it.finishedAt ? new Date(it.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '未完成'
  meta.appendChild(dchip('RUN ', it.id, true))
  meta.appendChild(dchip('时间 ', when))
  if (stt.durationMs) meta.appendChild(dchip('用时 ', Math.round(stt.durationMs / 1000) + 's'))
  if (stt.artifacts != null) meta.appendChild(dchip('产出 ', stt.artifacts + ' 件'))
  if (stt.retries) meta.appendChild(dchip('打回 ', stt.retries + ' 次'))
  meta.appendChild(dchip('状态 ', it.approved ? '审批通过' : (it.finishedAt ? '未通过' : '进行中')))
  head.appendChild(meta)
  box.appendChild(head)
  // —— 产出物 ——
  const arts = d.history.filter((e) => e.type === 'artifact')
  const s1 = document.createElement('div'); s1.className = 'hdsec'; s1.textContent = '产出物 · ' + arts.length + ' 件'
  box.appendChild(s1)
  const seen = new Set()
  for (const a of arts) {
    const key = a.rel || a.name
    if (seen.has(key)) continue
    seen.add(key)
    const row = document.createElement('div'); row.className = 'hdrow'
    const ex = extOf(a.name)
    const ext = document.createElement('span'); ext.className = 'hext ' + String(ex).toLowerCase(); ext.textContent = ex
    const nm = document.createElement('span'); nm.className = 'fn'; nm.textContent = a.name
    nm.dataset.tip = a.name
    row.appendChild(ext); row.appendChild(nm)
    if (a.url) {
      const op = document.createElement('a'); op.href = a.url; op.target = '_blank'; op.rel = 'noopener'; op.textContent = '打开 ↗'
      row.appendChild(op)
      if (String(a.rel || '').includes('prototype/')) {
        const pv = document.createElement('a'); pv.href = '#'; pv.textContent = '预览'
        pv.onclick = (e) => { e.preventDefault(); $('#hist').classList.remove('on'); openProto(a.url) }
        row.appendChild(pv)
      }
    }
    box.appendChild(row)
  }
  // —— 协作消息 ——
  const msgs = d.history.filter((e) => e.type === 'msg')
  const s2 = document.createElement('div'); s2.className = 'hdsec'; s2.textContent = '协作消息 · ' + msgs.length + ' 条'
  box.appendChild(s2)
  for (const m of msgs) {
    const row = document.createElement('div'); row.className = 'hdmsg'
    const who = document.createElement('span'); who.className = 'who'; who.style.color = DOTC[m.agent] || COLOR[m.agent] || '#9FB4D8'
    who.textContent = (NAME[m.agent] || m.agent || '') + '：'
    const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = m.text || ''
    row.appendChild(who); row.appendChild(txt)
    box.appendChild(row)
  }
  // —— 打回记录 ——
  const rejs = d.history.filter((e) => e.type === 'reject')
  if (rejs.length) {
    const s3 = document.createElement('div'); s3.className = 'hdsec'; s3.textContent = '打回记录 · ' + rejs.length + ' 次'
    box.appendChild(s3)
    for (const rj of rejs) {
      const row = document.createElement('div'); row.className = 'hdrow'
      row.textContent = (rj.label || '') + '：' + String((rj.issues || []).join('；')).slice(0, 160)
      box.appendChild(row)
    }
  }
  // —— 操作行 ——
  const acts = document.createElement('div'); acts.className = 'hdactions'
  const b1 = document.createElement('button'); b1.textContent = '▶ 在协作台回放'
  b1.onclick = () => { $('#hist').classList.remove('on'); viewRun(it) }
  const b2 = document.createElement('button'); b2.textContent = '📂 打开文件夹'
  b2.onclick = () => post('/api/reveal', { runId: it.id })
  const b3 = document.createElement('button'); b3.textContent = '⬇ 导出报告'
  b3.onclick = () => window.open('/api/runs/' + encodeURIComponent(it.id) + '/report', '_blank')
  const b4 = document.createElement('button'); b4.className = 'danger'; b4.textContent = '🗑 删除这条'
  b4.onclick = () => askConfirm('确定删除这条历史？', '将把整轮运行记录移入 runs-trash（软删除，可恢复）。', '确定删除', async () => {
    const rr = await fetch('/api/runs/' + encodeURIComponent(it.id), { method: 'DELETE' }).then((x) => x.json()).catch(() => null)
    if (rr && rr.ok) { toast('已删除 ' + it.id); openHist() }
    else toast('删除失败：' + ((rr && rr.error) || '未知'))
  })
  acts.appendChild(b1); acts.appendChild(b2); acts.appendChild(b3); acts.appendChild(b4)
  box.appendChild(acts)
  $('#hlist').style.display = 'none'
  box.classList.add('on')
}
async function viewRun(it) {
  const d = await fetch('/api/runs/' + encodeURIComponent(it.id)).then((x) => x.json()).catch(() => null)
  if (!d || !d.history || !d.history.length) { toast('读不到这个运行'); return }
  $('#hist').classList.remove('on')
  viewingPast = true
  hist = d.history.slice()
  lastRunId = it.id
  lastPrototypeUrl = it.hasPrototype ? '/runs/' + it.id + '/artifacts/prototype/index.html' : null
  const rd2 = [...d.history].reverse().find((e) => e.type === 'run_done' && e.stats)
  lastStats = rd2 ? rd2.stats : null
  updateProtoBtn(); updateSettleBtn()
  renderUpTo(hist.length - 1)
  const tv = $('#tllive'); if (tv) tv.style.display = ''
  setInputEnabled(false); replayBtnState()
  toast('正在回看：' + it.id + '（点「回到实时」退出）')
}
$('#histbtn').onclick = openHist
$('#hclose').onclick = () => $('#hist').classList.remove('on')

// ===== 时间轴拖拽回看 =====
function renderUpTo(idx) {
  if (!hist.length) return
  idx = Math.max(0, Math.min(idx, hist.length - 1))
  resetBoard(null)
  const upto = hist.slice(0, idx + 1)
  for (const ev of upto) { try { applyEvent(ev, true) } catch {} }
  const t0 = hist[0] && hist[0].ts
  if (t0 && upto[idx]) clockFreeze(Math.max(0, (upto[idx].ts || t0) - t0))
  $('#tlfill').style.width = ((idx + 1) / hist.length) * 100 + '%'
  const ts = $('#tlseek'); if (ts) ts.value = ((idx + 1) / hist.length) * 100
}
const tlseekEl = $('#tlseek')
if (tlseekEl) {
  tlseekEl.addEventListener('input', () => {
    if (!hist.length) return
    viewingPast = true
    const tv = $('#tllive'); if (tv) tv.style.display = ''
    const idx = Math.round((Number(tlseekEl.value) / 100) * (hist.length - 1))
    renderUpTo(idx)
    setInputEnabled(false)
  })
}
$('#tllive').onclick = () => {
  viewingPast = false
  $('#tllive').style.display = 'none'
  renderUpTo(hist.length - 1)
  setInputEnabled(!running)
  replayBtnState()
  updateProtoBtn()
  toast('已回到实时')
}

async function replayHistory() {
  if (running || replaying || viewingPast) { toast(viewingPast ? '回看中——先点「回到实时」' : '忙线中，稍后再回放'); return }
  let stt = null
  try { stt = await (await fetch('/api/state')).json() } catch {}
  if (!stt || !stt.history || !stt.history.length) { toast('还没有可回放的运行'); return }
  replaying = true; setInputEnabled(false); replayBtnState()
  toast('回放本次运行…')
  resetBoard((stt.current && stt.current.requirement) || null)
  let prevTs = null
  for (const ev of stt.history) {
    if (prevTs) { const gap = Math.min(900, Math.max(60, (ev.ts - prevTs) / 3)); if (gap > 80) await sleep(gap) }
    prevTs = ev.ts
    applyEvent(ev, false)
  }
  replaying = false; running = false; setInputEnabled(true); replayBtnState()
  appliedRun = (stt.history.find((e) => e.runId) || {}).runId || appliedRun
  lastApplied = maxSeq(stt.history)
  toast('回放结束')
}
$('#replay').onclick = replayHistory

// ===== 启动 =====
async function boot() {
  document.body.classList.add('rebooting')
  try {
    const stt = await (await fetch('/api/state')).json()
    if (stt && stt.history && stt.history.length) {
      hist = stt.history.slice()
      markSeen(stt.history)
      for (const ev of stt.history) { try { applyEvent(ev, true) } catch (err) { console.warn('rebuild', err) } }
      appliedRun = (stt.history.find((e) => e.runId) || {}).runId || (stt.current && stt.current.id) || null
      lastApplied = maxSeq(stt.history)
      lastRunId = (stt.current && stt.current.id) || (stt.history.find((e) => e.type === 'run_start' && e.runId) || {}).runId || null
      const rd = [...stt.history].reverse().find((e) => e.type === 'run_done' && e.stats)
      if (rd) lastStats = rd.stats
      if (stt.running) { running = true; clockStart(stt.current && stt.current.startedAt) }
      else { running = false }
    } else {
      const m = document.createElement('div'); m.className = 'msg'; m.style.setProperty('--c', '#8695ab')
      m.innerHTML = '<b>协作台</b><span>输入一句话需求，六个角色开工：拆解 → 需求 → 设计 → 编码 → 真浏览器测试 → 文档 → 人工审批。</span>'
      drawer.appendChild(m)
    }
    if (stt && stt.resumable) showResume(stt.resumable)
  } catch {}
  setInputEnabled(!running)
  replayBtnState()
  updateProtoBtn()
  updateSettleBtn()
  updateDcards()
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('rebooting')))
  const es = new EventSource('/events')
  es.onopen = () => setConn(true)
  es.onerror = () => setConn(false)
  // 诊断探针（排查实时链路用，不影响功能）
  window.__dbg = () => ({ viewingPast, appliedRun, lastApplied, histLen: hist.length, running, replaying, msgs, seenSize: seenKeys.size, lastKeys: [...seenKeys].slice(-6), seenHas: (k) => seenKeys.has(k) })
  es.onmessage = (e) => {
    if (replaying) return
    let ev = null
    try { ev = JSON.parse(e.data) } catch { return }
    if (typeof ev.seq === 'number') { const k = evKey(ev); if (seenKeys.has(k)) return; seenKeys.add(k) }
    hist.push(ev)
    if (!viewingPast || ev.type === 'chat') applyEvent(ev, false)
    if (ev.runId && ev.runId !== appliedRun) { appliedRun = ev.runId; lastApplied = 0 }
    if (typeof ev.seq === 'number') lastApplied = Math.max(lastApplied, ev.seq)
  }
}
// ===== 项目库 / 记忆区 =====
const RMETA = { pm: ['项目经理', '#86909C'], req: ['需求分析师', '#4080E8'], des: ['方案设计', '#9B6CD9'], dev: ['编码开发', '#00B8C4'], qa: ['测试工程', '#F28C38'], doc: ['文档工程', '#86909C'] }
{ const b = $('#projbtn'); if (b) b.onclick = () => { location.href = '/projects' } }
{ const b = $('#projclose'); if (b) b.onclick = () => $('#proj').classList.remove('on') }
{ const b = $('#memobtn'); if (b) b.onclick = () => { location.href = '/memory' } }
{ const b = $('#memoclose'); if (b) b.onclick = () => $('#memo').classList.remove('on') }

async function renderProjects() {
  const grid = $('#projgrid'), grow = $('#projgrowth')
  grid.innerHTML = '<div class="empty2">读取中…</div>'; grow.innerHTML = ''
  const j = await fetch('/api/projects').then((r) => r.json()).catch(() => null)
  const list = (j && j.projects) || []
  grid.innerHTML = ''
  if (!list.length) { grid.innerHTML = '<div class="empty2">还没有项目 —— 回协作台开一次工，这里就会出现第一张卡片</div>'; return }
  // 成长曲线（设计分趋势，越往右越新）
  const scored = list.slice().reverse().filter((p) => p.scores && p.scores.design != null)
  for (const p of scored.slice(-20)) {
    const bar = document.createElement('div'); bar.className = 'bar2'
    bar.style.height = Math.max(6, Math.round((p.scores.design / 100) * 50)) + 'px'
    bar.title = `${p.requirement.slice(0, 30)} · 设计 ${p.scores.design} 分`
    const t = document.createElement('b'); t.textContent = p.scores.design; bar.appendChild(t)
    grow.appendChild(bar)
  }
  if (scored.length) { const lb = document.createElement('span'); lb.style.cssText = 'font-size:10px;color:var(--mut);align-self:flex-end;margin-left:8px;padding-bottom:2px'; lb.textContent = `设计分趋势（${scored.length} 次有分数记录）`; grow.appendChild(lb) }
  for (const p of list) {
    const card = document.createElement('div'); card.className = 'pcard2'
    const th = document.createElement('div'); th.className = 'pthumb'
    if (p.thumb) { const im = document.createElement('img'); im.src = p.thumb; im.loading = 'lazy'; im.alt = ''; th.appendChild(im) }
    else { const ph = document.createElement('div'); ph.className = 'ph2'; ph.textContent = '⬡'; th.appendChild(ph) }
    card.appendChild(th)
    const body = document.createElement('div'); body.className = 'pbody'
    const nm = document.createElement('div'); nm.className = 'pname'; nm.textContent = p.requirement; nm.title = p.requirement; body.appendChild(nm)
    const meta = document.createElement('div'); meta.className = 'pmeta'
    const badge = (txt, cls) => { const s = document.createElement('span'); s.className = 'pbadge ' + (cls || ''); s.textContent = txt; return s }
    if (p.at) meta.appendChild(badge('🕒 ' + p.at, 'dim'))
    if (p.durationMs) meta.appendChild(badge('⏱ ' + (p.durationMs / 1000).toFixed(0) + 's', 'dim'))
    meta.appendChild(badge(p.approved === true ? '✅ 已交付' : p.stopped ? '⏸ 已停止' : p.approved === false ? '↩ 被打回' : '◐ ' + String(p.stage || ''), p.approved === true ? 'ok' : p.stopped ? 'warn' : ''))
    if (p.scores) {
      if (p.scores.design != null) meta.appendChild(badge('设计 ' + p.scores.design, 'brand'))
      if (p.scores.quality != null) meta.appendChild(badge('质量 ' + p.scores.quality))
      if (p.scores.coverage != null) meta.appendChild(badge('覆盖 ' + Math.round(p.scores.coverage * 100) + '%', p.scores.coverage >= 0.8 ? 'ok' : 'warn'))
    }
    if (p.files) meta.appendChild(badge('📦 ' + p.files + ' 件'))
    if (p.cert) meta.appendChild(badge('📜 有证书', 'ok'))
    body.appendChild(meta)
    if (p.git && p.git.length) {
      const gl = document.createElement('div'); gl.className = 'pmeta'
      for (const g of p.git.slice(0, 3)) gl.appendChild(badge(`${g.hash} ${g.author} · ${String(g.msg).slice(0, 20)}`))
      body.appendChild(gl)
    }
    card.appendChild(body)
    const acts = document.createElement('div'); acts.className = 'pacts'
    const mk = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; return b }
    acts.appendChild(mk('▶ 打开原型', () => window.open(`/runs/${p.id}/artifacts/prototype/index.html`, '_blank')))
    if (p.cert) acts.appendChild(mk('📜 看证书', () => window.open(`/runs/${p.id}/artifacts/certificate.json`, '_blank')))
    card.appendChild(acts)
    grid.appendChild(card)
  }
}

async function renderMemory() {
  const grid = $('#memogrid')
  grid.innerHTML = '<div class="empty2">读取中…</div>'
  const j = await fetch('/api/memory').then((r) => r.json()).catch(() => null)
  if (!j) { grid.innerHTML = '<div class="empty2">读取失败</div>'; return }
  grid.innerHTML = ''
  const rc = Object.values(j.stats.roles || {}).reduce((a, b) => a + b, 0)
  const cc = $('#memocount')
  if (cc) { cc.className = 'mcount'; cc.style.cssText = ''; cc.textContent = `共 ${rc + (j.stats.project || 0)} 条 · 角色 ${rc} · 项目 ${j.stats.project || 0}` }
  // 把 "- [日期] [分类] 正文" 拆成「前置信息」和「正文」，正文才是主文字
  const parse = (l) => {
    const s = String(l).replace(/^-\s*/, '')
    const m = s.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*)$/)
    return m ? { date: m[1], tag: m[2], text: m[3] } : { date: '', tag: '', text: s }
  }
  const mkCard = (title, color, lines, scope, id) => {
    const c = document.createElement('div'); c.className = 'mcard2'
    const h = document.createElement('div'); h.className = 'mhead'
    const d = document.createElement('span'); d.className = 'dot3'; d.style.background = color; h.appendChild(d)
    h.appendChild(document.createTextNode(`${title} · ${lines.length}`))
    c.appendChild(h)
    if (!lines.length) {
      const e = document.createElement('div'); e.className = 'mempty'
      const ic = document.createElement('span'); ic.className = 'ic2'; ic.textContent = '◎'
      const t = document.createElement('span'); t.textContent = '还没有记忆'
      e.appendChild(ic); e.appendChild(t); c.appendChild(e)
      return c
    }
    for (const l of lines.slice().reverse()) {
      const { date, tag, text } = parse(l)
      const row = document.createElement('div'); row.className = 'mrow'
      if (date || tag) {
        const pre = document.createElement('div'); pre.className = 'pre'
        if (date) { const b = document.createElement('b'); b.textContent = date; pre.appendChild(b) }
        if (tag) { const s2 = document.createElement('span'); s2.textContent = tag; pre.appendChild(s2) }
        row.appendChild(pre)
      }
      const tx = document.createElement('span'); tx.className = 'txt'; tx.textContent = text; row.appendChild(tx)
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = '忘掉这条'
      x.onclick = async () => {
        const r = await post('/api/memory-forget', { scope, id, text: String(l).replace(/^-\s*/, '') })
        if (r && r.ok) { toast('已忘掉这条'); await renderMemory() } else toast('没找到这条')
      }
      row.appendChild(x); c.appendChild(row)
    }
    return c
  }
  grid.appendChild(mkCard('📌 项目记忆 / 全局规范', 'var(--brand)', j.project || [], 'project', 'project'))
  for (const id of ['dev', 'qa', 'des', 'req', 'pm', 'doc']) grid.appendChild(mkCard((RMETA[id] || [id])[0], (RMETA[id] || ['', 'var(--mut)'])[1], (j.roles && j.roles[id]) || [], 'role', id))
}

// 兜底：2.5 秒后强制清掉入场动画（标签页被冻结/节流时动画可能永远跑不完 →
// 元素会停在起始帧；这一刀保证页面最终一定是"自然可见"的状态）
setTimeout(() => { try { document.body.classList.add('pt-shot') } catch {} }, 2500)
layout(); setTimeout(layout, 350)
boot()
