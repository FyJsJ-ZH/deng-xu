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
import { isSillyTavernPreset, fromSillyTavernPreset, describePreset } from './stPreset'

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

describe('预算：超了要如实说，不能悄悄吃', () => {
  it('★ 超长条目被丢，名字写在段末（玩家得知道少了什么）', () => {
    const huge = { identifier: 'big', name: '超长规则说明', content: '很'.repeat(4000) }
    const raw = preset([huge, { identifier: 'r', name: '规则', content: '不许抢话' }])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.rules).toContain('不许抢话')
    expect(w.rules).not.toContain('很'.repeat(500))
    expect(w.rules).toContain('超长规则说明')   // 名字留在提示里
    expect(w.rules).toContain('未并入')
  })

  it('丢的是**最长**的，短规则留下（短的往往是硬规矩）', () => {
    // 两条都在规则桶里才比得出"按长度丢"——名字带「规则」，别让它们掉进 worldLore
    const long = { identifier: 'l', name: '长规则条目', content: '甲'.repeat(3000) }
    const short = { identifier: 's', name: '短规则', content: '乙'.repeat(50) }
    const raw = preset([long, short])
    const w = fromSillyTavernPreset(raw, 't.json')!
    expect(w.rules).toContain('乙'.repeat(50))
    expect(w.rules).not.toContain('甲'.repeat(500))
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
