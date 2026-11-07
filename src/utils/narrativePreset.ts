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

import type { NarrativePreset, WorldCard } from '@/types/cards'

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
 * 把一份预设叠到世界上，返回**新的** world 对象（原对象不变）。
 *
 * 传 `null` / `undefined`（没有启用任何预设）时原样返回同一个引用 ——
 * 调用方常把它放在渲染路径上，能不新建对象就不新建。
 */
export function withNarrativePreset(
  world: WorldCard,
  preset: NarrativePreset | null | undefined,
): WorldCard {
  if (!preset) return world

  const rules = preset.rules.trim().slice(0, PRESET_RULES_MAX)
  const style = preset.style.trim().slice(0, PRESET_STYLE_MAX)
  if (!rules && !style) return world

  const rulesBlock = rules
    ? `### 叙事预设：${preset.name}\n\n${rules}`
    : ''
  /*
    ⚠️ 这句话不是客套：世界卡的作者与预设的作者不是同一个人，
    两份要求打起来时模型需要知道该听谁的。世界卡在前、且写明"冲突时以本作为准"，
    是为了保住这个题材自己的底线（比如《极乐》那张卡明确不写露骨细节）。
  */
  const styleBlock = style
    ? `（以下文风要求来自叙事预设「${preset.name}」；与世界本身的规则冲突时，以世界为准）\n\n${style}`
    : ''

  return {
    ...world,
    rules: joinBlock(world.rules, rulesBlock),
    narrative: {
      ...world.narrative,
      customStyle: joinBlock(world.narrative.customStyle, styleBlock),
    },
  }
}

/** 这一份预设会不会真的改变提示词（空预设不该让"已启用"三个字骗人） */
export function presetHasContent(preset: NarrativePreset | null | undefined): boolean {
  if (!preset) return false
  return Boolean(preset.rules.trim() || preset.style.trim())
}

/** 给 UI 用的一句话摘要 */
export function describeNarrativePreset(preset: NarrativePreset): string {
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
  const text = `${preset.rules}\n${preset.style}`
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
