/**
 * SillyTavern **角色卡（PNG）** → 灯叙的**完整世界卡**（角色 / 属性 / 资源 / 出身 / 物品）
 *
 * 用法：
 *   node scripts/st-card-to-world.mjs <卡.png> [-o 目录] [--cover 封面]
 *   node scripts/st-card-to-world.mjs <卡1.png> <卡2.png> --book "书名" [-o 目录]
 *
 * ## 转的不只是正文
 *
 * 这类卡的 `description` 是空的，内容全在 `character_book` 里 ——
 * 但不止是"设定文本"：`[initvar]` 那张变量表里还写着
 *
 *  · 主角的境界 / 修为 / 气血 / 灵石（→ `resources`）
 *  · 每个人物的 `_属性: { 力道: 65, 体魄: 60, … }`（→ `attributes` 与角色卡）
 *  · 势力 / 宗门（→ 出身槽位与 lore）
 *  · 秘籍 / 物品（→ `items`）
 *
 * 转换逻辑在 `src/utils/stCardToWorld.ts`，**与游戏内导入共用同一份** ——
 * 命令行和拖进界面的结果必须一模一样，否则"我这里好好的，你那边不对"永远查不完。
 *
 * ## 两种输出
 *
 * | 格式 | 什么时候 |
 * |---|---|
 * | `deng-xu-worldpack` | 单张卡 |
 * | `deng-xu-worldbook` | 给了 `--book`，或转了不止一张 |
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkDir = path.join(root, '.check')
const args = process.argv.slice(2)

function opt(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] || '' : ''
}

const outDir = opt('-o') ? path.resolve(opt('-o')) : path.join(root, 'converted')
const coverPath = opt('--cover')
const bookTitle = opt('--book')

/*
  ⚠️ `i !== outIdx + 1` 单独写是**错的**：没给选项时 indexOf 返回 -1，
  加一正好是 0，于是唯一的那个文件参数被当成"选项的值"过滤掉，
  脚本报一句"用法"，而命令明明是对的。判据必须先确认 `>= 0`。
*/
const VALUE_FLAGS = ['-o', '--cover', '--book']
const files = args.filter((a, i) => {
  if (VALUE_FLAGS.includes(a)) return false
  return !VALUE_FLAGS.some(flag => {
    const idx = args.indexOf(flag)
    return idx >= 0 && i === idx + 1
  })
})

if (!files.length) {
  console.error('用法: node scripts/st-card-to-world.mjs <卡.png> [...] [--book 书名] [-o 目录] [--cover 图]')
  process.exit(1)
}

// 打包转换器（它 import 了 @/types、@/utils/files，只能走 esbuild 别名）
fs.mkdirSync(checkDir, { recursive: true })
execFileSync(process.execPath, [
  path.join(root, 'node_modules/esbuild/bin/esbuild'),
  'src/utils/stCardToWorld.ts', 'src/utils/pngCard.ts',
  '--bundle', '--platform=node', '--format=esm', '--outdir=.check/full-src',
  '--alias:@=./src', '--log-level=error',
], { cwd: root, stdio: 'inherit' })

const { stCardToWorld } = await import(
  'file://' + path.join(root, '.check/full-src/stCardToWorld.js').replace(/\\/g, '/'))
const { readStCardFromPng } = await import(
  'file://' + path.join(root, '.check/full-src/pngCard.js').replace(/\\/g, '/'))

function mimeOf(file) {
  const b = fs.readFileSync(file)
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  return ''
}

const coverDataUrl = (() => {
  if (!coverPath || !fs.existsSync(coverPath)) return ''
  const mime = mimeOf(coverPath)
  return mime ? `data:${mime};base64,${fs.readFileSync(coverPath).toString('base64')}` : ''
})()

fs.mkdirSync(outDir, { recursive: true })
const worlds = []

for (const f of files) {
  const p = path.resolve(f)
  const name = path.basename(p)
  if (!fs.existsSync(p)) { console.log(`✗ ${name}：文件不存在`); continue }

  const buf = fs.readFileSync(p)
  const card = readStCardFromPng(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  if (!card) {
    console.log(`✗ ${name}：不是带角色数据的 PNG（WebP/JPEG 存不了 ST 卡数据 —— 那只是一张图）`)
    continue
  }

  const r = stCardToWorld(card)
  if (!r) { console.log(`✗ ${name}：世界书是空的（条目全被停用或没正文）`); continue }

  const world = files.length === 1 && coverDataUrl ? { ...r.world, cover: coverDataUrl } : r.world
  worlds.push(world)

  const s = r.stats
  console.log(`✓ ${name} → 《${world.title}》`)
  console.log(`   角色 ${s.characters} | 属性 ${s.attributes} | 资源 ${s.resources} | 出身 ${s.backgrounds} | 物品 ${s.items} | 设定 ${s.lores}`)
  console.log(`   worldLore ${s.loreChars} 字 | rules ${world.rules.length} 字 | 机制层 ${world.enableMechanics}`)
  if (s.dropped.length) console.log(`   跳过变量系统 ${s.dropped.length} 条`)
}

if (!worlds.length) { console.log('\n没有可转换的卡'); process.exit(1) }

const now = Date.now()
const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_')

if (bookTitle || worlds.length > 1) {
  const title = bookTitle || worlds.map(w => w.title).join(' · ')
  const book = {
    format: 'deng-xu-worldbook',
    version: 1,
    title: title.slice(0, 80),
    tagline: `${worlds.length} 个世界，由 SillyTavern 角色卡转换`,
    description: [
      '每张卡对应一个世界：角色、属性、资源、出身、物品都已就位。',
      '',
      ...worlds.map(w => `· 《${w.title}》：${w.characters.length} 角色 / ${w.lores.length} 设定 / ${w.items.length} 物品`),
    ].join('\n'),
    author: '由 SillyTavern 角色卡转换',
    tags: ['SillyTavern', '世界书转换'],
    worlds,
  }
  const outPath = path.join(outDir, `${safe(title).slice(0, 60)}.worldbook.json`)
  fs.writeFileSync(outPath, JSON.stringify(book, null, 2), 'utf8')
  console.log(`\n✓ 世界书《${book.title}》：${worlds.length} 个世界`)
  console.log(`   ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB → ${outPath}`)
} else {
  const world = worlds[0]
  const pack = {
    format: 'deng-xu-worldpack',
    version: 1,
    exportedAt: now,
    worldCount: 1,
    worldTitles: [world.title],
    worlds: [world],
  }
  const outPath = path.join(outDir, `${safe(world.title)}.worldpack.json`)
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf8')
  console.log(`\n✓ 世界包：${(fs.statSync(outPath).size / 1024).toFixed(0)} KB → ${outPath}`)
}
