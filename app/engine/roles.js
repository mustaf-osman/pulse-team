// Pulse 虚拟团队 · 角色加载器
// 角色 = 数据：roles/index.json（花名册）+ roles/<id>.prompt.md（人设与输出契约）
// 想加一个角色：丢一个 prompt 文件 + 在 index.json 里加一行。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = path.join(__dirname, 'roles')

export function loadRoles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROLES_DIR, 'index.json'), 'utf-8'))
  return manifest.map((r) => ({
    ...r,
    prompt: fs.readFileSync(path.join(ROLES_DIR, `${r.id}.prompt.md`), 'utf-8'),
  }))
}
