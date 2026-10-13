/**
 * 离线渲染入口 —— 给 Node 用的渲染门面。
 *
 * 让 esbuild 把 `rpgMap` / `lpcSprite` / `appearance` 打包成一个新模块，
 * 再在**没装 DOM 垫片的情况下**导入这里的函数调用。
 *
 * 为什么要一个单独的门面，而不是让脚本直接 import 那两个模块：
 *   1. `rpgMap.ts` / `lpcSprite.ts` 用了 `@/` 别名，Node 解析不了 ——
 *      必须经 esbuild 打包，所以需要一个明确的打包入口。
 *   2. 打包后的产物里带 `import.meta.glob` 之类的 Vite 记号，
 *      由构建脚本的插件替换掉（见 `scripts/render-offline.mjs`）。
 *   3. 门面把"要渲染什么"和"怎么渲染"分开：调用方只关心
 *      "我要一张地图/一个立绘"，不关心 canvas 垫片与资源路径。
 *
 * ⚠️ 这个文件**不要**在浏览器代码里 import —— 它是构建期入口。
 */

import { generateMap, ARCHETYPE_TO_MAP, timeOfDayLabel, TILE_KINDS, renderTilePreview, renderTileVariants } from '@/utils/rpgMap'
import { recipeFor, renderSprite, FRAME_SIZE, DIRECTIONS } from '@/utils/lpcSprite'
import { inferTraits } from '@/utils/appearance'
import { dayPhase, phaseLabel } from '@/utils/mapPalette'

/** 九种地形（与地图走查脚本保持一致，方便对照） */
export const ARCHETYPES = [
  'interior', 'street', 'forest', 'mountain', 'coast', 'ruins', 'underground', 'sky', 'night',
]
/** 四档时段 */
export const PHASES = ['dawn', 'day', 'dusk', 'night']

/** 渲染一张地图，返回 dataURL */
export function mapDataUrl(archetype, seed, phase) {
  return generateMap(archetype, seed, phase).dataUrl
}

/** 地图的纯像素数据（不经 base64，给需要逐像素分析的场景用） */
export function mapInfo(archetype, seed, phase) {
  const g = generateMap(archetype, seed, phase)
  return { archetype, seed, phase, width: g.width, height: g.height, dataUrl: g.dataUrl }
}

/** 单个瓦片的放大预览（走真实 drawTile 路径，见 rpgMap.ts 的说明） */
export function tileDataUrl(kind, phase, scale = 8, variant = 0) {
  return renderTilePreview(kind, phase, scale, variant)
}

/** 某种地形三套变体的预览 */
export function tileVariantUrls(kind, phase, scale = 8) {
  return renderTileVariants(kind, phase, scale)
}

/**
 * 渲染一个角色立绘，返回 dataURL。
 *
 * @param key        随机种子（同 key 同形象）
 * @param description 角色描述 —— **兜底**推断的输入（有 look 时它不再决定部件）
 * @param opts       gender / headOnly / scale / direction / **look**
 */
export async function spriteDataUrl(key, description, opts = {}) {
  const profile = { description, gender: opts.gender }
  const recipe = recipeFor(key, { profile, gender: opts.gender, look: opts.look })
  return renderSprite(recipe, {
    headOnly: opts.headOnly,
    scale: opts.scale,
    direction: opts.direction,
  })
}

/**
 * 直接暴露配方函数，供诊断脚本对比"推断结果 → 实际部件"。
 *
 * ⚠️ `opts.look` **必须透传**。这条路径原先只传 `profile` 与 `gender`，
 * 于是离线审计（`audit-sprites.mjs`）看到的永远是"关键词推断"的结果 ——
 * 而**线上渲染早就优先用 `look` 了**。两套结果不一致，
 * 审计就会对着一张与游戏里完全不同的图下判断（并且它还会说"没问题"）。
 * 这类"审计与渲染不同源"的错，是这个项目里最贵的一种。
 */
export function recipeForDiag(key, opts = {}) {
  const profile = opts.profile || { description: opts.description, gender: opts.gender }
  // ⚠️ 这里**不能**加 `async`：`recipeFor` 是同步的，包成 Promise 之后
  // 调用方拿到的 `recipe.parts` 会是 undefined（`contradictions()` 直接崩）。
  return recipeFor(key, { profile, gender: opts.gender, look: opts.look })
}

/** 全部内置世界（含各自的角色卡）—— 供"全量立绘审计"遍历真实语料 */
export { BUILTIN_WORLDS } from '@/data/builtinWorlds'

/** 立绘详情：配方 + 推断结果，供"为什么画成这样"的诊断 */
export async function spriteDetail(key, description, opts = {}) {
  const profile = { description, gender: opts.gender }
  const recipe = recipeFor(key, { profile, gender: opts.gender, look: opts.look })
  const traits = inferTraits({ description })
  const url = await renderSprite(recipe, {
    headOnly: opts.headOnly, scale: opts.scale, direction: opts.direction,
  })
  return { key, description, traits, recipe, dataUrl: url }
}

export { FRAME_SIZE, DIRECTIONS, ARCHETYPE_TO_MAP, TILE_KINDS, timeOfDayLabel, dayPhase, phaseLabel, inferTraits }
