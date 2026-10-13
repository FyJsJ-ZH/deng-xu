/**
 * 旧版世界卡的**字段迁移**（normalizeWorldCard）。
 *
 * ## 为什么现在才写
 *
 * `types/cards.ts` 里 `story.opening` 的注释写着「加载/导入时
 * `normalizeWorldCard()` 会把它搬到 `atmosphere`」—— 但这个函数**从来没被写出来**，
 * 也没有任何调用点。注释描述的是一个不存在的机制，而它掩盖了两个真问题：
 *
 *  1. **从旧世界包导入的卡，氛围文本留在废弃字段上**。
 *     引擎读取时用的是 `atmosphere || opening`（到处都写了这个兜底），
 *     所以"跑起来没问题"—— 但卡片编辑器只认 `atmosphere`，
 *     打开一张老卡会看到空白的"开场设定"，一改就把原文覆盖掉了。
 *  2. **`openingSeeds` 的旧结构是两层嵌套**
 *     （`{ 槽位label: { 选项id: 文本 } }`），某次改版扁平化成了
 *     `{ 选项id: 文本 }`。旧卡的两层结构在新代码里会被当成"选项 id 是槽位名"，
 *     于是 `resolveOpeningSeed` 永远取不到素材，**开场静默退回世界基调**。
 *
 * 两件事都是"不报错、不崩、只是内容悄悄失效"，正是最该被迁移逻辑收掉的一类。
 */

import type { StorySettings, WorldCard } from '@/types/cards'

/**
 * 把 `openingSeeds` 统一成扁平结构（选项 id → 文本）。
 *
 * 判据是**值的类型**：扁平结构的值一定是字符串；旧结构的值是对象。
 * 不按"键看起来像不像槽位名"去猜 —— 那需要知道世界卡有哪些槽位，
 * 而这个函数只拿到一个字段。
 */
export function flattenOpeningSeeds(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      // 已经是扁平结构
      if (value.trim()) out[key] = value
      continue
    }
    if (value && typeof value === 'object') {
      // 旧的两层结构：这一层是「槽位 label」，下一层才是「选项 id → 文本」
      for (const [optId, text] of Object.entries(value as Record<string, unknown>)) {
        if (typeof text === 'string' && text.trim()) out[optId] = text
      }
    }
  }
  return out
}

/**
 * 迁移一张世界卡的旧字段。**幂等**：对新卡调用不会改变任何东西。
 *
 * 目前处理两件事：
 *   · `story.opening` → `story.atmosphere`（只在 `atmosphere` 为空时搬，
 *     新字段有内容就以它为准，绝不覆盖作者已经写好的东西）
 *   · `openingSeeds` 的两层嵌套 → 扁平
 */
export function normalizeWorldCard(raw: WorldCard): WorldCard {
  if (!raw || typeof raw !== 'object') return raw

  const story = (raw.story || {}) as StorySettings
  const atmosphere = String(story.atmosphere || '').trim() || String(story.opening || '').trim()

  return {
    ...raw,
    story: {
      ...story,
      atmosphere,
      // 迁移完就把废弃字段清掉：留着它只会让下一个读代码的人以为这里还有两条路径
      opening: undefined,
      openingSeeds: flattenOpeningSeeds(story.openingSeeds),
    },
  }
}
