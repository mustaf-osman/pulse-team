// Pulse 虚拟团队 · 事件总线
// SSE 广播 + 运行记录（events.jsonl）+ 历史回放（页面刷新后可重建现场）
import fs from 'node:fs'
import path from 'node:path'

let clients = new Set()
let history = []
let seq = 0
let eventsFile = null
let runDir = null
let currentRunId = null

// 从事件文件里取最大 seq：同一运行目录会被多次重启继续写，
// 若每次都从 0 重开，(runId, seq) 就会重复，前端去重会误杀实时事件。
function seedSeq(file) {
  let mx = 0
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim()
    if (!raw) return 0
    for (const line of raw.split('\n')) {
      try { const e = JSON.parse(line); if (typeof e.seq === 'number' && e.seq > mx) mx = e.seq } catch {}
    }
  } catch {}
  return mx
}

export function setRun(dir) {
  runDir = dir
  eventsFile = path.join(dir, 'events.jsonl')
  currentRunId = path.basename(dir)
  history = []
  seq = seedSeq(eventsFile)
  console.log(`[bus] 新运行：${dir}（seq 从 ${seq} 续号）`)
}

// 服务器重启后：从磁盘恢复某次运行的事件历史（留痕可回放）
export function rehydrate(dir, events) {
  runDir = dir
  eventsFile = path.join(dir, 'events.jsonl')
  currentRunId = path.basename(dir)
  history = Array.isArray(events) ? events : []
  const inMem = history.reduce((m, e) => Math.max(m, (e && e.seq) || 0), 0)
  seq = Math.max(inMem, seedSeq(eventsFile))
  console.log(`[bus] 恢复运行：${dir}（${history.length} 条事件，seq 从 ${seq} 续号）`)
}

export function getRunDir() { return runDir }
export function getHistory() { return history }

export function emit(type, data = {}) {
  const ev = { seq: ++seq, ts: Date.now(), runId: currentRunId, type, ...data }
  history.push(ev)
  if (eventsFile) {
    try { fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n') } catch {}
  }
  const payload = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of [...clients]) {
    try { res.write(payload) } catch { clients.delete(res) }
  }
  const brief = String(data.text || data.action || data.name || data.label || '').slice(0, 64)
  console.log(`[team] ${type}${data.agent ? ' · ' + data.agent : ''}${brief ? ' · ' + brief : ''}`)
  return ev
}

export function subscribe(res) {
  clients.add(res)
  for (const ev of history) {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch { break }
  }
  return () => clients.delete(res)
}
