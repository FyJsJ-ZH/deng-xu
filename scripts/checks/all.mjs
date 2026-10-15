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
  const ok = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(HERE, c.file)], {
      stdio: 'inherit',
      env: { ...process.env, SITE, AUDIT_OUT: OUT, CDP_PORT: String(c.port) },
    })
    p.on('exit', code => res(code === 0))
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push({ ...c, ok, secs })
  if (!ok) console.log(`✗ ${c.name} 未通过（${secs}s）`)
  else console.log(`✓ ${c.name} 通过（${secs}s）`)
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
