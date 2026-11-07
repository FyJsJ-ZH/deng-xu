/**
 * SillyTavern **角色卡（PNG / WebP）里的世界书** → 本作世界包。
 *
 * 用法：
 *   node scripts/st-card-to-world.mjs <卡文件> [-o 输出目录] [--cover <图片>]
 *
 * ## 为什么需要它（2026-11 第二十六轮）
 *
 * 玩家丢进来两张文件，一张 PNG 一张 WebP，问"怎么用"。
 * 本作的导入器只吃 JSON —— **PNG 卡整个进不来**，连报错都没有，
 * 因为在 `handleImport` 里它连 `JSON.parse` 都过不去。
 *
 * 而 ST 生态里大量"重设定"卡正是这个形态：卡的 `description` 是空的，
 * 十六万字全塞在 `character_book` 的 226 条条目里。
 *
 * ## 这个脚本做什么
 *
 * 1. 从 PNG 的 `tEXt/ccv3` 里取出 `chara`（base64 的 V3 JSON）；
 * 2. 清掉**脚手架话术**与**变量系统**条目（规则在 `src/utils/stNoise.ts`，
 *    与游戏内导入**共用同一份** —— 各写一份必然漂移）；
 * 3. 其余条目按 `**标题**\n正文` 拼成 `worldLore`；
 * 4. 可选地把一张图片嵌成 `cover`。
 *
 * ⚠️ **不建角色卡**：这张卡里的人物条目动辄五千字，
 * 而本作的 `CharacterCard.description` 是**每轮全量注入**的。
 * 十个人 × 五千字 = 五万字/轮，直接把上下文撑爆。
 * 所以人物留在 `worldLore` 里，靠 `loreDigest` 按话题检索 —— 说到谁才捞谁。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkDir = path.join(root, '.check')

const args = process.argv.slice(2)
const outIdx = args.indexOf('-o')
const coverIdx = args.indexOf('--cover')
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(root, 'converted')
const coverPath = coverIdx >= 0 ? args[coverIdx + 1] : ''
const files = args.filter((a, i) =>
  a !== '-o' && a !== '--cover' && i !== outIdx + 1 && i !== coverIdx + 1)

if (!files.length) {
  console.error('用法: node scripts/st-card-to-world.mjs <卡文件> [-o 目录] [--cover img]')
  process.exit(1)
}

// 打包共用的清洗规则（与游戏内导入同一份）
const bundle = path.join(checkDir, 'stNoise.mjs')
fs.mkdirSync(checkDir, { recursive: true })
execFileSync(process.execPath, [
  path.join(root, 'node_modules/esbuild/bin/esbuild'),
  'src/utils/stNoise.ts',
  '--bundle', '--platform=node', '--format=esm',
  `--outfile=${bundle}`, '--alias:@=./src', '--log-level=error',
], { cwd: root, stdio: 'inherit' })

const { stripStBoilerplate, isStVariableEntry, pickStEntryTitle } = await import(
  'file://' + bundle.replace(/\\/g, '/')
)

/** PNG 的 tEXt / iTXt chunk 里取 chara（ST 把 JSON 存成 base64） */
function readPngCard(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null
  const found = {}
  let i = 8
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'tEXt') {
      const z = data.indexOf(0)
      const k = data.toString('latin1', 0, z)
      if (k === 'chara' || k === 'ccv3') found[k] = data.toString('latin1', z + 1)
    } else if (type === 'iTXt') {
      const z = data.indexOf(0)
      const k = data.toString('latin1', 0, z)
      const rest = data.subarray(z + 1)
      let p = 2
      for (let n = 0; n < 2; n++) { const q = rest.indexOf(0, p); p = q < 0 ? rest.length : q + 1 }
      const body = rest.subarray(p).toString('utf8')
      if ((k === 'chara' || k === 'ccv3') && !found[k]) {
        found[k] = Buffer.from(body, 'utf8').toString('latin1')
      }
    }
    i += 12 + len
    if (type === 'IEND') break
  }
  const raw = found.ccv3 || found.chara
  if (!raw) return null
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) } catch { return null }
}

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
  if (!mime) return ''
  return `data:${mime};base64,${fs.readFileSync(coverPath).toString('base64')}`
})()

fs.mkdirSync(outDir, { recursive: true })
let ok = 0

for (const f of files) {
  const p = path.resolve(f)
  const name = path.basename(p)
  if (!fs.existsSync(p)) { console.log(`✗ ${name}：文件不存在`); continue }

  const buf = fs.readFileSync(p)
  const card = readPngCard(buf)
  if (!card) {
    console.log(`✗ ${name}：不是带角色数据的 PNG（WebP/JPEG 存不了 ST 卡数据 —— 那只是一张图）`)
    continue
  }

  const data = card.data || card
  const book = data.character_book
  const entries = Array.isArray(book?.entries) ? book.entries : []
  if (!entries.length) {
    console.log(`✗ ${name}：这张卡没有内嵌世界书（只是一张普通角色卡）`)
    continue
  }

  const blocks = []
  const dropped = []
  let totalChars = 0
  let idx = 0
  for (const e of entries) {
    const raw = String(e.content || '').trim()
    if (!raw) continue
    if (e.enabled === false || e.disable === true) continue
    const content = stripStBoilerplate(raw)
    if (!content) continue
    const title = pickStEntryTitle(e, content, idx++)
    if (isStVariableEntry(title, content)) { dropped.push(title); continue }
    blocks.push({ title, content })
    totalChars += content.length
  }

  if (!blocks.length) { console.log(`✗ ${name}：条目全被过滤掉了`); continue }

  const header = [
    `> 由 SillyTavern 角色卡《${data.name || name}》的世界书转换（${blocks.length} 条，${totalChars} 字）。`,
    '> 原卡是"设定驱动"的：卡片本身几乎是空的，内容全在这本世界书里。',
  ].join('\n')

  /*
    分段用 `**标题**`，不用 `## 标题`。
    这是本项目 `worldLore` 的写作惯例，`loreDigest` 与 `check-worlds.mjs`
    都按它切段 —— 换成 markdown 标题会让检索切不到段落，整本书变成一大块。
  */
  const lore = blocks.map(b => `**${b.title}**\n${b.content}`).join('\n\n')
  const now = Date.now()

  const world = {
    id: 'world_' + crypto.randomBytes(6).toString('hex'),
    title: (book.name || data.name || name).slice(0, 60),
    tagline: `由 SillyTavern 角色卡转换：${blocks.length} 条设定、${totalChars} 字`,
    ...(coverDataUrl ? { cover: coverDataUrl } : {}),
    worldLore: header + '\n\n' + lore,
    rules: '',
    attributes: [],
    resources: [],
    backgrounds: [],
    attributePoints: 0,
    items: [],
    lores: [],
    story: {
      atmosphere: '',
      mainQuest: '',
      enableStages: false,
      stages: [],
      enableChoices: true,
      urgencyAfterTurns: 0,
    },
    narrative: { pov: 'third', tense: 'past', replyLength: 1800, customStyle: '' },
    characters: [],
    enableMechanics: false,
    createdAt: now,
    updatedAt: now,
  }

  const pack = {
    format: 'deng-xu-worldpack',
    version: 1,
    exportedAt: now,
    worldCount: 1,
    worldTitles: [world.title],
    worlds: [world],
  }

  const outName = `${(book.name || data.name || name).replace(/[\\/:*?"<>|]/g, '_')}.worldpack.json`
  const outPath = path.join(outDir, outName)
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf8')

  ok++
  console.log(`✓ ${name} → 《${world.title}》`)
  console.log(`   条目 ${blocks.length} 条 / ${totalChars} 字`)
  if (dropped.length) console.log(`   跳过变量系统 ${dropped.length} 条：${dropped.join('、')}`)
  console.log(`   文件 ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB → ${outPath}`)
}

console.log(`\n完成：${ok}/${files.length}`)
