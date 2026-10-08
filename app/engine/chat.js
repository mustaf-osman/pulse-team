// Pulse 虚拟团队 · 与角色直接对话（@点名）
// 用户在协作台 @ 某个角色，用该角色的身份提示词 + 真实上下文进行多轮对话
import fs from 'node:fs'
import path from 'node:path'
import { chat as llm } from './llm.js'
import { loadRoles } from './roles.js'
import { emit, getHistory, getRunDir } from './bus.js'
import { isRunning, getCurrent, generateHtml } from './orchestrator.js'
import { runWebTest } from './webtest.js'

const histories = new Map() // agentId -> [{role, content}]

export function resetChat() {
  histories.clear()
  console.log('[chat] 对话历史已重置')
}

// 别名表（与前端 web/app.js 里的 CHAT_ALIAS 保持同步）
export const ALIAS = {
  项目经理: 'pm', 总: 'pm', pm: 'pm',
  需求分析师: 'req', 需求: 'req', 需: 'req', req: 'req',
  方案设计: 'des', 设计: 'des', 设: 'des', des: 'des',
  编码开发: 'dev', 编码: 'dev', 码: 'dev', dev: 'dev',
  测试工程: 'qa', 测试: 'qa', 测: 'qa', qa: 'qa',
  文档工程: 'doc', 文档: 'doc', 档: 'doc', doc: 'doc',
}

export function resolveAlias(name) {
  const raw = String(name || '').trim()
  return ALIAS[raw] || ALIAS[raw.toLowerCase()] || null
}

function projectContext() {
  const cur = getCurrent()
  const hist = getHistory()
  const artifacts = hist.filter((e) => e.type === 'artifact').map((e) => e.name)
  const lines = []
  if (cur && cur.requirement) lines.push(`当前项目需求：${cur.requirement}`)
  lines.push(`已产出：${artifacts.length ? artifacts.join('、') : '（还没有产出）'}`)
  lines.push(`流水线状态：${isRunning() ? '正在运行中' : '空闲或已结束'}`)
  return lines.join('\n')
}

const headTail = (s, cap = 24000) => (s && s.length > cap ? s.slice(0, cap / 2) + '\n…（中间省略）…\n' + s.slice(-cap / 2) : s || '')

// 对话式修改：编码角色把用户的修改要求真的改到原型里（改完真浏览器复测）
async function runEdit(instruction) {
  if (isRunning()) {
    emit('chat', { agent: 'dev', from: 'agent', text: '流水线正在跑——等它跑完我再动手改，免得两边打架。' })
    return
  }
  const dir = getRunDir()
  if (!dir) { emit('chat', { agent: 'dev', from: 'agent', text: '现在还没有原型可改——先发一个需求给团队吧。' }); return }
  const htmlPath = path.join(dir, 'artifacts', 'prototype', 'index.html')
  if (!fs.existsSync(htmlPath)) { emit('chat', { agent: 'dev', from: 'agent', text: '这个运行里还没有原型产出，先让团队跑一轮吧。' }); return }
  const cur = fs.readFileSync(htmlPath, 'utf-8')
  emit('chat', { agent: 'dev', from: 'agent', text: '收到，我现在动手改：「' + instruction.slice(0, 40) + '」' })
  const role = loadRoles().find((r) => r.id === 'dev')
  const next = await generateHtml(role, `按下面的修改说明修改你当前的单文件 HTML（保持其余部分不变、最小改动，输出修改后的完整 HTML）：\n${instruction}\n\n当前代码：\n${headTail(cur)}`)
  const run = { id: path.basename(dir), dir }
  // 保险 1：形状检查（截断/大面积丢失 → 不写盘直接还原）
  const badShape = !/<\/html>\s*$/i.test(next.trim()) || next.length < cur.length * 0.4
  let web = { ok: false, consoleErrors: [], reason: '产出不完整（形状检查未通过）', shotRel: null }
  if (!badShape) {
    fs.writeFileSync(htmlPath, sanitizeHtml(next))
    web = await runWebTest(htmlPath, run)
  }
  if (web.ok) {
    emit('artifact', { agent: 'dev', name: 'index.html（对话修改版）', rel: 'prototype/index.html', url: `/runs/${run.id}/artifacts/prototype/index.html` })
    emit('test', { ok: true, errors: [], shot: web.shotRel, retest: true, reason: null, fromChat: true })
    emit('chat', { agent: 'dev', from: 'agent', text: '改好了 ✓ 已复测通过，点「预览原型 ▶」看新版。' })
  } else {
    // 保险 2：复测没过 → 自动还原上一版
    try { fs.writeFileSync(htmlPath, cur) } catch {}
    emit('test', { ok: false, errors: (web.consoleErrors || []).slice(0, 5), shot: web.shotRel, retest: true, reason: web.reason || null, fromChat: true, restored: true })
    emit('chat', { agent: 'dev', from: 'agent', text: '这次改动复测没过（' + String(web.reason || '产出不完整').slice(0, 40) + '），已自动还原到上一版，免得改坏。换个说法再试一次？' })
  }
}

export async function chatWithAgent(agentId, text) {
  const role = loadRoles().find((r) => r.id === agentId)
  if (!role) throw new Error('未知角色：' + agentId)
  emit('chat', { agent: agentId, from: 'user', to: agentId, text })
  const hist = histories.get(agentId) || []
  const editHint = agentId === 'dev' ? `

## 修改原型的能力
如果用户的消息是在要求修改原型（改颜色/文案/布局/加功能等），请在回答的最后单独一行输出：<<<EDIT: 把用户的修改要求整理成明确可执行的修改说明>>>（这一行只写修改说明，不要写代码）。如果只是普通提问或闲聊，不要输出该标记。` : ''
  const sys = `${role.prompt}

## 你正在和用户直接对话
你正在协作台里被用户 @ 点名对话。结合团队当前项目与产出、以你的角色身份直接回答。
要求：口语、自然、简洁（通常 1~4 句）；不写文档体、不用 Markdown 标题；不知道的事就直说。${editHint}

## 当前项目快照
${projectContext()}`
  const messages = [
    { role: 'system', content: sys },
    ...hist.slice(-12),
    { role: 'user', content: text },
  ]
  const r = await llm({ messages, temperature: Math.max(0.3, (role.temp || 0.6) + 0.2), maxTokens: 800, provider: role.provider, model: role.model })
  let reply = (r.content || '').trim() || '（我没想好怎么回，你再说一遍？）'
  let editInstruction = null
  if (agentId === 'dev') {
    const em = reply.match(/<<<EDIT:\s*([\s\S]*?)>>>/)
    if (em) { editInstruction = em[1].trim(); reply = reply.replace(em[0], '').trim() || '好的，我来改。' }
  }
  hist.push({ role: 'user', content: text }, { role: 'assistant', content: reply })
  histories.set(agentId, hist.slice(-16))
  emit('chat', { agent: agentId, from: 'agent', text: reply })
  if (editInstruction) runEdit(editInstruction).catch((e) => emit('chat', { agent: 'dev', from: 'agent', text: '（修改出了点问题：' + String((e && e.message) || e).slice(0, 80) + '）' }))
  return reply
}
