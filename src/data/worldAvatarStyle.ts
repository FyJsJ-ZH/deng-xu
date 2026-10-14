/**
 * 内置世界的**头像风格**映射。
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑原先住在 `builtinWorlds.ts` 里，与「把八张世界卡静态 import 进来」同处一室。
 * 但 2026-10 起，前端不再整体加载那八张卡（合计约 2.5 MB 源码 / gzip 640 KB），
 * 而是**按需**加载缺的那几张（见 `builtinWorldIds.ts`）。
 *
 * 那条按需路径同样需要这份风格映射 —— 少了它，走懒加载得到的世界卡
 * 就没有 `avatarStyle` / `avatarTone`，人物头像会退回默认配色，
 * 表现为"从旧版升级上来的玩家，新世界的头像颜色不对"。
 *
 * 所以把它抽出来，让**同步**路径（脚本、测试）与**按需**路径共用同一份。
 *
 * ## 风格与题材的对应
 *
 * 同一套几何造型在不同风格下观感差别很大，所以题材完全不同的卡
 * 复用同一套生成算法也不会互相违和。
 */
import type { WorldCard } from '@/types/cards'

const AVATAR_STYLE_BY_WORLD: Record<string, { style: WorldCard['avatarStyle']; tone: string }> = {
  builtin_deepcore: { style: 'ink', tone: '#4a5568' },          // 地渊：水墨 + 冷灰（压迫、金属、地下）
  builtin_greatchen: { style: 'parchment', tone: '#8b1a1a' },   // 大晟：羊皮纸 + 朱（典章、宫墙）
  builtin_westfantasy: { style: 'parchment', tone: '#2f4f4f' }, // 三邦：羊皮纸 + 深绿（古地图、森林）
  builtin_veil: { style: 'ink', tone: '#5d4370' },              // 帷幕：水墨 + 雾紫（煤气灯、天鹅绒、另一侧）
  builtin_zhongdi: { style: 'ink', tone: '#3f4a5a' },           // 中帝：水墨 + 钢灰（军装、混凝土、档案柜）
  builtin_zhiming: { style: 'ink', tone: '#7a2233' },           // 织命星：水墨 + 铁锈红（铁棘美学、魔导战车）
  builtin_ximeng: { style: 'holo', tone: '#1f6f8b' },           // 汐梦洲：光环 + 深海蓝（渊海、魔网、珊瑚）
  builtin_elysion: { style: 'ink', tone: '#4a2d5c' },           // 埃律西昂：水墨 + 暗紫（魔素、原欲、黑铁）
  builtin_london1905: { style: 'ink', tone: '#3a3f47' },        // 雾都1905：水墨 + 煤烟灰（煤气灯、雾、砖墙）
}

/** 给一张内置世界卡补上头像风格；没有配过的原样返回 */
export function withAvatarStyle(world: WorldCard): WorldCard {
  const preset = AVATAR_STYLE_BY_WORLD[world.id]
  if (!preset) return world
  return { ...world, avatarStyle: preset.style, avatarTone: preset.tone }
}
