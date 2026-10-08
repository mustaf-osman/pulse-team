// Pulse 虚拟团队 · LLM 客户端（多提供商）
// 主提供商读 config.json（provider/apiKey/model）；角色可指定其它提供商（如 DeepSeek，key 从 G:/pulse-team/.env 读取）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { emit } from './bus.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json')

// 载入 G:/pulse-team/.env（补齐缺失的环境变量）
let envLoaded = false
function loadEnvOnce() {
  if (envLoaded) return
  envLoaded = true
  try {
    const file = path.resolve(__dirname, '..', '..', '.env')
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
}

const PROVIDERS = {
  minimax: { baseURL: 'https://api.minimax.chat/v1', label: 'MiniMax' },
  deepseek: { baseURL: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', label: 'DeepSeek', defaultModel: 'deepseek-chat' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', label: '通义千问', defaultModel: 'qwen-plus' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', envKey: 'MOONSHOT_API_KEY', label: '月之暗面 Kimi', defaultModel: 'moonshot-v1-8k' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'ZHIPU_API_KEY', label: '智谱 GLM', defaultModel: 'glm-4-flash' },
  openai: { baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
}

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
}

function resolveProvider(cfg, providerName) {
  const name = providerName || cfg.provider || 'custom'
  if (name === 'custom') return { name, baseURL: cfg.baseURL, apiKey: cfg.apiKey }
  const meta = PROVIDERS[name]
  if (!meta) return { name, baseURL: cfg.baseURL, apiKey: cfg.apiKey }
  loadEnvOnce()
  const apiKey = meta.envKey ? (process.env[meta.envKey] || '') : cfg.apiKey
  return { name, baseURL: meta.baseURL, apiKey }
}

const _clients = new Map()
function getClient(prov, model) {
  const sig = `${prov.name}|${prov.baseURL}|${prov.apiKey}|${model}`
  if (_clients.has(sig)) return _clients.get(sig)
  const client = new OpenAI({ apiKey: prov.apiKey, baseURL: prov.baseURL, timeout: 240000, maxRetries: 0 })
  _clients.set(sig, client)
  return client
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 单提供商调用（带重试与参数自愈）
async function callOnce(prov, useModel, { messages, temperature, maxTokens, tries }) {
  if (!prov.apiKey) throw new Error(`提供商 ${prov.name} 缺少 API key`)
  const client = getClient(prov, useModel)
  const p = {
    model: useModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  }
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now()
    try {
      const resp = await client.chat.completions.create({ ...p })
      let content = resp.choices?.[0]?.message?.content || ''
      // 剥掉模型夹带的思考块（MiniMax / DeepSeek 等）
      content = content.replace(/<(think|thinking|redacted_thinking)>[\s\S]*?<\/\1>/g, '').trim()
      const ms = Date.now() - t0
      // 观测日志（走 stderr，不占 stdout 缓冲）
      process.stderr.write(`[llm] ${prov.name} · ${useModel} · ${(ms / 1000).toFixed(1)}s · ${content.length} 字\n`)
      // 观测事件（HUD 用）：调用次数 / 耗时 / 字数 / token
      const usage = resp.usage || null
      const tokens = usage ? (usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))) : 0
      try { emit('metrics', { provider: prov.name, model: useModel, ms, chars: content.length, tokens }) } catch {}
      noteProv(prov.name, true, ms)
      return { content, usage, ms, finish: resp.choices?.[0]?.finish_reason || '', provider: prov.name, model: useModel }
    } catch (e) {
      lastErr = e
      const msg = String(e.message || e)
      if (e.status === 401 || e.status === 403) { noteProv(prov.name, false, 0, msg); throw e }
      if (e.status === 400) {
        // 参数不兼容自愈
        if (/max_tokens/i.test(msg) && 'max_tokens' in p) { delete p.max_tokens; continue }
        if (/temperature/i.test(msg) && 'temperature' in p) { delete p.temperature; continue }
        throw e
      }
      if (i < tries - 1) await sleep(1000 * (i + 1))
    }
  }
  noteProv(prov.name, false, 0, String((lastErr && lastErr.message) || lastErr))
  throw lastErr
}

// 备用提供商（容灾路由）：主模型全挂了自动切备用（按 deepseek → minimax → 其它有钥匙的 顺序挑）
function pickFallback(cfg, primaryName) {
  loadEnvOnce()
  const has = (n) => {
    const meta = PROVIDERS[n]
    const key = meta && meta.envKey ? process.env[meta.envKey] : (cfg.apiKey || '')
    return !!key
  }
  const order = [...(Array.isArray(cfg.failoverOrder) ? cfg.failoverOrder : []), 'deepseek', 'minimax', ...Object.keys(PROVIDERS)]
  for (const n of order) {
    if (n === primaryName || !PROVIDERS[n] || !has(n)) continue
    return { provider: resolveProvider(cfg, n), model: modelForProvider(n) }
  }
  return null
}

// 保存用户自定义的容灾路由（设置页「新增容灾路由」）：把 to 放到备用顺序最前
export function saveFailoverOrder(from, to) {
  const cfg = loadConfig()
  const custom = Array.isArray(cfg.failoverOrder) ? cfg.failoverOrder : []
  const next = [to, ...custom.filter((n) => n !== to)]
  cfg.failoverOrder = next
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8')
  return cfg.failoverOrder
}

// ===== 容灾路由（带优先级 / 触发失败类型 / 可编辑删除）=====
const DEFAULT_TRIGGERS = ['超时', '限流', '认证', '余额']
function rawRoutes(cfg) {
  if (Array.isArray(cfg.routes) && cfg.routes.length) return cfg.routes.slice()
  // 兼容旧数据：failoverOrder（纯名字数组）→ 路由对象
  const legacy = Array.isArray(cfg.failoverOrder) ? cfg.failoverOrder : []
  return legacy.map((to, i) => ({ from: cfg.provider || 'minimax', to, priority: i + 1, triggers: DEFAULT_TRIGGERS.slice() }))
}
function persistRoutes(cfg, routes) {
  const sorted = routes.slice().sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99))
  cfg.routes = sorted
  cfg.failoverOrder = sorted.map((r) => r.to)   // pickFallback 仍按这个顺序挑备用
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8')
  return sorted
}
// 读取（按优先级升序）
export function readRoutes() {
  const cfg = loadConfig()
  return rawRoutes(cfg).sort((a, b) => (Number(a.priority) || 99) - (Number(b.priority) || 99))
}
// 新增或编辑（index 为已存在条目的下标时=编辑）
export function saveRoute(input, index) {
  const cfg = loadConfig()
  const routes = rawRoutes(cfg)
  const from = String((input && input.from) || '').trim()
  const to = String((input && input.to) || '').trim()
  if (!PROVIDERS[from] || !PROVIDERS[to]) throw new Error('未知提供商')
  if (from === to) throw new Error('主模型与备用模型不能相同')
  const trig = Array.isArray(input && input.triggers) && input.triggers.length ? input.triggers.map(String) : DEFAULT_TRIGGERS.slice()
  const route = { from, to, priority: Math.min(99, Math.max(1, Number(input && input.priority) || 1)), triggers: trig, updatedAt: new Date().toISOString() }
  if (index != null && index >= 0 && index < routes.length) routes[index] = route
  else routes.push(route)
  const sorted = persistRoutes(cfg, routes)
  return { routes: sorted, order: cfg.failoverOrder }
}
export function deleteRoute(index) {
  const cfg = loadConfig()
  const routes = rawRoutes(cfg)
  const i = Number(index)
  if (!(i >= 0 && i < routes.length)) throw new Error('条目不存在')
  routes.splice(i, 1)
  const sorted = persistRoutes(cfg, routes)
  return { routes: sorted, order: cfg.failoverOrder }
}
export function triggerKinds() { return DEFAULT_TRIGGERS.slice() }

// 单轮对话（支持多轮 messages / 指定 provider 与 model；主模型失败自动切备用）
// 返回 { content, usage, ms, finish, provider, model, failover? }
export async function chat({ system, user, messages, provider, model, temperature = 0.6, maxTokens = 3200, tries = 3 }) {
  const cfg = loadConfig()
  const prov = resolveProvider(cfg, provider)
  const useModel = model || cfg.model
  const msgs = Array.isArray(messages) && messages.length
    ? messages
    : [
        { role: 'system', content: String(system || '') },
        { role: 'user', content: String(user || '') },
      ]
  try {
    return await callOnce(prov, useModel, { messages: msgs, temperature, maxTokens, tries })
  } catch (e1) {
    // ===== 容灾：主模型挂了 → 自动切备用模型，团队不停工 =====
    const fb = pickFallback(cfg, prov.name)
    if (!fb) throw e1
    const reason = String((e1 && e1.message) || e1).slice(0, 140)
    process.stderr.write(`[llm] 容灾切换 ${prov.name}(${useModel}) → ${fb.provider.name}(${fb.model})：${reason}\n`)
    try { emit('failover', { from: prov.name, fromModel: useModel, to: fb.provider.name, model: fb.model, reason }) } catch {}
    try {
      const r = await callOnce(fb.provider, fb.model, { messages: msgs, temperature, maxTokens, tries: 1 })
      r.failover = true
      r.failoverFrom = prov.name
      return r
    } catch (e2) {
      throw new Error(`主模型 ${prov.name} 失败（${reason.slice(0, 60)}）；备用 ${fb.provider.name} 也失败（${String((e2 && e2.message) || e2).slice(0, 60)}）`)
    }
  }
}

// ===== 提供商状态登记（设置页 / 自检） =====
const _provStats = new Map()
function noteProv(name, ok, ms, err) {
  const s = _provStats.get(name) || { name, ok: null, lastMs: null, lastAt: null, okCount: 0, errCount: 0, lastErr: null }
  s.ok = ok
  s.lastAt = Date.now()
  if (ok) { s.okCount++; s.lastMs = ms; s.lastErr = null } else { s.errCount++; s.lastErr = String(err || '').slice(0, 160) }
  _provStats.set(name, s)
}

// 提供商名单 / 每个提供商推荐模型
export function providerNames() { return Object.keys(PROVIDERS) }
export function modelForProvider(name) {
  const cfg = loadConfig()
  const meta = PROVIDERS[name]
  if (name === 'minimax') return cfg.model || 'MiniMax-M2.7'
  return (meta && meta.defaultModel) || cfg.model
}

// 模型池概览（设置页展示）
export function providersOverview() {
  const cfg = loadConfig()
  loadEnvOnce()
  const out = []
  for (const [name, meta] of Object.entries(PROVIDERS)) {
    const apiKey = meta.envKey ? (process.env[meta.envKey] || '') : (cfg.apiKey || '')
    const s = _provStats.get(name) || null
    const k = apiKey ? String(apiKey) : ''
    const masked = k ? (k.slice(0, 6) + '•••' + k.slice(-4)) : ''
    out.push({
      name, label: meta.label || name, endpoint: meta.baseURL, model: modelForProvider(name),
      keyMasked: masked, hasKey: !!k,
      stats: s ? {
        ok: s.ok, lastMs: s.lastMs,
        lastAt: s.lastAt ? new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false }) : null,
        okCount: s.okCount, errCount: s.errCount, lastErr: s.lastErr,
      } : null,
    })
  }
  return out
}

// 单提供商自检（不触发容灾，直测原始连通性）
export async function probeProvider(providerName) {
  const cfg = loadConfig()
  const prov = resolveProvider(cfg, providerName)
  const model = modelForProvider(providerName)
  const t0 = Date.now()
  try {
    const r = await callOnce(prov, model || cfg.model, {
      messages: [{ role: 'user', content: '只回复两个字：在线' }],
      temperature: 0.3, maxTokens: 20, tries: 1,
    })
    return { ok: true, ms: Date.now() - t0, provider: prov.name, model: r.model, content: String(r.content).slice(0, 30) }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, provider: prov.name, error: String((e && e.message) || e).slice(0, 160) }
  }
}

// 保存提供商密钥（minimax → config.json；其它 → G:/pulse-team/.env）
export function saveProviderKey(name, key) {
  const k = String(key || '').trim()
  if (!k) throw new Error('密钥为空')
  if (name === 'minimax') {
    const cfg = loadConfig()
    cfg.apiKey = k
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
    return true
  }
  const meta = PROVIDERS[name]
  if (!meta || !meta.envKey) throw new Error('未知提供商或不支持该提供商')
  const envPath = path.resolve(__dirname, '..', '..', '.env')
  let lines = []
  try { lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/) } catch {}
  const re = new RegExp('^\\s*' + meta.envKey + '\\s*=')
  let found = false
  lines = lines.map((l) => { if (re.test(l)) { found = true; return meta.envKey + '=' + k } return l })
  if (!found) lines.push(meta.envKey + '=' + k)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  fs.writeFileSync(envPath, lines.join('\n') + '\n')
  process.env[meta.envKey] = k
  return true
}
