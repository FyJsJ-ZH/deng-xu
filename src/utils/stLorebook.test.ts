import { describe, it, expect } from 'vitest'
import { fromSillyTavernLorebook, isSillyTavernLorebook, toSillyTavernLorebook } from '@/utils/stLorebook'
import type { WorldCard } from '@/types/cards'

/**
 * SillyTavern 世界书互转的回归测试。
 *
 * 守两件事：
 *
 * 1. **双向都要通**。曾经只有本作自己的 `{ format: 'deng-xu-worldbook' }` 能读，
 *    于是把本作世界书交给 ST 侧工具只会得到 `world file has no usable entries`，
 *    而 ST 生态里成千上万本世界书一本也进不来。这里把两种 ST 形状
 *    （数组 / 数字键 map / 角色卡内嵌 character_book）都钉住。
 *
 * 2. ⚠️ **"keys 在本作不生效"这件事必须留在数据里**。
 *    本作的 lore 是全量注入的，没有关键词触发。导入时如果把 keys 丢掉，
 *    作者会以为触发配置生效了；如果把它当成触发条件去过滤条目，
 *    那就等于悄悄丢内容。所以断言：keys 变成正文里的「触发词：…」一行，
 *    **而不会**变成任何"触发配置"字段。
 */

const ST_ARRAY = {
  name: '汴京风物志',
  description: '一本关于旧都的设定集。\n第二行说明不该进标题。',
  entries: [
    {
      keys: ['汴梁', '汴京', '东京'],
      content: '旧都是三层城墙套着的一座城，外城住商贾，内城住官署。',
      comment: '旧都城',
      enabled: true,
    },
    {
      key: '漕运',
      content: '漕粮经水路进城，码头在城北，冬季水浅要等开春。',
      comment: '漕运',
    },
    {
      keys: ['已停用'],
      content: '这条在 ST 里是关掉的，导入时不该生效。',
      comment: '停用条目',
      disable: true,
    },
  ],
}

describe('isSillyTavernLorebook 的识别', () => {
  it('认数组形状的 entries', () => {
    expect(isSillyTavernLorebook(ST_ARRAY)).toBe(true)
  })

  it('认数字键 map 形状的 entries（ST 自己的导出文件长这样）', () => {
    const asMap = {
      entries: {
        '1': { key: ['灯'], content: '灯是相之一。', comment: '灯' },
        '0': { key: ['冬'], content: '冬是相之一。', comment: '冬' },
      },
    }
    expect(isSillyTavernLorebook(asMap)).toBe(true)
  })

  it('认角色卡里内嵌的 character_book（含 V2 卡包装）', () => {
    expect(isSillyTavernLorebook({ character_book: ST_ARRAY })).toBe(true)
    expect(isSillyTavernLorebook({ spec: 'chara_card_v2', data: { character_book: ST_ARRAY } })).toBe(true)
  })

  it('本作自己的世界书不会被当成 ST 世界书（它没有 entries）', () => {
    expect(isSillyTavernLorebook({ format: 'deng-xu-worldbook', version: 1, worlds: [] })).toBe(false)
  })

  it('空 entries、或条目里没有任何内容时不算可用', () => {
    expect(isSillyTavernLorebook({ entries: [] })).toBe(false)
    expect(isSillyTavernLorebook({ entries: [{ keys: [], content: '' }] })).toBe(false)
    expect(isSillyTavernLorebook(null)).toBe(false)
    expect(isSillyTavernLorebook('不是对象')).toBe(false)
  })
})

describe('fromSillyTavernLorebook 的映射', () => {
  const world = fromSillyTavernLorebook(ST_ARRAY)!

  it('条目名取 comment，条目正文取 content', () => {
    expect(world.lores.map(l => l.name)).toEqual(['旧都城', '漕运'])
    expect(world.lores[0].description).toContain('外城住商贾')
  })

  it('★ 触发词写进正文，而不是变成"触发配置"（本作没有关键词触发）', () => {
    expect(world.lores[0].description.startsWith('触发词：汴梁、汴京、东京')).toBe(true)
    // 旧格式的裸串 key 也认
    expect(world.lores[1].description).toContain('触发词：漕运')
    // 关键：lore 对象上不该多出任何 keys / trigger 字段 —— 那会让人以为触发生效了
    expect((world.lores[0] as unknown as Record<string, unknown>).keys).toBeUndefined()
    expect((world.lores[0] as unknown as Record<string, unknown>).triggers).toBeUndefined()
  })

  it('被禁用的条目不会导进来（ST 里它本来就不注入）', () => {
    expect(world.lores.some(l => l.name === '停用条目')).toBe(false)
  })

  it('worldLore 是全部条目的拼接版，条目名成为小标题', () => {
    expect(world.worldLore).toContain('**旧都城**')
    expect(world.worldLore).toContain('**漕运**')
    expect(world.worldLore).toContain('外城住商贾')
    // 2 条可用条目（第 3 条被禁用）→ 段间一个空行
    expect(world.worldLore.split('\n\n')).toHaveLength(2)
  })

  it('书名与描述进 title / tagline', () => {
    expect(world.title).toBe('汴京风物志')
    expect(world.tagline).toBe('一本关于旧都的设定集。 第二行说明不该进标题。')
  })

  it('★ 必填字段全部填齐（照内置世界的形状）', () => {
    expect(world.id).toBeTruthy()
    expect(world.tagline).toBeTruthy()
    expect(Array.isArray(world.attributes)).toBe(true)
    expect(Array.isArray(world.resources)).toBe(true)
    expect(Array.isArray(world.backgrounds)).toBe(true)
    expect(Array.isArray(world.items)).toBe(true)
    expect(Array.isArray(world.story.stages)).toBe(true)
    expect(world.story.atmosphere).toBe('')
    expect(world.story.openingSeeds).toBeUndefined()
    // 2026-10 起默认第三人称（与内置世界卡一致），不再是 second
    expect(world.narrative.pov).toBe('third')
    expect(typeof world.createdAt).toBe('number')
    // ST 世界书没有数值体系，误开机制层会让面板上一片 0
    expect(world.enableMechanics).toBe(false)
  })

  it('没有可用条目时返回 null，而不是抛异常', () => {
    expect(fromSillyTavernLorebook({ entries: [] })).toBeNull()
    expect(fromSillyTavernLorebook({ 随便: 1 })).toBeNull()
    expect(fromSillyTavernLorebook(undefined)).toBeNull()
  })

  it('超大世界书：worldLore 拼接有上限并且写明了省略，但条目一条不少', () => {
    const huge = {
      name: '设定百科',
      entries: Array.from({ length: 80 }, (_, i) => ({
        comment: `条目${i}`,
        keys: [`词${i}`],
        // 每条 4000 字 → 合计远超上限，逼出保护分支
        content: '漕渠的秋水深三尺。'.repeat(500),
      })),
    }
    const w = fromSillyTavernLorebook(huge)!
    expect(w.lores).toHaveLength(80)                       // 内容没丢
    expect(w.worldLore).toContain('未并入这段正文')          // 但明说了有省略
    expect(w.worldLore.length).toBeLessThan(130_000)
  })
})

describe('toSillyTavernLorebook 的反向映射', () => {
  const mkWorld = (over: Partial<WorldCard> = {}): WorldCard => ({
    id: 'w1', title: '测试世界', tagline: '一句话简介',
    worldLore: '', rules: '',
    attributes: [], resources: [], backgrounds: [], attributePoints: 0,
    items: [],
    lores: [
      { id: 'l1', name: '旧都城', description: '触发词：汴梁、汴京\n\n三层城墙套着的一座城。' },
      { id: 'l2', name: '漕运', description: '漕粮经水路进城。' },
    ],
    story: {
      atmosphere: '', mainQuest: '',
      enableStages: false, stages: [], enableChoices: true, urgencyAfterTurns: 0,
    },
    narrative: { pov: 'second', tense: 'present', replyLength: 500, customStyle: '' },
    characters: [], enableMechanics: false,
    createdAt: 0, updatedAt: 0,
    ...over,
  })

  const book = toSillyTavernLorebook(mkWorld()) as {
    name: string
    description: string
    entries: Record<string, unknown>[]
  }

  it('书名与简介反向填回 name / description', () => {
    expect(book.name).toBe('测试世界')
    expect(book.description).toBe('一句话简介')
  })

  it('★ 每条 lore 都是常驻条目（本作 lore 是全量注入，对应 ST 的蓝灯）', () => {
    expect(book.entries).toHaveLength(2)
    expect(book.entries.every(e => e.constant === true)).toBe(true)
    expect(book.entries.every(e => e.disable === false)).toBe(true)
  })

  it('★ 「触发词：…」被还原成 keys，而不是留在正文里', () => {
    expect(book.entries[0].keys).toEqual(['汴梁', '汴京'])
    expect(book.entries[0].key).toEqual(['汴梁', '汴京'])
    expect(String(book.entries[0].content)).toBe('三层城墙套着的一座城。')
    // 没有触发词行的条目退回用条目名当 key
    expect(book.entries[1].keys).toEqual(['漕运'])
  })

  it('同时写 key/keys 与 comment/name：只写一份会在某些读取端变成"没有可用条目"', () => {
    for (const e of book.entries) {
      expect(e.key).toEqual(e.keys)
      expect(e.comment).toBe(e.name)
    }
  })

  it('★ 往返：导出再导入，条目名与正文回到原样', () => {
    const back = fromSillyTavernLorebook(book)!
    expect(back.lores.map(l => l.name)).toEqual(['旧都城', '漕运'])
    expect(back.lores[0].description).toBe('触发词：汴梁、汴京\n\n三层城墙套着的一座城。')
    /*
      第二条原卡里没写触发词行，导出时用条目名补了 keys
      （ST 里没有 key 的条目只能靠 constant 生效），所以导入回来会多一行触发词 ——
      这是**预期内的信息增益**，不是丢数据。文件头已声明往返不保证逐字节还原。
    */
    expect(back.lores[1].description).toBe('触发词：漕运\n\n漕粮经水路进城。')
  })

  it('没有 lores 的世界卡也能导出：按 worldLore 里的 **标题** 分段', () => {
    const bare = mkWorld({
      lores: [],
      worldLore: '**地理**\n黄河改道留下了三条故道。\n\n**势力**\n漕帮与盐商互相制衡。',
    })
    const out = toSillyTavernLorebook(bare) as { entries: { name: string; content: string }[] }
    expect(out.entries.map(e => e.name)).toEqual(['地理', '势力'])
    expect(out.entries[0].content).toContain('黄河改道')
  })

  it('既没有 lores 也没有 worldLore 时导出空条目表，而不是编造条目', () => {
    const empty = mkWorld({ lores: [], worldLore: '' })
    const out = toSillyTavernLorebook(empty) as { entries: unknown[] }
    expect(out.entries).toHaveLength(0)
  })
})
