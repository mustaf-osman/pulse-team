// Pulse 虚拟团队 · 交付证书
// 别的 Agent 说"我做好了"；我们给一张**可复现的证明**：每件产出的哈希 + 每个质量指标 +
// 谁批的 + 一条复验命令（任何人都能自己跑一遍，对不上就是造假）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const sha256 = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16) } catch { return null }
}
const sizeKB = (file) => { try { return +(fs.statSync(file).size / 1024).toFixed(1) } catch { return null } }

// 收集产出物（跳过测试截图等噪音可选保留）
function collectArtifacts(run) {
  const out = []
  const walk = (dir, rel = '') => {
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = path.join(dir, it.name)
      const r = rel ? rel + '/' + it.name : it.name
      if (it.isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(run.artifactsDir)
  return out.filter((f) => !/\.(bak|tmp)$/i.test(f) && !/\.bak-/.test(f))
}

export function issueCertificate(run, { requirement, design, vision, quality, coverage, verify, stats, approved, gateNote, models }) {
  const files = collectArtifacts(run)
  const arts = files.map((rel) => {
    const abs = path.join(run.artifactsDir, rel)
    return { rel: 'artifacts/' + rel, kb: sizeKB(abs), sha256: sha256(abs) }
  })
  const cert = {
    kind: 'pulse-delivery-certificate',
    version: 1,
    runId: run.id,
    requirement: String(requirement || '').slice(0, 300),
    issuedAt: new Date().toISOString(),
    durationMs: stats && stats.durationMs ? stats.durationMs : null,
    approved: !!approved,
    gateComment: gateNote ? String(gateNote).slice(0, 300) : '',
    models: models || [],
    metrics: {
      designScore: design && design.ok ? design.score : null,
      designGrade: design && design.ok ? design.grade : null,
      visionScore: vision && vision.ok ? vision.score : null,
      visionVerdict: vision && vision.ok ? vision.verdict : null,
      qualityScore: quality ? quality.score : null,
      coverage: coverage && !coverage.error ? { total: coverage.total, covered: coverage.covered, rate: coverage.rate } : null,
      htmlValidate: verify && verify.html ? { ok: verify.html.ok, errors: verify.html.errors, warnings: verify.html.warnings } : null,
      axe: verify && verify.axe ? { ok: verify.axe.ok, critical: verify.axe.critical, serious: verify.axe.serious } : null,
      compile: verify && verify.compile ? { ok: verify.compile.ok } : null,
    },
    artifacts: arts,
  }
  const json = JSON.stringify(cert, null, 2)
  fs.writeFileSync(path.join(run.artifactsDir, 'certificate.json'), json)

  const md = `# 交付证书 · ${run.id}

> 本证书由引擎自动签发：**每条结论都对应一次真实测量**，任何人对不上可以重跑。
> 复验命令：\`node app/tools/verify-certificate.mjs runs/${run.id}\`

## 需求
${cert.requirement}

## 结论
- 交付时间：${new Date(cert.issuedAt).toLocaleString('zh-CN')}
- 用时：${cert.durationMs ? (cert.durationMs / 1000).toFixed(1) + ' 秒' : '—'}
- 人工批复：${cert.approved ? '✅ 通过' : '❌ 未通过'}${cert.gateComment ? '（意见：' + cert.gateComment + '）' : ''}
- 参与模型：${cert.models.join(' · ') || '—'}

## 质量指标（全部为真实测量）
| 指标 | 结果 |
|---|---|
| 设计审计（真浏览器量测排版/对比度/一致性） | ${cert.metrics.designScore == null ? '—' : cert.metrics.designScore + ' 分（' + cert.metrics.designGrade + '）'} |
| 视觉评审（多模态真看图） | ${cert.metrics.visionScore == null ? '—' : cert.metrics.visionScore + ' 分 · ' + (cert.metrics.visionVerdict || '')} |
| 质量体检（安全/健壮性/性能预算） | ${cert.metrics.qualityScore == null ? '—' : cert.metrics.qualityScore + ' 分'} |
| 需求覆盖对账 | ${cert.metrics.coverage ? cert.metrics.coverage.covered + '/' + cert.metrics.coverage.total + '（' + (cert.metrics.coverage.rate * 100).toFixed(0) + '%）' : '—'} |
| HTML 规范（html-validate） | ${cert.metrics.htmlValidate ? (cert.metrics.htmlValidate.ok ? '通过' : cert.metrics.htmlValidate.errors + ' 个错误') : '—'} |
| 无障碍（axe-core, WCAG 2.0 AA） | ${cert.metrics.axe ? (cert.metrics.axe.ok ? '通过（0 严重项）' : cert.metrics.axe.critical + ' 个严重项') : '—'} |
| 语法编译（esbuild） | ${cert.metrics.compile ? (cert.metrics.compile.ok ? '通过' : '失败') : '—'} |

## 产出物与指纹（SHA-256 前 16 位）
| 文件 | 大小 | 指纹 |
|---|---|---|
${arts.map((a) => `| ${a.rel} | ${a.kb} KB | \`${a.sha256}\` |`).join('\n')}

---
*任何一份产出被改动，指纹都会变 —— 拿复验命令跑一遍即可验证。*
`
  fs.writeFileSync(path.join(run.artifactsDir, '交付证书.md'), md)
  return { cert, rel: 'artifacts/交付证书.md', relJson: 'artifacts/certificate.json' }
}
