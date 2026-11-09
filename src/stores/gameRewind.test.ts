import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 回溯（B8）的状态回滚测试
 *
 * ## 为什么值得单独钉死
 *
 * 回溯是**唯一**会让存档"往回走"的功能，出错的表现有几种，全都很难查：
 *
 *  1. **回滚不干净**：数值回到了第 3 轮，但关系/记忆还停在第 9 轮 ——
 *     玩家看到的是"故事退回去了，可人人都还记得那件没发生过的事"。
 *  2. **回滚过头**：把世界卡定义（属性/资源体系）也一起回滚，
 *     玩家的自定义世界直接散架。
 *  3. **快照跟着未来一起变**：快照只存了引用时，回溯等于"回到现在"。
 *  4. **回溯后存档不自洽**：快照的轮次超过历史轮次，导入/导出时炸掉。
 *
 * 这里把 1~3 钉在引擎层（store），4 钉在 saveFile 的修补函数上。
 */

/**
 * Node 环境没有 localStorage（vitest 的 environment 是 'node'）。
 * `stores/game.ts` 用 persist + createJSONStorage，导入时就会读一次存储 ——
 * 所以必须在 import 之前铺好内存版实现，否则导入即崩。
 */
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
})

const { useGameStore, countTurns, MAX_TURN_SNAPSHOTS, replayHistory, isOpeningSnapshot } = await import('@/stores/game')
const { reconcileGameState } = await import('@/utils/saveFile')

type G = ReturnType<typeof useGameStore.getState>
const S = (): G => useGameStore.getState()

/** 把 store 恢复成干净的开局态（INITIAL_STATE 里有默认的兜底数值体系） */
function freshGame() {
  S().resetGame()
  S().startGame()
}

/** 模拟"一轮完整走完"：加一条叙事 → 改数值/摘要/记忆 → 拍快照 */
function playTurn(
  turn: number,
  opts: { bond?: string; resDelta?: number; item?: string; summary?: string } = {},
) {
  S().addHistory({ role: 'user', content: `第${turn}轮的行动`, timestamp: turn })
  S().addHistory({ role: 'assistant', content: `第${turn}轮的叙事`, timestamp: turn })
  if (opts.resDelta) S().modifyResource('health', opts.resDelta)
  if (opts.item) {
    S().addItem({ id: opts.item, name: opts.item, description: '', tags: [] })
  }
  if (opts.summary) S().updateSummary(opts.summary)
  if (opts.bond) {
    S().patchMemory({ bonds: [{ who: opts.bond, state: `第${turn}轮的关系` }] })
  }
  S().patchMemory({ timeline: [{ turn, text: `第${turn}轮发生了什么` }] })
  // 第二个参数是"这一轮玩家输入的行动"，回溯下拉要靠它（见下面的 describe）
  S().pushTurnSnapshot(turn, `第${turn}轮的行动`)
}

beforeEach(() => {
  mem.clear()
  freshGame()
})

describe('回溯 · 每一轮要记得住「玩家当时干了什么」', () => {
  /*
    这条是为**界面**存的，不是为模型存的。

    `history` 里其实只有两种消息：assistant（叙事）与 system（状态变更）——
    玩家的输入从来没有落进历史，它只出现在发给模型的 messages 里。
    于是回溯下拉原先只有「第 3 轮结束时」这种编号，而玩家面对一串编号
    完全想不起来当时做过什么，也就无从判断该退回哪一轮。

    存进快照而不是补进 history 是刻意的：history 每轮都要整段发给模型，
    往里加消息等于每轮多花 token；快照只服务于回溯界面。
  */
  it('★ 快照里存下这一轮玩家输入的行动原文', () => {
    playTurn(1)
    playTurn(2)
    expect(S().turnSnapshots.find(s => s.turn === 2)?.playerAction).toBe('第2轮的行动')
  })

  it('没传行动时不写空串（开局那一轮本来就没有玩家输入）', () => {
    S().pushTurnSnapshot(1)
    expect(S().turnSnapshots[0].playerAction).toBeUndefined()
  })

  it('只写了空白也不写进去（免得下拉里多一个空条目）', () => {
    S().pushTurnSnapshot(1, '   ')
    expect(S().turnSnapshots[0].playerAction).toBeUndefined()
  })

  it('回溯之后那一轮的行动仍然在（界面要靠它说明"你要退掉的是哪一轮"）', () => {
    playTurn(1)
    playTurn(2)
    playTurn(3)
    expect(S().rewindTo(1)).toBe(true)
    expect(S().turnSnapshots.find(s => s.turn === 1)?.playerAction).toBe('第1轮的行动')
    expect(S().turnSnapshots.some(s => s.turn === 3)).toBe(false)
  })
})

describe('回溯 · 只回滚玩家能感知的那几项', () => {
  it('★ history 回到第 N 轮结束时（第 N+1 轮的叙事必须消失）', () => {
    playTurn(1)
    playTurn(2)
    playTurn(3)
    expect(countTurns(S().history)).toBe(3)

    expect(S().rewindTo(2)).toBe(true)
    expect(countTurns(S().history)).toBe(2)
    expect(S().history.some(h => h.content.includes('第3轮'))).toBe(false)
    expect(S().history.some(h => h.content.includes('第2轮'))).toBe(true)
    /*
      增量快照是**重放**出来的，必须逐条对齐 —— 顺序错、少一条、多一条，
      玩家看到的就是一段错位的历史（而他不会知道那是回滚造成的）。
    */
    expect(S().history.map(h => h.content)).toEqual([
      '第1轮的行动', '第1轮的叙事',
      '第2轮的行动', '第2轮的叙事',
    ])
  })

  it('★ 三层记忆一起回滚（否则会出现"人人还记得没发生过的事"）', () => {
    playTurn(1, { bond: '裴无咎' })
    playTurn(2, { bond: '柳三娘' })
    playTurn(3, { bond: '陈九' })
    expect(S().memory.bonds.map(b => b.who)).toContain('陈九')

    S().rewindTo(2)
    const names = S().memory.bonds.map(b => b.who)
    expect(names).toContain('柳三娘')
    expect(names).not.toContain('陈九')
    expect(S().memory.timeline.map(b => b.turn)).toEqual([1, 2])
  })

  it('★ 数值与物品一起回滚', () => {
    const start = S().resources.health
    playTurn(1, { resDelta: -1, item: '缺角的铜火漆' })
    playTurn(2, { resDelta: -1, item: '旧账本' })
    expect(S().resources.health).toBe(start - 2)

    S().rewindTo(1)
    expect(S().resources.health).toBe(start - 1)
    expect(S().inventory.map(i => i.id)).toEqual(['缺角的铜火漆'])
  })

  it('★ 世界卡定义的数值体系**不**回滚（回滚过头会把自定义世界弄散架）', () => {
    const defs = [
      { id: 'health', name: '生命', description: '', color: '#f00', initial: 5, max: 10 },
    ]
    useGameStore.setState({ resourceDefs: defs as any, attributeDefs: [] })
    playTurn(1)
    playTurn(2)
    S().rewindTo(1)
    expect(S().resourceDefs).toEqual(defs)
  })

  it('摘要与时间线一并回滚到那一轮的样子', () => {
    playTurn(1, { summary: '第1轮的摘要' })
    playTurn(2, { summary: '第2轮的摘要' })
    playTurn(3, { summary: '第3轮的摘要' })
    expect(S().summary).toBe('第3轮的摘要')

    S().rewindTo(2)
    expect(S().summary).toBe('第2轮的摘要')
  })

  it('回溯会丢掉"被取消的未来"的快照（不能退回去再跳到未来）', () => {
    playTurn(1)
    playTurn(2)
    playTurn(3)
    S().rewindTo(2)
    // turn 0（开局）不在"被取消的未来"里 —— 它永远留着
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0, 1, 2])
    expect(S().rewindTo(3)).toBe(false)
  })

  it('没有该轮快照时返回 false 且**什么都不改**（绝不猜一个近似状态）', () => {
    playTurn(1)
    const before = JSON.stringify({ h: S().history, m: S().memory, r: S().resources })
    expect(S().rewindTo(9)).toBe(false)
    // 早已被裁掉、或压根不存在的轮次（负数是脏数据）也回不去
    expect(S().rewindTo(-1)).toBe(false)
    expect(JSON.stringify({ h: S().history, m: S().memory, r: S().resources })).toBe(before)
  })

  it('回溯后清掉"上一轮快照"，避免"重新生成"把状态还原到回滚之后', () => {
    playTurn(1)
    S().saveSnapshot()
    playTurn(2)
    S().rewindTo(1)
    expect(S().lastStateSnapshot).toBeNull()
  })
})

/**
 * 回到开局（turn 0）。
 *
 * ## 为什么这个锚点必须存在
 *
 * 玩家报：「现在的『回到上几轮』不能用于回到游戏开局重新生成开局，
 * 如果要用一样的配置重开一局很麻烦」。
 *
 * 病根很直接：快照是在每轮**结束**时拍的，第一幕没有"结束前"这个时刻，
 * 于是开场不满意就只能退回标题、重选世界、重配主角、重分配属性点。
 *
 * 现在 `startGame()` 在 isGameStarted 变 true 的那一刻拍一份 turn 0 ——
 * 那时 SessionSetup 已经把世界卡、主角、背景、属性点、开局物品、在场角色
 * 全部写完了，所以这份快照就是"第一幕生成之前的完整现场"。
 *
 * 三件事必须成立：有这份快照、玩多少轮都不被裁、还原后历史清空。
 */
describe('回到开局（turn 0 锚点）', () => {
  it('★ 开局就会留下 turn 0 快照', () => {
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0])
    expect(S().turnSnapshots[0].historyDelta).toEqual([])
    expect(S().turnSnapshots[0].historyLength).toBe(0)
  })

  it('★ 玩了几轮之后 rewindTo(0)：历史清空、数值回到开局时的样子', () => {
    /*
      ⚠️ 顺序要跟真实流程一致：SessionSetup 是**先**把主角/角色/物品写进 store，
      **最后**才 onLaunch → startGame（那时才拍 turn 0）。
      所以这里也先加角色、再重拍一次开局快照。
    */
    S().addCharacter({ id: 'pei', name: '裴无咎', description: '', relationship: '陌生人', status: '正常' })
    S().resetGame()
    S().addCharacter({ id: 'pei', name: '裴无咎', description: '', relationship: '陌生人', status: '正常' })
    S().startGame()

    const atStart = JSON.parse(JSON.stringify(S().resources))

    playTurn(1, { item: '一枚铜钱', summary: '第1轮的摘要' })
    playTurn(2)
    S().modifyResource('health', -3)
    expect(S().resources.health).not.toBe(atStart.health)
    expect(countTurns(S().history)).toBe(2)

    expect(S().rewindTo(0)).toBe(true)
    expect(S().history).toHaveLength(0)
    expect(S().summary).toBe('')
    expect(S().resources).toEqual(atStart)
    // 开局就在场的人也还在（它在开局快照里，不是被清掉的东西）
    expect(S().characters.map(c => c.id)).toEqual(['pei'])
    // 快照链只剩开局那一个锚点
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0])
  })

  it('★ 玩满上限之后仍能回到开局（turn 0 不参与裁剪）', () => {
    for (let t = 1; t <= MAX_TURN_SNAPSHOTS + 5; t++) playTurn(t)
    expect(S().turnSnapshots.some(s => s.turn === 0)).toBe(true)
    expect(S().rewindTo(0)).toBe(true)
    expect(S().history).toHaveLength(0)
  })

  it('回到开局之后还能继续正常回溯（链从 0 重建）', () => {
    playTurn(1)
    playTurn(2)
    S().rewindTo(0)
    playTurn(1)
    expect(S().rewindTo(1)).toBe(true)
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0, 1])
  })

  it('开局快照不会被"外部截短历史"的启发式误清（它是历史的合法起点）', () => {
    playTurn(1)
    playTurn(2)
    // 模拟手动清史：历史被截短，旧快照描述的历史已不存在
    useGameStore.setState({ history: [] })
    playTurn(1)
    // 链从 0 重建：开局锚点仍在
    expect(S().turnSnapshots[0].turn).toBe(0)
  })
})

/**
 * 续玩存档（`resumeGame`）· 载入存档**不许动快照链**
 *
 * ## 玩家报的正是这里
 *
 * 「载入存档后只能选回到开局了，之前都能载入后重新回到前面的地方，
 * 而回到开局也不是真回到开局，重新生成第一幕不是我想要的」
 *
 * 两个病根，同一个源头：从标题页点「继续」走的是 `startGame()`，而它
 * 会把 `turnSnapshots` 整个换成 `[turn 0]`：
 *
 *  1. 第 1~9 轮的快照全没了 —— 回退下拉里只剩「回到开局」；
 *  2. 那份 turn 0 还是用**中局状态**拍的（`historyLength` = 当时的条数），
 *     于是"回到开局"还原出 30 条历史，接下来的"第一幕"接在第 9 轮后面写。
 *
 * 现在续玩走 `resumeGame()`（只置 `isGameStarted`），并且 turn 0 的
 * `historyLength` 一律写死 0、过 `isOpeningSnapshot` 校验。
 */
describe('续玩存档（resumeGame）', () => {
  it('★ 续玩不重拍快照：整条轮次链原样保留，中间轮次照样回得去', () => {
    playTurn(1)
    playTurn(2)
    playTurn(3)
    const before = S().turnSnapshots.map(s => s.turn)

    S().returnToTitle()
    S().resumeGame()

    expect(S().turnSnapshots.map(s => s.turn)).toEqual(before)
    // 真正要保证的是这件事：载入之后还能退到中间某一轮
    expect(S().rewindTo(2)).toBe(true)
    expect(countTurns(S().history)).toBe(2)
  })

  it('★ 守卫：进行中的局被误调 startGame，轮次链不许被抹掉', () => {
    playTurn(1)
    playTurn(2)
    // 模拟"某个入口又把续玩写成了开局"——这道守卫必须挡住，
    // 代价只是这次没拍锚点，而不是整条回溯链消失
    S().startGame()
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0, 1, 2])
    expect(S().rewindTo(1)).toBe(true)
    expect(countTurns(S().history)).toBe(1)
  })

  it('★ 新开局拍的锚点 historyLength 恒为 0（不跟着当时的实际长度走）', () => {
    // 造一份"历史非空、但确实是新开局"的状态：resetGame 之后又塞进一段
    S().resetGame()
    S().addHistory({ role: 'assistant', content: '开局前的残留' })
    S().startGame()

    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0])
    /*
      ⚠️ 跟着实际长度走（写成 `state.history.length`）的话，这份"开局快照"
      还原出来是 1 条历史的状态，界面还管它叫「回到开局」——
      那正是玩家说的"不是真回到开局，重新生成第一幕不是我想要的"。
    */
    expect(S().turnSnapshots[0].historyLength).toBe(0)
    expect(isOpeningSnapshot(S().turnSnapshots[0])).toBe(true)
    // 还原之后历史必须是空的
    expect(S().rewindTo(0)).toBe(true)
    expect(S().history).toHaveLength(0)
  })

  it('★ 假开局锚点被挡住：不能拿中局历史冒充"回到开局"', () => {
    playTurn(1)
    playTurn(2)
    // 旧实现留下的那种快照：turn 0，但 historyLength 是当时的真实条数
    const fake = { ...S().turnSnapshots[0], historyLength: S().history.length }
    useGameStore.setState({
      turnSnapshots: [fake as any, ...S().turnSnapshots.filter(s => s.turn > 0)],
    })

    expect(isOpeningSnapshot(fake as any)).toBe(false)
    // 判失败，而不是拿一段中局历史冒充开局
    expect(S().rewindTo(0)).toBe(false)
    // 轮次回溯不受牵连
    expect(S().rewindTo(2)).toBe(true)
  })
})

describe('快照 · 深度隔离与上限', () => {  it('★ 快照不是引用：之后的 UPDATE_CHARACTER 不能改到它', () => {
    S().addCharacter({
      id: 'pei', name: '裴无咎', description: '', relationship: '欠他人情', status: '正常',
    })
    playTurn(1)
    S().updateCharacter('pei', { relationship: '已经结仇' })
    expect(S().characters[0].relationship).toBe('已经结仇')

    S().rewindTo(1)
    expect(S().characters[0].relationship).toBe('欠他人情')
  })

  it(`最多保留 ${MAX_TURN_SNAPSHOTS} 轮快照（localStorage 配额要有界）`, () => {
    for (let t = 1; t <= MAX_TURN_SNAPSHOTS + 3; t++) playTurn(t)
    const turns = S().turnSnapshots.map(s => s.turn)
    expect(turns).toHaveLength(MAX_TURN_SNAPSHOTS)
    /*
      ⚠️ 首位是 **0**（开局快照），不是 4 —— 它不占"最近 N 轮"的名额，
      而是常驻。从第 5 轮起才是被窗口保住的轮次。
    */
    expect(turns[0]).toBe(0)
    expect(turns[1]).toBe(5)
    // 超出的最旧几轮**回不去**了 —— 这是设计取舍，接口必须如实返回 false
    expect(S().rewindTo(1)).toBe(false)
    // 而保留窗口里的轮次仍然能正确回滚（增量重放不因裁掉旧快照而失效）
    expect(S().rewindTo(MAX_TURN_SNAPSHOTS + 3)).toBe(true)
    expect(countTurns(S().history)).toBe(MAX_TURN_SNAPSHOTS + 3)
    expect(S().history[S().history.length - 1].content).toContain(`第${MAX_TURN_SNAPSHOTS + 3}轮`)
  })

  it('★ 增量快照的占用与"消息总数"同量级，而不是 O(轮数²)', () => {
    for (let t = 1; t <= 40; t++) playTurn(t)
    const bytes = JSON.stringify(S().turnSnapshots).length
    // 40 轮 × 每轮 2 条 → 所有快照的 historyDelta 加起来只有 80 条。
    // 若每轮存完整历史，这里是 1640 条（约 20 倍），几十轮就会撑爆 localStorage。
    const deltas = S().turnSnapshots.reduce((n, s) => n + s.historyDelta.length, 0)
    expect(deltas).toBe(80)
    expect(bytes).toBeLessThan(200 * 1024)
  })

  it('重置一局会清空快照（否则新局能回到上一局）', () => {
    playTurn(1)
    S().resetGame()
    expect(S().turnSnapshots).toHaveLength(0)
  })

  it('★ 快照链断了就拒绝回滚，而不是拿错位的历史冒充过去', () => {
    playTurn(1)
    playTurn(2)
    playTurn(3)
    /*
      人为制造"断链"：让第 2 轮那份快照声称的长度比实际多一条
      （模拟失败的一轮没拍快照、历史被外部改动过等）。
      它之后就再也拼不出对齐的历史了 —— 宁可回不去，
      也不能让玩家退回一个**别人的**时刻。

      ⚠️ 这里**必须**用 map 建新对象再改，不能写成
      `broken[1] = { ...broken[1], historyLength: broken[1].historyLength + 1 }` ——
      JS 先求值右侧的 `broken[1]` 再赋值，拿到的是同一个对象，
      "加一"写回去的正是它自己原来的值（这个写法我踩过一次，测试反而绿了）。
    */
    const broken = S().turnSnapshots.map(s =>
      s.turn === 2 ? { ...s, historyLength: s.historyLength + 1 } : { ...s },
    )
    useGameStore.setState({ turnSnapshots: broken as any })

    // 第 2 轮要走链式重放（它不是最新那一轮），元数据脏了就必须拒绝
    expect(replayHistory(S().turnSnapshots, 2, S().history)).toBeNull()
    expect(S().rewindTo(2)).toBe(false)
    // 状态一丝不动
    expect(countTurns(S().history)).toBe(3)

    /*
      而**最新一轮**仍然回得去 —— 它走的是"截断当前历史"那条路径，
      读的是此刻真实的历史，不依赖快照记录的元数据。
      这正好是玩家最常用的那次回溯（"刚刚那轮不算，重来"），
      不该因为一份更早的快照被弄脏而失效。
    */
    expect(S().rewindTo(3)).toBe(true)
    expect(countTurns(S().history)).toBe(3)
  })

  it('历史被外部截短后，旧快照整条链被丢弃（不会拿已不存在的历史去重放）', () => {
    playTurn(1)
    playTurn(2)
    // 模拟一次"外部清史"（导入存档、旧版归档等都可能造成）：历史只剩最近一条
    useGameStore.setState({ history: S().history.slice(-1) })
    playTurn(3)
    playTurn(4)

    // 旧链（第 1、2 轮）描述的历史已经不存在了，重放会整体错位 —— 必须被丢掉
    // （**开局锚点除外**：它描述的是"第一幕之前"，和后来的历史没有依赖关系）
    expect(S().turnSnapshots.map(s => s.turn)).toEqual([0, 3, 4])
    expect(S().rewindTo(1)).toBe(false)
    expect(S().rewindTo(3)).toBe(true)
    expect(S().history.map(h => h.content)).toEqual(['第2轮的叙事', '第3轮的行动', '第3轮的叙事'])
  })

  it('clearHistory 连记忆与快照一起清（换了世界卡就不该再记得上一局）', () => {
    playTurn(1, { bond: '裴无咎' })
    S().clearHistory()
    expect(S().history).toHaveLength(0)
    expect(S().memory.bonds).toHaveLength(0)
    expect(S().turnSnapshots).toHaveLength(0)
  })
})

describe('存档兼容 · 回滚后的状态必须能被保存与导入', () => {
  it('★ 快照轮次超过历史轮次时被裁掉（"指向未来"的快照是坏数据）', () => {
    const state = {
      history: [
        { role: 'user', content: 'a' }, { role: 'assistant', content: 'A' },
        { role: 'user', content: 'b' }, { role: 'assistant', content: 'B' },
      ],
      // 这份存档来自"回滚之前"，所以快照比历史长
      turnSnapshots: [{ turn: 1 }, { turn: 2 }, { turn: 3 }, { turn: 4 }],
      memory: {
        bonds: [{ who: '裴无咎', state: '欠他人情' }],
        threads: [{ id: 't', text: '未结的线索' }],
        timeline: [{ turn: 1, text: '一' }, { turn: 2, text: '二' }, { turn: 5, text: '指向未来' }],
      },
    }
    const r = reconcileGameState(state)
    expect(r.turnSnapshots.map((s: any) => s.turn)).toEqual([1, 2])
    expect(r.memory.timeline.map((b: any) => b.turn)).toEqual([1, 2])
    // 关系与线索不属于"时间线"，必须原样保留 —— 它们没有指向未来的问题
    expect(r.memory.bonds).toHaveLength(1)
    expect(r.memory.threads).toHaveLength(1)
  })

  it('旧存档（没有 memory / turnSnapshots 字段）不会被判为损坏，且字段被补成合法值', () => {
    const r = reconcileGameState({ history: [{ role: 'assistant', content: 'A' }] })
    expect(r.turnSnapshots).toEqual([])
    // ⚠️ 必须补上而不是留 undefined：UI 会直接 .map() 这个字段，
    // 导入旧存档后崩在渲染层是最难归因的一类失败
    expect(r.memory).toEqual({ bonds: [], threads: [], timeline: [], earlierSummary: '', updatedAtTurn: 0 })
    expect(r.sessionUsage).toMatchObject({ promptTokens: 0, totalTokens: 0 })
    expect(r.history).toHaveLength(1)
  })

  it('★ 合法的开局锚点（turn 0 · historyLength 0）能穿过读档过滤', () => {
    /*
      原先这里一刀切 `s.turn > 0`，把每一份存档的「回到开局」都过滤掉了 ——
      而 turn 0 的语义是"第一幕生成之前"，跟历史有几轮毫无关系。
    */
    const r = reconcileGameState({
      history: [{ role: 'assistant', content: 'A' }],
      turnSnapshots: [
        { turn: 0, historyLength: 0, historyDelta: [] },
        { turn: 1, historyLength: 1, historyDelta: [{ role: 'assistant', content: 'A' }] },
      ],
    })
    expect(r.turnSnapshots.map((s: any) => s.turn)).toEqual([0, 1])
  })

  it('★ 假开局锚点（historyLength > 0）在读档时被丢掉', () => {
    const r = reconcileGameState({
      history: [{ role: 'assistant', content: 'A' }],
      turnSnapshots: [
        { turn: 0, historyLength: 1, historyDelta: [{ role: 'assistant', content: 'A' }] },
      ],
    })
    expect(r.turnSnapshots).toEqual([])
  })

  it('非对象输入原样返回（存档里可能是 null 或字符串）', () => {
    expect(reconcileGameState(null)).toBeNull()
    expect(reconcileGameState('nope')).toBe('nope')
  })
})

describe('成本统计（C9）· 累加与清零', () => {
  it('recordUsage 同时累加到 lastUsage 与 sessionUsage', () => {
    S().clearLastUsage()
    S().recordUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120, estimated: false })
    S().recordUsage({ promptTokens: 50, completionTokens: 10, totalTokens: 60, estimated: true })
    expect(S().lastUsage).toMatchObject({ promptTokens: 150, completionTokens: 30, totalTokens: 180 })
    expect(S().sessionUsage).toMatchObject({ promptTokens: 150, completionTokens: 30 })
    // 只要有一次是估算，整体就必须标明是估算（不能让玩家把估算当账单）
    expect(S().sessionUsage.estimated).toBe(true)
  })

  it('清零累计不会污染全局零值常量', () => {
    S().recordUsage({ promptTokens: 10, completionTokens: 1, totalTokens: 11, estimated: false })
    S().resetSessionUsage()
    expect(S().sessionUsage.totalTokens).toBe(0)
    // 再记一次：如果零值常量被共享修改过，这里会算出错误的基准
    S().recordUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10, estimated: false })
    expect(S().sessionUsage.totalTokens).toBe(10)
  })
})
