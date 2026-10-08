// Pulse 虚拟团队 · 团队记忆
// 信仰：模型每次调用都是白纸 —— 所以"变强的唯一途径"是把每轮经验存下来、下轮再喂回去。
// 这里做三件事：① 存（跑完自动沉淀教训）② 取（按相关性注入角色提示词）③ 不重复（去重）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
const DATA = process.env.PT_DATA || path.join(path.dirname(APP_ROOT), 'data')
const MEM_DIR = path.join(DATA, 'memory')
const ROLES_DIR = path.join(MEM_DIR, 'roles')
const PROJECT = path.join(MEM_DIR, 'project.md')
const MAX_PER_ROLE = 60        // 每角色最多留 60 条，超了淘汰最旧的
const MAX_PER_PROJECT = 80
const RECALL_N = 6             // 每次注入 6 条最相关的

function ensure() {
  try { fs.mkdirSync(ROLES_DIR, { recursive: true }) } catch {}
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').map((s) => s.trim()).filter((s) => s.startsWith('- '))
  } catch { return [] }
}

function writeLines(file, lines) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `# 团队记忆 · ${path.basename(file).replace('.md', '')}\n\n` + lines.join('\n') + '\n')
  } catch {}
}

// 记忆条目格式：- [时间] [标签] 内容
function addLine(file, text, tag = '经验', cap = MAX_PER_ROLE) {
  ensure()
  const line = `- [${new Date().toISOString().slice(0, 10)}] [${tag}] ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`
  const key = line.slice(line.indexOf(']', line.indexOf(']') + 1) + 1).trim().toLowerCase().slice(0, 60)
  const lines = readLines(file)
  if (lines.some((l) => l.toLowerCase().includes(key))) return false
  lines.push(line)
  writeLines(file, lines.slice(-cap))
  return true
}

export function learnRole(roleId, text, tag) { return addLine(path.join(ROLES_DIR, `${roleId}.md`), text, tag) }
export function learnProject(text, tag) { return addLine(PROJECT, text, tag, MAX_PER_PROJECT) }
export function allRoleMemory(roleId) { return readLines(path.join(ROLES_DIR, `${roleId}.md`)) }
export function allProjectMemory() { return readLines(PROJECT) }

// 相关性打分：关键词重合 + 标签权重（确定性，不用模型）
const STOP = new Set(['的', '了', '和', '与', '在', '是', '我', '你', '他', '这', '那', '个', '要', '把', 'the', 'and', 'for', 'with', 'a', 'to', 'of'])
function tokens(s) {
  const en = String(s).toLowerCase().match(/[a-z0-9_\-]{3,}/g) || []
  const zh = String(s).match(/[\u4e00-\u9fa5]{2,4}/g) || []
  return [...new Set([...en, ...zh].filter((t) => !STOP.has(t)))]
}
export function recall(roleId, ctxText = '', n = RECALL_N) {
  const pool = [
    ...allRoleMemory(roleId).map((l) => ({ l, w: 1 })),
    ...allProjectMemory().map((l) => ({ l, w: 0.8 })),
  ]
  if (!pool.length) return []
  const ctx = new Set(tokens(ctxText))
  const scored = pool.map(({ l, w }) => {
    let s = w
    for (const t of tokens(l)) if (ctx.has(t)) s += 1
    if (/\[教训\]/.test(l)) s += 0.6          // 教训优先被复用
    if (/\[回滚\]|\[打回\]/.test(l)) s += 0.4
    return { l, s }
  })
  return scored.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.l)
}

// 把记忆渲染成可注入提示词的一段（没有记忆就返回空串）
export function memoryBlock(roleId, ctxText = '') {
  const lines = recall(roleId, ctxText)
  if (!lines.length) return ''
  return `\n\n## 团队历史经验（真跑出来的，优先照做，不要重犯）\n${lines.join('\n')}\n`
}

// 跑完一次运行，把可复用的结论沉淀下来（确定性，不额外调模型）
export function learnFromRun({ requirement, audit, web, rejects = [], gateComment = '', vision = null, artifacts = [] }) {
  const learned = []
  const l = (ok) => { if (ok) learned.push(1) }
  l(learnProject(`需求「${String(requirement || '').slice(0, 40)}」的设计审计 ${audit && audit.score} 分（${audit && audit.grade}）`, '统计'))
  if (audit && audit.metrics) {
    const m = audit.metrics
    const col = m.column ? m.column.ratio : m.container.ratio
    if (col < 0.75) l(learnRole('dev', `内容列只占视口 ${(col * 100).toFixed(0)}% 会被审计扣分 → 页面级容器一律 max-width:var(--pt-max,1200px)`, '教训'))
    if (m.emojiIcons > 0) l(learnRole('dev', `用了 ${m.emojiIcons} 处 emoji 当图标被扣分 → 一律内联 SVG`, '教训'))
    if (m.wiring && m.wiring.rate < 0.6) l(learnRole('dev', `CSS 类名命中率只有 ${(m.wiring.rate * 100).toFixed(0)}%：写完必须回头核对「CSS 里每个类在 HTML 里都存在」，类名对不上等于没上样式`, '教训'))
    if (m.contrast && m.contrast.worst < 4.5) l(learnRole('dev', `文字对比度 ${m.contrast.worst}:1 不达标 → 浅底不用浅灰字，正文 ≥4.5:1`, '教训'))
    if (m.fontSizes && m.fontSizes.length > 10) l(learnRole('dev', `字号用了 ${m.fontSizes.length} 级太碎 → 只用 12/14/16/18/24/32/44`, '教训'))
    if (m.overflowX) l(learnRole('dev', '出现横向溢出 → 所有固定宽度容器加 max-width:100%，长文本加 word-break', '教训'))
  }
  if (web && !web.ok) l(learnRole('qa', `原型未通过真实浏览器检查：${String(web.reason || '').slice(0, 60)}`, '教训'))
  if (web && web.clickIssues && web.clickIssues.length) l(learnRole('qa', `点测发现问题：${web.clickIssues.slice(0, 2).join('；').slice(0, 100)}`, '教训'))
  for (const r of rejects.slice(0, 3)) l(learnRole('dev', `被打回原因：${String(r).slice(0, 120)}`, '打回'))
  if (gateComment) l(learnProject(`人工批复意见：${String(gateComment).slice(0, 160)}`, '打回'))
  if (vision && vision.issues && vision.issues.length) l(learnRole('des', `视觉评审指出：${vision.issues.slice(0, 3).join('；').slice(0, 160)}`, '教训'))
  if (artifacts.length) l(learnProject(`本次产出：${artifacts.slice(0, 6).join(' / ')}`, '产出'))
  return learned.length
}

export function memoryStats() {
  ensure()
  const roles = {}
  try { for (const f of fs.readdirSync(ROLES_DIR)) roles[f.replace('.md', '')] = readLines(path.join(ROLES_DIR, f)).length } catch {}
  return { dir: MEM_DIR, roles, project: allProjectMemory().length }
}

// 忘掉某条（用户在"记忆区"里点删除）
export function forgetMemory({ scope = 'role', id = 'dev', text = '' } = {}) {
  const file = scope === 'project' ? PROJECT : path.join(ROLES_DIR, `${id}.md`)
  const lines = readLines(file)
  const key = String(text).replace(/^-\s*/, '').trim().slice(0, 60).toLowerCase()
  const idx = lines.findIndex((l) => l.toLowerCase().includes(key))
  if (idx < 0) return false
  lines.splice(idx, 1)
  writeLines(file, lines)
  return true
}

// 清空某角色的记忆（或整个项目记忆）
export function clearMemory({ scope = 'role', id = 'dev' } = {}) {
  const file = scope === 'project' ? PROJECT : path.join(ROLES_DIR, `${id}.md`)
  try { fs.writeFileSync(file, `# 团队记忆 · ${path.basename(file).replace('.md', '')}\n`); return true } catch { return false }
}
