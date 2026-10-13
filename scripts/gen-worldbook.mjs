/**
 * 从内置世界生成官方世界书 JSON。
 *
 * 用法：先由 esbuild 把 src/data/builtinWorlds.ts 打成一个 .mjs（见 package.json 的 gen:worldbook），
 * 本脚本再读那个产物 —— Node 无法直接 import .ts，所以必须分两步。
 *
 * 为什么要有这一步：
 *  内置世界只以 TypeScript 对象的形式存在（`src/data/worlds/*.ts`，约 580 KB），
 *  用户看得到、却**拿不走**。生成一份 JSON 之后：
 *   - 用户可以在标题页下载它，作为格式范例照着写自己的世界书；
 *   - 也可以改一改再导入回去，当作"从内置世界派生出自己的世界"的起点；
 *   - 世界书格式因此有了一个真实存在的参考实现，而不是只写在文档里。
 *
 * 产物：
 *   public/official-worldbook.json   （随站点发布，可直接下载）
 *   presets/official-worldbook.json  （留在仓库里，便于 diff 与审阅）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const out = process.argv[2] || 'public'
const bundled = process.argv[3] || '.check/worlds.mjs'

const abs = path.isAbsolute(bundled) ? bundled : path.join(root, bundled)
if (!fs.existsSync(abs)) {
  console.error(`找不到打包产物 ${abs}\n请先运行 npm run gen:worldbook（它会先 esbuild 再执行本脚本）`)
  process.exit(1)
}

const mod = await import(pathToFileURL(abs).href)
const BUILTIN_WORLDS = mod.BUILTIN_WORLDS
if (!Array.isArray(BUILTIN_WORLDS) || !BUILTIN_WORLDS.length) {
  console.error('打包产物里没有 BUILTIN_WORLDS')
  process.exit(1)
}

const book = {
  format: 'deng-xu-worldbook',
  version: 1,
  title: '灯叙 · 官方世界集',
  tagline: '八个深度世界：后末日企业、中式王朝、经典西幻、维多利亚神秘学、架空 1905、工业奇幻、位面海洋、魔素原欲',
  description: [
    '这本世界书里八个世界**题材互不相干**，是刻意安排的 ——',
    '它们要说明的是：这个引擎不绑定任何题材，世界观完全由卡片决定。',
    '',
    '每个世界都用同一套设计法：',
    '· **先立框架，再向下长** —— 文明/族裔、意识形态、政体形态、生活方式',
    '  各铺开七八种以上，且彼此有结构性矛盾；然后只挑一两处写死具体的人、钱与规矩。',
    '  这样世界才有"宏大活人感"，而不是围着一个城市堆五万字细节。',
    '· **长期目标是模糊的大方向，不是任务** —— 每个方向内部都容得下好人、',
    '  坏人与中间人；你可以做能臣，也可以做狼子野心的奸臣；可以只想安稳过日子。',
    '· **明确留白** —— rules 里都有一条"世界比这更大"：已写的只是下限，',
    '  没提到的部分允许按世界逻辑自行扩展。',
    '· **沙盒优先** —— 没有必须完成的主线，不催进度，允许玩家只当一个普通人。',
    '· **背景与属性每一轮都参与叙事** —— 你挑的来路与立场、分配的属性点，',
    '  会决定他认得出什么、习惯怎么做、做得到什么；而不是开局点一下就作废的表单。',
    '· **开场由 AI 现场创作** —— 处境槽位给的是"这类环境的气味、行话与价钱"，',
    '  不是写死的剧本；你在「扮演角色」里写的身份与职位优先于它。',
    '',
    '· 《深核集团·地渊之下》—— 后末日反乌托邦。喜马拉雅山脉地下三千米的',
    '  垂直企业都市「地渊」，100 层、一亿两千万人。**设定核心之一是禁用强人工智能。**',
    '· 《大晟会典》—— 虚构的中式古风王朝，立国三百余年。**没有任何超自然力量**，',
    '  只有武力、智谋、权力与阴谋。',
    '· 《三邦纪年》—— 经典西方奇幻。三政体、五族之外还有八个族裔；低魔且有代价。',
    '· 《帷幕纪年》—— 维多利亚式工业都城 + 神秘学。煤气灯、电报与初生地铁之下，',
    '  现实与"另一侧"之间隔着一层**帷幕**，而它正在变薄。优雅、神秘、危险、压抑。',
    '· 《中帝纪年》—— 1905 年的架空东北亚。去人格化的「中帝」、政治监察官、',
    '  真理部与「铁内脏」。**同样没有任何超自然力量** —— 一切靠数字、程序与人事。',
    '· 《织命星典》—— 工业味的剑与魔法。浮空晶脉托起云上文明圈，双月同满之夜为',
    '  「双生潮」；十大政权并立，军事核心是铁律系统与魔导战车。',
    '· 《汐梦洲风物志》—— 渊海位面。魔网与符文构成日常，而把「原欲回路」',
    '  调谐到错误频率的「腐化」正在蔓延 —— 那是它当前最大的危机。',
    '· 《埃律西昂：原欲之壤》—— 魔素与原欲法则。阿斯特拉历、大陆尽头的最终都市与',
    '  「千塔之城」；四大基本法则之中，原欲排在第一位。',
    '',
    '每个世界的世界观正文都在三万字以上（全卡五万字以上）。',
    '想自己写世界？把这份 JSON 下载下来改，或者直接在卡片编辑器里新建。',
    '字段含义见 README 的「核心概念」。',
  ].join('\n'),
  author: '灯叙项目',
  revision: '5.0',
  tags: ['官方', '深度世界', '沙盒', '多题材'],
  chapters: [
    {
      title: '本辑八个世界',
      note: '每个世界约五万字设定，机制层全开',
      worldIds: BUILTIN_WORLDS.map(w => w.id),
    },
  ].filter(c => c.worldIds.length > 0),
  worlds: BUILTIN_WORLDS,
}

const json = JSON.stringify(book, null, 2)
const dir = path.join(root, out)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'official-worldbook.json'), json, 'utf8')

fs.mkdirSync(path.join(root, 'presets'), { recursive: true })
fs.writeFileSync(path.join(root, 'presets/official-worldbook.json'), json, 'utf8')

const sizeKb = (Buffer.byteLength(json) / 1024).toFixed(1)
console.log(`✓ 官方世界书已生成：${book.worlds.length} 个世界，${sizeKb} KB`)
console.log(`  ${out}/official-worldbook.json`)
console.log(`  presets/official-worldbook.json`)
for (const w of book.worlds) {
  console.log(`  · ${w.title}  机制层=${w.enableMechanics ? '开' : '关'}  角色=${(w.characters || []).length}  属性=${(w.attributes || []).length}  资源=${(w.resources || []).length}`)
}
for (const c of book.chapters) {
  console.log(`  章节「${c.title}」：${c.worldIds.length} 个世界`)
}
