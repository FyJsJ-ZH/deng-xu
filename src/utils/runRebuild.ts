import type { WorldCard } from '@/types/cards'

/**
 * 从「会话配置」重算一局的开局状态。
 *
 * ## 为什么需要（2026-11）
 *
 * 玩家要「随时重开一局」。原先这条路依赖 `startGame()` 拍的 **turn 0 快照** ——
 * 而那份快照在老存档里可能根本不存在（旧版本没拍过、或读档时被校验剔掉了）。
 * 快照没了，入口也跟着消失，玩家只能退回标题页从头选世界、重配主角、重分属性点。
 *
 * 但重开其实**不需要那份快照**：开局状态完全可以从 `session` 里的配置算出来 ——
 * 世界卡、主角、背景选择、属性点、在场角色 id 全在，缺的只是"算一遍"。
 *
 * 这段逻辑原先散在 `SessionSetup.handleLaunch` 里（组件内、依赖若干 useState）。
 * 那里不动（它还要处理 ref 与重挂载的坑），这里只是把**同样的算法**抽成纯函数，
 * 供「重开本局」使用。两边算法必须一致 —— 否则重开出来的属性和第一次开局对不上。
 */

/** 玩家在选角页分配的属性点（属性 id → 点数） */
export type Allocation = Record<string, number>

/** 背景槽位选择（槽位 label → option id） */
export type BackgroundChoices = Record<string, string>

/** 「我自己写」的自由文本（槽位 label → 文本） */
export type BackgroundCustom = Record<string, string>

interface SlotOption {
  id: string
  custom?: boolean
  attributeBonus?: Record<string, number>
  resourceBonus?: Record<string, number>
  startingItems?: string[]
}

interface SlotLike {
  label: string
  options: SlotOption[]
}

function effectiveOption(
  slot: SlotLike,
  choices: BackgroundChoices,
  custom: BackgroundCustom,
): SlotOption | null {
  const option = slot.options.find(o => o.id === choices[slot.label])
  if (!option) return null
  // 自定义项但玩家没写东西 → 等于没选
  if (option.custom && !(custom[slot.label] || '').trim()) return null
  return option
}

/** 汇总属性与资源：属性点 + 背景加成；资源 = 初始值 + 背景加成（并夹在上下限内） */
export function computeStats(
  world: WorldCard,
  allocation: Allocation,
  choices: BackgroundChoices,
  custom: BackgroundCustom,
): { attributes: Record<string, number>; resources: Record<string, number> } {
  const attributes: Record<string, number> = { ...allocation }
  const resources: Record<string, number> = {}
  world.resources.forEach(r => { resources[r.id] = r.initial })

  world.backgrounds.forEach(slot => {
    const option = effectiveOption(slot as unknown as SlotLike, choices, custom)
    if (!option) return
    Object.entries(option.attributeBonus || {}).forEach(([k, v]) => {
      if (k in attributes) attributes[k] += v
    })
    Object.entries(option.resourceBonus || {}).forEach(([k, v]) => {
      if (k in resources) resources[k] += v
    })
  })

  world.resources.forEach(r => {
    resources[r.id] = Math.max(0, resources[r.id])
    if (typeof r.max === 'number') resources[r.id] = Math.min(resources[r.id], r.max)
  })

  return { attributes, resources }
}

/** 背景带来的开局物品（按世界卡的 items 取对象） */
export function startingItemsOf(
  world: WorldCard,
  choices: BackgroundChoices,
  custom: BackgroundCustom,
) {
  const ids = new Set<string>()
  world.backgrounds.forEach(slot => {
    effectiveOption(slot as unknown as SlotLike, choices, custom)?.startingItems?.forEach(id => ids.add(id))
  })
  return world.items.filter(i => ids.has(i.id))
}
