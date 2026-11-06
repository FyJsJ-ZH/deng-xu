/**
 * 把 SillyTavern 提示词预设（completion preset）转成本作的世界包。
 *
 * 用法：
 *   node scripts/st-preset-to-world.mjs "<文件1.json>" ["<文件2.json>" ...] [-o 输出目录]
 *
 * 产出：`<输出目录>/<原名>.worldpack.json`（`format: deng-xu-worldpack`），
 * 直接拖进「世界包 → 导入」即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const checkDir = path.join(root, '.check')
const bundle = path.join(checkDir, 'stPreset.mjs')

const args = process.argv.slice(2)
const outIdx = args.indexOf('-o')
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'converted')
const files = args.filter((a, i) => a !== '-o' && i !== outIdx + 1)

if (!files.length) {
  console.error('用法: node scripts/st-preset-to-world.mjs <预设.json> [...] [-o 输出目录]')
  process.exit(1)
}

// 1) 打包转换器（它 import 了 @/utils/files，只能用 esbuild 走别名）
fs.mkdirSync(checkDir, { recursive: true })
execFileSync(process.execPath, [
  path.join(root, 'node_modules/esbuild/bin/esbuild'),
  'src/utils/stPreset.ts',
  '--bundle', '--platform=node', '--format=esm',
  `--outfile=${bundle}`, '--alias:@=./src', '--log-level=error',
], { cwd: root, stdio: 'inherit' })

const { isSillyTavernPreset, fromSillyTavernPreset, describePreset } = await import(
  'file://' + bundle.replace(/\\/g, '/')
)

// 2) 逐个转换
fs.mkdirSync(outDir, { recursive: true })
let ok = 0

for (const f of files) {
  const p = path.resolve(f)
  const name = path.basename(p)
  if (!fs.existsSync(p)) { console.log(`✗ ${name}：文件不存在`); continue }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.log(`✗ ${name}：不是合法 JSON（${e.message}）`); continue
  }

  if (!isSillyTavernPreset(raw)) {
    console.log(`✗ ${name}：不是 SillyTavern 提示词预设`)
    continue
  }

  const brief = describePreset(raw)
  const world = fromSillyTavernPreset(raw, name)
  if (!world) { console.log(`✗ ${name}：条目全是停用或空的`); continue }

  const pack = {
    format: 'deng-xu-worldpack',
    version: 1,
    exportedAt: Date.now(),
    worldCount: 1,
    worldTitles: [world.title],
    worlds: [world],
  }

  const outName = `${path.basename(name, '.json')}.worldpack.json`
  const outPath = path.join(outDir, outName)
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf8')

  ok++
  console.log(`✓ ${name}`)
  console.log(`   启用条目 ${brief.total} 条 → 文风 ${brief.style} / 规则 ${brief.rules} / 设定 ${brief.other}`)
  console.log(`   worldLore ${world.worldLore.length} 字 · rules ${world.rules.length} 字 · customStyle ${world.narrative.customStyle.length} 字`)
  console.log(`   → ${outPath}`)
}

console.log(`\n完成：${ok}/${files.length}`)
if (ok) console.log(`把 ${outDir} 里的文件拖进「世界包 → 导入」即可。`)
