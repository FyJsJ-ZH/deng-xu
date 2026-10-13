import { describe, it, expect, beforeEach } from 'vitest'

/**
 * 开局流程的数据保全测试。
 *
 * 守的是这个项目里最隐蔽的一个 bug（查了四轮才见底）：
 *
 *   SessionSetup.handleLaunch 依次写入
 *     initFromWorld / setPlayerProfile / setAspects / setResources
 *     / addItem / addCharacter / setTime / setLocation
 *   然后调 onLaunch()，而 StartScreen.handleLaunch 里执行了 resetGame()，
 *   `set({ ...INITIAL_STATE })` 把整个 gameStore 清空 —— 上面写的一切全部作废。
 *
 * 症状是「主角叫未命名」「预设属性与物品没了」「关系栏没有 NPC，
 * 所以点不出全身立绘」—— 三个看似无关的问题，同一个根因。
 *
 * 这个测试把两个 store 的真实行为串起来，确保：
 *   1. resetGame 确实会清空（这是它的职责，不能被改成不清）；
 *   2. **清空必须发生在写入之前**，否则数据丢失。
 */
import { useGameStore } from '@/stores/game'
import type { AttributeDef, ResourceDef, ItemTemplate } from '@/types/cards'

const ATTRS: AttributeDef[] = [
  { id: 'force', name: '武力', description: '', color: '#f00' },
  { id: 'insight', name: '智识', description: '', color: '#00f' },
]
const RES: ResourceDef[] = [
  { id: 'health', name: '生命', description: '', color: '#f00', initial: 5, max: 10 },
]
const ITEM: ItemTemplate = {
  id: 'tuning_fork', name: '歪掉的音叉', description: '旧物', tags: [],
}

const fakeWorld = {
  id: 'w1', title: '测试世界',
  attributes: ATTRS, resources: RES, items: [ITEM],
  backgrounds: [], characters: [], enableMechanics: true,
} as any

beforeEach(() => {
  useGameStore.getState().resetGame()
})

describe('resetGame 的职责', () => {
  it('会清空玩家档案、数值、物品与角色', () => {
    const g = useGameStore.getState()
    g.initFromWorld(fakeWorld)
    g.setPlayerProfile('测试者', '女', '外貌', undefined)
    g.setAspects({ force: 3 })
    g.setResources({ health: 8 })
    g.addItem({ ...ITEM })
    g.addCharacter({ id: 'c1', name: '某人', description: '', relationship: '', status: '' })

    useGameStore.getState().resetGame()

    const after = useGameStore.getState()
    expect(after.playerName, 'resetGame 应清空 playerName').toBe('')
    expect(after.inventory, 'resetGame 应清空 inventory').toHaveLength(0)
    expect(after.characters, 'resetGame 应清空 characters').toHaveLength(0)
    expect(Object.values(after.aspects || {}).every(v => !v)).toBe(true)
  })
})

describe('正确的开局顺序：先清空，再写入', () => {
  it('先 resetGame 再写入 → 数据全部保留（这是修好后的顺序）', () => {
    // 模拟 beginSetup：进入选角时先清
    useGameStore.getState().resetGame()

    // 模拟 SessionSetup.handleLaunch：写入本局数据
    const g = useGameStore.getState()
    g.initFromWorld(fakeWorld)
    g.setPlayerProfile('预设测试者', '女', '左手戴皮手套', undefined)
    g.setAspects({ force: 3, insight: 1 })
    g.setResources({ health: 6 })
    g.addItem({ ...ITEM })
    g.addCharacter({ id: 'npc1', name: '薇拉', description: '测试', relationship: '同行', status: '正常' })
    g.setLocation('灰港')

    // 模拟 StartScreen.handleLaunch：只 startGame，不再 reset
    useGameStore.getState().startGame()

    const after = useGameStore.getState()
    expect(after.isGameStarted).toBe(true)
    expect(after.playerName).toBe('预设测试者')
    expect(after.aspects).toEqual({ force: 3, insight: 1 })
    expect(after.resources.health).toBe(6)
    expect(after.inventory.map(i => i.name)).toEqual(['歪掉的音叉'])
    expect(after.characters.map(c => c.name)).toEqual(['薇拉'])
    expect(after.location).toBe('灰港')
    expect(after.attributeDefs.map(d => d.id)).toEqual(['force', 'insight'])
  })

  it('反例：写入之后再 resetGame → 数据全丢（修复前的顺序）', () => {
    const g = useGameStore.getState()
    g.initFromWorld(fakeWorld)
    g.setPlayerProfile('预设测试者', '女', '', undefined)
    g.addItem({ ...ITEM })
    g.addCharacter({ id: 'npc1', name: '薇拉', description: '', relationship: '', status: '' })

    // 这就是 bug：写入之后才清
    useGameStore.getState().resetGame()
    useGameStore.getState().startGame()

    const after = useGameStore.getState()
    expect(after.playerName, '这条断言描述的是 bug 现象，不是期望行为').toBe('')
    expect(after.inventory).toHaveLength(0)
    expect(after.characters).toHaveLength(0)
    // 属性定义回退到默认值 —— 这正是"预设数值没带进游戏"的现象
    expect(after.attributeDefs.map(d => d.id)).not.toEqual(['force', 'insight'])
  })
})

describe('initFromWorld 的语义', () => {  it('装载世界的属性/资源定义，并清空上一局的数值', () => {
    useGameStore.getState().setAspects({ force: 9 })
    useGameStore.getState().initFromWorld(fakeWorld)
    const after = useGameStore.getState()
    expect(after.attributeDefs.map(d => d.id)).toEqual(['force', 'insight'])
    expect(after.resourceDefs.map(d => d.id)).toEqual(['health'])
    // 数值应被重置为世界的初始状态，而不是留着上一局的
    expect(after.aspects.force ?? 0).toBe(0)
    expect(after.resources.health).toBe(5)
  })

  it('**不**碰玩家档案（所以它可以和 setPlayerProfile 并存）', () => {
    useGameStore.getState().setPlayerProfile('先设的名字', '女', '', undefined)
    useGameStore.getState().initFromWorld(fakeWorld)
    expect(useGameStore.getState().playerName).toBe('先设的名字')
  })

  it('**不**碰物品与角色（那是 resetGame 的职责）', () => {
    useGameStore.getState().addItem({ ...ITEM })
    useGameStore.getState().initFromWorld(fakeWorld)
    expect(useGameStore.getState().inventory).toHaveLength(1)
  })
})

describe('addItem 的去重语义', () => {
  it('同 id 覆盖而不是堆重复条目', () => {
    const g = useGameStore.getState()
    g.addItem({ ...ITEM, name: '第一版' })
    g.addItem({ ...ITEM, name: '第二版' })
    const inv = useGameStore.getState().inventory
    expect(inv).toHaveLength(1)
    expect(inv[0].name).toBe('第二版')
  })
})

/**
 * B5：世界状态与世界卡分离。
 *
 * `attributeDefs` / `resourceDefs` 原先只在**开局那一刻**由 `initFromWorld()` 拷一份，
 * 之后是**冻结的快照** —— 玩家在卡片编辑器里给世界加了一个属性，
 * 正在进行的这一局看不到它，必须重开一局才生效。
 *
 * `syncWorldDefs` 就是那条"卡改了，把定义追上来"的通道。
 * 它与 `initFromWorld` 的关键差别：**只补不改，绝不重置玩家的数值**。
 */
describe('syncWorldDefs · 世界卡改了要跟上，但不能动进度', () => {
  it('★ 世界卡新增的属性会追进来，值为 0', () => {
    useGameStore.getState().initFromWorld(fakeWorld)
    useGameStore.getState().setAspects({ force: 7 })

    const grown = {
      ...fakeWorld,
      attributes: [...fakeWorld.attributes, { id: 'luck', name: '运气', description: '' }],
    }
    useGameStore.getState().syncWorldDefs(grown as any)

    const after = useGameStore.getState()
    expect(after.attributeDefs.map(d => d.id)).toEqual(['force', 'insight', 'luck'])
    expect(after.aspects.luck).toBe(0)
  })

  it('★ 已有的数值一个都不动（那是玩家的进度，不是定义）', () => {
    useGameStore.getState().initFromWorld(fakeWorld)
    useGameStore.getState().setAspects({ force: 7, insight: 2 })
    useGameStore.getState().modifyResource('health', -2)

    useGameStore.getState().syncWorldDefs(fakeWorld as any)

    const after = useGameStore.getState()
    expect(after.aspects.force).toBe(7)
    expect(after.aspects.insight).toBe(2)
    expect(after.resources.health).toBe(3)   // 5 - 2，没有被重置回 5
  })

  it('新增的资源补初始值，已有的保持当前值', () => {
    useGameStore.getState().initFromWorld(fakeWorld)
    useGameStore.getState().modifyResource('health', -1)

    const grown = {
      ...fakeWorld,
      resources: [...fakeWorld.resources, { id: 'sanity', name: '理智', initial: 4 }],
    }
    useGameStore.getState().syncWorldDefs(grown as any)

    const after = useGameStore.getState()
    expect(after.resources.sanity).toBe(4)
    expect(after.resources.health).toBe(4)   // 仍是 5-1
  })

  it('世界卡删掉的属性：定义里不再有，但数值留着（万一又加回来，进度还在）', () => {
    useGameStore.getState().initFromWorld(fakeWorld)
    useGameStore.getState().setAspects({ force: 5, insight: 3 })

    const shrunk = { ...fakeWorld, attributes: [fakeWorld.attributes[0]] }
    useGameStore.getState().syncWorldDefs(shrunk as any)

    const after = useGameStore.getState()
    expect(after.attributeDefs.map(d => d.id)).toEqual(['force'])
    expect(after.aspects.insight, '孤儿值留着，渲染按 defs 走所以不会露出来').toBe(3)
  })

  it('世界卡没定义属性时退回兜底体系（不能让界面空掉）', () => {
    useGameStore.getState().initFromWorld(fakeWorld)
    useGameStore.getState().syncWorldDefs({ ...fakeWorld, attributes: [], resources: [] } as any)
    expect(useGameStore.getState().attributeDefs.length).toBeGreaterThan(0)
    expect(useGameStore.getState().resourceDefs.length).toBeGreaterThan(0)
  })
})
