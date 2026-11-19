import type { Character } from '@/stores/game'

/**
 * 给结算 AI 看的角色卡（2026-11）。
 *
 * ## 起因
 *
 * 玩家原话：「正文极快，三十秒就出，结算却慢，三四分钟才好」。
 *
 * 结算那一次请求里，`characters` 原来是**原样** `JSON.stringify` 出去的 ——
 * 于是每张卡上这些东西全部进了报文：
 *
 * ```
 * avatar    base64 data URL，一张几十 KB
 * look      LPC 立绘的部件 id 表
 * prompt    角色卡的完整提示词资料，几百到几千字
 * ```
 *
 * 这三样对「这一轮数值该不该变」毫无用处，却能让输入凭空涨出几十万字符。
 * 而 Gemini 会为它收到的整份报文完整思考一遍 —— 结算慢三四分钟，
 * 很大一截花在这些它根本用不上的数据上。
 *
 * 裁掉之后报文只留判断需要的东西：谁、跟主角什么关系、现在什么状态、
 * 在哪、有没有旧名。几十万字的数据换成一两万，思考量跟着掉。
 *
 * ## 为什么不连 description 一起砍
 *
 * 人物描写是它判断"这个人的反应是否合理"的依据，留着有用。但一份人物小传
 * 动辄几千字，而结算看的是**这一轮发生了什么** —— 所以截到 400 字：
 * 够认出是谁、什么性子，不足以把整篇小传再读一遍。
 */
export const ANALYSIS_DESC_LIMIT = 400

export function slimCharactersForAnalysis(chars: Character[] | undefined): unknown[] {
  return (chars || []).map(c => ({
    id: c.id,
    name: c.name,
    description: (c.description || '').slice(0, ANALYSIS_DESC_LIMIT),
    relationship: c.relationship,
    status: c.status,
    ...(c.location ? { location: c.location } : {}),
    ...(c.aka && c.aka.length ? { aka: c.aka } : {}),
    ...(c.stats ? { stats: c.stats } : {}),
  }))
}
