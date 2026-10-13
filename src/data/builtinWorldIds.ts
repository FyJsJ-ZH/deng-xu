import type { WorldCard } from '@/types/cards'
import { withAvatarStyle } from '@/data/worldAvatarStyle'

/**
 * 内置世界卡的 **id 清单** —— 刻意与 `builtinWorlds.ts` **分成两个文件**。
 *
 * ## 为什么不能直接 import `BUILTIN_WORLDS`
 *
 * 八张世界卡的正文合计约 2.5 MB 源码（打包后 minify 约 2.5 MB、gzip 约 640 KB）。
 * `library.ts` 要回答的问题只有一个：「玩家的库里是不是缺了某张内置卡？」
 * —— 回答这个问题只需要一串 id。
 *
 * 若为此静态 import `BUILTIN_WORLDS`，那 640 KB 就会落进**首屏包**
 * （见 `vite.config.ts` 里对 chunk 体积的取舍），手机上主菜单要多下一大截才出得来。
 * 所以：**id 清单放这里**（几百字节，静态引入），**完整卡走动态 import**。
 *
 * ## 加新内置世界时必须改两处
 *
 *   1. 本文件的 `BUILTIN_WORLD_IDS`
 *   2. `builtinWorlds.ts` 的 import 与 `BUILTIN_WORLDS` 数组
 *
 * 漏掉本文件 ⇒ **老玩家升级后看不到那张新卡**：他们的库里已经有旧的卡，
 * 不会触发"首次运行播种"，而缺卡检测又不知道有这么一张新卡存在。
 * 这条一致性由 `builtinWorldIds.test.ts` 断言，漏了会红。
 */
export const BUILTIN_WORLD_IDS: readonly string[] = [
  'builtin_deepcore',
  'builtin_greatchen',
  'builtin_westfantasy',
  'builtin_veil',
  'builtin_zhongdi',
  'builtin_zhiming',
  'builtin_ximeng',
  'builtin_elysion',
]

/**
 * 库里**缺**哪些内置卡 —— 计算时排除玩家自己删过的。
 *
 * ## 为什么需要它
 *
 * 原先内置卡只在 `worlds === null`（**首次运行**）时播种。于是 2026-10 新增四张卡时，
 * 所有老玩家的库里都看不到它们 —— 而这是最容易被漏掉的一类 bug：
 * 新装的机器一切正常，只有"已经玩过的人"看不到新内容。
 *
 * ## 为什么必须排除"删过的"
 *
 * 补卡与"用户删卡"天然冲突：补卡逻辑一跑，玩家昨天删掉的那张内置卡就又回来了，
 * 表现为"删除操作没生效"。所以 `deleteWorld` 会把删掉的内置卡 id 记下来，
 * 这里跳过它们。
 *
 * 这一步刻意抽成**纯函数**：store 的加载路径依赖 IndexedDB，
 * 纯函数可以在 node 环境下直接测。
 *
 * @param haveIds    玩家库里现有的世界卡 id
 * @param removedIds 玩家主动删掉的内置卡 id
 */
export function missingBuiltinIds(
  haveIds: readonly string[],
  removedIds: readonly string[] = [],
): string[] {
  const have = new Set(haveIds)
  const removed = new Set(removedIds)
  return BUILTIN_WORLD_IDS.filter(id => !have.has(id) && !removed.has(id))
}

/**
 * 按 id 取内置世界卡的**加载器**。
 *
 * ## 这里的 `import()` 必须是动态的
 *
 * 它是整个「首屏不背 640 KB」方案的关键。写成静态 import
 * （或者图省事把 `builtinWorlds.ts` 拉进来）会让八张卡立刻回到主包里 ——
 * 而 `builtinWorlds.ts` 存在的意义只是给**脚本与测试**一个同步入口。
 *
 * 每个世界因此各自成一个 chunk：
 *  · 老玩家升级时只下载**缺的那几张**；
 *  · 首次运行并行下载全部，每个约 80 KB —— 比一个 640 KB 的大文件更稳，
 *    `vite.config.ts` 里记过 surge 免费 CDN 会掐掉大文件的连接
 *    （实测单个 810 KB 连取 8 次失败 5 次）。
 *
 * ⚠️ 加新世界时这里也要加一条；`builtinWorldIds.test.ts` 会断言
 * 加载器的键与 `BUILTIN_WORLD_IDS` 完全一致。
 */
const WORLD_LOADERS: Record<string, () => Promise<WorldCard>> = {
  builtin_deepcore: async () => (await import('./worlds/deepcore')).deepcore,
  builtin_greatchen: async () => (await import('./worlds/greatchen')).greatchen,
  builtin_westfantasy: async () => (await import('./worlds/westfantasy')).westfantasy,
  builtin_veil: async () => (await import('./worlds/veil')).veil,
  builtin_zhongdi: async () => (await import('./worlds/zhongdi')).zhongdi,
  builtin_zhiming: async () => (await import('./worlds/zhiming')).zhiming,
  builtin_ximeng: async () => (await import('./worlds/ximeng')).ximeng,
  builtin_elysion: async () => (await import('./worlds/elysion')).elysion,
}

/** 加载器覆盖了哪些 id（供测试核对，不必真的把卡读进来） */
export const BUILTIN_WORLD_LOADER_IDS: readonly string[] =
  Object.keys(WORLD_LOADERS).sort()

/**
 * 按 id 加载内置世界卡。
 *
 * 只加载请求的那些；未知 id **静默忽略** ——
 * 宁可少一张卡，也不要因为清单里多了一个坏 id 就让整库播不进去。
 * 头像风格在这里补上（与同步路径共用 `worldAvatarStyle.ts`），
 * 否则懒加载得到的卡会退回默认配色。
 */
export async function loadBuiltinWorlds(ids: readonly string[]): Promise<WorldCard[]> {
  const want = new Set(ids)
  const picked = await Promise.all(
    BUILTIN_WORLD_LOADER_IDS.filter(id => want.has(id)).map(id => WORLD_LOADERS[id]()),
  )
  return picked.map(withAvatarStyle)
}
