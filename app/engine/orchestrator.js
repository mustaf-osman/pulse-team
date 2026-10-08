// Pulse 虚拟团队 · 编排器 v2
// 一句话需求 → 六角色协同 → 真实产出 → 人工审批
// 新特性：多模型路由 / 检查点断点续跑 / 真并行（测试预写用例）/ 视觉打磨工序 / 审批打回带意见
import fs from 'node:fs'
import path from 'node:path'
import { chat } from './llm.js'
import { emit, setRun } from './bus.js'
import { createRun, writeArtifact, artifactUrl, RUNS_DIR } from './workspace.js'
import { loadRoles } from './roles.js'
import { runWebTest } from './webtest.js'
import { designAudit, designLine } from './designaudit.js'
import { visualReview, visionLine } from './vision.js'
import { htmlValidate, axeAudit, compileCheck, packagePrototype, verifyLine } from './verify.js'
import { memoryBlock, learnFromRun } from './memory.js'
import { coverageAudit, coverageLine } from './coverage.js'
import { qualityAudit, qualityLine } from './quality.js'
import { injectUikit } from './uikit.js'
import { issueCertificate } from './certificate.js'
import { gitInit, gitCommit, gitLog } from './gitrepo.js'

let running = false
let current = null
let gateResolve = null
let stopFlag = false

// ===== 真停止（用户点"停止"就走这里）=====
export class StoppedError extends Error {
  constructor(paused = false) { super(paused ? '等待人工批复超时' : '已手动停止'); this.code = 'STOPPED'; this.paused = paused }
}
// 置停止标志 + 先释放审批门（审批门是无限等待的，不放它整个流程就永远醒不过来）
export function requestStop() {
  const wasRunning = running
  stopFlag = true
  let gateReleased = false
  if (gateResolve) { const r = gateResolve; gateResolve = null; gateReleased = true; try { r('stop') } catch {} }
  return { wasRunning, gateReleased }
}
// 强制清空运行状态：引擎已经不认得这次运行、但界面卡在"运行中"时用
export function forceIdle() {
  stopFlag = true
  if (gateResolve) { const r = gateResolve; gateResolve = null; try { r('stop') } catch {} }
  const was = running
  running = false
  return { wasRunning: was, forced: true }
}
export function isStopping() { return stopFlag }
function checkStop() { if (stopFlag) throw new StoppedError() }
let gateNote = null

export function isRunning() { return running }
export function getCurrent() { return current }
export function resolveGate(approve, note) {
  gateNote = typeof note === 'string' ? note.trim() : ''
  if (gateResolve) { const r = gateResolve; gateResolve = null; r(!!approve) }
}
export function restoreCurrent(c) { current = c }

const stripFences = (s) => {
  let t = String(s || '').trim()
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')
  return t.trim()
}
const pickJson = (s) => {
  const a = String(s || '').indexOf('{')
  const b = String(s || '').lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}
const headTail = (s, cap = 24000) => (s && s.length > cap ? s.slice(0, cap / 2) + '\n…（中间省略）…\n' + s.slice(-cap / 2) : s || '')

// 生成长 HTML：若输出被截断（没到 </html>），自动请求续写（最多 2 次）
export async function generateHtml(role, userPrompt) {
  const mem = memoryBlock(role.id || 'dev', userPrompt)
  let out = stripFences((await chat({ system: role.prompt + mem, user: userPrompt, temperature: role.temp, maxTokens: 8000, provider: role.provider, model: role.model })).content)
  for (let i = 0; i < 2; i++) {
    if (/<\/html>\s*$/i.test(out)) break
    const tail = out.slice(-1400)
    const cont = stripFences((await chat({
      system: role.prompt,
      user: `下面是你正在生成的单文件 HTML 的结尾片段。请紧接着它继续输出剩余代码——只输出后续代码，不要重复已有内容，不要任何解释：\n\n${tail}`,
      temperature: role.temp, maxTokens: 8000, provider: role.provider, model: role.model,
    })).content)
    if (!cont) break
    out = out + '\n' + cont
  }
  return out
}

// ---- 检查点（断点续跑）----
function saveCheckpoint(run, payload) {
  try { fs.writeFileSync(path.join(run.dir, 'checkpoint.json'), JSON.stringify(payload, null, 2)) } catch {}
}
export function findResumable(opts = {}) {
  const allowStale = !!opts.allowStale
  try {
    const names = fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()
    for (const name of names.slice(0, 6)) {
      const dir = path.join(RUNS_DIR, name)
      const cp = path.join(dir, 'checkpoint.json')
      if (!fs.existsSync(cp)) continue
      let data = null
      try { data = JSON.parse(fs.readFileSync(cp, 'utf-8')) } catch { continue }
      if (!data || data.done) continue
      if (!data.ctx || !data.ctx.requirement) continue
      if (!allowStale) {
        // ① 手动停止的运行不再弹「继续运行」打扰用户（历史运行页里仍可手动恢复）
        if (data.stopped || data.stage === 'stopped') continue
        // ② 末尾事件就是手动停止的
        try {
          const evFile = path.join(dir, 'events.jsonl')
          if (fs.existsSync(evFile)) {
            const lines = fs.readFileSync(evFile, 'utf-8').trim().split('\n')
            const last = lines[lines.length - 1] || ''
            if (last.includes('"run_stop"')) continue
          }
        } catch {}
        // ③ 超过 6 小时的陈旧断点不再自动弹（历史运行页里仍可手动恢复）
        const saved = data.savedAt ? Date.parse(data.savedAt) : 0
        if (saved && Date.now() - saved > 6 * 3600 * 1000) continue
      }
      return { runId: name, dir, stage: data.stage, requirement: data.ctx.requirement, savedAt: data.savedAt || null }
    }
  } catch {}
  return null
}

const STAGE_LABEL = {
  '1-req': '需求分析', '2-des': '方案设计', '3-dev': '编码开发', '4-test': '自动化测试',
  '5-polish': '视觉打磨', '6-qa': '测试报告', '7-doc': '交付文档', '8-gate': '人工审批',
}

export async function startRun({ requirement, autoApprove = false, polish = true, resume = null }) {
  if (running) throw new Error('已有任务在运行，等它跑完')
  running = true
  stopFlag = false

  const roles = Object.fromEntries(loadRoles().map((r) => [r.id, r]))
  // 团队记忆：加载角色时把该角色 + 项目的历史经验附加到提示词（模型每次都是白纸，记忆靠这里补）
  for (const id of Object.keys(roles)) {
    const blk = memoryBlock(id, '')
    if (blk) roles[id] = { ...roles[id], prompt: roles[id].prompt + blk }
  }
  const role = (id) => roles[id]
  const run = resume && resume.dir
    ? { id: path.basename(resume.dir), dir: resume.dir, artifactsDir: path.join(resume.dir, 'artifacts') }
    : createRun()
  setRun(run.dir)
  // 一次交付 = 一个真 git 仓库（git log 就是交付史，作者是角色）
  try { gitInit(run.dir); gitCommit(run.dir, `开工：${String(requirement || '').slice(0, 60)}`, 'user') } catch {}

  const ctx = resume && resume.ctx ? { ...resume.ctx } : {}
  requirement = ctx.requirement || requirement
  if (ctx.autoApprove != null) autoApprove = !!ctx.autoApprove
  if (ctx.polish != null) polish = !!ctx.polish
  ctx.requirement = requirement
  ctx.autoApprove = autoApprove
  ctx.polish = polish

  const t0 = Date.now()
  let msgs = 0
  let artifacts = 0
  let retries = 0
  let audit = null
  let visionRes = null
  let verifyRes = null
  let cov = null
  let quality = null
  let plan = ctx.plan || null
  let prd = ctx.prd || null
  let design = ctx.design || null
  let html = ctx.html || null
  let web = ctx.web || null
  let qaPrep = ctx.qaPrep || null
  current = { id: run.id, dir: run.dir, requirement, startedAt: Date.now(), autoApprove, resumed: !!resume }

  const say = (agent, text) => { msgs++; emit('msg', { agent, text }) }
  const state = (agent, st, action) => emit('agent', { agent, st, action })
  const put = (agent, rel, content) => {
    writeArtifact(run, rel, content)
    artifacts++
    emit('artifact', { agent, name: path.basename(rel), rel, url: artifactUrl(run, rel) })
    // 每次产出落盘 = 一次真实 commit（作者是产出它的角色）→ git log 就是交付史
    try { gitCommit(run.dir, `产出 ${rel}`, agent) } catch {}
    return path.join(run.artifactsDir, rel)
  }
  const snap = (stage) => {
    if (stopFlag && stage !== 'error') throw new StoppedError()   // 每道工序之间检查"用户是否点了停止"
    ctx.plan = plan; ctx.prd = prd; ctx.design = design; ctx.html = html; ctx.web = web; ctx.qaPrep = qaPrep
    saveCheckpoint(run, { stage, done: false, savedAt: new Date().toISOString(), ctx })
  }
  const done = (extra = {}) => {
    const stats = { durationMs: Date.now() - t0, msgs, artifacts, retries, ...extra }
    current = { ...current, finishedAt: Date.now(), stats }
    return stats
  }

  try {
    if (!resume) {
      fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify({ runId: run.id, requirement, startedAt: new Date().toISOString() }, null, 2))
    }
    emit('run_start', { runId: run.id, requirement, resumed: !!resume })
    if (resume) say('pm', `已从检查点恢复（${STAGE_LABEL[resume.stage] || resume.stage || '中途'} 起续跑）`)
    state('pm', 'think', '拆解需求…')

    /* ---- 0. PM 拆解 ---- */
    if (!plan) {
      const pmOut = await chat({ system: role('pm').prompt, user: `用户需求：${requirement}`, temperature: role('pm').temp, provider: role('pm').provider, model: role('pm').model })
      plan = pickJson(pmOut.content)
      if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) {
        plan = { goal: requirement, tasks: [
          { agent: 'req', title: '需求文档' }, { agent: 'des', title: '页面结构设计' },
          { agent: 'dev', title: '原型编码' }, { agent: 'qa', title: '自动化测试' }, { agent: 'doc', title: '交付文档' } ] }
      }
      say('pm', `收到需求。目标：${plan.goal}`)
      say('pm', `分工完成：${plan.tasks.map((t) => t.title).join(' / ')}`)
    }
    emit('plan', { tasks: plan.tasks, goal: plan.goal })
    state('pm', 'done', '分工已下达')
    snap('1-req')

    /* ---- 1. 需求 ---- */
    if (!prd) {
      state('req', 'work', '撰写需求文档…')
      prd = stripFences((await chat({ system: role('req').prompt, user: `用户需求：${requirement}\n\nPM 拆解：${JSON.stringify(plan.tasks)}`, temperature: role('req').temp, maxTokens: 4000, provider: role('req').provider, model: role('req').model })).content)
      put('req', '需求文档.md', prd)
      state('req', 'done', '需求书完成')
      say('req', '需求书 v1 完成 ✓，交给设计')
      emit('handoff', { from: 'req', to: 'des', label: 'PRD v1 → 设计' })
    }
    snap('2-des')

    /* ---- 2. 设计 ---- */
    if (!design) {
      state('des', 'work', '画页面结构…')
      design = stripFences((await chat({ system: role('des').prompt, user: `需求文档：\n${prd.slice(0, 9000)}`, temperature: role('des').temp, maxTokens: 5200, provider: role('des').provider, model: role('des').model })).content)
      put('des', '设计说明.md', design)
      state('des', 'done', '设计定稿')
      say('des', '页面结构与交互定稿 ✓')
      emit('handoff', { from: 'des', to: 'dev', label: '设计 → 编码' })
    }
    snap('3-dev')

    /* ---- 3. 编码（与测试预写用例 真并行） ---- */
    let htmlPath = path.join(run.artifactsDir, 'prototype', 'index.html')
    if (!html) {
      state('dev', 'work', '生成原型代码…')
      // 真并行：测试工程同时开始预写用例清单
      const qaPrepPromise = chat({
        system: role('qa').prompt,
        user: `需求文档：\n${prd.slice(0, 4000)}\n\n编码正在并行开发原型。请先写出你将执行的测试用例清单（10 条以内，覆盖主要交互与边界），稍后你将对照真实自动化结果出报告。`,
        temperature: role('qa').temp, maxTokens: 900, provider: role('qa').provider, model: role('qa').model,
      }).then((r) => stripFences(r.content)).catch(() => null)
      state('qa', 'work', '并行预写测试用例…')
      html = await generateHtml(role('dev'), `需求文档：\n${prd.slice(0, 6500)}\n\n设计说明：\n${design.slice(0, 6500)}\n\n请输出完整单文件 HTML 原型。（注意：务必输出到 </html> 结束；CSS 用紧凑写法，先保证结构与正文完整）`)
      qaPrep = await qaPrepPromise
      state('qa', 'idle', '用例已备好')
      htmlPath = put('dev', 'prototype/index.html', html)
      state('dev', 'done', '原型 v1 完成')
      say('dev', '原型 v1 写完，交测试')
      if (qaPrep) say('qa', `测试用例已并行备好（${qaPrep.length} 字），等原型开检`)
      emit('handoff', { from: 'dev', to: 'qa', label: '原型 v1 → 测试' })
    } else {
      say('dev', '（检查点：原型已就绪）')
      try {
        html = fs.readFileSync(htmlPath, 'utf-8')
      } catch {}
    }
    snap('4-test')

    /* ---- 4. 测试（真跑浏览器 + 点测 + 手机尺寸） ---- */
    if (!web) {
      state('qa', 'work', '真实浏览器检查中…')
      web = await runWebTest(htmlPath, run)
      emit('test', { ok: web.ok, errors: web.consoleErrors.slice(0, 5), shot: web.shotRel, retest: false, reason: web.reason || null, clicked: web.clicked, clickIssues: web.clickIssues.slice(0, 3), mobile: web.mobile ? { ok: web.mobile.ok, overflow: web.mobile.overflow } : null })
      if (web.shotRel) {
        artifacts++
        emit('artifact', { agent: 'qa', name: '测试证据.png', rel: web.shotRel, url: `/runs/${run.id}/${web.shotRel}` })
      }
      if (web.mobile && web.mobile.shotRel) {
        artifacts++
        emit('artifact', { agent: 'qa', name: '测试证据-手机.png', rel: web.mobile.shotRel, url: `/runs/${run.id}/${web.mobile.shotRel}` })
      }
      if (!web.ok) {
        retries++
        const issueText = web.consoleErrors.length
          ? web.consoleErrors.join('\n')
          : [...(web.clickIssues || []), web.reason].filter(Boolean).join('\n') || '页面未正常渲染'
        say('qa', web.consoleErrors.length ? `发现 ${web.consoleErrors.length} 个问题 → 打回编码` : `点测/渲染发现问题 → 打回编码`)
        emit('reject', { from: 'qa', to: 'dev', label: '问题单 → 编码', issues: web.consoleErrors.length ? web.consoleErrors.slice(0, 5) : [...(web.clickIssues || []), web.reason].filter(Boolean).slice(0, 5) })
        state('dev', 'work', '修复中…')
        html = await generateHtml(role('dev'), `你的原型经真实浏览器检查有以下问题（必须修复）：\n${issueText}\n\n这是你当前的完整代码：\n${headTail(html)}\n\n请修复上述问题，保持其余部分不变、最小改动，输出修复后的完整单文件 HTML。`)
        htmlPath = put('dev', 'prototype/index.html', html)
        web = await runWebTest(htmlPath, run)
        emit('test', { ok: web.ok, errors: web.consoleErrors.slice(0, 5), shot: web.shotRel, retest: true, reason: web.reason || null, clicked: web.clicked, clickIssues: web.clickIssues.slice(0, 3), mobile: web.mobile ? { ok: web.mobile.ok, overflow: web.mobile.overflow } : null })
        emit('handoff', { from: 'dev', to: 'qa', label: '修复 v2 → 复测' })
        state('dev', 'done', '修复完成')
      }
    } else {
      emit('test', { ok: web.ok, errors: (web.consoleErrors || []).slice(0, 5), shot: web.shotRel, retest: true, reason: web.reason || null })
    }
    snap('5-polish')

    /* ---- 4.5 视觉打磨（可开关；打磨反而改坏时自动还原） ---- */
    if (polish && !ctx.polished && html) {
      state('dev', 'work', '视觉打磨中…')
      const beforeHtml = html
      const score = (w) => (w.ok ? 1e6 : 0) + (w.textLen || 0) - (w.consoleErrors ? w.consoleErrors.length * 500 : 0) - (w.clickIssues ? w.clickIssues.length * 200 : 0)
      const polishedHtml = await generateHtml(role('dev'), `以资深视觉设计师的标准，打磨下面这版单文件 HTML 的视觉质量：排版层级、留白节奏、配色质感、悬停/入场动效细节；不改功能、保持单文件零依赖、兼顾手机宽度（390px 不横向溢出）。输出打磨后的完整 HTML：\n\n${headTail(html)}`)
      htmlPath = put('dev', 'prototype/index.html', polishedHtml)
      web = await runWebTest(htmlPath, run)
      if (web.ok) {
        html = polishedHtml
        emit('test', { ok: true, errors: [], shot: web.shotRel, retest: true, reason: null, polished: true })
        say('dev', '视觉打磨完成，复测通过 ✓')
      } else {
        // 打磨把页面改坏了 → 自动还原到打磨前那版（事务性 AI 编辑：宁可不变好，也不能变坏）
        const polishedWeb = web
        try { fs.writeFileSync(htmlPath, beforeHtml) } catch {}
        const w2 = await runWebTest(htmlPath, run)
        const keepPolished = !w2.ok && score(polishedWeb) > score(w2)
        if (keepPolished) { html = polishedHtml; try { fs.writeFileSync(htmlPath, polishedHtml) } catch {} ; web = polishedWeb }
        else { html = beforeHtml; web = w2 }
        emit('test', { ok: web.ok, errors: (web.consoleErrors || []).slice(0, 5), shot: web.shotRel, retest: true, reason: keepPolished ? '打磨版与原版复测均未过，保留评分更高的打磨版' : '打磨版未通过复测 → 已自动还原到打磨前版本', reverted: !keepPolished, polished: true })
        say('dev', keepPolished ? '打磨版复测有提示项（已保留评分更高的版本）' : '打磨版未通过复测 → 已自动还原到打磨前版本（安全回滚）')
      }
      state('dev', 'done', '打磨完成')
      ctx.polished = true
    }
    /* ---- 4.7 设计审计（把"丑"量成分数：不达标就带问题清单重做一轮，改坏自动回滚） ---- */
    if (html) {
      const rd = () => { try { return fs.readFileSync(htmlPath, 'utf-8') } catch { return html } }
      state('qa', 'work', '设计审计中（排版/对比度/一致性）…')
      audit = await designAudit(htmlPath)
      html = rd()
      emit('design', {
        score: audit.score, grade: audit.grade, stage: 'v1',
        issues: audit.issues.slice(0, 6),
        applied: (audit.applied || []).slice(0, 8),
        metrics: audit.metrics ? { columnRatio: (audit.metrics.column || audit.metrics.container).ratio, fontLevels: audit.metrics.fontSizes.length, radiusKinds: audit.metrics.radii.filter((r) => r[0] < 900).length, hover: audit.metrics.hoverRules, contrast: audit.metrics.contrast.worst, overflowX: audit.metrics.overflowX, emoji: audit.metrics.emojiIcons, textLen: audit.metrics.textLen } : null,
      })
      say('qa', designLine(audit))
      // 需求覆盖对账：PRD 里写的功能点，页面里到底有没有落点
      cov = await coverageAudit(htmlPath, prd || '')
      emit('coverage', { total: cov.total, covered: cov.covered, rate: cov.rate, missing: cov.missing, error: cov.error || null })
      say('pm', coverageLine(cov))
      const bad = audit.ok && (audit.score < 78 || (cov.total > 0 && cov.rate < 0.8)) && audit.issues.filter((i) => i.level !== 'low').length > 0
      if (bad) {
        const before = audit
        const list = [
          ...audit.issues.map((i) => `· [${i.level === 'high' ? '严重' : '中'}] ${i.msg}`),
          cov.total > 0 && cov.rate < 0.8 ? `· [严重] 需求缺口（需求文档里有、页面里找不到落点）：${cov.missing.join('；')}` : '',
        ].filter(Boolean).join('\n')
        state('dev', 'work', '按设计审计重做视觉…')
        say('dev', `设计分 ${audit.score}，按审计意见重做一版`)
        const fixed = await generateHtml(role('dev'), `你是资深 UI 工程师。下面是真实浏览器对你这版原型的设计审计报告（分数 ${audit.score}/100）。请**逐条**修复，做最小改动，不动功能与文案结构：

${list}

硬性设计要求：
1. 主内容容器宽度用 var(--pt-max,1200px)：桌面要占满，禁止把整页塞进 600-700px 的窄柱（两侧大空白是最严重的问题）
2. 字号只用 12/14/16/18/24/32/44 这几级，层级靠字号+字重拉开
3. 圆角只用 6/8/12/999 四种
4. 正文文字对比度 ≥4.5:1
5. 每个可点元素都要有 hover 反馈（transition .2s）
6. 禁止 emoji 当图标，用内联 SVG
引擎已注入设计令牌（--pt-* 变量）与 pt- 组件类（pt-wrap/pt-section/pt-card/pt-btn/pt-hero/pt-badge/pt-grid 等），请直接复用，不要另起一套色板。

输出修复后的完整单文件 HTML：\n\n${headTail(html)}`)
        const target = put('dev', 'prototype/index.html', fixed)
        const a2 = await designAudit(target)
        const w2 = await runWebTest(target, run)
        const better = a2.ok && a2.score > before.score
        if (better) {
          html = rd(); htmlPath = target; if (w2) web = w2
          emit('design', { score: a2.score, grade: a2.grade, stage: 'v2', retry: true, delta: a2.score - before.score, issues: a2.issues.slice(0, 6) })
          say('dev', `按审计重做完成：设计分 ${before.score} → ${a2.score}（+${a2.score - before.score}）`)
        } else {
          try { fs.writeFileSync(htmlPath, html) } catch {}
          emit('design', { score: before.score, grade: before.grade, stage: 'kept-v1', retry: true, reason: '重做版设计分未提升，已保留原版' })
          say('dev', `重做版设计分未提升（${a2.score || '-'}），已保留原版 ${before.score} 分`)
        }
        state('dev', 'done', '视觉迭代完成')
      }
      state('qa', 'idle', `设计分 ${audit.ok ? audit.score : '—'}`)
    }

    /* ---- 4.8 视觉评审（给团队装"眼睛"：真的看图挑问题） ---- */
    if (html && htmlPath) {
      state('des', 'work', '视觉评审中（真看图）…')
      visionRes = await visualReview(htmlPath, run)
      if (visionRes.ok) {
        emit('vision', { score: visionRes.score, verdict: visionRes.verdict, issues: visionRes.issues, highlights: visionRes.highlights, model: visionRes.model, shots: visionRes.shots.map((p) => path.relative(run.dir, p).replace(/\\/g, '/')) })
        say('des', visionLine(visionRes))
        const rel = path.relative(run.dir, visionRes.shots[0]).replace(/\\/g, '/')
        artifacts++
        emit('artifact', { agent: 'des', name: '视觉评审-桌面.png', rel, url: `/runs/${run.id}/${rel}` })
        // 视觉评审发现明显问题（<70 分）→ 带意见回炉一轮
        if (visionRes.score != null && visionRes.score < 70 && visionRes.issues.length) {
          const beforeScore = audit && audit.ok ? audit.score : 0
          state('dev', 'work', '按视觉评审意见修改…')
          const fixed = await generateHtml(role('dev'), `视觉评审（真看图，分数 ${visionRes.score}/100）对你这版原型的意见，请逐条改掉，最小改动、不动功能：

${visionRes.issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}

硬性要求：内容容器 max-width:var(--pt-max,1200px)（桌面占满，不要窄柱）；字号只用 12/14/16/18/24/32/44；圆角只用 6/8/12/999；正文对比度 ≥4.5:1；每个可点元素有 hover 反馈；不要 emoji 当图标。引擎已注入 pt- 组件类可直接用。

输出修改后的完整单文件 HTML：\n\n${headTail(html)}`)
          const target = put('dev', 'prototype/index.html', fixed)
          const a2 = await designAudit(target)
          const w2 = await runWebTest(target, run)
          const v2 = await visualReview(target, run)
          const better = a2.ok && (a2.score > beforeScore) && (!v2.ok || v2.score == null || v2.score >= (visionRes.score || 0))
          if (better) {
            html = fs.readFileSync(target, 'utf-8'); htmlPath = target; if (w2) web = w2
            if (v2.ok) visionRes = v2
            audit = a2
            emit('vision', { score: v2.score, verdict: v2.verdict, issues: v2.issues, retry: true, deltaScore: a2.score - beforeScore })
            say('dev', `按视觉评审改完：设计分 ${beforeScore} → ${a2.score}${v2.ok && v2.score != null ? '，视觉分 ' + v2.score : ''}`)
          } else {
            try { fs.writeFileSync(htmlPath, html) } catch {}
            emit('vision', { retry: true, kept: 'v1', reason: '修改版设计分未提升，已回滚' })
            say('dev', '视觉修改版未提升 → 已回滚到原版')
          }
        }
      } else {
        say('des', visionLine(visionRes))
      }
      state('des', 'idle', '视觉评审完成')
    }

    /* ---- 4.9 真工具校验 + 打包（HTML 规范 / 无障碍 / 编译器语法 / 可直接部署包） ---- */
    if (html && htmlPath) {
      state('qa', 'work', '真工具校验（HTML 规范 / axe 无障碍 / esbuild）…')
      const htmlTxt = (() => { try { return fs.readFileSync(htmlPath, 'utf-8') } catch { return html } })()
      const [hv, ax, cc] = await Promise.all([htmlValidate(htmlPath), axeAudit(htmlPath), compileCheck(htmlTxt)])
      verifyRes = { html: hv, axe: ax, compile: cc }
      emit('verify', {
        html: { ok: hv.ok, errors: hv.errors, warnings: hv.warnings, issues: hv.issues.slice(0, 5) },
        axe: { ok: ax.ok, critical: ax.critical, serious: ax.serious, issues: ax.issues.slice(0, 5) },
        compile: { ok: cc.ok, js: cc.js, css: cc.css },
      })
      say('qa', verifyLine(verifyRes))
      quality = await qualityAudit(htmlPath)
      emit('quality', {
        score: quality.score, grade: quality.grade,
        issues: quality.issues.slice(0, 6),
        metrics: quality.metrics ? { sizeKB: quality.metrics.sizeKB, dom: quality.metrics.dom, loadMs: quality.metrics.loadMs, interactive: quality.metrics.interactive, textLen: quality.metrics.textLen, stress: quality.metrics.stress, sec: quality.metrics.sec } : null,
      })
      say('qa', qualityLine(quality))
      const critical = (!cc.ok || ax.critical > 0 || hv.errors > 6 || (quality.score < 70) || (quality.metrics && quality.metrics.errs && quality.metrics.errs.length))
      if (critical && html) {
        state('dev', 'work', '修严重问题（编译/无障碍/健壮性）…')
        const list = [
          cc.js ? `· JS 语法错误（编译器报）：${cc.js}` : '',
          cc.css ? `· CSS 语法错误（编译器报）：${cc.css}` : '',
          ax.critical > 0 ? `· 无障碍严重项 ${ax.critical} 个：` + ax.issues.filter((i) => i.impact === 'critical').map((i) => i.msg).join('；') : '',
          hv.errors > 0 ? `· HTML 规范错误 ${hv.errors} 个：` + hv.issues.filter((i) => i.sev === 'error').slice(0, 3).map((i) => i.msg).join('；') : '',
          ...quality.issues.filter((i) => i.level !== 'low').map((i) => `· [${i.level === 'high' ? '严重' : '中'}] ${i.msg}`),
        ].filter(Boolean).join('\n')
        const fixed = await generateHtml(role('dev'), `真实工具（esbuild 编译器 / axe-core / html-validate）检查出以下**必须修**的问题，请最小改动修掉，保持功能与结构：

${list}

注意：① 所有 <button> 必须写 type="button"（否则默认 submit）② 页面必须有 lang 属性、唯一的 id、<img> 要 alt ③ 标签必须正确闭合 ④ 颜色对比度不足要改文字色。

输出修复后的完整单文件 HTML：\n\n${headTail(html)}`)
        const target = put('dev', 'prototype/index.html', fixed)
        const [hv2, ax2, cc2] = await Promise.all([htmlValidate(target), axeAudit(target), compileCheck(fs.readFileSync(target, 'utf-8'))])
        const ok2 = cc2.ok && ax2.critical === 0 && hv2.errors <= hv.errors
        if (ok2) {
          html = fs.readFileSync(target, 'utf-8'); htmlPath = target
          verifyRes = { html: hv2, axe: ax2, compile: cc2 }
          emit('verify', { html: { ok: hv2.ok, errors: hv2.errors, warnings: hv2.warnings }, axe: { ok: ax2.ok, critical: ax2.critical }, compile: { ok: cc2.ok }, retry: true })
          say('dev', `严重问题已修：${verifyLine(verifyRes)}`)
        } else {
          try { fs.writeFileSync(htmlPath, html) } catch {}
          emit('verify', { retry: true, kept: 'v1', reason: '修复版未更好，已回滚' })
          say('dev', '修复版未更好 → 已回滚')
        }
      }
      // 打包成"可直接部署"的产物
      const pkg = await packagePrototype(htmlPath, run)
      if (pkg.ok) {
        artifacts += 2
        emit('artifact', { agent: 'doc', name: 'dist/index.html（可部署）', rel: pkg.rel, url: `/runs/${run.id}/${pkg.rel}` })
        emit('artifact', { agent: 'doc', name: 'dist/README.md', rel: pkg.readme, url: `/runs/${run.id}/${pkg.readme}` })
        say('doc', `已打包可直接部署：${(pkg.before / 1024).toFixed(1)}KB → ${(pkg.after / 1024).toFixed(1)}KB（零依赖单文件 + 交付说明）`)
      }
      state('qa', 'idle', '校验完成')
    }
    snap('6-qa')

    /* ---- 4.6 测试报告（对照并行预写的用例） ---- */
    state('qa', 'work', '对照用例写测试报告…')
    const qaReport = stripFences((await chat({
      system: role('qa').prompt,
      user: `当前时间：${new Date().toLocaleString('zh-CN')}（请以此为准，不要臆造日期）\n\n需求文档：\n${prd.slice(0, 3000)}\n\n你在编码期间预先写好的测试用例清单：\n${qaPrep ? qaPrep.slice(0, 1500) : '（无）'}\n\n自动化检查结果（真实数据）：\n${JSON.stringify({ ok: web.ok, reason: web.reason || null, consoleErrors: web.consoleErrors, clicked: web.clicked, clickIssues: web.clickIssues, elems: web.elems, textLen: web.textLen, mobile: web.mobile, shot: web.shotRel }, null, 2)}`,
      temperature: role('qa').temp, maxTokens: 4200, provider: role('qa').provider, model: role('qa').model,
    })).content)
    put('qa', '测试报告.md', qaReport)
    state('qa', 'done', '测试完成')
    say('qa', web.ok ? ((retries > 0 ? '复测通过 ✓' : '测试通过 ✓') + '，测试报告已出') : '测试报告已出（含待修项）')
    emit('handoff', { from: 'qa', to: 'doc', label: '测试报告 → 文档' })
    snap('7-doc')

    /* ---- 5. 文档 ---- */
    state('doc', 'work', '写交付文档…')
    const readme = stripFences((await chat({
      system: role('doc').prompt,
      user: `项目名建议：${plan.goal || requirement}\n\n需求摘要：\n${prd.slice(0, 3000)}\n\n设计摘要：\n${design.slice(0, 1800)}\n\n测试结论：\n${qaReport.slice(0, 1800)}\n\n交付文件清单：需求文档.md / 设计说明.md / prototype/index.html / 测试报告.md / 测试证据.png / 测试证据-手机.png`,
      temperature: role('doc').temp, provider: role('doc').provider, model: role('doc').model,
    })).content)
    put('doc', 'README.md', readme)
    state('doc', 'done', '文档完成')
    say('doc', 'README 交付文档完成 ✓')
    snap('8-gate')

    /* ---- 6. 审批门（打回带意见 → 回炉一次） ---- */
    /* ---- 4.10 红队对抗测试（专职把产出搞坏：XSS/超长/连点/空提交/极端值/窄屏） ---- */
    if (html && htmlPath) {
      const { redTeam, redReportMarkdown } = await import('./redteam.js')
      const rl = (r) => (r.error ? '红队测试未完成：' + r.error.slice(0, 60) : `红队对抗 ${r.score} 分 · ${r.ok ? '全部攻击被挡住 ✅' : '被打穿 ' + r.issues.length + ' 处：' + r.issues.slice(0, 2).map((i) => i.name).join('、')}`)
      state('qa', 'work', '红队对抗测试中（真攻击产出）…')
      let redRes = await redTeam(htmlPath)
      emit('redteam', { ok: redRes.ok, score: redRes.score, attacks: redRes.attacks, issues: redRes.issues })
      say('qa', rl(redRes))
      try { put('qa', '攻防记录.md', redReportMarkdown(redRes, run.id)) } catch {}
      if (!redRes.ok && redRes.issues.length) {
        const beforeScore = audit && audit.ok ? audit.score : 0
        state('dev', 'work', '修红队打穿的问题…')
        const fixed = await generateHtml(role('dev'), `红队对抗测试把你这版原型打穿了。以下问题**必须修**（最小改动，保持功能）：

${redRes.issues.map((i, n) => `${n + 1}. [${i.name}] ${i.msg}`).join('\n')}

硬性要求：① 用户输入插入 DOM 前必须转义（禁止 innerHTML 直接拼变量，用 textContent）② 长文本要换行/截断兜底 ③ 提交类按钮要防重复点击（点击后 disabled）④ 空输入要有校验提示而不是抛错。

输出修复后的完整单文件 HTML：\n\n${headTail(html)}`)
        const target = put('dev', 'prototype/index.html', fixed)
        const r2 = await redTeam(target)
        const a2 = await designAudit(target)
        if (r2.ok || r2.score > redRes.score) {
          html = fs.readFileSync(target, 'utf-8'); htmlPath = target
          redRes = r2; if (a2.ok) audit = a2
          emit('redteam', { ok: r2.ok, score: r2.score, attacks: r2.attacks, retry: true })
          say('dev', `红队问题已修：对抗分 ${r2.score}${r2.ok ? '（全部攻击被挡住）' : '（仍有 ' + r2.issues.length + ' 处）'}`)
        } else {
          try { fs.writeFileSync(htmlPath, html) } catch {}
          emit('redteam', { retry: true, kept: 'v1', reason: '修复版对抗分未提升，已回滚' })
          say('dev', '修复版对抗分未提升 → 已回滚')
        }
      }
      state('qa', 'idle', `对抗分 ${redRes.score}`)
    }

    let approved = autoApprove
    let gateRound = 0
    while (true) {
      state('pm', 'wait', '等待人工审批')
      emit('gate', { kind: 'approval', round: gateRound, summary: web.ok ? `${run.id} · 产出 ${artifacts} 件 · 打回 ${retries} 次已修复 · 全程留痕` : `${run.id} · 自动化测试未通过（含待修项）· 请人工裁决` })
      say('pm', web.ok ? '全部验证通过，等待人工审批批复' : '测试未过，产出含有待修项，等待人工裁决')
      if (autoApprove) { approved = true; break }
      gateNote = ''
      // 等人工批复：① 可被"停止"打断 ② 超时自保（上次就是这里无限等待卡了一整晚）
      let gateTimer = null
      const gateMs = Number(process.env.PT_GATE_TIMEOUT_MS || 30 * 60 * 1000)
      const gateAns = await new Promise((res) => {
        gateResolve = res
        gateTimer = setTimeout(() => { if (gateResolve) { const r = gateResolve; gateResolve = null; r('timeout') } }, gateMs)
      })
      if (gateTimer) clearTimeout(gateTimer)
      if (gateAns === 'stop') throw new StoppedError()
      if (gateAns === 'timeout') { emit('gate_timeout', { waitedMin: Math.round(gateMs / 60000) }); say('pm', `等待人工批复超过 ${Math.round(gateMs / 60000)} 分钟，已保存断点并暂停（可从历史里恢复继续）`); throw new StoppedError(true) }
      approved = gateAns
      if (approved || !gateNote || gateRound >= 1) break
      gateRound++
      retries++
      say('pm', `收到审批意见，转给编码修改：「${gateNote.slice(0, 48)}」`)
      emit('reject', { from: 'pm', to: 'dev', label: '审批意见 → 编码', issues: [gateNote] })
      state('dev', 'work', '按审批意见修改…')
      html = await generateHtml(role('dev'), `人工审批意见（必须落实）：\n${gateNote}\n\n这是你当前的完整代码：\n${headTail(html)}\n\n请在现有基础上按要求修改（保持其余部分不变，最小改动），输出修改后的完整单文件 HTML。`)
      htmlPath = put('dev', 'prototype/index.html', html)
      web = await runWebTest(htmlPath, run)
      emit('test', { ok: web.ok, errors: web.consoleErrors.slice(0, 5), shot: web.shotRel, retest: true, reason: web.reason || null, fromGate: true })
      state('dev', 'done', '按意见改完')
      say('dev', '已按审批意见修改完成，请复查')
      snap('8-gate')
    }
    state('pm', 'done', approved ? '审批通过' : '已打回')
    if (approved) say('pm', '审批通过，交付完成')
    else say('pm', '审批被打回（未附修改意见，本轮到审批门为止）')

    const stats = done({ approved })
    fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify({ runId: run.id, requirement, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), stats, approved, resumed: !!resume }, null, 2))
    saveCheckpoint(run, { stage: 'done', done: true, savedAt: new Date().toISOString(), ctx })
    // 团队记忆写回：把这次跑出来的教训沉淀下来，下次开工自动带上
    try {
      const learned = learnFromRun({
        requirement,
        audit,
        web,
        rejects: [gateNote, (web && !web.ok && web.reason) || ''].filter(Boolean),
        gateComment: gateNote || '',
        vision: visionRes,
        artifacts: [],
      })
      if (learned) say('doc', `已把本次 ${learned} 条经验写进团队记忆（下次开工自动复用）`)
    } catch {}

    // 交付证书：把"每条结论都对应一次真实测量"钉在一起，任何人可复验
    try {
      const models = [...new Set(Object.values(roles).map((r) => r.model || r.provider).filter(Boolean))]
      const c = issueCertificate(run, { requirement, design: audit, vision: visionRes, quality, coverage: cov, verify: verifyRes, stats, approved, gateNote, models })
      artifacts += 2
      emit('artifact', { agent: 'pm', name: '交付证书.md', rel: c.rel, url: `/runs/${run.id}/${c.rel}` })
      emit('artifact', { agent: 'pm', name: 'certificate.json（含哈希指纹）', rel: c.relJson, url: `/runs/${run.id}/${c.relJson}` })
      say('pm', `交付证书已签发：${c.cert.artifacts.length} 件产出登记指纹，任何人可用 verify-certificate.mjs 复验`)
    } catch (e) { console.error('[cert] 签发失败', e && e.message) }

    emit('run_done', { stats, summary: approved ? '交付完成' : '已打回', approved })
    console.log(`[team] 运行结束 ${run.id} 用时 ${(stats.durationMs / 1000).toFixed(1)}s 产出 ${artifacts} 件`)
    return { runId: run.id, ...stats }
  } catch (e) {
    const message = String((e && e.message) || e)
    // 用户点"停止" / 审批门超时 → 正常收尾：保存断点、可恢复，不当成运行错误
    if (e && e.code === 'STOPPED') {
      const paused = !!e.paused
      try { saveCheckpoint(run, { stage: paused ? 'paused' : 'stopped', done: false, savedAt: new Date().toISOString(), ctx }) } catch {}
      emit('run_stop', { by: 'user', paused, message: paused ? '等待批复超时 → 已暂停，断点已保存（可从历史恢复）' : '任务已被手动停止（断点已保存，可从历史恢复继续）' })
      console.log(`[team] ${paused ? '暂停' : '停止'} ${run.id}`)
      done({ stopped: true, paused })
    } else {
      console.error('[team] 运行失败：', message)
      snap('error')
      emit('run_error', { message })
      done({ error: message })
      throw e
    }
  } finally {
    running = false
    gateResolve = null
  }
}
