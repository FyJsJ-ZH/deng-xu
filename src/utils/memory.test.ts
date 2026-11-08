import { describe, it, expect } from 'vitest'
import {
  KNOWN_PER_CHARACTER,
  MEMORY_BUDGET,
  SUMMARY_LIMIT,
  TIMELINE_KEEP,
  appendTimelineBeat,
  clipSummary,
  emptyMemory,
  ensurePlace,
  mergeMemory,
  normalizeMemory,
  renderKnownByForPrompt,
  renderMemoryForPrompt,
  type StoryMemory,
} from '@/utils/memory'

/**
 * 三层长期记忆的纯逻辑测试（A1）
 *
 * ## 为什么这一层值得单独钉死
 *
 * 它出错的**表现是"AI 忘了"**，而不是报错。玩家会说"它不记得我们见过"，
 * 而日志里一切正常 —— 这类 bug 没有断言根本无法回归。
 * 最容易错的三处：
 *
 *  1. **合并被写成替换**：模型漏写一层，就把攒了二十轮的关系清空了。
 *  2. **折叠丢内容**：时间线超长时把旧拍子直接丢掉，而没有折进 earlierSummary ——
 *     "更早发生过什么"于是凭空断掉，正是要修的那个问题。
 *  3. **渲染无上限**：三层全塞进提示词，token 成本失控（C9 那边刚加的成本可见
 *     会立刻显示出来，但那时已经花了钱）。
 */

const mk = (over: Partial<StoryMemory> = {}): StoryMemory => ({ ...emptyMemory(), ...over })

describe('mergeMemory · 增量合并不是替换', () => {
  it('★ 补丁没提到的层必须原样保留（模型漏写一层不能让它消失）', () => {
    const old = mk({
      bonds: [{ who: '裴无咎', state: '欠他一枚铜钱未还' }],
      threads: [{ id: 'missing_ledger', text: '账本缺了七页' }],
      timeline: [{ turn: 3, text: '在渡口见到了裴无咎' }],
      updatedAtTurn: 3,
    })

    // 这一轮只提到了新的线索，完全没提关系与时间线
    const next = mergeMemory(old, { threads: [{ id: 'seal', text: '那枚私印是谁刻的' }] })

    expect(next.bonds).toEqual(old.bonds)
    expect(next.timeline).toEqual(old.timeline)
    expect(next.threads.map(t => t.id).sort()).toEqual(['missing_ledger', 'seal'])
  })

  it('★ 同一个人只保留一条最新关系（欠人情 → 结仇，不能新旧并存）', () => {
    const old = mk({ bonds: [{ who: '裴无咎', state: '欠他人情' }] })
    const next = mergeMemory(old, { bonds: [{ who: '裴无咎', state: '已经结仇' }] })
    expect(next.bonds).toHaveLength(1)
    expect(next.bonds[0].state).toBe('已经结仇')
  })

  it('人名比对忽略空白与大小写（模型常多写一个空格）', () => {
    const next = mergeMemory(
      mk({ bonds: [{ who: '裴无咎', state: '同桌喝酒' }] }),
      { bonds: [{ who: ' 裴无咎 ', state: '翻脸' }] },
    )
    expect(next.bonds).toHaveLength(1)
    expect(next.bonds[0].state).toBe('翻脸')
  })

  it('没写"谁"的关系被丢弃（对模型没有指代价值）', () => {
    const next = mergeMemory(emptyMemory(), { bonds: [{ who: '', state: '一个神秘人' }] })
    expect(next.bonds).toHaveLength(0)
  })

  it('线索按 id 或正文去重，重复提交只更新措辞', () => {
    const old = mk({ threads: [{ id: 'ledger', text: '账本缺页' }] })
    const next = mergeMemory(old, { threads: [{ id: 'ledger', text: '账本缺了七页，且在最后一页被人撕过' }] })
    expect(next.threads).toHaveLength(1)
    expect(next.threads[0].text).toContain('撕过')
  })

  it('同一轮次的时间线是覆盖而不是追加（模型可能对同一拍给出更准的写法）', () => {
    const old = mk({ timeline: [{ turn: 4, text: '粗糙的记录' }] })
    const next = mergeMemory(old, { timeline: [{ turn: 4, text: '更准确的记录' }] })
    expect(next.timeline).toHaveLength(1)
    expect(next.timeline[0].text).toBe('更准确的记录')
  })

  it('乱序给出的时间线按轮次排序（"最近 N 拍"必须按轮次算）', () => {
    const next = mergeMemory(emptyMemory(), {
      timeline: [{ turn: 7, text: '七' }, { turn: 2, text: '二' }, { turn: 5, text: '五' }],
    })
    expect(next.timeline.map(b => b.turn)).toEqual([2, 5, 7])
  })
})

describe('时间线折叠 · 被折掉的拍子必须留下痕迹', () => {
  it(`★ 超过 ${TIMELINE_KEEP} 拍时折叠，且内容进入 earlierSummary`, () => {
    const beats = Array.from({ length: TIMELINE_KEEP + 3 }, (_, i) => ({
      turn: i + 1,
      text: `第${i + 1}轮的事`,
    }))
    const next = mergeMemory(emptyMemory(), { timeline: beats })

    expect(next.timeline).toHaveLength(TIMELINE_KEEP)
    // 保留的是**最近**的那些
    expect(next.timeline[0].turn).toBe(4)
    expect(next.timeline[next.timeline.length - 1].turn).toBe(TIMELINE_KEEP + 3)
    // 被折掉的三轮，一句话都不能丢
    expect(next.earlierSummary).toContain('第1轮的事')
    expect(next.earlierSummary).toContain('第3轮的事')
  })

  it('反复合并不产生重复的折叠记录（幂等）', () => {
    let mem = emptyMemory()
    for (let turn = 1; turn <= TIMELINE_KEEP + 4; turn++) {
      mem = mergeMemory(mem, { timeline: [{ turn, text: `第${turn}轮` }] })
    }
    const once = mem.earlierSummary
    const again = mergeMemory(mem, {})
    expect(again.earlierSummary).toBe(once)
  })

  it('模型给出的 earlierSummary 会被保留并拼接', () => {
    const next = mergeMemory(mk({ earlierSummary: '更早：他从北边来' }), { earlierSummary: '又及：他带了封信' })
    expect(next.earlierSummary).toContain('他从北边来')
    expect(next.earlierSummary).toContain('他带了封信')
  })
})

describe('normalizeMemory · 模型与旧存档的坏数据都要能接住', () => {
  it('字符串/数字/null 等非法结构一律不崩，退化成空记忆', () => {
    for (const bad of ['张三欠我钱', 42, null, undefined, [], { bonds: '不是数组' }]) {
      const m = normalizeMemory(bad)
      expect(Array.isArray(m.bonds)).toBe(true)
      expect(Array.isArray(m.threads)).toBe(true)
      expect(Array.isArray(m.timeline)).toBe(true)
    }
  })

  it('轮次写成"第3轮"这类非数字时按 0（未知轮次）处理，而不是 NaN', () => {
    const m = normalizeMemory({ timeline: [{ turn: '第3轮', text: '某事' }] })
    expect(m.timeline[0].turn).toBe(0)
    expect(Number.isNaN(m.timeline[0].turn)).toBe(false)
  })

  it('缺 text 的拍子被丢弃，缺 id 的线索用正文兜底', () => {
    const m = normalizeMemory({
      timeline: [{ turn: 1, text: '' }, { turn: 2, text: '有效' }],
      threads: [{ text: '没有 id 的线索' }],
    })
    expect(m.timeline).toHaveLength(1)
    expect(m.threads[0].id).toBe('没有 id 的线索')
  })

  it('★ 旧存档（完全没有记忆字段）读出来是合法的空记忆', () => {
    const m = normalizeMemory({ summary: '旧存档只有摘要' })
    expect(m).toMatchObject({ bonds: [], threads: [], timeline: [], earlierSummary: '' })
  })
})

describe('renderMemoryForPrompt · 注入文本', () => {
  it('空记忆返回空串（调用方据此完全不注入，避免只塞一个空标题）', () => {
    expect(renderMemoryForPrompt(emptyMemory())).toBe('')
    expect(renderMemoryForPrompt(undefined)).toBe('')
  })

  it('三层都有内容时，三个区块与轮次编号都在', () => {
    const text = renderMemoryForPrompt(mk({
      bonds: [{ who: '裴无咎', state: '欠他一枚铜钱未还' }],
      threads: [{ id: 'ledger', text: '账本缺了七页' }],
      timeline: [{ turn: 9, text: '在渡口见到了裴无咎' }],
      earlierSummary: '更早：他从北边来',
    }))
    expect(text).toContain('### 人物关系')
    expect(text).toContain('裴无咎')
    expect(text).toContain('### 未结线索')
    expect(text).toContain('账本缺了七页')
    expect(text).toContain('### 事件时间线')
    expect(text).toContain('第9轮')
    expect(text).toContain('更早的经过')
  })

  it(`★ 三层加起来不超过 ${MEMORY_BUDGET} 字（token 成本必须有硬上限）`, () => {
    const text = renderMemoryForPrompt(mk({
      // 故意给一堆很长的条目把预算撑爆
      bonds: Array.from({ length: 20 }, (_, i) => ({ who: `人物${i}`, state: '关系说明'.repeat(6) })),
      threads: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, text: '线索内容'.repeat(6) })),
      timeline: Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, text: '发生过的事情'.repeat(4) })),
      earlierSummary: '更早的经过'.repeat(10),
    }))
    expect(text.length).toBeLessThanOrEqual(MEMORY_BUDGET)
  })

  it('★ 超预算时优先砍时间线，关系与线索尽量留住（丢了最伤的是关系）', () => {
    const text = renderMemoryForPrompt(mk({
      bonds: [{ who: '裴无咎', state: '欠他一枚铜钱未还' }],
      threads: [{ id: 'ledger', text: '账本缺了七页' }],
      timeline: Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, text: '发生过的事情'.repeat(4) })),
    }))
    expect(text).toContain('裴无咎')
    expect(text).toContain('账本缺了七页')
  })

  it('某一层的条目单独超长时会被裁剪，不会把整块撑爆', () => {
    const text = renderMemoryForPrompt(mk({
      bonds: [{ who: '裴无咎', state: '关系'.repeat(200) }],
    }))
    expect(text.length).toBeLessThan(200)
  })
})

describe('appendTimelineBeat · 每轮的机械记账（不依赖 LLM）', () => {
  it('追加一拍，并把轮次规整为正整数', () => {
    const m = appendTimelineBeat(emptyMemory(), 3, '在渡口见到了裴无咎')
    expect(m.timeline).toEqual([{ turn: 3, text: '在渡口见到了裴无咎' }])
  })

  it('空文本不产生拍子（不要往时间线里塞空行）', () => {
    expect(appendTimelineBeat(emptyMemory(), 3, '   ').timeline).toHaveLength(0)
  })

  it('同一轮重复记账是覆盖（重试同一轮不会出现两条）', () => {
    let m = appendTimelineBeat(emptyMemory(), 3, '第一次的结果')
    m = appendTimelineBeat(m, 3, '重试后的结果')
    expect(m.timeline).toHaveLength(1)
    expect(m.timeline[0].text).toBe('重试后的结果')
  })

  it('轮次非法（0 / 负数 / NaN）时退到第 1 轮，而不是写进一个取不回来的格子', () => {
    expect(appendTimelineBeat(emptyMemory(), 0, 'x').timeline[0].turn).toBe(1)
    expect(appendTimelineBeat(emptyMemory(), -5, 'x').timeline[0].turn).toBe(1)
    expect(appendTimelineBeat(emptyMemory(), NaN, 'x').timeline[0].turn).toBe(1)
  })

  it('updatedAtTurn 跟着最新轮次前进（下一次摘要据此知道进度）', () => {
    const m = appendTimelineBeat(emptyMemory(), 8, '第八轮')
    expect(m.updatedAtTurn).toBe(8)
  })
})

/**
 * 「每个角色知道主角什么」—— 防 **NPC 全知**（2026-11）。
 *
 * ## 这一层防的是什么
 *
 * 在此之前，任何角色一登场就知道玩家的一切：`formatCharacter()` 把整张卡
 * （description / personality / scenario）塞进提示词，模型把**设定**当成了**认知**。
 * 症状在正文里看着完全正常 —— 只有玩家自己知道「我从来没告诉过他」。
 *
 * 这和我们修过的「不要替玩家认亲」是同一类病：
 * **模型把作者知道的事，当成了角色知道的事。**
 *
 * ## 三条关键约束
 *
 *  1. **只增不减**：`bonds` 是现状（覆盖），`knownBy` 是认知（并集）——
 *     用替换的话，模型某一轮只报了新的一条，之前那个人的认知就被清空了。
 *  2. **一无所知也要写出来**：不写的话模型会退回角色卡设定，等于又变回全知。
 *  3. **按在场角色过滤**：全塞进去就是换个方式全知。
 */
describe('knownBy · 角色认知的收敛与合并', () => {
  it('★ 合并是**并集**，不是替换（旧认知不会被新一轮清空）', () => {
    const old = mk({ knownBy: { 阿什沃斯勋爵: ['在成衣行做工'] } })
    const next = mergeMemory(old, { knownBy: { 阿什沃斯勋爵: ['从爱尔兰来'] } })
    expect(next.knownBy['阿什沃斯勋爵']).toEqual(['在成衣行做工', '从爱尔兰来'])
  })

  it('重复上报同一条不会堆成两条', () => {
    const old = mk({ knownBy: { 巡警布兰登: ['在成衣行做工'] } })
    const next = mergeMemory(old, { knownBy: { 巡警布兰登: ['在成衣行做工'] } })
    expect(next.knownBy['巡警布兰登']).toHaveLength(1)
  })

  it('补丁没提到的人，认知原样保留', () => {
    const old = mk({ knownBy: { 甲: ['知道一件事'], 乙: ['知道另一件事'] } })
    const next = mergeMemory(old, { knownBy: { 丙: ['新的一条'] } })
    expect(next.knownBy['甲']).toEqual(['知道一件事'])
    expect(next.knownBy['乙']).toEqual(['知道另一件事'])
    expect(next.knownBy['丙']).toEqual(['新的一条'])
  })

  it('★ 每个人有上限（超出保留最近的，不然会长成人物小传）', () => {
    const facts = Array.from({ length: 20 }, (_, i) => `第${i}件事`)
    const m = normalizeMemory({ knownBy: { 甲: facts } })
    expect(m.knownBy['甲']).toHaveLength(KNOWN_PER_CHARACTER)
    expect(m.knownBy['甲'].at(-1)).toBe('第19件事')
  })

  it('★ 坏数据一律滤掉（名字空 / 条目空 / 不是数组 / 根本不是对象）', () => {
    expect(normalizeMemory({ knownBy: '甲知道一切' }).knownBy).toEqual({})
    expect(normalizeMemory({ knownBy: ['甲'] }).knownBy).toEqual({})
    expect(normalizeMemory({ knownBy: { '': ['x'] } }).knownBy).toEqual({})
    expect(normalizeMemory({ knownBy: { 甲: [] } }).knownBy).toEqual({})
    expect(normalizeMemory({ knownBy: { 甲: ['  ', '真的'] } }).knownBy).toEqual({ 甲: ['真的'] })
  })

  it('旧存档里没有这个字段也不崩', () => {
    const m = normalizeMemory({ bonds: [{ who: '甲', state: '欠钱' }] })
    expect(m.knownBy).toEqual({})
  })
})

describe('renderKnownByForPrompt · 按在场角色渲染', () => {
  const mem = mk({
    knownBy: {
      阿什沃斯勋爵: ['在成衣行做工', '从爱尔兰来'],
      巡警布兰登: ['上周在西印度码头出现'],
    },
  })

  it('没有在场角色时返回空串（不占 token）', () => {
    expect(renderKnownByForPrompt(mem, [])).toBe('')
    expect(renderKnownByForPrompt(mem, ['  '])).toBe('')
  })

  it('★ 只渲染在场的那几个人（没在场的一个都不给）', () => {
    const text = renderKnownByForPrompt(mem, ['阿什沃斯勋爵'])
    expect(text).toContain('成衣行')
    expect(text).not.toContain('西印度码头')
  })

  it('★ 一无所知的角色也要写出来 —— 省略等于退回全知', () => {
    const text = renderKnownByForPrompt(mem, ['卖热汤的'])
    expect(text).toContain('卖热汤的')
    expect(text).toContain('一无所知')
  })

  it('★ 必须写明边界：没写的事他就不知道，且不许拿角色卡设定当认知', () => {
    const text = renderKnownByForPrompt(mem, ['阿什沃斯勋爵'])
    expect(text).toMatch(/没写.*就\*\*不知道\*\*/)
    expect(text).toContain('不要把角色卡上的设定当成他知道的事')
  })

  it('名字不必逐字相同（双向包含即算命中）', () => {
    expect(renderKnownByForPrompt(mem, ['勋爵'])).toContain('成衣行')
    expect(renderKnownByForPrompt(mem, ['巡警布兰登'])).toContain('西印度码头')
  })

  it('同一个人重复出现在列表里只渲染一次', () => {
    const text = renderKnownByForPrompt(mem, ['阿什沃斯勋爵', '阿什沃斯勋爵'])
    expect(text.match(/阿什沃斯勋爵/g)?.length).toBe(1)
  })
})

/**
 * 好感双轨 / 地点树 / 物品台账（2026-11，来自酒馆生态评估里柏宝书那四本台账）。
 *
 * ## 这三样各自在修什么
 *
 * - **好感双轨**：单轨表达不了「嘴硬」。单轨时模型只能二选一（熟人 / 陌生人），
 *   于是玩家看到"好感一到就突然熟起来"的跳变。
 * - **地点树**：原先只有一个 `location` 字符串，切三次场景就记不住谁在哪、
 *   哪两个地方是同一片街区。
 * - **物品台账**：`WorldCard.items` 是「世界上这种东西长什么样」的模板，
 *   不是「他手上这一件现在在哪」。混用的结果是玩家的东西凭空消失又出现。
 */
describe('affinity · 好感双轨是"现状"，同一个人只留最新', () => {
  it('★ 内外两档分开存（不能合并成一条）', () => {
    const m = normalizeMemory({
      affinity: [{ who: '阿什沃斯勋爵', inner: '近', outer: '疏', note: '嘴硬' }],
    })
    expect(m.affinity[0]).toEqual({ who: '阿什沃斯勋爵', inner: '近', outer: '疏', note: '嘴硬' })
  })

  it('★ 没写档位就是「未知」，不要替它填「平」（那会让模型以为已经判断过）', () => {
    const m = normalizeMemory({ affinity: [{ who: '某人' }] })
    expect(m.affinity[0].inner).toBe('未知')
    expect(m.affinity[0].outer).toBe('未知')
  })

  it('★ 同一个人只留最新一条（关系是会变的）', () => {
    const old = mk({ affinity: [{ who: '老周', inner: '平', outer: '平' }] })
    const next = mergeMemory(old, { affinity: [{ who: '老周', inner: '近', outer: '平' }] })
    expect(next.affinity).toHaveLength(1)
    expect(next.affinity[0].inner).toBe('近')
  })

  it('补丁没提到的人，好感原样保留', () => {
    const old = mk({ affinity: [{ who: '甲', inner: '亲', outer: '亲' }] })
    const next = mergeMemory(old, { affinity: [{ who: '乙', inner: '疏', outer: '疏' }] })
    expect(next.affinity.map(a => a.who).sort()).toEqual(['乙', '甲'].sort())
  })

  it('坏数据滤掉（没名字 / 不是数组）', () => {
    expect(normalizeMemory({ affinity: '甲很亲' }).affinity).toEqual([])
    expect(normalizeMemory({ affinity: [{ inner: '近' }] }).affinity).toEqual([])
  })

  it('渲染时必须写明「不要把外表当成内心」', () => {
    const text = renderMemoryForPrompt(mk({ affinity: [{ who: '老周', inner: '近', outer: '疏' }] }))
    expect(text).toContain('内心')
    expect(text).toContain('外表')
    expect(text).toMatch(/不要把外表当成内心/)
  })
})

describe('places · 地点树由大到小', () => {
  it('★ 子地点缩进在父地点下面', () => {
    const m = normalizeMemory({
      places: [{ name: '柳关' }, { name: '南市', parent: '柳关' }, { name: '牌墙', parent: '南市' }],
    })
    const text = renderMemoryForPrompt(mk({ places: m.places }))
    const lines = text.split('\n')
    const iRoot = lines.findIndex(l => l.trim() === '- 柳关')
    const iMid = lines.findIndex(l => l.trim() === '- 南市')
    const iLeaf = lines.findIndex(l => l.trim() === '- 牌墙')
    expect(iRoot).toBeGreaterThanOrEqual(0)
    expect(iMid).toBeGreaterThan(iRoot)
    expect(iLeaf).toBeGreaterThan(iMid)
    // 缩进逐级加深
    expect(lines[iMid].search(/\S/)).toBeGreaterThan(lines[iRoot].search(/\S/))
    expect(lines[iLeaf].search(/\S/)).toBeGreaterThan(lines[iMid].search(/\S/))
  })

  it('★ 并集：去过的地方不会因为这一轮没提就消失', () => {
    const old = mk({ places: [{ name: '柳关' }] })
    const next = mergeMemory(old, { places: [{ name: '醉仙楼', parent: '柳关' }] })
    expect(next.places.map(p => p.name).sort()).toEqual(['柳关', '醉仙楼'].sort())
  })

  it('★ 环不会让渲染死循环（模型会写出 甲→乙、乙→甲）', () => {
    const text = renderMemoryForPrompt(mk({
      places: [{ name: '甲', parent: '乙' }, { name: '乙', parent: '甲' }],
    }))
    expect(text).toContain('甲')
    expect(text).toContain('乙')
  })

  it('★ 上级不在表里的「孤儿」也要渲染出来（否则它从世界里消失）', () => {
    const text = renderMemoryForPrompt(mk({ places: [{ name: '牌墙', parent: '南市' }] }))
    expect(text).toContain('牌墙')
  })

  it('自己当自己的上级会被丢掉（那是个环）', () => {
    const m = normalizeMemory({ places: [{ name: '甲', parent: '甲' }] })
    expect(m.places).toEqual([{ name: '甲' }])
  })
})

describe('inventory · 手上有什么、放在哪', () => {
  it('★ where 缺省是「随身」（不替模型编一个地方）', () => {
    const m = normalizeMemory({ inventory: [{ name: '当票' }] })
    expect(m.inventory[0].where).toBe('随身')
  })

  it('★ 同名覆盖 where（东西会挪位置），但不会变成两条', () => {
    const old = mk({ inventory: [{ name: '外套', where: '寄存在和通号' }] })
    const next = mergeMemory(old, { inventory: [{ name: '外套', where: '随身', note: '刚赎回' }] })
    expect(next.inventory).toHaveLength(1)
    expect(next.inventory[0].where).toBe('随身')
  })

  it('★ 只增不删：模型没报的东西仍然在（否则玩家的东西会凭空消失）', () => {
    const old = mk({ inventory: [{ name: '当票', where: '随身' }] })
    const next = mergeMemory(old, { inventory: [{ name: '外套', where: '随身' }] })
    expect(next.inventory.map(i => i.name).sort()).toEqual(['外套', '当票'].sort())
  })

  it('渲染时要提醒模型「不要让他丢掉、也不要凭空多出」', () => {
    const text = renderMemoryForPrompt(mk({ inventory: [{ name: '外套', where: '随身' }] }))
    expect(text).toMatch(/不要让他丢掉、也不要凭空多出/)
  })
})

describe('ensurePlace · 当前地点机械入册（不靠模型）', () => {
  it('★ 新地点补成一条顶层节点', () => {
    const m = ensurePlace(emptyMemory(), '南市')
    expect(m.places).toEqual([{ name: '南市' }])
  })

  it('★ 带层级的地点拆成父子（「伦敦·威斯敏斯特」）', () => {
    const m = ensurePlace(emptyMemory(), '柳关·南市')
    expect(m.places).toContainEqual({ name: '柳关' })
    expect(m.places).toContainEqual({ name: '南市', parent: '柳关' })
  })

  it('★ 已经有了就不重复加（并集语义）', () => {
    const old = mk({ places: [{ name: '柳关' }, { name: '南市', parent: '柳关' }] })
    const m = ensurePlace(old, '柳关·南市')
    expect(m.places).toHaveLength(2)
  })

  it('地点为空时原样返回（不往树里塞空名字）', () => {
    const old = mk({ places: [{ name: '柳关' }] })
    expect(ensurePlace(old, '')).toBe(old)
    expect(ensurePlace(old, '   ')).toBe(old)
  })

  it('partial 写入路径也要生效 —— patchMemory 是唯一入口', () => {
    // 这条测的是"补地点发生在 store 层"，所以只验证 ensurePlace 与 mergeMemory 的组合语义
    const merged = ensurePlace(mergeMemory(emptyMemory(), { bonds: [{ who: '老周', state: '欠钱' }] }), '南市')
    expect(merged.places).toEqual([{ name: '南市' }])
    expect(merged.bonds).toHaveLength(1)
  })
})

describe('预算 · 丢的顺序是「越物的越先丢，越人的越后丢」', () => {
  it('★ 超预算时，时间线与地点先被丢掉，人物关系留到最后', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      turn: i + 1, text: `第${i + 1}轮的某件足够长的事情描述，用来把预算撑满`.repeat(2),
    }))
    const m = mk({
      bonds: [{ who: '老周', state: '欠他一枚铜钱未还' }],
      affinity: [{ who: '老周', inner: '近', outer: '疏' }],
      places: Array.from({ length: 12 }, (_, i) => ({ name: `地点${i}` })),
      timeline: many,
    })
    const text = renderMemoryForPrompt(m)
    expect(text.length).toBeLessThan(MEMORY_BUDGET * 2)
    // 关系与好感最不该丢
    expect(text).toContain('老周')
  })
})

/**
 * 前情摘要的预算（2026-11）。
 *
 * ## 这组测试守的是一个真实事故
 *
 * 玩家报：「本轮近十万 tok 才出 1 千多 tok」。
 *
 * 溯源到三个地方同时没有闸门：
 *  1. 摘要提示词写的是「在旧摘要基础上**累加**」——模型听到的是"扩写"；
 *  2. `updateSummary` 是 `set({ summary })`，一个字的截断都没有；
 *  3. 摘要**每一轮整份**塞进提示词。
 *
 * 于是每 6 轮它就长一截，一百轮之后是几万字，一轮输入被它一个人撑爆。
 * 而 `EARLIER_SUMMARY_LIMIT`（200 字）只约束了折进 `earlierSummary` 的那一小撮。
 */
describe('clipSummary：前情摘要必须封顶', () => {
  const LONG = Array.from({ length: 400 }, (_, i) =>
    `第${i + 1}轮，他在城里办了一件事，牵连到三四个人，最后留下一个没解的扣子。`,
  ).join('')

  it('没超上限就原样返回（不做任何改写）', () => {
    const short = '他离开雾都，坐船往北，船上遇见了那个戴铜戒指的人。'
    expect(clipSummary(short)).toBe(short)
  })

  it('★ 超上限时长度必须压到上限以内', () => {
    expect(LONG.length).toBeGreaterThan(SUMMARY_LIMIT * 2)
    const out = clipSummary(LONG)
    expect(out.length).toBeLessThanOrEqual(SUMMARY_LIMIT)
  })

  it('★ 保头保尾：开头来路与最近处境都在，中段有记号', () => {
    const out = clipSummary(LONG)
    expect(out.startsWith('第1轮')).toBe(true)
    expect(out).toContain('中段已经压缩')
    // 末尾应该是原文末尾那几句，而不是被切断的中间
    expect(out.trimEnd().endsWith('扣子。')).toBe(true)
  })

  it('刚好等于上限时不动它（边界不许误伤）', () => {
    const exact = '字'.repeat(SUMMARY_LIMIT)
    expect(clipSummary(exact)).toBe(exact)
  })

  it('空串 / 纯空白 ⇒ 空串', () => {
    expect(clipSummary('')).toBe('')
    expect(clipSummary('   \n  ')).toBe('')
  })

  it('可以传入更小的上限（测试与将来的"快速模式"都用得上）', () => {
    const out = clipSummary(LONG, 500)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toContain('中段已经压缩')
  })

  it('摘要预算要显著小于它该压住的正文量，否则等于没封顶', () => {
    // 一轮 1800 字。上限应当只值几轮的体量，而不是几十轮
    expect(SUMMARY_LIMIT).toBeLessThanOrEqual(1800 * 3)
    expect(SUMMARY_LIMIT).toBeGreaterThan(1800)
  })
})

