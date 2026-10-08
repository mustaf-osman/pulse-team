// Pulse 虚拟团队 · 运行工作区
// 每次运行一个目录：runs/<runId>/（artifacts/ 存产出，events.jsonl 存事件）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectUikit } from './uikit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = path.resolve(__dirname, '..')
export const RUNS_DIR = path.join(APP_ROOT, 'runs')

export function createRun() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const id = `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`
  const dir = path.join(RUNS_DIR, id)
  const artifactsDir = path.join(dir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  return { id, dir, artifactsDir }
}

export function writeArtifact(run, rel, content) {
  const target = path.join(run.artifactsDir, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let body = content
  if (/\.html?$/i.test(rel)) {
    body = sanitizeHtml(content)
    // UI 保证层：注入设计系统 + 机械统一字号/圆角/容器宽度（确定性，零 LLM）
    try { body = injectUikit(body).html } catch {}
  }
  fs.writeFileSync(target, body)
  return target
}

// 净化模型输出为可用的 HTML：
// 模型常把代码包在 markdown 围栏里、或在前面写一段说明 —— 若原样落盘，浏览器会因为
// DOCTYPE 之前有文本而进入「怪异模式」(BackCompat)，布局全乱；这里统一剥掉。
export function sanitizeHtml(raw) {
  let src = String(raw == null ? '' : raw)
  let i = src.search(/<!DOCTYPE\s+html/i)
  if (i < 0) i = src.search(/<html[\s>]/i)
  if (i > 0) src = src.slice(i)
  src = src.replace(/^\s*```[a-zA-Z]*\s*/, '')
  src = src.replace(/```[\s\S]*$/, '').trimEnd()
  if (!/^<!DOCTYPE/i.test(src)) src = '<!DOCTYPE html>\n' + src.replace(/^<html/i, '<html')
  const j = src.lastIndexOf('</html>')
  if (j > 0) src = src.slice(0, j + 7)
  return src.trimEnd() + '\n'
}

export function artifactUrl(run, rel) {
  return `/runs/${run.id}/artifacts/${rel.split(path.sep).join('/')}`
}
