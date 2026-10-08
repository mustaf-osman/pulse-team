// Pulse 虚拟团队 · git 交付历史
// 单智能体给不出"多角色署名的提交历史"。这里把每次产出/每次打回/每次审批都变成真实 commit：
// git log = 交付史 · git diff = 打回证据 · git blame = 这行是谁改的
import { execFileSync } from 'node:child_process'

const NAME = { pm: '项目经理', req: '需求分析师', des: '方案设计', dev: '编码开发', qa: '测试工程', doc: '文档工程', user: '人类·用户', engine: '引擎' }

function run(dir, args, opts = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

export function gitInit(dir) {
  try {
    run(dir, ['init', '-q'])
    run(dir, ['config', 'user.name', 'Pulse 虚拟团队'])
    run(dir, ['config', 'user.email', 'team@pulse.local'])
    run(dir, ['config', 'commit.gpgsign', 'false'])
    return true
  } catch { return false }
}

export function gitCommit(dir, message, roleId = 'engine', when = null) {
  try {
    run(dir, ['add', '-A'])
    const args = ['commit', '-q', '--allow-empty', '-m', String(message).slice(0, 200), '--author', `${NAME[roleId] || roleId} <${roleId}@pulse.local>`]
    if (when) args.push('--date', when)
    run(dir, args)
    return true
  } catch { return false }
}

export function gitLog(dir, n = 30) {
  try {
    const out = run(dir, ['log', `-n${n}`, '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--date=format:%m-%d %H:%M'])
    return out.split('\n').filter(Boolean).map((l) => {
      const [hash, an, ad, ...rest] = l.split('\x1f')
      return { hash, author: an, date: ad, msg: rest.join('\x1f') }
    })
  } catch { return [] }
}

export function gitStat(dir) {
  try { return { commits: gitLog(dir, 200).length, files: run(dir, ['ls-files']).split('\n').filter(Boolean).length } } catch { return { commits: 0, files: 0 } }
}
