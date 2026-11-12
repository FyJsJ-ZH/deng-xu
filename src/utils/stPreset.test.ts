/**
 * SillyTavern **提示词预设** → 世界卡。
 *
 * ## 玩家报的事
 *
 * 「我下了两个世界书，发现不兼容」—— 那两个 `.json` 里一条世界设定都没有，
 * 它们是 ST 的 completion preset：`temperature` / `prompts[]` / `prompt_order`。
 * 写的是"**怎么写**"，而本作的"世界书"装的是"**写什么**"。
 *
 * 所以这里钉的不是"格式转换对不对"，而是**转换时会不会吃掉作者的东西**：
 * 停用的条目不能偷偷生效、超预算的要如实报名字、ST 宏要清干净。
 */
import { describe, it, expect } from 'vitest'
import { isSillyTavernPreset, fromSillyTavernPreset, describePreset, stPresetToNarrativePreset } from './stPreset'

const preset = (prompts: unknown[], order?: { identifier: string; enabled: boolean }[]) => ({
  temperature: 1,
  prompts,
  prompt_order: [{ order: order ?? prompts.map(p => ({ identifier: (p as { identifier: string }).identifier, enabled: true })) }],
})

describe('isSillyTavernPreset', () => {
  it('认出预设', () => {
    expect(isSillyTavernPreset(preset([{ identifier: 'a', name: 'A', content: 'x' }]))).toBe(true)
  })

  it('★ 世界书（有 entries）不是预设', () => {
    expect(isSillyTavernPreset({ entries: { 0: { content: 'x' } } })).toBe(false)
  })

  it('角色卡 / 随便一个对象不是预设', () => {
    expect(isSillyTavernPreset({ name: '角色', description: 'x' })).toBe(false)
    expect(isSillyTavernPreset(null)).toBe(false)
    expect(isSillyTavernPreset([])).toBe(false)
  })
})

describe('条目筛选', () => {
  it('★ 停用的条目不进卡（「停用」不能变成「生效」）', () => {
    const raw = preset(
      [
        { identifier: 'on', name: '要用的', content: '规则甲' },
        { identifier: 'off', name: '关掉的', content: '规则乙' },
      ],
      [
        { identifier: 'on', enabled: true },
        { identifier: 'off', enabled: false },
      ],
    )
    const w = fromSillyTavernPreset(raw, 't.json')!
    const all = w.rules + w.worldLore + w.narrative.customStyle
    expect(all).toContain('规则甲')
    expect(all).not.toContain('规则乙')
  })

  it('marker（空 content）被跳过', () => {
    const raw = preset([
      { identifier: 'm', name: '------', content: '', marker: true },
      { identifier: 'a', name: '有用', content: '内容' },
    ])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.worldLore).not.toContain('------')
  })

  it('全是停用 / 空条目 → 返回 null（UI 据此报"没有可转换的内容"）', () => {
    expect(fromSillyTavernPreset(preset([{ identifier: 'a', name: 'A', content: '' }]), 't.json')).toBeNull()
  })
})

describe('ST 宏清洗', () => {
  it('★ {{// 注释 }} 与 {{setvar}} 被删掉（在本作里是纯噪音）', () => {
    const raw = preset([{
      identifier: 'a',
      name: '规则',
      content: '开头\n{{//\n禁止商用，下载后 24h 内删掉\n}}\n中间\n{{setvar::x::\n  一段变量\n}}\n结尾',
    }])
    const w = fromSillyTavernPreset(raw, 't.json')!
    const all = w.rules + w.worldLore + w.narrative.customStyle
    expect(all).toContain('开头')
    expect(all).toContain('结尾')
    expect(all).not.toContain('24h')
    expect(all).not.toContain('setvar')
  })

  it('{{user}} / {{char}} 保留（语义仍成立，卡片开头已注明）', () => {
    const raw = preset([{ identifier: 'a', name: '文风', content: '描写 {{user}} 的动作' }])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.narrative.customStyle).toContain('{{user}}')
  })
})

describe('分类落点', () => {
  it('文风类进 customStyle，规则类进 rules，其余进 worldLore', () => {
    const raw = preset([
      { identifier: 's', name: '👻文风调教', content: '写比喻要克制' },
      { identifier: 'r', name: '👁防全知', content: '角色只知道他知道的事' },
      { identifier: 'w', name: '码头区', content: '下城区靠河，涨潮时淹到第二级台阶' },
    ])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.narrative.customStyle).toContain('写比喻要克制')
    expect(w.rules).toContain('角色只知道他知道的事')
    expect(w.worldLore).toContain('涨潮时淹到第二级台阶')
  })

  it('★ 作者说明（使用必看 / 禁止商用）不进 rules —— 那是给人看的，不是给模型的', () => {
    const raw = preset([
      { identifier: 'm', name: '⚠️使用必看', content: '禁止二创，下载后请删掉' },
      { identifier: 'r', name: '规则', content: '不许替玩家做决定' },
    ])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.rules).not.toContain('禁止二创')
    expect(w.rules).toContain('不许替玩家做决定')
    expect(w.worldLore).toContain('禁止二创')
  })
})

describe('预算：只挡病态数据（2026-11 从 2600 抬到 20000）', () => {
  /*
    玩家原话：「我要预设完完整整的生效」。

    原来的 2600 会让导入时**从最长的条目开始丢**，界面上标「超预算」、
    默认不勾 —— 而正常的酒馆预设本来就有一两万字。现在预算只挡
    "有人塞了一份十万字的东西"，下面这几条用的是**远超阈值**的内容。
  */
  it('★ 真正超长的条目才会被丢，名字写在段末（玩家得知道少了什么）', () => {
    const huge = { identifier: 'big', name: '超长规则说明', content: '很'.repeat(30000) }
    const raw = preset([huge, { identifier: 'r', name: '规则', content: '不许抢话' }])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.rules).toContain('不许抢话')
    expect(w.rules).not.toContain('很'.repeat(500))
    expect(w.rules).toContain('超长规则说明')   // 名字留在提示里
    expect(w.rules).toContain('未并入')
  })

  it('丢的是**最长**的，短规则留下（短的往往是硬规矩）', () => {
    // 两条都在规则桶里才比得出"按长度丢"——名字带「规则」，别让它们掉进 worldLore
    const long = { identifier: 'l', name: '长规则条目', content: '甲'.repeat(25000) }
    const short = { identifier: 's', name: '短规则', content: '乙'.repeat(50) }
    const raw = preset([long, short])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.rules).toContain('乙'.repeat(50))
    expect(w.rules).not.toContain('甲'.repeat(500))
  })

  it('★ 一万字的预设一条都不丢（这才是玩家的常态）', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      identifier: `r${i}`, name: `规则${i}`, content: `${'规'.repeat(1000)}-E${i}-`,
    }))
    const w = fromSillyTavernPreset(preset(entries), 't.json')!
    for (let i = 0; i < 10; i++) expect(w.rules, `第 ${i} 条`).toContain(`-E${i}-`)
    expect(w.rules).not.toContain('未并入')
  })
})

describe('生成的卡是"合法的空世界"', () => {
  const w = fromSillyTavernPreset(preset([{ identifier: 'a', name: '规则', content: 'x' }]), '我的预设.json')!

  it('标题取文件名', () => {
    expect(w.title).toBe('我的预设')
  })

  it('★ 明确标成"规则包，非世界设定"（否则玩家开局看到一片空白，以为导入坏了）', () => {
    expect(w.tagline).toContain('规则包')
    expect(w.worldLore).toContain('不是世界设定')
  })

  it('不开机制层（规则包没有数值体系，开了玩家会看到一片 0）', () => {
    expect(w.enableMechanics).toBe(false)
    expect(w.attributes).toEqual([])
    expect(w.resources).toEqual([])
  })
})

describe('describePreset（导入前先说清会发生什么）', () => {
  it('三类各几条', () => {
    const raw = preset([
      { identifier: 's', name: '文风', content: '要克制' },
      { identifier: 'r', name: '规则', content: '不许抢话' },
      { identifier: 'w', name: '设定', content: '河边的院子' },
    ])
    const d = describePreset(raw)!
    expect(d.total).toBe(3)
    expect(d.style).toBe(1)
    expect(d.rules).toBe(1)
    expect(d.other).toBe(1)
  })

  it('不是预设时返回 null', () => {
    expect(describePreset({ a: 1 })).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════
   2026-11 第二十九轮：玩家给了真文件（「夏瑾 天琴座 Beta 3.9」），暴露三个病
   ══════════════════════════════════════════════════════════════ */

describe('★ 多套方案（prompt_order 是数组）', () => {
  /** 两套方案：一套只有 1 条，一套是作者调好的 3 条 */
  const twoGroups = {
    temperature: 1,
    prompts: [
      { identifier: 'thin', name: '精简方案里的一条', content: '一条' },
      { identifier: 'a', name: '文风甲', content: '写比喻要克制' },
      { identifier: 'b', name: '规则甲', content: '不许抢话' },
      { identifier: 'c', name: '设定甲', content: '河边的院子' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'thin', enabled: true }, { identifier: 'a', enabled: false }] },
      { character_id: 100001, order: [
        { identifier: 'a', enabled: true },
        { identifier: 'b', enabled: true },
        { identifier: 'c', enabled: true },
      ] },
    ],
  }

  it('取「启用且有内容最多」的那一套，而不是死拿 [0]', () => {
    const w = fromSillyTavernPreset(twoGroups, 't.json')!
    const all = w.rules + w.worldLore + w.narrative.customStyle
    expect(all).toContain('写比喻要克制')
    expect(all).toContain('不许抢话')
    // 精简方案里的那条不算数（它属于另一套，作者没在完整方案里勾它）
    expect(all).not.toContain('一条')
  })

  it('describePreset 与真正转换用同一套筛选（数字不会互相矛盾）', () => {
    const d = describePreset(twoGroups)!
    expect(d.total).toBe(3)
    expect(fromSillyTavernPreset(twoGroups, 't.json')!.rules).toContain('不许抢话')
  })
})

describe('★ 不在任何方案里的条目 = 备选，不能收', () => {
  /*
    玩家那份预设里 144 条 prompts，两套方案只覆盖 73 条 —— 剩下 71 条是
    作者堆着备选的（三选一的人称、三选一的冒险度）。老代码当它们全启用，
    于是「保守」「冒险」「特别冒险」一起注进提示词，模型只能在矛盾里瞎猜。
  */
  const raw = {
    temperature: 1,
    prompts: [
      { identifier: 'on', name: '🧭冒险', content: '情节要敢展开' },
      { identifier: 'off1', name: '🧭保守', content: '情节要克制' },
      { identifier: 'off2', name: '🧭特别冒险', content: '情节要爆炸' },
    ],
    prompt_order: [{ order: [{ identifier: 'on', enabled: true }] }],
  }

  it('备选池不进提示词', () => {
    const w = fromSillyTavernPreset(raw, 't.json')!
    const all = w.rules + w.worldLore + w.narrative.customStyle
    expect(all).toContain('情节要敢展开')
    expect(all).not.toContain('情节要克制')
    expect(all).not.toContain('情节要爆炸')
  })

  it('方案表一条有内容的都没有时，退回全部（别交空卡）', () => {
    const fallback = {
      temperature: 1,
      prompts: [{ identifier: 'a', name: '规则', content: '不许抢话' }],
      prompt_order: [{ order: [{ identifier: '空占位', enabled: true }] }],
    }
    const w = fromSillyTavernPreset(fallback, 't.json')!
    expect(w.rules).toContain('不许抢话')
  })
})

describe('★ 变量还原（setvar / getvar）', () => {
  /*
    真预设把最重要的一段藏进变量里：
      🛡️ 变量（别动） = {{setvar::JailbreakPrompt::You are a helpful…}}
      🛡️破限[顶]    = {{trim}}{{getvar::JailbreakPrompt}}
    老代码把两者都删掉 —— 破限串凭空消失，玩家以为导入没生效。
  */
  const raw = {
    temperature: 1,
    prompts: [
      { identifier: 'v', name: '变量（别动）', content: '{{setvar::JB::这是一段被藏起来的正文}}' },
      { identifier: 'j', name: '🛡️破限[顶]', content: '{{trim}}{{getvar::JB}}' },
      { identifier: 'g', name: '规则', content: '不许抢话' },
    ],
    prompt_order: [{ order: [
      { identifier: 'v', enabled: true },
      { identifier: 'j', enabled: true },
      { identifier: 'g', enabled: true },
    ] }],
  }

  it('getvar 换成变量值，setvar 条目本身不留下', () => {
    const w = fromSillyTavernPreset(raw, 't.json')!
    const all = w.rules + w.worldLore + w.narrative.customStyle
    expect(all).toContain('这是一段被藏起来的正文')
    expect(all).not.toContain('setvar')
    expect(all).not.toContain('getvar')
  })

  it('变量名写错时留空，不把 {{getvar::…}} 原样漏进提示词', () => {
    const bad = {
      temperature: 1,
      prompts: [{ identifier: 'a', name: '规则', content: '{{getvar::不存在}}不许抢话' }],
      prompt_order: [{ order: [{ identifier: 'a', enabled: true }] }],
    }
    const w = fromSillyTavernPreset(bad, 't.json')!
    expect(w.rules).toContain('不许抢话')
    expect(w.rules).not.toContain('getvar')
  })
})

describe('★ 拼接骨架（只有标签的条目）', () => {
  const raw = {
    temperature: 1,
    prompts: [
      { identifier: 'a', name: '设定首', content: '<相关资料>\n\n<{{user}}设定>' },
      { identifier: 'b', name: '设定集/前文', content: '</相关资料>\n\n<互动历史>' },
      { identifier: 'c', name: '规则', content: '不许抢话' },
      { identifier: 'd', name: '短标题', content: '【核心指令开始】' },
    ],
    prompt_order: [{ order: [
      { identifier: 'a', enabled: true },
      { identifier: 'b', enabled: true },
      { identifier: 'c', enabled: true },
      { identifier: 'd', enabled: true },
    ] }],
  }

  it('纯标签条目丢掉（否则卡片正文开头是一串 <相关资料>）', () => {
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.worldLore).not.toContain('<相关资料>')
    expect(w.worldLore).not.toContain('<互动历史>')
  })

  it('★ 但六个字的硬规矩不能一起丢（别按长度一刀切）', () => {
    const short = {
      temperature: 1,
      prompts: [{ identifier: 'a', name: '规则', content: '不许抢话' }],
      prompt_order: [{ order: [{ identifier: 'a', enabled: true }] }],
    }
    expect(fromSillyTavernPreset(short, 't.json')!.rules).toContain('不许抢话')
  })
})

describe('stPresetToNarrativePreset（存进预设库而不是世界卡）', () => {
  const raw = {
    temperature: 1,
    prompts: [
      { identifier: 's', name: '✅基础文风', content: '写比喻要克制' },
      { identifier: 'r', name: '✅基础创作准则', content: '不许替玩家做决定' },
      { identifier: 'w', name: '⚠️使用必看', content: '禁止二创，下载后 24h 内删掉' },
    ],
    prompt_order: [{ order: [
      { identifier: 's', enabled: true },
      { identifier: 'r', enabled: true },
      { identifier: 'w', enabled: true },
    ] }],
  }

  it('三段分开落，统计与实际一致', () => {
    const p = stPresetToNarrativePreset(raw, '夏瑾 天琴座 Beta 3.9.json')!
    expect(p.name).toBe('夏瑾 天琴座 Beta 3.9')
    expect(p.style).toContain('写比喻要克制')
    expect(p.rules).toContain('不许替玩家做决定')
    // 作者说明只存档、不进每轮注入
    expect(p.rules).not.toContain('禁止二创')
    expect(p.lore).toContain('禁止二创')
    expect(p.counts.total).toBe(3)
    expect(p.counts.style + p.counts.rules + p.counts.other).toBe(3)
  })

  it('没有可用条目时返回 null', () => {
    expect(stPresetToNarrativePreset(preset([{ identifier: 'a', name: 'A', content: '' }]), 't.json')).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════
   2026-11 第三十七轮：导入时交出逐条清单（供 UI 勾选）
   ══════════════════════════════════════════════════════════════ */

describe('逐条清单 · entries', () => {
  const raw = {
    temperature: 1,
    prompts: [
      { identifier: 's', name: '✅基础文风', content: '写比喻要克制' },
      { identifier: 'r', name: '✅基础创作准则', content: '不许替玩家做决定' },
      { identifier: 'w', name: '⚠️使用必看', content: '禁止二创，下载后 24h 内删掉' },
    ],
    prompt_order: [{ order: [
      { identifier: 's', enabled: true },
      { identifier: 'r', enabled: true },
      { identifier: 'w', enabled: true },
    ] }],
  }

  it('★ 每条都进清单，带落点，默认全勾', () => {
    const p = stPresetToNarrativePreset(raw, 'x.json')!
    expect(p.entries).toHaveLength(3)
    const byId = Object.fromEntries(p.entries!.map(e => [e.id, e]))
    expect(byId.s.kind).toBe('style')
    expect(byId.r.kind).toBe('rules')
    expect(byId.w.kind).toBe('other')
    for (const e of p.entries!) {
      expect(e.enabled, e.id).toBe(true)
      expect(e.dropped, e.id).toBeUndefined()
    }
  })

  it('★ 顺序照酒馆的 prompt_order，不按落点分组重排（2026-11）', () => {
    /*
      上一版这里断言的是 `['rules','style','other']` —— 那是"按语义重排"，
      而玩家看到的正是它的后果：「user → 头部破甲 → 格式要求结束 → 主提示下半
      → 自定义字数 → 文风开始」被拆成三段，他一句"顺序都是错乱的"。
      现在只认文件里的顺序：style / rules / other 按 order 交错也可以。
    */
    const p = stPresetToNarrativePreset(raw, 'x.json')!
    expect(p.entries!.map(e => e.id)).toEqual(['s', 'r', 'w'])
    expect(p.entries!.map(e => e.order)).toEqual([0, 1, 2])
  })

  it('★ 被预算裁掉的条目也留在原位（只是没勾上，不是被搬到组尾）', () => {
    const big = '长'.repeat(25000)
    const raw3 = {
      temperature: 1,
      prompts: [
        { identifier: 'a', name: 'A', content: '短的一条' },
        { identifier: 'b', name: '✅基础文风', content: big },
        { identifier: 'c', name: 'C', content: '另一条短的' },
      ],
      prompt_order: [{ order: [
        { identifier: 'a', enabled: true },
        { identifier: 'b', enabled: true },
        { identifier: 'c', enabled: true },
      ] }],
    }
    const p = stPresetToNarrativePreset(raw3, 'y.json')!
    expect(p.entries!.map(e => e.id)).toEqual(['a', 'b', 'c'])
    const b = p.entries!.find(e => e.id === 'b')!
    expect(b.dropped).toBe(true)
    expect(b.enabled).toBe(false)
    // 原位不动
    expect(b.order).toBe(1)
  })

  it('★ 默认勾选拼出来，与三段快照逐字一致（导入不该改变注入内容）', () => {
    const p = stPresetToNarrativePreset(raw, 'x.json')!
    const on = p.entries!.filter(e => e.enabled && e.kind === 'rules')
    expect(on.map(e => `【${e.name}】\n${e.content}`).join('\n\n')).toBe(p.rules)
  })

  it('★ 超预算而被丢掉的条目也在清单里，标记 dropped 且默认不勾（玩家能自己勾回来）', () => {
    const huge = '文'.repeat(25000)
    const p = stPresetToNarrativePreset(preset([
      { identifier: 'r', name: '✅基础创作准则', content: '不许替玩家做决定' },
      { identifier: 's1', name: '文风甲', content: huge },
    ]), 'x.json')!
    const s1 = p.entries!.find(e => e.id === 's1')!
    expect(s1.enabled).toBe(false)
    expect(s1.dropped).toBe(true)
    // 它不在快照的正体里（默认注入时不出现），但内容一个字没丢
    expect(p.style).not.toContain('文文文')
    expect(s1.content).toHaveLength(25000)
  })

  it('counts.total 数的是"默认勾了几条"，不是"文件里有几条"', () => {
    const huge = '文'.repeat(25000)
    const p = stPresetToNarrativePreset(preset([
      { identifier: 'r', name: '✅基础创作准则', content: '不许替玩家做决定' },
      { identifier: 's1', name: '文风甲', content: huge },
    ]), 'x.json')!
    expect(p.entries).toHaveLength(2)
    expect(p.counts.total).toBe(1)
  })
})
