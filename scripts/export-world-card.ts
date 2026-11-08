/**
 * 把《大延侠客行》导出成**可导入的** `.world.json`。
 *
 * ## 为什么这张卡不进内置列表
 *
 * 2026-11 我把它做成了第 10 张内置卡，用户的答复是：
 * 「不是让你做成预置的，是让你优化完了把卡给我我自己导入」。
 *
 * 内置卡和"自己导入的卡"在引擎里是两种东西：
 *  · 内置卡由内容指纹整批刷新（`stores/library.ts`）、默认只读、玩家一改就脱离更新；
 *  · 导入卡在玩家自己的库、可自由编辑、不会被任何刷新盖掉。
 *
 * 他要后者。所以这张卡留在 `src/data/worlds/dayan.ts` 当**素材源**
 * （方便继续改），但**不注册**进 `builtinWorldIds.ts` / `builtinWorlds.ts`，
 * 而是由这个脚本产出一个文件让他自己导进去。
 *
 * ## 导出成什么形态
 *
 * `StartScreen.handleImport` → `library.importWorlds` 认三种：
 * 单卡对象 / `{format:'pale-notes-bundle'}` 卡包 / 卡数组。
 * 这里用卡包，与编辑器「导出」按钮产出的文件同构。
 *
 * ## 两个必须抹掉的字段
 *
 *  · `builtin: true` —— `importWorlds` 里写的是 `card.builtin = card.builtin === true`，
 *    留着 true 会变成只读内置卡，还进内置刷新队列。
 *  · `id: 'builtin_dayan'` —— 换一个用户卡 id，免得将来又把这张卡收进内置时撞车。
 *
 * 用法：`pnpm export:dayan`（产物默认落到 `D:\工作区\世界卡\`）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dayan } from '@/data/worlds/dayan'
import { normalizeWorldCard } from '@/utils/worldCard'

/** 产物目录：故意放在仓库外 —— 这是给用户拿的文件，不是源码。 */
const OUT_DIR = process.env.DAYAN_OUT_DIR ?? 'D:/工作区/世界卡'
const OUT_NAME = '大延侠客行.world.json'

const cjk = (s: string) => (s.match(/[\u4e00-\u9fff]/g) ?? []).length

const clone = JSON.parse(JSON.stringify(dayan)) as Record<string, any>
delete clone.builtin
clone.id = 'world_dayan_manual'
clone.avatarStyle = clone.avatarStyle ?? 'parchment'
const now = Date.now()
clone.createdAt = now
clone.updatedAt = now

const bundle = {
  format: 'pale-notes-bundle',
  version: 1,
  exportedAt: new Date().toISOString(),
  world: clone
}

mkdirSync(OUT_DIR, { recursive: true })
const out = `${OUT_DIR}/${OUT_NAME}`
writeFileSync(out, JSON.stringify(bundle, null, 2), 'utf8')

const slots = (clone.backgrounds ?? []) as any[]
const story = clone.story ?? {}
const chars = (clone.characters ?? []) as any[]

console.log('输出：', out)
console.log('大小：', (JSON.stringify(bundle).length / 1024).toFixed(1), 'KB')
console.log('id：', clone.id, '｜ builtin：', clone.builtin, '｜ 色调：', clone.avatarStyle)
console.log(
  'worldLore', cjk(clone.worldLore), '｜ rules', cjk(clone.rules),
  '｜ 文风', cjk(clone.narrative?.customStyle), '｜ 氛围', cjk(story.atmosphere),
  '｜ 主线', cjk(story.mainQuest)
)
console.log('角色', chars.length, '｜ 物品', (clone.items ?? []).length, '｜ 知识', (clone.lores ?? []).length)
console.log('属性：', (clone.attributes ?? []).map((a: any) => a.name).join('/'))
console.log(
  '资源：',
  (clone.resources ?? []).map((r: any) => `${r.name}(${r.initial}${r.max ? '/' + r.max : ''})`).join('/')
)
console.log('背景槽：', slots.map((s: any) => `${s.label}:${s.options.length}`).join('｜'), '｜ 开场槽：', story.openerSlot)

/*
  ⚠️ 下面这三项是**导入后必须仍然成立**的自检。
  它们对应的正是这张卡上一版的三处硬伤：立绘随机长脸（无性别词）、
  人物卡是一句话摘要（desc < 80）、开场素材缺项（开场退回世界基调）。
*/
const seeds = (story.openingSeeds ?? {}) as Record<string, string>
const seedSlot = slots.find((s: any) => s.label === story.openerSlot)
const seedMissing = seedSlot
  ? (seedSlot.options as any[]).filter((o) => !seeds[o.id]).map((o) => o.id)
  : []
const noGender = chars.filter((ch) => !/男|女/.test(ch.description ?? ''))
const shortDesc = chars.filter((ch) => cjk(ch.description ?? '') < 80)

console.log('｜ 自检 ——')
console.log('  开场素材：', Object.keys(seeds).length, '段，缺项', seedMissing.length ? seedMissing.join(',') : '无')
console.log('  角色缺性别：', noGender.length)
console.log('  角色 desc < 80：', shortDesc.length, shortDesc.slice(0, 6).map((c) => c.name).join(' '))

// —— 导入回放：读回文件 → 过 `importWorlds` 的收口 `normalizeWorldCard` ——
const restored = normalizeWorldCard(JSON.parse(readFileSync(out, 'utf8')).world)
const ok =
  restored.title === clone.title &&
  cjk(restored.worldLore) === cjk(clone.worldLore) &&
  Object.keys(restored.story?.openingSeeds ?? {}).length === Object.keys(seeds).length &&
  restored.characters.length === chars.length &&
  restored.builtin !== true

console.log('  导入回放：', ok ? '通过' : '✗ 字段在归一化中丢失')

if (!ok || noGender.length || shortDesc.length || seedMissing.length) {
  process.exitCode = 1
}
