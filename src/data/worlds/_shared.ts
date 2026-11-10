/**
 * 世界卡工厂 —— 三个整合世界的公共工具。
 *
 * ## 为什么单独一个文件
 *
 * `CharacterCard` 有 16 个字段，其中 10 个是必填的（SillyTavern V2 兼容字段：
 * firstMessage / messageExamples / creatorNotes / systemPrompt /
 * postHistoryInstructions / alternateGreetings / tags / creator / characterVersion …）。
 *
 * 本作不使用 SillyTavern 的 `firstMessage` 与示例对话，一律留空字符串。
 * 手写角色卡时逐个补这些默认值**必然漏**（原 `builtinWorldsThemed.ts`
 * 就是为此先写了 `char()`）。三个世界各写一份会重复三遍，
 * 所以抽到这里共用。
 *
 * ## 内容标准（三个世界统一遵守）
 *
 * · **术语表**：给 AI 一套明确的专有名词，避免它自由发挥出戏
 * · **禁止词汇**：写清"什么不可能"，比堆形容词更能防跑题
 * · **机制与题材匹配**：现代题材不用"法力"，古代题材不用"接口"
 * · **至少 6 名角色卡**：让关系面板一开局就有内容
 * · **开场已在进行中**：主角不是"刚醒"，而是已经在做事
 */
import type { AttributeDef, CharacterCard } from '@/types/cards'

/** 补全 CharacterCard 的必填默认值；只需给出 id / name / description */
export function char(
  c: Partial<CharacterCard> & Pick<CharacterCard, 'id' | 'name' | 'description'>
): CharacterCard {
  return {
    personality: '',
    firstMessage: '',
    messageExamples: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '灯叙内置世界',
    characterVersion: '1.0',
    ...c,
  } as CharacterCard
}

/**
 * 内置世界统一使用"构建时确定"的时间戳。
 *
 * 不用 `Date.now()`：那会让每次构建产生不同的 `createdAt`，
 * 于是 `official-worldbook.json` 的产物每次都变 —— 不利于比对与缓存。
 */
export const BUILTIN_TIMESTAMP = 1735689600000   // 2025-01-01T00:00:00Z

/**
 * 九个**性相** —— 学原项目《苍白卷宗》的做法，三个新世界共用。
 *
 * ## 为什么一字不改地照搬原作的九相
 *
 * 原作的性相不是"属性"，是**九双看世界的眼睛**。它每一相都带三样东西：
 *
 *   · `description` —— 本质（四到六个字，比如灯是「理智，光明，残酷的真理」）
 *   · `traits` —— 这个相的人会怎么**反应**（冷静分析、闻到就分心、对伤口亲切…）
 *   · `behaviors` —— 这个相的人下意识会**做什么**（注视光源、冷笑、抚摸伤口…）
 *
 * 选一个相，不是选一个加成的方向，是选**你想成为哪种人**。
 * 这一层才是"性相"和"属性"的区别，也正是用户反复要的「原作的机制」。
 *
 * ## 三个世界为什么不各写一套
 *
 * 伦敦与西幻本就是西方神秘学的语境（灯、铸、刃、冬本来就是那套语汇）；
 * 武侠里的「灯=明察、刃=刀剑、杯=酒色、蛾=痴狂」也照样立得住。
 * 与其每个世界造一套半吊子的相，不如共用这一套已经千锤百炼的。
 */
export const PHASES: AttributeDef[] = [
  {
    id: 'lantern',
    name: '灯',
    description: '理智，光明，残酷的真理',
    color: '#c9a227',
    traits: ['理性', '残酷', '揭示', '执着', '无情'],
    behaviors: ['用冷漠的目光审视', '强迫自己直视恐惧', '在混乱中寻找规律'],
  },
  {
    id: 'forge',
    name: '铸',
    description: '力量，改变，火焰',
    color: '#b5532a',
    traits: ['变革', '火焰', '锤炼', '重塑', '力量'],
    behaviors: ['紧握双拳', '感受到血液中的燥热', '试图强行改变现状'],
  },
  {
    id: 'edge',
    name: '刃',
    description: '斗争，征服，痛苦',
    color: '#8b2f2f',
    traits: ['斗争', '痛苦', '征服', '界限', '狡诈'],
    behaviors: ['下意识地寻找武器', '冷笑', '评估对方的弱点'],
  },
  {
    id: 'winter',
    name: '冬',
    description: '寂静，终结，寒冷',
    color: '#5b7c8d',
    traits: ['寂静', '终结', '寒冷', '遗忘', '苍白'],
    behaviors: ['保持沉默', '眼神空洞', '对恐怖景象无动于衷'],
  },
  {
    id: 'heart',
    name: '心',
    description: '生命，保存，永恒的跳动',
    color: '#b03a4a',
    traits: ['延续', '保护', '脉动', '舞蹈', '坚持'],
    behaviors: ['深呼吸平复心跳', '顽强地站立', '拒绝放弃'],
  },
  {
    id: 'grail',
    name: '杯',
    description: '欲望，诱惑，感官',
    color: '#7a3f5c',
    traits: ['渴望', '诱惑', '感官', '饥饿', '血液'],
    behaviors: ['舔舐嘴唇', '被异香吸引', '感到一阵战栗'],
  },
  {
    id: 'moth',
    name: '蛾',
    description: '混乱，自然，难以捉摸',
    color: '#8a7f4a',
    traits: ['混乱', '蜕变', '疯狂', '森林', '不可预测'],
    behaviors: ['神经质地颤抖', '发出毫无意义的笑声', '想要撕掉什么'],
  },
  {
    id: 'knock',
    name: '启',
    description: '开启，秘密，界限',
    color: '#4e6b4a',
    traits: ['门扉', '伤口', '开启', '召唤', '连接'],
    behaviors: ['抚摸伤口', '凝视紧闭的门', '听到不存在的敲击声'],
  },
  {
    id: 'secrethistory',
    name: '秘史',
    description: '悖论，多重历史，模糊，记录，选择',
    color: '#5c5c58',
    traits: ['悖论', '多重历史', '模糊', '记录', '选择'],
    behaviors: ['记下这一刻', '感到强烈的既视感', '不确定这是哪一段历史'],
  },
]
