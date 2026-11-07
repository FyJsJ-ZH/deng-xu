/**
 * SillyTavern **角色卡（PNG）里的世界书** → 灯叙能直接导入的格式。
 *
 * 用法：
 *   # 单张卡 → 世界包（一张卡一个世界）
 *   node scripts/st-card-to-world.mjs <卡.png> [-o 输出目录] [--cover 封面图]
 *
 *   # 多张卡 → 合成**一本世界书**（一个问题里装多个世界）
 *   node scripts/st-card-to-world.mjs <卡1.png> <卡2.png> --book "书名" [-o 输出目录]
 *
 * ## 两种输出有什么区别
 *
 * | 格式 | 装什么 | 哪种情况用 |
 * |---|---|---|
 * | `deng-xu-worldpack` | 一个世界包，`worlds: [...]` | 单张卡，转完就能玩 |
 * | `deng-xu-worldbook` | **世界书**，`worlds: [...]` + 章节 | 多张卡收成一本，一次导入 |
 *
 * 两者的 `worlds` 结构完全一样，差的是外壳与导入路径
 * （`parseWorldbook` 会校验标题与版本，`importPackFile` 不校验这些）。
 *
 * ## 为什么需要它
 *
 * 本作的导入器原本只吃 JSON —— **PNG 卡整个进不来**，
 * 因为在 `handleImport` 里它连 `JSON.parse` 都过不去。
 * 而 ST 生态里大量"重设定"卡正是这个形态：卡的 `description` 是空的，
 * 十几万字全塞在 `character_book` 里。
 *
 * ## 清洗规则在 `src/utils/stNoise.ts`
 *
 * 脚手架话术 / 变量系统 / 无意义标题 —— 与游戏内导入**共用同一份**。
 * 各写一份必然漂移，而漂移的后果是"命令行看到的是干净的，拖进游戏又脏了"。
 *
 * ⚠️ **不建角色卡**：这类卡里的人物条目动辄五千字，
 * 而本作 `CharacterCard.description` 是**每轮全量注入**的 ——
 * 十个人 × 五千字 = 五万字/轮，上下文直接爆。
 * 所以人物留在 `worldLore` 里，靠 `loreDigest` 按话题检索：说到谁才捞谁。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkDir = path.join(root, '.check')

const args = process.argv.slice(2)

/** 取某个选项的值（不存在时返回空串） */
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

/**
 * 一张 PNG 卡 → 一张世界卡。
 *
 * 返回 `null` 表示这张卡用不了（不是 PNG / 没有世界书 / 条目全被过滤）。
 */
function toWorld(file, { withCover = false } = {}) {
  const p = path.resolve(file)
  const name = path.basename(p)
  if (!fs.existsSync(p)) return { error: `${name}：文件不存在` }

  const card = readPngCard(fs.readFileSync(p))
  if (!card) {
    return { error: `${name}：不是带角色数据的 PNG（WebP/JPEG 存不了 ST 卡数据 —— 那只是一张图）` }
  }

  const data = card.data || card
  const book = data.character_book
  const entries = Array.isArray(book?.entries) ? book.entries : []
  if (!entries.length) return { error: `${name}：这张卡没有内嵌世界书（只是一张普通角色卡）` }

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
  if (!blocks.length) return { error: `${name}：条目全被过滤掉了` }

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
    ...(withCover && coverDataUrl ? { cover: coverDataUrl } : {}),
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

  return { world, blocks, dropped, totalChars, file: name }
}

fs.mkdirSync(outDir, { recursive: true })

// ── 转换全部文件 ──
const results = []
for (const f of files) {
  const r = toWorld(f, { withCover: files.length === 1 })
  if (r.error) { console.log('✗ ' + r.error); continue }
  results.push(r)
  console.log(`✓ ${r.file} → 《${r.world.title}》`)
  console.log(`   条目 ${r.blocks.length} 条 / ${r.totalChars} 字`)
  if (r.dropped.length) console.log(`   跳过变量系统 ${r.dropped.length} 条：${r.dropped.join('、')}`)
}

if (!results.length) { console.log('\n没有可转换的卡'); process.exit(1) }

const now = Date.now()
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '_')

/*
  输出形态：
  · 给了 `--book`，或者转了不止一张 → 一本**世界书**（一次导入多个世界）
  · 否则 → 单个**世界包**
*/
if (bookTitle || results.length > 1) {
  const title = bookTitle || results.map(r => r.world.title).join(' · ')
  const book = {
    format: 'deng-xu-worldbook',
    version: 1,
    title: title.slice(0, 80),
    tagline: `${results.length} 个世界，由 SillyTavern 角色卡的世界书转换`,
    description: [
      '每张卡对应一个世界。设定已清掉变量系统与作者脚手架，',
      '正文按 `**条目名**` 分段 —— 灯叙按段检索，说到哪才捞哪。',
      '',
      ...results.map(r => `· 《${r.world.title}》：${r.blocks.length} 条，${r.totalChars} 字`),
    ].join('\n'),
    author: '由 SillyTavern 角色卡转换',
    tags: ['SillyTavern', '世界书转换'],
    worlds: results.map(r => r.world),
  }
  const outPath = path.join(outDir, `${safe(title).slice(0, 60)}.worldbook.json`)
  fs.writeFileSync(outPath, JSON.stringify(book, null, 2), 'utf8')
  console.log(`\n✓ 世界书《${book.title}》：${results.length} 个世界`)
  console.log(`   ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB → ${outPath}`)
  console.log('   拖进「世界包 → 导入」即可（导入器会认 format=deng-xu-worldbook）')
} else {
  const r = results[0]
  const pack = {
    format: 'deng-xu-worldpack',
    version: 1,
    exportedAt: now,
    worldCount: 1,
    worldTitles: [r.world.title],
    worlds: [r.world],
  }
  const outPath = path.join(outDir, `${safe(r.world.title)}.worldpack.json`)
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf8')
  console.log(`\n✓ 世界包：${(fs.statSync(outPath).size / 1024).toFixed(0)} KB → ${outPath}`)
}
