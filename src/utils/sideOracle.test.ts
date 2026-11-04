import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildOracleMessages,
  pickLatestNarrative,
  shouldPolish,
  POLISH_MIN_CHARS,
  ORACLE_MODES,
  type OracleInput,
  type OracleMode,
} from '@/utils/sideOracle'

/**
 * 旁路 AI 的纯逻辑测试。
 *
 * ## 这里防的是三类错
 *
 * 1. **它开始写正文**：旁路一旦续写，就等于开了第二个叙事者，
 *    而它写的东西**不会进存档** —— 玩家看着一段好文字消失，比看不到更气人。
 * 2. **它把世界书整本塞进提示词**：3–8 万字，既贵又稀释，查设定反而更不准。
 * 3. **它偷偷写回存档**：这是最严重的一种，且一旦发生就是"我的存档被它改了"。
 *    第 3 条靠**结构**保证（模块不 import 任何 store），下面有一条测试盯着源码。
 */

const base = (over: Partial<OracleInput> = {}): OracleInput => ({
  worldTitle: '测试世界',
  worldLore: '## 总纲\n\n这是一段总纲。\n\n**第一章 市井**\n\n州桥一带是夜市。一碗汤饼八文。',
  rules: '术语规范：一律称「先生」。',
  playerName: '沈砚',
  location: '州桥',
  summary: '他刚从当铺出来。',
  recent: [
    { role: 'assistant', content: '掌柜把当票推回来，说少三文。' },
    { role: 'user', content: '我数了一遍钱。' },
  ],
  question: '当铺在哪？',
  ...over,
})

/** 取 system / user 两条消息的正文（返回的永远是字符串，直接可以 toContain） */
const sysOf = (mode: OracleMode, input: OracleInput): string =>
  buildOracleMessages(mode, input)[0].content
const userOf = (mode: OracleMode, input: OracleInput): string =>
  buildOracleMessages(mode, input)[1].content

describe('旁路 AI · 三种模式各管一件事', () => {
  it('三种模式都在（少一个就等于砍掉一种用法）', () => {
    expect(ORACLE_MODES.map(m => m.id).sort()).toEqual(['lore', 'plot', 'polish'])
  })

  it('★ 问剧情：明确禁止写正文与推进剧情', () => {
    const sys = sysOf('plot', base())
    expect(sys).toContain('不是叙事者')
    expect(sys).toContain('不写正文')
    expect(sys).toContain('不推动剧情')
    expect(userOf('plot', base())).toContain('我的问题')
  })

  it('★ 问剧情会带上最近对话，且标注「只读材料，不要接着写」', () => {
    const user = userOf('plot', base())
    expect(user).toContain('掌柜把当票推回来')
    expect(user).toMatch(/只读材料/)
  })

  it('★ 查设定：只依据世界书片段，不许用常识补', () => {
    const sys = sysOf('lore', base())
    expect(sys).toMatch(/只依据给你的/)
    expect(sys).toMatch(/不要用常识补/)
  })

  it('★ 查设定：世界书是**按问题挑出来的**，不是整本', () => {
    const longLore = Array.from({ length: 40 }, (_, i) =>
      `**第${i + 1}章 无关的第${i + 1}件事**\n\n${'这一段讲的是别的事情。'.repeat(30)}`).join('\n\n')
    const lore = `## 总纲\n\n底子。\n\n**市井**\n\n州桥一带是夜市，一碗汤饼八文。当铺在桥东。\n\n${longLore}`
    const user = userOf('lore', base({ worldLore: lore, question: '州桥的当铺在哪' }))
    // 只挑片段 ⇒ 不可能把 40 章全带上
    expect(user.length).toBeLessThan(12000)
    expect(user).toMatch(/世界书片段/)
  })

  it('查设定会带上世界规则（术语与禁令优先于正文）', () => {
    const user = userOf('lore', base())
    expect(user).toMatch(/术语与禁令/)
    expect(user).toContain('一律称「先生」')
  })
})

describe('修文字模式 · 只做改写，不改情节', () => {
  it('★ 只给「要改的正文」与要求，**不塞世界书**（防它跑偏去补设定）', () => {
    const user = userOf('polish', base({ target: '他觉得心里五味杂陈。' }))
    expect(user).toContain('要改的正文')
    expect(user).toContain('五味杂陈')
    expect(user).not.toContain('世界书片段')
    expect(user).not.toContain('最近发生的')
  })

  it('★ 系统提示里写明：情节/专名/对白一字不许改，长度大致不变', () => {
    const sys = sysOf('polish', base({ target: 'x' }))
    expect(sys).toMatch(/情节、事件顺序/)
    expect(sys).toMatch(/专名/)
    expect(sys).toMatch(/长度大致不变/)
    expect(sys).toMatch(/不要压缩成梗概/)
  })

  it('★ 只输出正文，不要解释改了什么', () => {
    expect(sysOf('polish', base({ target: 'x' }))).toMatch(/只输出改写后的正文/)
  })

  it('目标正文缺失时也给出可读的提示，而不是空白', () => {
    expect(userOf('polish', base({ target: '' }))).toContain('没有拿到正文')
  })

  it('★ 太短的回复不值得改（省钱，且短文本本来就好改）', () => {
    expect(shouldPolish('短')).toBe(false)
    expect(shouldPolish('字'.repeat(POLISH_MIN_CHARS))).toBe(true)
  })
})

describe('取最新一条叙事', () => {
  it('★ 跳过夹在中间的 system（状态变更）消息', () => {
    const h = [
      { role: 'user', content: '我进店' },
      { role: 'assistant', content: '掌柜抬头。' },
      { role: 'system', content: '资金 -3' },
    ]
    expect(pickLatestNarrative(h)).toBe('掌柜抬头。')
  })

  it('空白回复不算，继续往前找', () => {
    const h = [
      { role: 'assistant', content: '真正的那一条。' },
      { role: 'assistant', content: '   ' },
    ]
    expect(pickLatestNarrative(h)).toBe('真正的那一条。')
  })

  it('一条都没有时返回空串（调用方据此禁用按钮）', () => {
    expect(pickLatestNarrative([])).toBe('')
    expect(pickLatestNarrative([{ role: 'user', content: 'x' }])).toBe('')
  })
})

describe('只读保证 · 这是结构性的，不是自觉', () => {
  it('★ 这个模块不 import 任何 store —— 它写不进存档', () => {
    /*
      这条测试看着像洁癖，其实是最要紧的一条：
      旁路 AI 一旦能写 store，"只读"就只是一句口号，而它写坏的是**存档**。
      所以判据放在源码层面：只要 import 里出现 `stores/`，这条就红。
    */
    const src = fs.readFileSync(path.resolve(__dirname, 'sideOracle.ts'), 'utf8')
    expect(/from\s+['"]@\/stores/.test(src)).toBe(false)
    expect(/useGameStore|useSessionStore|useUIStore|useLibraryStore/.test(src)).toBe(false)
  })

  it('★ 它也不带任何「保存 / 写入」的动作', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'sideOracle.ts'), 'utf8')
    expect(/setState\(/.test(src)).toBe(false)
    expect(/localStorage|indexedDB/i.test(src)).toBe(false)
  })
})
