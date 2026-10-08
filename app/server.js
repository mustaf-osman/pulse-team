// Pulse 虚拟团队 · 服务器（零依赖：node:http）
// 页面：/             → web/index.html（协作台）
// 事件：/events       → SSE 实时事件流
// 状态：/api/state    → { running, current, history }
// 开工：POST /api/run { requirement }
// 审批：POST /api/gate { approve }
// 文件：/web/*  /runs/*
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { subscribe, getHistory, rehydrate, emit } from './engine/bus.js'
import { memoryStats, allRoleMemory, allProjectMemory, forgetMemory, clearMemory } from './engine/memory.js'
import { gitLog } from './engine/gitrepo.js'
import { startRun, isRunning, getCurrent, resolveGate, restoreCurrent, findResumable, requestStop, forceIdle } from './engine/orchestrator.js'
import { providersOverview, probeProvider, loadConfig, providerNames, modelForProvider, saveProviderKey, saveFailoverOrder, readRoutes, saveRoute, deleteRoute, triggerKinds } from './engine/llm.js'
import { loadRoles } from './engine/roles.js'
import { chatWithAgent, resetChat } from './engine/chat.js'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3722)
const WEB_DIR = path.join(__dirname, 'web')
const RUNS_DIR = path.join(__dirname, 'runs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function sendFile(res, file, { noStore = false } = {}) {
  try {
    const data = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function safeJoin(root, rel) {
  const target = path.resolve(root, rel)
  const r = path.relative(root, target)
  if (r.startsWith('..') || path.isAbsolute(r)) return null
  return target
}

// 软删除：移到 runs-trash（可捞回），失败再回退硬删除
function softDelete(dir) {
  try {
    const trash = path.join(path.dirname(RUNS_DIR), 'runs-trash')
    fs.mkdirSync(trash, { recursive: true })
    fs.renameSync(dir, path.join(trash, path.basename(dir) + '-' + Date.now().toString(36)))
    return true
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch { return false }
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1048576) { req.destroy(); return resolve(null) }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(WEB_DIR, 'index.html'), { noStore: true })
    // 项目库 / 团队记忆：独立页面（自己的 URL，刷新后停在本页，不再是盖在协作台上的浮层）
    if (req.method === 'GET' && (p === '/projects' || p === '/projects.html')) return sendFile(res, path.join(WEB_DIR, 'projects.html'), { noStore: true })
    if (req.method === 'GET' && (p === '/memory' || p === '/memory.html')) return sendFile(res, path.join(WEB_DIR, 'memory.html'), { noStore: true })
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end() }

    if (req.method === 'GET' && p.startsWith('/web/')) {
      let rel = ''
      try { rel = decodeURIComponent(p.slice(5)) } catch { rel = '' }
      const f = rel ? safeJoin(WEB_DIR, rel) : null
      return f ? sendFile(res, f) : sendJson(res, { error: 'bad path' }, 400)
    }
    if (req.method === 'GET' && p.startsWith('/runs/')) {
      let rel = ''
      try { rel = decodeURIComponent(p.slice(6)) } catch { rel = '' }
      const f = rel ? safeJoin(RUNS_DIR, rel) : null
      return f ? sendFile(res, f) : sendJson(res, { error: 'bad path' }, 400)
    }

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      const unsubscribe = subscribe(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)
      req.on('close', () => { clearInterval(ping); unsubscribe() })
      return
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, { running: isRunning(), current: getCurrent(), history: getHistory(), resumable: isRunning() ? null : findResumable() })
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = await readJson(req)
      const requirement = body && String(body.requirement || '').trim()
      if (!requirement) return sendJson(res, { error: 'requirement 不能为空' }, 400)
      if (isRunning()) return sendJson(res, { error: '已有任务在运行' }, 409)
      resetChat()
      startRun({ requirement, autoApprove: !!(body && body.autoApprove), polish: !(body && body.polish === false) }).catch(() => {})
      return sendJson(res, { ok: true })
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const body = await readJson(req)
      const force = !!(body && body.force)
      const r = force ? forceIdle() : requestStop()
      emit('run_stop_ack', { force, wasRunning: !!r.wasRunning, gateReleased: !!r.gateReleased, by: 'user' })
      return sendJson(res, { ok: true, ...r })
    }

    if (req.method === 'POST' && p === '/api/gate') {
      const body = await readJson(req)
      resolveGate(!!(body && body.approve), (body && body.note) || '')
      return sendJson(res, { ok: true })
    }

    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readJson(req)
      const text = String((body && body.text) || '').trim().slice(0, 2000)
      const agent = String((body && body.agent) || '').trim()
      if (!text) return sendJson(res, { error: 'text 不能为空' }, 400)
      if (!agent) return sendJson(res, { error: 'agent 不能为空' }, 400)
      chatWithAgent(agent, text).catch((e) => {
        emit('chat', { agent, from: 'agent', text: '（我这边出了点问题：' + String((e && e.message) || e).slice(0, 80) + '）' })
      })
      return sendJson(res, { ok: true })
    }

    if (req.method === 'GET' && p === '/api/runs') {
      return sendJson(res, { runs: listRuns() })
    }

    // 项目库：每次交付一张卡片（分数来自证书实测 + git 提交历史 + 缩略图）
    if (req.method === 'GET' && p === '/api/projects') {
      const findPng = (dir, depth = 0) => {
        if (depth > 4) return null
        let items = []
        try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
        for (const it of items) {
          const fp = path.join(dir, it.name)
          if (it.isDirectory()) { const r = findPng(fp, depth + 1); if (r) return r }
          else if (/\.png$/i.test(it.name) && !/手机|mobile/i.test(it.name)) return fp
        }
        return null
      }
      let names = []
      try { names = fs.readdirSync(RUNS_DIR).filter((n) => n.startsWith('run-')) } catch {}
      names.sort().reverse()
      const out = []
      for (const name of names.slice(0, 40)) {
        const dir = path.join(RUNS_DIR, name)
        let meta = null, cert = null
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) } catch {}
        try { cert = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', 'certificate.json'), 'utf-8')) } catch {}
        let ckText = ''
        try { ckText = fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf-8') } catch {}
        let ck = null; try { ck = JSON.parse(ckText) } catch {}
        const png = findPng(path.join(dir, 'artifacts'))
        const ts = Number((name.split('-')[1] || '').slice(0, 14))
        out.push({
          id: name,
          requirement: (meta && meta.requirement) || (ck && ck.ctx && ck.ctx.requirement) || '（未记录需求）',
          at: ts ? `${String(ts).slice(4, 6)}-${String(ts).slice(6, 8)} ${String(ts).slice(8, 10)}:${String(ts).slice(10, 12)}` : '',
          durationMs: (meta && meta.stats && meta.stats.durationMs) || null,
          approved: meta ? !!meta.approved : null,
          stopped: !!(ck && (ck.stopped || ck.stage === 'stopped')),
          stage: (ck && ck.stage) || (meta ? 'done' : null),
          scores: cert ? { design: cert.metrics.designScore, quality: cert.metrics.qualityScore, coverage: cert.metrics.coverage ? cert.metrics.coverage.rate : null, vision: cert.metrics.visionScore } : null,
          files: cert ? cert.artifacts.length : null,
          cert: !!cert,
          thumb: png ? `/runs/${name}/` + path.relative(dir, png).replace(/\\/g, '/') : null,
          git: gitLog(dir, 6),
        })
      }
      return sendJson(res, { projects: out })
    }

    // 记忆区：团队记住的每一条
    if (req.method === 'GET' && p === '/api/memory') {
      const roles = {}
      for (const id of ['pm', 'req', 'des', 'dev', 'qa', 'doc']) roles[id] = allRoleMemory(id)
      return sendJson(res, { stats: memoryStats(), roles, project: allProjectMemory() })
    }
    if (req.method === 'POST' && p === '/api/memory-forget') {
      const body = await readJson(req)
      const ok = (body && body.clear)
        ? clearMemory({ scope: body.scope, id: body.id })
        : forgetMemory({ scope: body && body.scope, id: body && body.id, text: body && body.text })
      return sendJson(res, { ok })
    }

    if (req.method === 'GET' && p.startsWith('/api/runs/') && p.endsWith('/report')) {
      const id = decodeURIComponent(p.slice('/api/runs/'.length, -'/report'.length))
      const rep = buildReport(id)
      if (!rep) return sendJson(res, { error: 'not found' }, 404)
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${id}.md"` })
      return res.end(rep)
    }

    if (req.method === 'GET' && p.startsWith('/api/runs/')) {
      const id = decodeURIComponent(p.slice('/api/runs/'.length))
      const data = loadRun(id)
      if (!data) return sendJson(res, { error: 'not found' }, 404)
      return sendJson(res, data)
    }

    if (req.method === 'POST' && p === '/api/resume') {
      if (isRunning()) return sendJson(res, { error: '已有任务在运行' }, 409)
      const r = findResumable({ allowStale: true })
      if (!r) return sendJson(res, { error: '没有可恢复的运行' }, 404)
      let cp = null
      try { cp = JSON.parse(fs.readFileSync(path.join(r.dir, 'checkpoint.json'), 'utf-8')) } catch {}
      if (!cp || !cp.ctx) return sendJson(res, { error: '检查点不可用' }, 400)
      startRun({ resume: { dir: r.dir, ctx: cp.ctx, stage: cp.stage } }).catch(() => {})
      return sendJson(res, { ok: true, runId: r.runId })
    }

    if (req.method === 'POST' && p === '/api/reveal') {
      const body = await readJson(req)
      const id = String((body && body.runId) || '').trim()
      const dir = safeJoin(RUNS_DIR, id)
      if (!dir || !fs.existsSync(dir)) return sendJson(res, { error: 'not found' }, 404)
      try { spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref() } catch {}
      return sendJson(res, { ok: true })
    }

    // 删除单个运行（运行中的不可删；软删除：移到 runs-trash 可捞回）
    if (req.method === 'DELETE' && p.startsWith('/api/runs/')) {
      const id = decodeURIComponent(p.slice('/api/runs/'.length))
      if (!/^run-[A-Za-z0-9._-]+$/.test(id)) return sendJson(res, { error: '非法运行 id' }, 400)
      if (isRunning() && getCurrent() && getCurrent().id === id) return sendJson(res, { error: '正在运行的任务不能删除' }, 409)
      const dir = safeJoin(RUNS_DIR, id)
      if (!dir || !fs.existsSync(dir)) return sendJson(res, { error: 'not found' }, 404)
      const ok = softDelete(dir)
      return ok ? sendJson(res, { ok: true, trashed: true }) : sendJson(res, { error: '删除失败' }, 500)
    }

    // 清空全部历史（保留运行中的；软删除到 runs-trash）
    if (req.method === 'POST' && p === '/api/runs-clear') {
      const keep = isRunning() && getCurrent() ? getCurrent().id : null
      let deleted = 0
      try {
        for (const name of fs.readdirSync(RUNS_DIR)) {
          if (name === keep || !/^run-/.test(name)) continue
          if (softDelete(path.join(RUNS_DIR, name))) deleted++
        }
      } catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 500) }
      return sendJson(res, { ok: true, deleted, trashed: true })
    }

    // ===== 系统设置：总览 =====
    if (req.method === 'GET' && p === '/api/system') {
      let runsCount = 0, runsSize = 0
      try {
        for (const d of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          runsCount++
          const stack = [path.join(RUNS_DIR, d.name)]
          while (stack.length) {
            const cur = stack.pop()
            let entries = []
            try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
            for (const f of entries) {
              const fp = path.join(cur, f.name)
              if (f.isDirectory()) stack.push(fp)
              else { try { runsSize += fs.statSync(fp).size } catch {} }
            }
          }
        }
      } catch {}
      return sendJson(res, {
        node: process.version,
        uptimeS: Math.round(process.uptime()),
        providers: providersOverview(),
        roles: loadRoles().map((r) => ({ id: r.id, name: r.name, color: r.color, temp: r.temp, provider: r.provider || null, model: r.model || null })),
        failovers: getHistory().filter((e) => e.type === 'failover').slice(-8).map((e) => ({ from: e.from, to: e.to, reason: String(e.reason || '').slice(0, 90), ts: e.ts || null })),
        runs: { count: runsCount, sizeMB: +(runsSize / 1048576).toFixed(1) },
      })
    }

    // 单提供商自检
    if (req.method === 'POST' && p === '/api/selftest') {
      const body = await readJson(req)
      const name = String((body && body.provider) || '').trim()
      if (!providerNames().includes(name)) return sendJson(res, { error: '未知提供商' }, 400)
      return sendJson(res, await probeProvider(name))
    }

    // 保存提供商密钥（设置页填 key）
    if (req.method === 'POST' && p === '/api/provider-key') {
      const body = await readJson(req)
      const name = String((body && body.provider) || '').trim()
      const key = String((body && body.key) || '').trim()
      if (!providerNames().includes(name)) return sendJson(res, { error: '未知提供商' }, 400)
      try { saveProviderKey(name, key); return sendJson(res, { ok: true }) }
      catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 400) }
    }

    // 新增容灾路由（设置首选备用链路 → 写入 config.json，pickFallback 优先使用）
    if (req.method === 'POST' && p === '/api/failover-order') {
      const body = await readJson(req)
      const from = String((body && body.from) || '').trim()
      const to = String((body && body.to) || '').trim()
      if (!providerNames().includes(from) || !providerNames().includes(to)) return sendJson(res, { error: '未知提供商' }, 400)
      if (from === to) return sendJson(res, { error: '主模型与备用不能相同' }, 400)
      try { const order = saveFailoverOrder(from, to); return sendJson(res, { ok: true, order }) }
      catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 400) }
    }

    // 读取已保存的容灾路由（设置页展示用）
    if (req.method === 'GET' && p === '/api/failover-order') {
      let order = []
      try { const cfg = loadConfig(); order = Array.isArray(cfg.failoverOrder) ? cfg.failoverOrder : [] } catch {}
      return sendJson(res, { ok: true, order, main: (() => { try { return loadConfig().provider || 'minimax' } catch { return 'minimax' } })() })
    }

    // ===== 容灾路由 CRUD（带优先级 / 触发类型）=====
    if (req.method === 'GET' && p === '/api/routes') {
      let routes = []
      try { routes = readRoutes() } catch {}
      return sendJson(res, { ok: true, routes, triggers: triggerKinds(), providers: providerNames(), main: (() => { try { return loadConfig().provider || 'minimax' } catch { return 'minimax' } })() })
    }
    if (req.method === 'POST' && p === '/api/routes') {
      const body = await readJson(req)
      const route = (body && body.route) || body || {}
      const idx = body && body.index != null ? Number(body.index) : null
      try { const r = saveRoute(route, Number.isInteger(idx) ? idx : null); return sendJson(res, { ok: true, ...r }) }
      catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 400) }
    }
    if (req.method === 'POST' && p === '/api/routes-delete') {
      const body = await readJson(req)
      try { const r = deleteRoute(Number((body && body.index))); return sendJson(res, { ok: true, ...r }) }
      catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 400) }
    }

    // 角色 → 模型分工（写回 roles/index.json，下轮运行生效）
    if (req.method === 'POST' && p === '/api/role-assign') {
      const body = await readJson(req)
      const id = String((body && body.id) || '').trim()
      const provider = String((body && body.provider) || '').trim()
      if (provider !== 'default' && !providerNames().includes(provider)) return sendJson(res, { error: '未知提供商' }, 400)
      const rolesUrl = new URL('./engine/roles/index.json', import.meta.url)
      try {
        const arr = JSON.parse(fs.readFileSync(rolesUrl, 'utf-8'))
        const r0 = arr.find((x) => x.id === id)
        if (!r0) return sendJson(res, { error: '未知角色' }, 400)
        if (provider === 'default') {
          delete r0.provider; delete r0.model
        } else {
          r0.provider = provider
          r0.model = modelForProvider(provider)
        }
        fs.writeFileSync(rolesUrl, JSON.stringify(arr, null, 2) + '\n')
        return sendJson(res, { ok: true })
      } catch (e) { return sendJson(res, { error: String((e && e.message) || e) }, 500) }
    }

    res.writeHead(404)
    res.end('not found')
  } catch (e) {
    try { sendJson(res, { error: String((e && e.message) || e) }, 500) } catch {}
  }
})

// ---- 运行历史（列表 / 读取 / 报告） ----
function listRuns() {
  try {
    const names = fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse().slice(0, 20)
    return names.map((name) => {
      const dir = path.join(RUNS_DIR, name)
      let meta = null
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) } catch {}
      let cp = null
      try { cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf-8')) } catch {}
      return {
        id: name,
        requirement: (meta && meta.requirement) || (cp && cp.ctx && cp.ctx.requirement) || '',
        finishedAt: (meta && meta.finishedAt) || null,
        stats: (meta && meta.stats) || null,
        approved: meta ? !!meta.approved : null,
        interrupted: !!(cp && !cp.done),
        hasPrototype: fs.existsSync(path.join(dir, 'artifacts', 'prototype', 'index.html')),
      }
    })
  } catch { return [] }
}

function loadRun(id) {
  const dir = safeJoin(RUNS_DIR, id)
  if (!dir || !fs.existsSync(dir)) return null
  let events = []
  try {
    events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {}
  let meta = null
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) } catch {}
  return { id, meta, history: events }
}

function buildReport(id) {
  const data = loadRun(id)
  if (!data) return null
  const h = data.history
  const arts = h.filter((e) => e.type === 'artifact').map((e) => `- ${e.name}（${e.agent}）`)
  const msgs = h.filter((e) => e.type === 'msg').map((e) => `- [${e.agent}] ${e.text}`)
  const rejects = h.filter((e) => e.type === 'reject').map((e) => `- ${e.label}：${(e.issues || []).join('；')}`)
  const tests = h.filter((e) => e.type === 'test').map((e) => `- ${e.ok ? '通过' : '未通过'}${e.retest ? '（复测）' : ''} ${e.reason || ''}`)
  return [
    `# 运行报告 · ${id}`,
    '',
    `- 需求：${(data.meta && data.meta.requirement) || '—'}`,
    `- 开始：${(data.meta && data.meta.startedAt) || '—'}`,
    `- 结束：${(data.meta && data.meta.finishedAt) || '—'}`,
    `- 统计：${data.meta && data.meta.stats ? JSON.stringify(data.meta.stats) : '—'}`,
    `- 审批：${data.meta && data.meta.approved ? '已通过' : '未通过或进行中'}`,
    '',
    '## 产出物',
    ...(arts.length ? arts : ['- 无']),
    '',
    '## 测试',
    ...(tests.length ? tests : ['- 无']),
    '',
    '## 打回记录',
    ...(rejects.length ? rejects : ['- 无']),
    '',
    '## 协作消息',
    ...(msgs.length ? msgs : ['- 无']),
    '',
    `> 由 Pulse 虚拟团队生成 · 事件流水 ${h.length} 条`,
  ].join('\n')
}

// 启动时恢复最近一次运行（重启后仍可回放 / 查看上次现场）
function restoreLatestRun() {
  try {
    const names = fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse()
    for (const name of names) {
      const dir = path.join(RUNS_DIR, name)
      const evFile = path.join(dir, 'events.jsonl')
      if (!fs.existsSync(evFile)) continue
      const events = fs.readFileSync(evFile, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      if (!events.length) continue
      rehydrate(dir, events)
      let meta = null
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) } catch {}
      if (meta) restoreCurrent({ id: meta.runId || name, requirement: meta.requirement, startedAt: Date.parse(meta.startedAt) || null, finishedAt: meta.finishedAt ? Date.parse(meta.finishedAt) : null, stats: meta.stats || null })
      console.log(`[server] 已恢复最近运行：${name}（${events.length} 条事件）`)
      break
    }
  } catch (e) { console.warn('[server] 恢复最近运行失败:', e && e.message) }
}

server.listen(PORT, '127.0.0.1', () => {
  restoreLatestRun()
  console.log('──────────────────────────────────────────')
  console.log('  Pulse 虚拟团队 · 协作台')
  console.log(`  http://127.0.0.1:${PORT}`)
  console.log('──────────────────────────────────────────')
})
