/**
 * SillyTavern「重设定卡」→ **完整的灯叙世界卡**
 *
 * ## 和 `stLorebook.ts` 的区别
 *
 * `stLorebook` 只搬正文：226 条条目 → `worldLore` + `lores`。
 * 那够玩，但玩起来是"一本设定集 + 空角色表"：没有属性、没有出身、没有可分配的点数。
 *
 * 而这类卡的原作者**其实什么都写好了** —— 只是写在 ST 的 `[initvar]` 变量表里：
 *
 * ```yaml
 * 主角:
 *   境界: 炼气期·前期
 *   气血: 0
 *   灵石: 0
 * 重要人物:
 *   沈清辞:
 *     称号: 太虚剑宗首席
 *     境界: 化神期·前期
 *     关系: 中立
 *     所在地: 中州太虚剑宗
 *     _属性: { 力道: 65, 体魄: 60, 身法: 80, 灵力: 85, 神识: 75, 根骨: 70 }
 * ```
 *
 * 这一层要做的就是把那份 YAML **读成灯叙的字段**：
 *
 * | YAML | 灯叙 |
 * |---|---|
 * | `主角.气血 / 修为 / 灵石 …` | `resources` |
 * | `重要人物.*._属性` 的六个键 | `attributes` |
 * | `重要人物.*` / `角色_*` 条目 | `characters` |
 * | `势力_*` / `宗门_*` | `lores` + 一个出身槽位 |
 * | `秘籍_*` / `物品_*` | `items` |
 * | `基础：世界观` / `修炼体系` | `worldLore` / `rules` |
 *
 * ## ⚠️ 角色卡必须**精简**
 *
 * 本作 `CharacterCard.description` 是**每轮全量注入**的。原卡里一个人物的
 * 完整档案动辄五千字（外貌五条、人际关系八条、武学十几项），
 * 十个角色就是五万字/轮 —— 上下文直接爆，模型反而写得更短。
 *
 * 所以这里只留**在场时用得上的那几句**（他是谁、什么境界、什么脾气），
 * 细枝末节全部留在 `worldLore` 里靠检索。
 * 判据：**这句话换个场景还成立吗？** 不成立的（具体招式、一次性事件）都不进描述。
 */

import type {
  AttributeDef, BackgroundSlot, CharacterCard, ItemTemplate, LoreTemplate, ResourceDef, WorldCard,
} from '@/types/cards'
import { makeId } from '@/utils/files'
import { stripStBoilerplate } from '@/utils/stNoise'

// ============================================================================
// 极简 YAML 解析
// ============================================================================

/**
 * 只认 ST 卡里那种"缩进 + 键值 + `- 列表 + `|-` 块"的 YAML 子集。
 *
 * 为什么不装一个真正的 YAML 库：这 60 行覆盖了实测两张卡的全部写法，
 * 而多一个运行时依赖会让首屏包大一截 —— 这段代码一条卡只会跑一次。
 * 遇到不认识的写法就退化成字符串，不抛异常（坏数据不该让导入失败）。
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  let i = 0

  const indentOf = (line: string) => line.match(/^ */)?.[0].length ?? 0
  const isBlank = (line: string) => !line.trim()

  const parseScalar = (s: string): unknown => {
    const t = s.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      const obj: Record<string, unknown> = {}
      for (const pair of t.slice(1, -1).split(',')) {
        const idx = pair.indexOf(':')
        if (idx < 0) continue
        const k = pair.slice(0, idx).trim()
        if (k) obj[k] = parseScalar(pair.slice(idx + 1))
      }
      return obj
    }
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1)
    }
    if (/^-?\d+$/.test(t)) return Number(t)
    if (t === 'true') return true
    if (t === 'false') return false
    return t === 'null' ? '' : t
  }

  /** 解析从当前位置开始的、缩进 ≥ minIndent 的一块 */
  const parseBlock = (minIndent: number): unknown => {
    let first = ''
    for (let k = i; k < lines.length; k++) {
      if (isBlank(lines[k])) continue
      if (indentOf(lines[k]) < minIndent) return null
      first = lines[k]
      break
    }
    if (!first) return null

    const isArray = first.trim().startsWith('- ')
    const baseIndent = indentOf(first)
    const out: Record<string, unknown> | unknown[] = isArray ? [] : {}

    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) { i++; continue }
      const ind = indentOf(line)
      if (ind < baseIndent) break
      if (ind > baseIndent) { i++; continue }
      const t = line.trim()

      if (isArray) {
        if (!t.startsWith('- ')) break
        ;(out as unknown[]).push(parseScalar(t.slice(2)))
        i++
        continue
      }

      const m = t.match(/^([^:]+):\s*(.*)$/)
      if (!m) { i++; continue }
      const key = m[1].trim()
      const rest = m[2].trim()
      i++

      if (rest === '|-' || rest === '|') {
        // 块文本：缩进比当前行更深的连续行
        const buf: string[] = []
        let blockIndent = -1
        while (i < lines.length) {
          if (isBlank(lines[i])) { buf.push(''); i++; continue }
          const li = indentOf(lines[i])
          if (blockIndent < 0) {
            if (li <= ind) break
            blockIndent = li
          }
          if (li < blockIndent) break
          buf.push(lines[i].slice(blockIndent))
          i++
        }
        ;(out as Record<string, unknown>)[key] = buf.join('\n').trim()
        continue
      }

      if (rest) {
        ;(out as Record<string, unknown>)[key] = parseScalar(rest)
        continue
      }

      const sub = parseBlock(baseIndent + 1)
      ;(out as Record<string, unknown>)[key] = sub === null ? '' : sub
    }

    return out
  }

  const v = parseBlock(0)
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}
}

// ============================================================================
// 条目分类
// ============================================================================

type Entry = { name: string; content: string }

type Bucket = 'character' | 'faction' | 'place' | 'item' | 'rule' | 'world'

/**
 * 条目该归哪一类。
 *
 * 两张卡用的前缀不一样（一张 `角色_`、一张 `人物_`），所以两边都认。
 * 中文前缀是作者**刻意**打的标签 —— 比任何启发式都准，优先用它。
 */
function bucketOf(name: string): Bucket {
  const n = String(name || '')
  if (/^(角色|人物|NPC|npc)[_\s:：]/.test(n)) return 'character'
  if (/^(势力|宗门|门派|组织|阵营)[_\s:：]/.test(n)) return 'faction'
  if (/^(场景|地点|地区|秘境|地图)[_\s:：]/.test(n)) return 'place'
  if (/^(秘籍|武功|功法|武学|物品|道具|奇珍异兽|灵兽)[_\s:：]/.test(n)) return 'item'
  if (/^(基础|核心|规则|系统|玩法|好感度|经济|修炼体系|世界运转)/.test(n)) return 'rule'
  if (/^(事件|剧情|结局)/.test(n)) return 'world'
  return 'world'
}

/** 从条目名里剥掉前缀：「角色_周景贤」→「周景贤」 */
function stripPrefix(name: string): string {
  return String(name || '').replace(/^[^_\s:：]{1,8}[_\s:：]/, '').trim() || String(name || '').trim()
}

// ============================================================================
// 人物 → CharacterCard
// ============================================================================

/** 描述最多这么长。超了就是在拿每轮预算换一次性细节，见文件头 */
const DESC_MAX = 300
/** 单条 lore 正文的上限（`lores` 只是"知识页"能读到的全文，不注入） */
const LORE_MAX = 6000

function clip(s: string, max: number): string {
  const t = String(s || '').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/**
 * 条目正文是不是**一句引用宏**（`{{人物:温照雪}}`、`<npc_周景贤>` 之类）。
 *
 * 实测：这类卡里 `人物_温照雪` 这类条目的正文只有一行 `{{人物:温照雪}}` ——
 * 它是 ST 的 `getwi` 索引，真正的档案在别处（`[initvar]` 或另开一个条目）。
 * 拿它当描述，角色卡上写的就是一串花括号。
 */
function isReferenceOnly(content: string): boolean {
  const lines = String(content || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!lines.length) return true
  return lines.length <= 2 && lines.every(l => /^(\{\{.*\}\}|<[^>]+>)$/.test(l))
}

/** 剥掉正文开头的伪标签行（`<npc_周景贤>`、`<faction_武当派>`） */
function stripPseudoTag(content: string): string {
  return String(content || '').replace(/^\s*<[^>\n]+>\s*\n/, '').trim()
}

/** 把 YAML 里的人物块拼成一句可注入的描述 */
function describePerson(_name: string, p: Record<string, unknown>): string {
  const bits: string[] = []
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = p[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (typeof v === 'number') return String(v)
    }
    return ''
  }

  const title = pick('称号', '身份', '职位')
  const realm = pick('境界', '修为等级')
  const faction = pick('势力', '宗门', '所属')
  if (title) bits.push(title)
  if (realm) bits.push(`境界 ${realm}`)
  if (faction) bits.push(`属 ${faction}`)

  const desc = pick('描述', '人物设定', '介绍')
  if (desc) bits.push(desc)
  else {
    /*
      没有「描述」字段的卡（武当派那类）只有「身份 + 外貌」。
      这时拿外貌第一句顶上 —— 外貌是所有人里最有辨识度的一句，
      而"武当派第三代掌门"这种身份已经在上面写过了，再写一遍是重复。
    */
    const appearance = p['外貌']
    if (Array.isArray(appearance) && appearance.length) bits.push(String(appearance[0]).slice(0, 90))
    else if (typeof appearance === 'string' && appearance.trim()) bits.push(appearance.trim().slice(0, 90))
  }

  // 武功：写第一项就够，剩下的在 lore 里
  const inner = p['内功']
  if (Array.isArray(inner) && inner.length) {
    bits.push(`内功：${String(inner[0]).replace(/[()（）]/g, ' ').trim()}`)
  }

  const feature = pick('特征', '性格')
  if (feature) bits.push(`**特征**：${feature}`)

  // 六维写一行，短且信息密度高
  const attrs = p['_属性'] || p['属性']
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const pairs = Object.entries(attrs as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}${v}`)
    if (pairs.length) bits.push(`**属性**：${pairs.join(' ')}`)
  }

  return clip(bits.filter(Boolean).join('。').replace(/。+/g, '。'), DESC_MAX)
}

function personToCard(name: string, p: Record<string, unknown>): CharacterCard {
  const str = (k: string) => (typeof p[k] === 'string' ? String(p[k]).trim() : '')
  const lookNote = [str('外貌'), str('特征')].filter(Boolean).join('；').slice(0, 200)

  return {
    id: makeId('char'),
    name: name.trim(),
    description: describePerson(name, p),
    personality: str('性格').slice(0, 200),
    scenario: '',
    firstMessage: '',
    messageExamples: '',
    creatorNotes: '由 SillyTavern 角色卡的世界书转换',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    present: false,
    location: str('所在地') || undefined,
    relationship: str('关系') || str('势力') || undefined,
    status: str('境界') || undefined,
    ...(lookNote ? { look: { note: lookNote } } : {}),
  }
}

// ============================================================================
// 主转换
// ============================================================================

export interface ConvertOptions {
  /** 覆盖标题（默认取世界书名） */
  title?: string
}

export interface ConvertResult {
  world: WorldCard
  stats: {
    entries: number
    characters: number
    lores: number
    items: number
    attributes: number
    resources: number
    backgrounds: number
    loreChars: number
    dropped: string[]
  }
}

/** 六维：原卡的 `_属性` 里就是这几个键 */
const DEFAULT_ATTRIBUTES: AttributeDef[] = [
  { id: 'lidao', name: '力道', description: '筋骨之力，决定正面交手与负重' },
  { id: 'tipo', name: '体魄', description: '气血厚薄，扛伤与耐力' },
  { id: 'shenfa', name: '身法', description: '轻功与闪避，也关乎先手' },
  { id: 'lingli', name: '灵力', description: '法力总量与术法威能' },
  { id: 'shenshi', name: '神识', description: '感知、推演与心力' },
  { id: 'gengu', name: '根骨', description: '修炼资质，决定功法能练到第几重' },
]

/**
 * 从 `主角:` 那一块里读资源条。
 *
 * 只认**「X」与「X上限」成对出现**的键（`气血`/`气血上限`）——
 * 这种成对写法一看就是"血条"，而 `状态: ''`、`灵根: ''` 这种是自由文本，不是资源。
 *
 * ⚠️ 原卡的初始值与上限**大多写成 0**（等游戏里才涨）。所以不能因为
 * `上限: 0` 就把这条丢掉 —— 那会得到一张"没有任何资源条"的卡，
 * 玩家进游戏只看得到属性点。上限为 0 就当**无上限**（`max` 留空）。
 */
function resourcesFrom(protagonist: Record<string, unknown>): ResourceDef[] {
  const out: ResourceDef[] = []
  const nums = Object.entries(protagonist).filter(([, v]) => typeof v === 'number')
  const names = Object.keys(protagonist)

  for (const [key, initial] of nums) {
    const maxKey = `${key}上限`
    if (!names.includes(maxKey)) continue
    const rawMax = Number(protagonist[maxKey])
    out.push({
      id: `res_${out.length + 1}`,
      name: key,
      initial: Number(initial) || 0,
      ...(rawMax > 0 ? { max: rawMax } : {}),
    })
  }

  // 没有成对上限、但明显是"资源"的（灵石 / 善恶值 / san）
  const solo = nums.filter(([k]) => /灵石|金钱|银两|善恶|san|理智|声望|威望|贡献|疲劳|饱食/i.test(k))
  for (const [key, initial] of solo) {
    if (out.some(r => r.name === key)) continue
    out.push({ id: `res_${out.length + 1}`, name: key, initial: Number(initial) || 0 })
  }
  return out
}

export function stCardToWorld(card: unknown, opts: ConvertOptions = {}): ConvertResult | null {
  if (!card || typeof card !== 'object') return null
  const d = (card as { data?: Record<string, unknown> }).data ?? (card as Record<string, unknown>)
  const book = (d as { character_book?: { name?: string; entries?: unknown[] } }).character_book
  const rawEntries = Array.isArray(book?.entries) ? book!.entries : []
  if (!rawEntries.length) return null

  const entries: Entry[] = []
  for (const e of rawEntries) {
    const obj = e as { name?: unknown; comment?: unknown; content?: unknown; enabled?: unknown; disable?: unknown }
    const content = String(obj.content || '').trim()
    if (!content) continue
    const name = String(obj.comment || obj.name || '').trim() || `条目 ${entries.length + 1}`
    const disabled = obj.enabled === false || obj.disable === true
    /*
      ⚠️ **`[initvar]` 变量表在 ST 里是「停用」的，但它必须读**（2026-11 第二十八轮）。

      作者把它关掉是对的：它不该被注入上下文（那一大坨 YAML 喂给模型毫无用处）。
      但它同时也是**属性、资源、人物档案的唯一来源** ——
      按"停用就跳过"处理，结果是一张没有任何角色、没有资源条的卡，
      而源文件里明明写着 `重要人物: 沈清辞: …`。

      所以判据是"这条是**数据**还是**正文**"：数据照读，正文才看开关。
    */
    if (disabled && !/\[initvar\]/i.test(name)) continue
    // 作者写在每条正文开头的脚手架话术（见 stNoise.ts）—— 不删会反复命中检索打分
    const clean = stripStBoilerplate(content)
    if (!clean) continue
    entries.push({ name, content: clean })
  }
  if (!entries.length) return null

  const dropped: string[] = []
  const characters: CharacterCard[] = []
  const lores: LoreTemplate[] = []
  const items: ItemTemplate[] = []
  const worldBlocks: string[] = []
  const ruleBlocks: string[] = []
  let attributes: AttributeDef[] = []
  let resources: ResourceDef[] = []
  const factions: string[] = []
  let atmosphere = ''

  for (const e of entries) {
    // ── 变量表：属性与资源的唯一来源 ──
    if (/\[initvar\]|\[mvu_update\]/i.test(e.name)) {
      dropped.push(e.name)
      if (/\[initvar\]/i.test(e.name)) {
        const y = parseSimpleYaml(e.content)
        const protagonist = (y['主角'] as Record<string, unknown>) || {}
        const res = resourcesFrom(protagonist)
        if (res.length) resources = res

        // 重要人物 → 角色卡
        const important = (y['重要人物'] as Record<string, unknown>) || {}
        for (const [name, body] of Object.entries(important)) {
          if (name.startsWith('$') || name.startsWith('_')) continue
          if (!body || typeof body !== 'object') continue
          characters.push(personToCard(name, body as Record<string, unknown>))
        }
        // 古神 / 七宗罪 / 旧日支配者 → 也是角色（它们是这个世界的主要 NPC）
        for (const listKey of ['古神列表', '七宗罪列表', '旧日支配者列表']) {
          const list = (y[listKey] as Record<string, unknown>) || {}
          for (const [name, body] of Object.entries(list)) {
            if (name.startsWith('$') || !body || typeof body !== 'object') continue
            const p = body as Record<string, unknown>
            characters.push(personToCard(
              name,
              {
                称号: p['称号'] || p['神格'] || p['罪名'],
                境界: p['境界'] || p['位阶'],
                势力: p['领域'],
                描述: p['描述'],
                关系: p['状态'],
                所在地: p['所在地'] || p['位置'] || p['状态'],
              },
            ))
          }
        }

        // 六维：从人物属性里反推键名
        if (!attributes.length) {
          const keys = new Set<string>()
          for (const c of characters) {
            const m = c.description.match(/\*\*属性\*\*：(.+)$/)
            if (!m) continue
            for (const pair of m[1].split(' ')) {
              const k = pair.replace(/[-\d.]+$/, '').trim()
              if (k) keys.add(k)
            }
          }
          if (keys.size >= 3) {
            attributes = [...keys].map((name, idx) => ({
              id: `attr_${idx + 1}`,
              name,
              description: '',
            }))
          }
        }
      }
      continue
    }

    const bucket = bucketOf(e.name)
    const label = stripPrefix(e.name)

    if (bucket === 'character') {
      /*
        两种写法都要认：

        ① `人物_温照雪` 的正文只有一行 `{{人物:温照雪}}` —— 那是 ST 的索引宏，
           真档案在别处。**跳过**，否则角色卡上就写着两个花括号。
        ② `角色_周景贤` 的正文是半结构化档案（`<npc_周景贤>` 标签 +
           `角色档案: 基本信息: 姓名/称号/年龄/外貌…`）。剥掉标签再用 YAML 解一遍。
      */
      const body = stripPseudoTag(e.content)
      if (isReferenceOnly(body)) continue

      const y = parseSimpleYaml(body)
      const archive = (y['角色档案'] as Record<string, unknown>) || {}
      const info = (archive['基本信息'] as Record<string, unknown>) || (y['基本信息'] as Record<string, unknown>) || {}
      const hasInfo = Object.keys(info).length > 0

      const person = hasInfo
        ? personToCard(label, {
          ...info,
          姓名: info['姓名'] || label,
          称号: info['称号'],
          身份: info['身份'],
          境界: info['境界'] || info['修为等级'],
          描述: info['描述'],
          特征: info['特征'],
          性格: info['性格'],
          关系: '',
          // 武功在另一个块里，取第一项塞进描述（剩下的靠 lore 检索）
          内功: ((archive['武学信息'] as Record<string, unknown>) || {})['内功'],
        })
        : null

      const firstLine = body.split('\n').map(s => s.trim()).find(l => l && !l.includes(':')) || ''

      characters.push(person ?? {
        id: makeId('char'),
        name: label,
        description: clip(firstLine || body, DESC_MAX),
        personality: '',
        scenario: '',
        firstMessage: '',
        messageExamples: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        tags: ['导入角色'],
        creator: '',
        characterVersion: '',
        present: false,
        look: { note: body.slice(0, 160) },
      })

      /*
        全文**同时进 worldLore**：角色卡上的描述只有三百字，
        而"他练什么内功、和谁是旧识"这些细节得能被检索到 ——
        `lores` 只是知识页，不进提示词。两边都要有。
      */
      worldBlocks.push(`**${label}**\n${body}`)
      lores.push({ id: `lore_${lores.length + 1}`, name: label, description: clip(body, LORE_MAX) })
      continue
    }

    if (bucket === 'faction') {
      factions.push(label)
      lores.push({ id: `lore_${lores.length + 1}`, name: label, description: clip(e.content, LORE_MAX) })
      continue
    }

    if (bucket === 'item') {
      const y = parseSimpleYaml(e.content)
      const desc = String(y['描述'] || y['武学描述'] || e.content.split('\n').find(l => l.trim()) || '').trim()
      items.push({
        id: makeId('item'),
        name: label,
        description: clip(desc, 400),
        tags: ['秘籍', /奇珍|灵兽/.test(e.name) ? '异物' : '武学'],
      })
      lores.push({ id: `lore_${lores.length + 1}`, name: label, description: clip(e.content, LORE_MAX) })
      continue
    }

    if (bucket === 'rule') {
      ruleBlocks.push(`**${label}**\n${e.content}`)
      continue
    }

    // 世界观正文
    if (/世界观|世界概览|地理|总纲/.test(e.name) && !atmosphere) {
      atmosphere = clip(e.content, 1200)
    }
    worldBlocks.push(`**${label}**\n${e.content}`)
  }

  // ── 出身槽位：从势力列表里取前几个当"你从哪里来" ──
  const backgrounds: BackgroundSlot[] = []
  // 去重：同一本书里常有 `宗门_合欢宗` 与 `势力_合欢宗` 两条（不同阶段的写法）
  const uniqueFactions = [...new Set(factions.filter(Boolean))]
  if (uniqueFactions.length) {
    const picked = uniqueFactions.slice(0, 6)
    backgrounds.push({
      label: '出身',
      options: picked.map(f => ({
        id: makeId('bg'),
        title: f,
        description: `出自${f}。相关的人物、规矩与恩怨见世界书条目。`,
        attributeBonus: {},
        resourceBonus: {},
        startingItems: [],
      })),
    })
  }

  const now = Date.now()
  const worldLore = [
    `> 由 SillyTavern 角色卡《${String((d as { name?: string }).name || '')}》转换。`,
    `> 正文按 \`**条目名**\` 分段 —— 灯叙按段检索，说到哪才捞哪。`,
    '',
    worldBlocks.join('\n\n'),
  ].join('\n')

  const world: WorldCard = {
    id: makeId('world'),
    title: (opts.title || book?.name || String((d as { name?: string }).name || '') || '导入的世界').slice(0, 60),
    tagline: `${characters.length} 个角色、${lores.length} 条设定、${items.length} 件秘籍/物品`,
    worldLore,
    rules: ruleBlocks.join('\n\n').slice(0, 8000),
    attributes: attributes.length ? attributes : DEFAULT_ATTRIBUTES,
    resources,
    backgrounds,
    attributePoints: 30,
    items,
    lores,
    story: {
      atmosphere,
      mainQuest: '',
      enableStages: false,
      stages: [],
      enableChoices: true,
      urgencyAfterTurns: 0,
    },
    narrative: { pov: 'third', tense: 'past', replyLength: 1800, customStyle: '' },
    characters,
    /*
      机制层的判据要用**最终的** `world.attributes`，不能用循环里那个变量 ——
      那张武侠卡没有变量表，`attributes` 一直是空数组，
      于是卡片拿的是默认六维、而开关却是关的：玩家进来只看到叙事，看不到那六个点。
    */
    enableMechanics: resources.length > 0 || (attributes.length || DEFAULT_ATTRIBUTES.length) > 0,
    createdAt: now,
    updatedAt: now,
  }

  return {
    world,
    stats: {
      entries: entries.length,
      characters: characters.length,
      lores: lores.length,
      items: items.length,
      attributes: world.attributes.length,
      resources: resources.length,
      backgrounds: backgrounds.length,
      loreChars: worldLore.length,
      dropped,
    },
  }
}
