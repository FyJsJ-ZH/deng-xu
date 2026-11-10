/**
 * 叙事预设 → 叠加到当前世界卡上。
 *
 * ## 为什么用「叠加」而不是「替换」
 *
 * 预设管的是**怎么写**（文风、句式禁令、对白规范），世界卡管的是**写什么**
 * （地名、势力、物价）以及这个题材自己的硬约束（比如「本作不写露骨细节」）。
 * 玩家换上别人的预设，不该把世界卡作者定的规矩一起冲掉 ——
 * 那样的话，一份从网上下载的 NSFW 预设会把每一张内置卡都变成限制级。
 *
 * 所以两段都是**拼接**：世界卡在前，预设在後，并且给预设加一行小标题，
 * 让模型知道"这后面的一段是另一份来源"。
 *
 * ## 为什么只在构建提示词时叠加，不改写库里的卡
 *
 * 与 `withNarrativePreset` 的调用点有关：它每次构建提示词时现算，
 * 世界卡本身**一个字节都不动**。这样：
 *
 *  - 换预设＝换一个函数入参，立刻生效，不必重开一局、不必改卡；
 *  - 玩家在编辑器里看到的世界卡还是他自己的内容，不会莫名其妙多出一段别人的话。
 */

import type { NarrativePreset, PresetEntry, WorldCard } from '@/types/cards'
import { chosenStyleIds, styleById, type StyleChoice } from '@/data/narrativeStyles'

/** 预设两段各自的上限（字）。与 `stPreset.ts` 的预算一致，防止手动粘贴超长 */
const PRESET_RULES_MAX = 4000
const PRESET_STYLE_MAX = 4000

/** 段与段之间留一行空，模型才不会读成同一句 */
function joinBlock(base: string, extra: string): string {
  const a = base.trim()
  const b = extra.trim()
  if (!a) return b
  if (!b) return a
  return `${a}\n\n${b}`
}

/**
 * 把某一类**已勾选**的条目拼回一段正文。
 *
 * ## 格式与导入时完全一致
 *
 * `【条目名】\n正文`，条目之间空一行 —— 与 `stPreset.ts` 的 `fill()` 一模一样。
 * 这不是巧合：勾选全部打开时，拼出来的必须与改之前**逐字相同**，
 * 否则"我什么也没动，文风却变了"。测试里钉着这件事。
 */
export function renderPresetEntries(preset: NarrativePreset, kind: PresetEntry['kind']): string {
  const list = (preset.entries || []).filter(e => e.enabled && e.kind === kind && e.content.trim())
  if (!list.length) return ''
  return list.map(e => `【${e.name}】\n${e.content}`).join('\n\n')
}

/** 这一类条目现在勾掉了几条、总几条、占多少字（给 UI 的小标题用） */
export function presetEntryStats(preset: NarrativePreset): Record<PresetEntry['kind'], { on: number; all: number; chars: number }> {
  const out = {
    rules: { on: 0, all: 0, chars: 0 },
    style: { on: 0, all: 0, chars: 0 },
    other: { on: 0, all: 0, chars: 0 },
  }
  for (const e of preset.entries || []) {
    const k = out[e.kind]
    k.all++
    if (e.enabled) {
      k.on++
      k.chars += e.content.length
    }
  }
  return out
}

/**
 * 由 `entries` 重算三段快照。
 *
 * 勾选一变就调一次，把 `rules` / `style` / `lore` 与 `counts` 跟上 ——
 * 这三个字段是导出、列表摘要、旧版本降级读的入口，不能让它们与勾选状态分家。
 *
 * 没有 `entries` 的旧预设原样返回（不动它，也就不会误伤）。
 */
export function syncPresetSnapshot(preset: NarrativePreset): NarrativePreset {
  const entries = preset.entries
  if (!entries?.length) return preset
  const stats = presetEntryStats(preset)
  return {
    ...preset,
    rules: renderPresetEntries(preset, 'rules'),
    style: renderPresetEntries(preset, 'style'),
    lore: renderPresetEntries(preset, 'other'),
    counts: {
      ...preset.counts,
      total: entries.filter(e => e.enabled).length,
      rules: stats.rules.on,
      style: stats.style.on,
      other: stats.other.on,
    },
  }
}

/**
 * 把预设与文风叠到世界上，返回**新的** world 对象（原对象不变）。
 *
 * 三层，从下到上：
 *
 *   1. 世界卡自己的 `customStyle` / `rules`（作者定的，永远在最前）
 *   2. 叙事预设（从 ST 文件转来的整套规则 + 文风）
 *   3. 文风选择（玩家在预设页里现拨的开关，**最强**，放最后）
 *
 * 为什么第三层排最后：模型对越靠后的指令越敏感，而玩家刚点的那一下
 * 才是他此刻真正想要的。世界卡作者三年前写的文风不该压过他现在的选择。
 *
 * ## 第 2 层现在按**勾选**取（2026-11 第三十七轮）
 *
 * 有 `entries` 就只拼已勾选的条目；没有（旧版导入的预设）就退回整块字符串。
 * 两条路的上限是同一个 `PRESET_RULES_MAX` —— 玩家勾得再多，也不至于把
 * 每轮提示词撑到失控。
 *
 * 全空时原样返回同一个引用 —— 调用方常把它放在生成路径上，能不新建就不新建。
 */
export function withNarrativePreset(
  world: WorldCard,
  preset: NarrativePreset | null | undefined,
  styleChoice?: StyleChoice | null,
): WorldCard {
  const useEntries = Boolean(preset?.entries?.length)
  const presetRules = preset
    ? (useEntries ? renderPresetEntries(preset, 'rules') : preset.rules.trim()).slice(0, PRESET_RULES_MAX)
    : ''
  const presetStyle = preset
    ? (useEntries ? renderPresetEntries(preset, 'style') : preset.style.trim()).slice(0, PRESET_STYLE_MAX)
    : ''
  const chosenStyle = renderStyleChoice(styleChoice).slice(0, PRESET_STYLE_MAX)

  if (!presetRules && !presetStyle && !chosenStyle) return world

  const rulesBlock = presetRules
    ? `### 叙事预设：${preset!.name}\n\n${presetRules}`
    : ''
  /*
    ⚠️ 这句话不是客套：世界卡的作者与预设的作者不是同一个人，
    两份要求打起来时模型需要知道该听谁的。世界卡在前、且写明"冲突时以本作为准"，
    是为了保住这个题材自己的底线（比如《极乐》那张卡明确不写露骨细节）。
  */
  const presetStyleBlock = presetStyle
    ? `（以下文风要求来自叙事预设「${preset!.name}」；与世界本身的规则冲突时，以世界为准）\n\n${presetStyle}`
    : ''
  const chosenBlock = chosenStyle
    ? `（以下是玩家当前选定的文风，优先级高于以上风格描述）\n\n${chosenStyle}`
    : ''

  return {
    ...world,
    rules: joinBlock(world.rules, rulesBlock),
    narrative: {
      ...world.narrative,
      customStyle: joinBlock(
        joinBlock(world.narrative.customStyle, presetStyleBlock),
        chosenBlock,
      ),
    },
  }
}

/** 这一份预设会不会真的改变提示词（空预设不该让"已启用"三个字骗人） */
export function presetHasContent(preset: NarrativePreset | null | undefined): boolean {
  if (!preset) return false
  if (preset.entries?.length) {
    // 勾着 `other` 类不算 —— 那些本来就不注入
    return preset.entries.some(e => e.enabled && e.kind !== 'other' && e.content.trim())
  }
  return Boolean(preset.rules.trim() || preset.style.trim())
}

/**
 * 把一套文风选择拼成一段正文。
 *
 * 顺序是**核心 → 附加 → 基础 → 纠偏**：模型读到的最后一段印象最深，
 * 而纠偏器（抗升华、对白强化）最该被记住 —— 它们治的都是"读着读着就犯"的毛病。
 */
export function renderStyleChoice(choice: StyleChoice | null | undefined): string {
  if (!choice) return ''
  return chosenStyleIds(choice)
    .map(id => styleById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map(s => s.text)
    .join('\n\n')
}

/**
 * 选择里的**真冲突**（不是风格偏好，是语义打架）。
 *
 * 例：`📖 西式文学` 要"轻微翻译腔"，`✅基础文风` 明写"杜绝欧化句式"。
 * 两条同时注入，模型只能挑一边 —— 于是同一份提示词里出现自相矛盾的要求，
 * 而玩家看到的是"AI 怎么忽冷忽热"。
 *
 * 只在 UI 提示，不自动取消：那是玩家自己的选择，但得知道自己在选什么。
 */
export function styleConflicts(choice: StyleChoice | null | undefined): { a: string; b: string }[] {
  if (!choice) return []
  const ids = new Set(chosenStyleIds(choice))
  const out: { a: string; b: string }[] = []
  for (const id of ids) {
    const s = styleById(id)
    if (!s?.conflicts) continue
    for (const other of s.conflicts) {
      // 只报一次（A→B 与 B→A 不重复）
      if (!ids.has(other)) continue
      const o = styleById(other)
      if (!o) continue
      const key = [s.id, o.id].sort().join('|')
      if (out.some(x => [styleById(x.a)?.id, styleById(x.b)?.id].sort().join('|') === key)) continue
      out.push({ a: s.name, b: o.name })
    }
  }
  return out
}

/** 给 UI 用的一句话摘要 */
export function describeNarrativePreset(preset: NarrativePreset): string {
  // 有逐条清单时按**实际勾选**报，而不是报导入时那一瞬间的数字
  if (preset.entries?.length) {
    const stats = presetEntryStats(preset)
    const on = stats.rules.on + stats.style.on + stats.other.on
    const chars = stats.rules.chars + stats.style.chars
    return `${on}/${preset.entries.length} 条勾选 · 每轮注入 ${chars} 字`
  }
  const { counts } = preset
  const parts = [
    `${counts.total} 条启用条目`,
    `规则 ${preset.rules.replace(/\n\n（另有[\s\S]*$/, '').length} 字`,
    `文风 ${preset.style.replace(/\n\n（另有[\s\S]*$/, '').length} 字`,
  ]
  if (counts.dropped.length) parts.push(`超预算 ${counts.dropped.length} 条`)
  return parts.join(' · ')
}

/**
 * 这份预设里有没有**会跟本作打架**的东西。
 *
 * ## 为什么要主动说，而不是让玩家自己踩
 *
 * 这些预设是给 SillyTavern 写的，那边的输出管道与本作完全不同：
 *
 *  - **思维链前缀**：作者要求模型先输出 `<think>` / `<｜begin▁of▁thinking｜>`。
 *    在本作里这些标签不会被摘掉，会**原样出现在正文里** ——
 *    玩家看到的是"AI 又把思考过程漏出来了"，而那其实是预设要求的。
 *  - **状态栏 / 行动选项**：ST 靠这些面板显示数值，本作自己的界面已经有了，
 *    叠一份只会出现两套。
 *  - **`{{user}}` / `{{char}}`**：本作不替换 ST 宏，会原样发给模型。
 *
 * 全部只在**展开后提示**，不做拦截：那是作者的内容，删不删由玩家决定。
 */
export function presetWarnings(preset: NarrativePreset): string[] {
  /*
    只看**勾着的**条目：玩家已经把「思维链格式」那条关掉了，
    还弹一句"它可能污染正文"就是在骗他关错了。
  */
  const text = preset.entries?.length
    ? `${renderPresetEntries(preset, 'rules')}\n${renderPresetEntries(preset, 'style')}`
    : `${preset.rules}\n${preset.style}`
  const out: string[] = []
  if (/<think>|<thinking>|begin▁of▁thinking|思考格式/.test(text)) {
    out.push('含思维链格式要求（<think> 等）：这些标签在本作不会自动摘掉，可能漏进正文。发现正文被污染就关掉这份，或删掉那一条。')
  }
  if (/StatusBlock|状态栏|<SUOT>|行动选项|信息面板/.test(text)) {
    out.push('含状态栏 / 行动选项格式：本作界面自己会出这些，叠一份可能出现两套。')
  }
  if (/\{\{(?:user|char)\}\}/.test(text)) {
    out.push('含 {{user}} / {{char}}：本作不替换 ST 宏，会原样发给模型，需要的话自己替换成具体称呼。')
  }
  return out
}
