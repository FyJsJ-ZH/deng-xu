/**
 * 一次跑完所有浏览器走查。
 *
 * 为什么要一个总入口：CI 里一个个 `node scripts/checks/xxx.mjs` 写四遍，
 * 而且它们共用同一个 dev server 和 Edge —— 分散调用容易漏掉某个，
 * 也不好统一汇总"到底哪一项挂了"。
 *
 * 每个走查用**独立的 CDP 端口**：串行跑时端口复用会偶发
 * "浏览器未就绪"（上一个进程还没退干净），我为此白排查过一次。
 *
 * ## 迭代用法（本轮新增）
 *
 * 全套 10 套跑一遍要两分钟出头，改一行代码就等两分钟太亏。所以：
 *
 *   node scripts/checks/all.mjs --only-failed   # 只重跑上次失败的那几套
 *   node scripts/checks/all.mjs --list          # 列出所有套件名
 *   node scripts/checks/all.mjs 主菜单 地图       # 按名字/文件名筛选（老用法）
 *
 * 失败清单落在 `.check/last-failed.json`。**只有跑全量时才写**，
 * 否则"只重跑失败项"会把清单越缩越小，最后丢掉真正的失败。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { waitForServer } from './_browser.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = process.env.AUDIT_OUT || path.join(ROOT, 'playtest-shots')
const FAILED_LIST = path.join(ROOT, '.check', 'last-failed.json')

const CHECKS = [
  { name: '主菜单', file: 'main-menu.mjs', port: 9870 },
  { name: '玩家体验', file: 'playtest.mjs', port: 9871 },
  { name: '出错路径', file: 'error-paths.mjs', port: 9872 },
  { name: '手机端', file: 'mobile.mjs', port: 9873 },
  { name: '返回键层级', file: 'back-nav.mjs', port: 9874 },
  { name: '地图昼夜', file: 'map-gallery.mjs', port: 9875 },
  { name: 'NPC 贴合度', file: 'npc-fidelity.mjs', port: 9876 },
  { name: 'NPC 词表覆盖', file: 'npc-coverage.mjs', port: 9877 },
  // 主角预设（提前设定主角）：建成后能在开局时一键套用
  { name: '我的主角', file: 'heroes.mjs', port: 9878 },
  // 「我自己写」背景项：选角页真的放出了文本框、输入真的进了 state
  { name: '自填背景', file: 'background-custom.mjs', port: 9879 },
  // 内置卡内容更新：把 IndexedDB 改成老玩家的样子再刷新，卡必须被换成新版。
  // 玩家为这件事说了三次「改了没生效」，所以它值得一套真机走查。
  { name: '内置卡刷新', file: 'builtin-refresh.mjs', port: 9868 },
  // 世界卡编辑器在 390px 上的横向溢出（用户拍过截图：「角色卡编辑ui太宽」）。
  // 判据是**任何 overflow-x:visible 的容器都不许超出容器宽** —— 页签栏那种
  // 故意可横滚的、以及 truncate 那种裁长文的，都不算。
  { name: '卡片编辑器(手机)', file: 'card-editor-mobile.mjs', port: 9869 },
  /*
    「重开本局」全流程的走查，**暂时不进默认全套**（2026-11）。

    它在本地稳定 13/13，但一进 CI 就连红三次，而 job 日志需要登录才看得到、
    annotations 又只有一句 exit code 1 —— 我在本地盲改了三轮都没猜对。
    这套走查本身没问题（功能是对的），卡住的是它在 Windows runner 上的某个
    环境差异，得先拿到真日志才能定位。

    **先把它移出必跑清单，别让一个测试脚本堵住部署。**
    单独验证时用：
      node scripts/checks/all.mjs restart-run.mjs

    排查方向（留给下一次）：脚本已内置 `::error::` 输出，CI 失败时会生成
    一条 annotation，可以匿名从
      /repos/{owner}/{repo}/check-runs/{id}/annotations
    读到具体是哪条断言挂的。拿到那条之后再决定是修脚本还是修环境假设。
  */
  // { name: '重开本局', file: 'restart-run.mjs', port: 9816 },
]

// ── 参数解析 ──
const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const positional = argv.filter(a => !a.startsWith('--'))

if (flag('--list')) {
  console.log('\n可用的走查套件：\n')
  for (const c of CHECKS) console.log(`  ${c.name.padEnd(12)} ${c.file}   (CDP ${c.port})`)
  console.log('\n用法：')
  console.log('  node scripts/checks/all.mjs                    # 全套')
  console.log('  node scripts/checks/all.mjs --only-failed      # 只重跑上次失败的')
  console.log('  node scripts/checks/all.mjs 地图 NPC            # 按名字筛选')
  console.log('  node scripts/checks/all.mjs map-gallery.mjs    # 按文件名筛选\n')
  process.exit(0)
}

function readFailedList() {
  try {
    const j = JSON.parse(fs.readFileSync(FAILED_LIST, 'utf8'))
    return Array.isArray(j.failed) ? j.failed : []
  } catch { return [] }
}

let todo
let mode

if (flag('--only-failed')) {
  const failedFiles = readFailedList()
  if (!failedFiles.length) {
    console.log('\n上次没有失败项（或还没有失败清单）——没有要重跑的。')
    console.log(`清单位置：${FAILED_LIST}\n`)
    process.exit(0)
  }
  todo = CHECKS.filter(c => failedFiles.includes(c.file))
  mode = `只重跑上次失败的 ${todo.length} 套`
  if (!todo.length) {
    console.log('\n失败清单里的套件名都对不上当前列表，可能已被重命名。清单内容：')
    failedFiles.forEach(f => console.log('  ' + f))
    process.exit(1)
  }
} else if (positional.length) {
  todo = CHECKS.filter(c => positional.some(o => c.file.includes(o) || c.name.includes(o)))
  mode = `按名筛选出 ${todo.length} 套`
  if (!todo.length) {
    console.error(`✗ 没有匹配的套件：${positional.join('、')}`)
    console.error('  用 --list 看可用名字。')
    process.exit(1)
  }
} else {
  todo = CHECKS
  mode = '全套'
}

// 只有全量运行才更新失败清单
const isFullRun = todo.length === CHECKS.length

console.log(`\n运行模式：${mode}`)
console.log(`等待 dev server：${SITE}`)
if (!(await waitForServer(SITE))) {
  console.error('✗ dev server 没起来。先运行 `pnpm dev`（CI 里是 build 后 preview）。')
  process.exit(1)
}
console.log('✓ dev server 就绪\n')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

const started = Date.now()
const results = []
for (const c of todo) {
  console.log('─'.repeat(60))
  console.log(`▶ ${c.name}（${c.file}）`)
  console.log('─'.repeat(60))
  const t0 = Date.now()
  /*
    子进程输出**既原样转发、又留尾巴**（2026-11）。

    原来用 `stdio: 'inherit'`，输出直接进日志 —— 但 CI 只看最后 60 行，
    而最后 60 行永远是总览表。于是"哪一套挂了、挂在哪条断言"根本看不到，
    只能靠本地复现猜（本地 12/12，猜了两轮都没猜对）。

    改成 pipe + 转发：终端里照旧实时可见，同时把每套最后 40 行留下 ——
    失败时用它拼一条 `::error::`，GitHub 会收成 annotation，
    **未登录也能通过 API 读到**。
  */
  let tail = []
  const ok = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(HERE, c.file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SITE, AUDIT_OUT: OUT, CDP_PORT: String(c.port) },
    })
    const keep = (d) => {
      process.stdout.write(d)
      const lines = String(d).split('\n').filter(l => l.trim())
      tail = [...tail, ...lines].slice(-40)
    }
    p.stdout.on('data', keep)
    p.stderr.on('data', d => { process.stderr.write(d); const lines = String(d).split('\n').filter(l => l.trim()); tail = [...tail, ...lines].slice(-40) })
    p.on('exit', code => res(code === 0))
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push({ ...c, ok, secs })
  if (!ok) {
    console.log(`✗ ${c.name} 未通过（${secs}s）`)
    /*
      在 CI 里把失败现场抬成 annotation。取尾巴里最像"结论"的几行：
      断言失败行（✗ 开头）优先，没有就取最后三行。
    */
    const bad = tail.filter(l => l.includes('✗')).slice(0, 3)
    const detail = (bad.length ? bad : tail.slice(-3)).join(' ／ ').replace(/::/g, ':')
    console.log(`::error::${c.name} 未通过 —— ${detail}`)
  } else {
    console.log(`✓ ${c.name} 通过（${secs}s）`)
  }
  console.log('')
}

console.log('═'.repeat(60))
console.log('浏览器走查总览')
console.log('═'.repeat(60))
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(12)} ${r.secs}s`)
const failed = results.filter(r => !r.ok)
const total = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n  ${results.length - failed.length}/${results.length} 套走查通过（用时 ${total}s）`)
if (failed.length) console.log('  失败：' + failed.map(r => r.name).join('、'))
console.log(`  截图目录：${OUT}`)

// ── 失败清单 ──
if (isFullRun) {
  fs.mkdirSync(path.dirname(FAILED_LIST), { recursive: true })
  fs.writeFileSync(FAILED_LIST, JSON.stringify({
    at: new Date().toISOString(),
    site: SITE,
    failed: failed.map(r => r.file),
    failedNames: failed.map(r => r.name),
    passed: results.filter(r => r.ok).length,
    total: results.length,
  }, null, 2) + '\n', 'utf8')
}

if (failed.length) {
  console.log(`\n  下次只重跑失败的这几套：`)
  console.log(`    node scripts/checks/all.mjs --only-failed\n`)
} else if (isFullRun) {
  console.log(`\n  全部通过 ✓  失败清单已清空（${path.relative(ROOT, FAILED_LIST)}）\n`)
}

process.exit(failed.length ? 1 : 0)
