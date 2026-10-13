import type { WorldCard } from '@/types/cards'
import { deepcore } from '@/data/worlds/deepcore'
import { greatchen } from '@/data/worlds/greatchen'
import { westfantasy } from '@/data/worlds/westfantasy'
import { veil } from '@/data/worlds/veil'
import { zhongdi } from '@/data/worlds/zhongdi'
import { zhiming } from '@/data/worlds/zhiming'
import { ximeng } from '@/data/worlds/ximeng'
import { elysion } from '@/data/worlds/elysion'

/**
 * 内置世界总表（**8 个深度世界**，每个 ≥5 万字设定）。
 *
 * ## 沿革
 *
 * - 最早是九张浅卡（灰烬回响 / 霓虹雨季 / …），每张只有几百到一千多字，
 *   玩起来"太空、太杂"：AI 拿一千字设定撑不住二十轮，很快就自己编世界。
 * - 于是整合成**三个深度世界**（深核 / 大晟 / 三邦）＋**三个举一反三**
 *   （大洋 / 蒸汽 / 青铜），每个世界观正文 ≥3 万字。
 * - 再后来按用户要求收敛为**四个**：
 *   · 删掉《大洋纪年》—— 海世界的题材本质单一（洋流、季风、港口法度），
 *     铺到五万字靠的是同一个母题反复变奏，边际收益低。
 *   · 删掉《青铜纪年》—— 不符合用户审美。
 *   · 《蒸汽纪年》**整体重做**为《帷幕纪年》：主题从"工业革命的社会史"
 *     换成**维多利亚式神秘学**（优雅神秘、危险恐怖、奢靡压抑）。
 *     工业只是舞台，真正的内容是帷幕、相、遗物与结社。
 * - 2026-10 又按用户要求，把 `D:\艺创区` 里他自己的文字设定稿做成了**四张新卡**
 *   （中帝纪年 / 织命星典 / 汐梦洲风物志 / 埃律西昂），补上东方架空现实、
 *   工业奇幻、位面海洋与魔素原欲四个方向。素材是他多年写下的设定稿，
 *   共约 105 万汉字，每张卡是**提炼**而非摘抄。
 *
 * ## 八个世界
 *
 *   1. 《深核集团·地渊之下》—— 后末日反乌托邦巨型企业。
 *      喜马拉雅地下三千米、100 层的垂直企业都市，**禁用强人工智能**。
 *   2. 《大晟会典》—— 虚构的中式古风王朝，**无超自然力量**。
 *      只有武力、智谋、权力与阴谋。
 *   3. 《三邦纪年》—— 经典西方奇幻。三大政治体、五族之外还有八个族裔，
 *      低魔且有代价。
 *   4. 《帷幕纪年》—— 维多利亚式工业都城 + 神秘学。
 *      煤气灯与电报之下，现实与"另一侧"之间隔着一层**帷幕**，而它正在变薄。
 *   5. 《中帝纪年》—— 1905 年的架空东北亚，**无超自然力量**。
 *      去人格化的"中帝"、政治监察官、真理部与"铁内脏"。
 *   6. 《织命星典》—— 工业味的剑与魔法。浮空晶脉、双月与双生潮、
 *      十大政权、铁律系统与魔导战车。
 *   7. 《汐梦洲风物志》—— 渊海位面。魔网与符文，以及把原欲回路
 *      调谐到错误频率的"腐化"。
 *   8. 《埃律西昂：原欲之壤》—— 魔素与原欲法则。阿斯特拉历、
 *      大陆尽头的最终都市与千塔之城。
 *
 * 八个世界**共用同一套设计法**：
 *
 *  1. **先立框架，再向下长**：先把"文明/族裔""意识形态""政体形态""生活方式"
 *     各铺开若干种（且彼此有结构性矛盾），再只挑一两处写死具体的人、钱与规矩。
 *     反过来做（围着一个城市写五万字）会"堆砌细节而 world 很窄"。
 *  2. **长期目标是模糊的大方向**，不是任务：每个方向内部都容得下
 *     好人、坏人与中间人。
 *  3. **明确留白**：`rules` 里都有一条"世界比这更大"——已写的只是下限。
 *  4. **沙盒优先**：都有一条独立的沙盒条款（不要催、没有必须做的事、
 *     世界自己动、允许玩家只当普通人）。见 `constants/prompts.ts`。
 *  5. **背景给的是"方向"，不是第一幕。** 每个世界的 `story.openerSlot` 指向一个
 *     处境槽位，其每个选项对应一段**彼此不同**的素材（这类环境的气味、行话与价钱）。
 *     ⚠️ 2026-10 用户第二次打回后**降级**：它不再规定"你现在在哪、正在做什么"——
 *     那由玩家自设的主角决定。见 `constants/prompts.ts` 的 `buildOpeningInstruction`。
 *  6. **背景与属性每一轮都参与叙事。** 见 `buildBackgroundBriefing` /
 *     `buildAttributeBriefing`：玩家挑的来路与立场、他分配的属性点，都会作为
 *     "他认得出什么、习惯怎么做、做得到什么"的判据写进**每一轮**的提示词。
 *     在此之前，这两样东西只在第一幕或数值结算里露过一次面 —— 玩家原话是
 *     「只有开局处境对剧情有影响」「那些属性对游戏剧情的影响也几乎没有」。
 *
 * 达标情况由 `node scripts/check-worlds.mjs` 客观核对。
 */

/**
 * 给内置世界卡指定头像风格 —— 映射表与函数已抽到 `worldAvatarStyle.ts`。
 * 抽出去的理由：前端现在走**按需**加载（`builtinWorldIds.ts`），
 * 那条路径也必须套同一份风格，否则懒加载得到的卡会退回默认头像配色。
 */
import { withAvatarStyle } from '@/data/worldAvatarStyle'

/**
 * 同步的内置世界总表 —— 供**脚本与测试**使用
 * （`check-worlds.mjs` / `gen-worldbook.mjs` / `check-sprites.mjs` / `render-entry.ts`）。
 *
 * ⚠️ **前端不要 import 这个文件**：它静态拉入八张世界卡的全部正文
 * （约 2.5 MB 源码 / gzip 640 KB），会整块落进首屏包。
 * 前端请用 `@/data/builtinWorldIds` 的 `loadBuiltinWorlds()`，
 * 它按 id 动态加载，每个世界各成一个 chunk。
 */
export const BUILTIN_WORLDS: WorldCard[] = [
  deepcore,
  greatchen,
  westfantasy,
  veil,
  zhongdi,
  zhiming,
  ximeng,
  elysion,
].map(withAvatarStyle)

export default BUILTIN_WORLDS
