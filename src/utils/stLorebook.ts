/**
 * SillyTavern 世界书（World Info / Lorebook）⇄ 本作世界卡
 *
 * ## 为什么要有这个文件
 *
 * 角色卡那条线早就互通了（`utils/cardIO.ts`：ST 的 V2/V3 导入导出）。
 * 世界书这条线却只认本作自己的 `{ format: 'deng-xu-worldbook', worlds: [...] }`，
 * 靠 `format` 字段分流。后果是双向都断：
 *
 *  · 把本作世界书交给 DSH 的 ST 世界书导入器，报
 *    `world file has no usable entries` —— 那边读的是 `{ entries: [...] }`；
 *  · ST 生态里有海量现成世界书（设定集、地名志、势力表），本作一本都用不了。
 *
 * 这个文件就是补这两条通道：
 *  · `isSillyTavernLorebook` / `fromSillyTavernLorebook` —— 导进来
 *  · `toSillyTavernLorebook` —— 导出去（外部的 `prompt_import_world` 只认 ST 格式，
 *    所以"能导出"不是锦上添花，而是让两边的工具链真正接上的必要一环）
 *
 * ## ⚠️⚠️ 最关键的一处语义差异：ST 的 keys 在本作**不生效**
 *
 * ST 的世界书条目是**关键词触发**的：只有对话里出现了 `keys` 里的词，
 * 那一条才会被塞进上下文（`constant: true` 的"蓝灯"条目除外）。
 *
 * **本作没有这个机制。** 本作的 `lores` 是一份**全量注入**的知识条目
 * —— 只要它在世界卡里，就会出现在提示词里，跟玩家说了什么无关。
 *
 * 所以导入时**绝不能**把 `keys` 当成"触发生效"的东西对待，
 * 更不能把条目按 keys 丢掉、或对外宣称"触发词已配置"。
 * 这里的做法是：把 keys **写进 `description` 的开头**
 * （形如 `触发词：汴梁、汴京`），
 *  1. 让玩家/作者看得见"原书是靠这些词触发的"，信息不丢；
 *  2. 让它成为正文的一部分，AI 至少知道这些词是同义指代。
 *
 * 反过来说，**导出**时必须把本作 lore 写成 `constant: true`（ST 的蓝灯常驻），
 * 因为本作 lore 的语义就是"永远注入"。若导出成普通绿灯条目并只给 keys，
 * 到了 ST 那边就会变成"必须命中关键词才出现"——那是把语义导错了。
 *
 * ## 往返不保证逐字节还原
 *
 * ST 条目的 `position` / `depth` / `probability` / `selective` 这些注入参数
 * 本作一律没有对应字段（本作只有"注入 / 不注入"两种状态），
 * 所以 `ST → 本作 → ST` 会在这些参数上回到默认值。这不是缺陷，
 * 是两套模型的表达能力不同 —— 与其造假字段假装无损，不如把差异写在这里。
 */

import type { LoreTemplate, WorldCard } from '@/types/cards'
import { makeId } from '@/utils/files'

type JsonObject = Record<string, unknown>

/** ST 里"这条不注入"的两种写法：旧格式 `disable`、V2 格式 `enabled: false` */
function isDisabledEntry(entry: JsonObject): boolean {
  return entry.disable === true || entry.enabled === false
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受字符串；数字/布尔在宽松 JSON 里也常见，顺手转成字符串 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * 保证得到 string[]：兼容数组、JSON 字符串数组、单个字符串（旧 ST 的 `key` 有时是裸串）。
 * 与 cardIO 的同名工具行为一致 —— 两处都面对"用户手改过的 JSON"。
 */
function toStringArray(value: unknown): string[] {
  let candidate: unknown = value
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        candidate = JSON.parse(trimmed)
      } catch {
        candidate = [trimmed]
      }
    } else {
      // 旧格式里 key 可能是 "a,b,c" 这种逗号分隔的裸串
      candidate = trimmed.includes(',') ? trimmed.split(',') : [trimmed]
    }
  }
  if (!Array.isArray(candidate)) return []
  return candidate.map(item => asText(item).trim()).filter(Boolean)
}

/**
 * ST 的 entries 有两种形状，都要认：
 *  · 数组          —— V2 `character_book` 与大多数导出脚本
 *  · 对象 map（键是数字 uid）—— ST 自己的 World Info 导出文件
 *
 * map 形状刻意**按数字键排序**而不是按插入顺序：ST 导出时键是 uid 字符串，
 * 而 JSON 对象键的遍历顺序对"看起来是整数"的键是按数值升序的 ——
 * 依赖这一点才不会再导出时把条目顺序打乱。
 */
function normalizeEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isPlainObject)
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort((a, b) => {
        const na = Number(a)
        const nb = Number(b)
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
        return a.localeCompare(b)
      })
      .map(key => value[key])
      .filter(isPlainObject)
  }
  return []
}

interface LorebookSource {
  entries: JsonObject[]
  name: string
  description: string
}

/** 条目里是否真有内容 —— 空条目导入进来只会污染世界书预览 */
function hasUsableEntry(entries: JsonObject[]): boolean {
  return entries.some(e => !isDisabledEntry(e) && (asText(e.content).trim() || asText(e.comment).trim()))
}

/**
 * 从任意一种 ST 形状里取出 `{ entries, name, description }`。
 *
 * 需要认这几种包装（最多解 3 层，避免畸形文件造成无尽循环）：
 *  1. 裸世界书：`{ entries: [...] }`
 *  2. 带书名的世界书：`{ name, description, entries: {...} }`
 *  3. 角色卡内嵌的世界书：`{ character_book: { entries } }`
 *  4. 整张 V2/V3 角色卡：`{ spec, data: { character_book } }`
 *
 * ⚠️ 本作自己的文件（`format` 以 `deng-xu` 开头）必须在这里就排除：
 * 世界包/世界书也是 JSON，且 `WorldCard` 里没有 `entries` 字段 ——
 * 万一将来某个字段重名，就会把本作文件误判成 ST 世界书。
 */
function unwrapLorebook(input: unknown): LorebookSource | null {
  let current: unknown = input
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isPlainObject(current)) return null
    const obj = current

    const format = asText(obj.format)
    if (format.startsWith('deng-xu')) return null

    if (isPlainObject(obj.character_book)) {
      current = obj.character_book
      continue
    }

    const entries = normalizeEntries(obj.entries)
    if (entries.length > 0) {
      return { entries, name: asText(obj.name), description: asText(obj.description) }
    }

    if (isPlainObject(obj.data)) {
      current = obj.data
      continue
    }
    return null
  }
  return null
}

/** 判断一个值是否长得像 SillyTavern 世界书（且真的带可用条目） */
export function isSillyTavernLorebook(value: unknown): boolean {
  const source = unwrapLorebook(value)
  return !!source && hasUsableEntry(source.entries)
}

/**
 * 读出一条 ST 条目的触发词。
 *
 * 同时认三种写法：新格式 `keys` / `secondary_keys`、旧格式 `key` / `keysecondary`。
 * **主要与次要触发词一并收进来**：本作没有主/次之分，分开保存没有意义，
 * 而丢掉次要触发词会让作者以为原书没写。
 */
function readKeys(entry: JsonObject): string[] {
  const primary = toStringArray(entry.keys ?? entry.key)
  const secondary = toStringArray(entry.secondary_keys ?? entry.keysecondary)
  return [...new Set([...primary, ...secondary])]
}

/** 取第一条非空行 —— ST 的 `description` 常常是一整段，标题只该取一行 */
function firstLine(text: string): string {
  return text.split('\n').map(s => s.trim()).find(Boolean) || ''
}

/** 压成一行（换行→空格），用于 tagline 这类单行字段 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * `worldLore` 拼接版的上限（字符）。
 *
 * ST 生态里的世界书动辄几百上千条（有的就是一本设定百科），而 `worldLore`
 * 会被整段注入提示词、也会进 localStorage：
 *  · 不设上限时，一本大书能直接把提示词顶爆（模型只看到前几行）；
 *  · `lores` **仍然全量保留**，所以这不是丢内容 —— 只是"世界观正文"这一段
 *    不把整本书抄一遍，末尾会写明还有多少条在知识条目里。
 */
const WORLD_LORE_MAX = 120_000

/**
 * 把 SillyTavern 世界书映射成**一张本作世界卡**。
 *
 * 映射表（左 ST，右本作）：
 *  · `entries[].comment`（或 `name`）→ `lores[].name`
 *  · `entries[].content`            → `lores[].description`
 *  · `entries[].keys`               → 拼进 `description` 开头，形如 `触发词：a、b`
 *                                     （**只为留档，本作不按它触发**，见文件头注释）
 *  · 全部 entry 的 content          → `worldLore`（`**条目名**` + 正文，用空行分段）
 *  · 书名 / 描述                    → `title` / `tagline`
 *
 * 返回 null 表示"认不出、或没有可用条目"，由调用方决定提示什么 ——
 * 与 cardIO 一样，解析这类用户本地文件绝不抛异常。
 */
export function fromSillyTavernLorebook(payload: unknown): WorldCard | null {
  const source = unwrapLorebook(payload)
  if (!source || !hasUsableEntry(source.entries)) return null

  const lores: LoreTemplate[] = []
  const loreBlocks: string[] = []
  let loreChars = 0
  let droppedFromLore = 0

  for (const entry of source.entries) {
    // 被作者停用的条目在 ST 里本来就不注入，导入时也跳过，别让"停用"变成"生效"
    if (isDisabledEntry(entry)) continue

    const keys = readKeys(entry)
    const content = asText(entry.content).trim()
    const comment = asText(entry.comment).trim() || asText(entry.name).trim()
    if (!content && !keys.length && !comment) continue

    const name = comment || keys[0] || `条目 ${lores.length + 1}`

    lores.push({
      id: `st_${lores.length + 1}`,
      name,
      /*
        ⚠️ 触发词写进正文，而不是配一套"触发机制" —— 本作 lore 是全量注入的，
        没有关键词触发这回事。写成正文既保住了信息，又不会被误当成生效的触发。
        空 content 的条目只剩触发词，就只留这一行。
      */
      description: keys.length
        ? `触发词：${keys.join('、')}\n\n${content}`
        : content,
    })

    const block = `**${name}**\n${content || `（触发词：${keys.join('、')}）`}`
    if (loreChars + block.length > WORLD_LORE_MAX) {
      // 只从"世界观正文"里省略，条目本身照旧进 lores（内容没丢，只是不重复一遍）
      droppedFromLore += 1
    } else {
      loreBlocks.push(block)
      loreChars += block.length
    }
  }

  if (!lores.length) return null

  const sourceName = source.name.trim()
  const sourceDesc = source.description.trim()
  const now = Date.now()

  const title = sourceName || firstLine(sourceDesc).slice(0, 40) || '导入的 SillyTavern 世界书'
  const tagline = sourceDesc && firstLine(sourceDesc) !== title
    ? oneLine(sourceDesc).slice(0, 160)
    : `由 SillyTavern 世界书导入：${lores.length} 条知识条目`
  const worldLore = droppedFromLore
    ? `${loreBlocks.join('\n\n')}\n\n（另有 ${droppedFromLore} 条条目因篇幅过长未并入这段正文，它们仍在下面的「知识条目」里。）`
    : loreBlocks.join('\n\n')

  /*
    必填字段一律给"空白但合法"的默认值。
    尤其 `enableMechanics: false`：ST 世界书里没有任何数值体系，
    若默认开启机制层，这张卡会带着空的 attributes/resources 进游戏 ——
    面板上是一片 0，而作者从未定义过它们。
  */
  return {
    id: makeId('world'),
    title,
    tagline,
    worldLore,
    rules: '',
    attributes: [],
    resources: [],
    backgrounds: [],
    attributePoints: 0,
    items: [],
    lores,
    story: {
      atmosphere: '',
      mainQuest: '',
      enableStages: false,
      stages: [],
      enableChoices: true,
      urgencyAfterTurns: 0,
    },
    /*
      ⚠️ 默认人称是 **third**，与内置世界卡当前的规范一致（2026-10 用户要求）。
      导入外部世界书造出来的卡如果默认第二人称，玩家一进游戏就会看到
      "与其它卡都不一样"的叙述口吻。
    */
    narrative: { pov: 'third', tense: 'past', replyLength: 500, customStyle: '' },
    characters: [],
    enableMechanics: false,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 反向：把本作世界卡导出成 SillyTavern 世界书。
 *
 * 要点：
 *  · 每条 lore 写成 `constant: true`（蓝灯常驻）—— 本作 lore 的语义就是
 *    **无条件全量注入**，只有 constant 能在 ST 那边表达同一件事；
 *  · `description` 开头的「触发词：…」会被**还原回 `keys` 字段**
 *    （导入时写进去的那一行，往返时不该退化成一堆正文）；
 *  · 没有 lores 的世界卡不会导出成空文件：改成按 `worldLore` 里的
 *    `**标题**` 分段（本项目 `worldLore` 的写作惯例，`check-worlds.mjs` 也按它切段），
 *    这样任何一张世界卡都能导出成可用的 ST 世界书。
 */
export function toSillyTavernLorebook(world: WorldCard): object {
  /** 从导入时注入的「触发词：a、b」行里把关键词捡回来 */
  const splitTriggerLine = (description: string): { keys: string[]; body: string } => {
    const match = description.match(/^触发词：([^\n]*)\n+/)
    if (!match) return { keys: [], body: description }
    const keys = match[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean)
    return { keys, body: description.slice(match[0].length) }
  }

  const raw: { name: string; content: string; keys: string[]; order: number }[] = []

  for (const lore of world.lores || []) {
    const { keys, body } = splitTriggerLine(lore.description || '')
    raw.push({
      name: lore.name,
      content: body.trim() || lore.description || '',
      // 没有触发词行时退回用条目名当 key：ST 里没有 key 的条目只能靠 constant 生效，
      // 而条目名是作者能提供的最自然的关键词
      keys: keys.length ? keys : [lore.name],
      order: raw.length,
    })
  }

  if (!raw.length) {
    const sections = splitLoreIntoSections(world.worldLore || '')
    for (const section of sections) {
      raw.push({ name: section.name, content: section.body, keys: [section.name], order: raw.length })
    }
  }

  /*
    双写 `key`/`keys`、`comment`/`name` 不是冗余：ST 自己的导出是 `key`/`comment`，
    V2 `character_book` 与较新的读取端（含 DSH 的 ST 世界书导入器）读 `keys`/`name`。
    少写一份就会在某一端变成"没有可用条目"，而那正是本文件要修的毛病。
  */
  const entries = raw.map((item, index) => ({
    uid: index,
    key: item.keys,
    keys: item.keys,
    keysecondary: [],
    secondary_keys: [],
    comment: item.name,
    name: item.name,
    content: item.content,
    // 本作 lore 全量注入 ⇒ ST 的常驻条目
    constant: true,
    selective: false,
    enabled: true,
    disable: false,
    order: 100 + item.order,
    insertion_order: 100 + item.order,
    position: 'before_char',
    case_sensitive: false,
    extensions: {},
  }))

  return {
    name: world.title,
    description: world.tagline || '',
    entries,
  }
}

/**
 * 把没有 lore 条目的 `worldLore` 按行首 `**标题**` 切成段。
 *
 * 只认**行首**的成对星号：正文里的加粗强调若被当成标题，
 * 会把一整段内容切碎（`check-worlds.mjs` 的注释里记着同一个教训）。
 * 一段标题都没有时返回整篇作为单条，宁可给一大条，也不要导出空世界书。
 */
function splitLoreIntoSections(worldLore: string): { name: string; body: string }[] {
  const lines = String(worldLore).split('\n')
  const sections: { name: string; body: string[] }[] = []
  let current: { name: string; body: string[] } | null = null

  for (const line of lines) {
    const match = line.match(/^\s*\*\*(.+?)\*\*\s*$/)
    if (match) {
      current = { name: match[1].trim(), body: [] }
      sections.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }

  const out = sections
    .map(s => ({ name: s.name, body: s.body.join('\n').trim() }))
    .filter(s => s.body)

  if (out.length) return out
  const whole = String(worldLore).trim()
  return whole ? [{ name: '世界观设定', body: whole }] : []
}
