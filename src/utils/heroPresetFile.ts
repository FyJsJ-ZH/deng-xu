import type { PlayerCard } from '@/types/cards'

/**
 * 主角预设文件的格式与解析。
 *
 * ## 为什么单独抽出来
 *
 * 这段逻辑原先内嵌在 `HeroPresets.tsx` 里，所以**没法测** —— 而它恰恰漏过一次：
 * `look`（立绘部件）与 `avatar` 被静默丢弃，玩家在选角页调好的立绘
 * 一导出再导入就退回关键词猜。而 `PlayerCard.look` 的注释写着
 * 「主角的立绘**必须**走这条路」。
 *
 * 抽成纯函数之后，`heroPresetFile.test.ts` 盯住它。
 */
export const PRESET_FORMAT = 'deng-xu-hero-presets'
export const PRESET_VERSION = 1

/**
 * 从任意形状的 JSON 里尽量抠出一个主角档案；抠不出返回 null。
 *
 * 允许两种写法：`{ label, player: {…} }`（本项目的导出格式）或直接就是一个
 * `PlayerCard`（手写的文件、别人给的卡）。
 */
export function coercePlayer(v: unknown): PlayerCard | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const src = (o.player && typeof o.player === 'object' ? o.player : o) as Record<string, unknown>
  const str = (k: string): string => (typeof src[k] === 'string' ? (src[k] as string) : '')

  const player: PlayerCard = {
    name: str('name'),
    gender: str('gender'),
    age: str('age'),
    appearance: str('appearance'),
    personality: str('personality'),
    background: str('background'),
    extra: str('extra'),
  }

  /*
    ⚠️ `look` 与 `avatar` 也要带过来。

    在此之前这两个字段在导入时被**直接丢掉** —— 而 `PlayerCard.look` 的注释
    里写着「主角的立绘**必须**走这条路」（拿自由文本去猜部件命中率很低，
    而"我自己设的主角画得不像"最伤代入感）。

    也就是说：玩家在选角页辛辛苦苦调好的立绘，导出再导入就没了，
    退回关键词猜。这和角色卡那边的 `look` 是同一个问题，一起修掉。
  */
  if (typeof src.avatar === 'string' && src.avatar) player.avatar = src.avatar
  if (src.look && typeof src.look === 'object' && !Array.isArray(src.look)) {
    player.look = src.look as PlayerCard['look']
  }

  /*
    七个**文本**字段全空 = 这不是一个主角档案。
    ⚠️ 判空只看文本，不看 look —— 只有立绘没有名字的记录在列表里
    就是一行「未命名主角」，玩家点进去一片空白，不如直接跳过。
  */
  const hasText = [
    player.name, player.gender, player.age,
    player.appearance, player.personality, player.background, player.extra,
  ].some(field => field.trim().length > 0)
  if (!hasText) return null
  return player
}

/** 文件里可能是卡包（`{presets:[…]}`）也可能直接是数组 */
export function extractPresetList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const list = (data as { presets?: unknown }).presets
    if (Array.isArray(list)) return list
  }
  return []
}
