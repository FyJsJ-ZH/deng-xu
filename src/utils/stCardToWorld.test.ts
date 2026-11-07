/**
 * ST「重设定卡」→ 完整灯叙世界卡。
 *
 * ## 这组测试钉的是**能不能真的开一局**
 *
 * 只转 `worldLore` 的时候，卡是能导入的 —— 但没有角色、没有属性、没有出身，
 * 玩家进去看到的是一本设定集。而原作者其实把这一切都写在 `[initvar]` 里了。
 *
 * 所以这里钉四件事：
 *  1. **停用的 `[initvar]` 必须读**（它在 ST 里是关着的，但它是数据不是正文）；
 *  2. 资源条从 `X` / `X上限` 成对里来，上限写 0 也要建（原卡初始值就是 0）；
 *  3. 角色描述必须**精简**（每轮全量注入，五千字一个角色会把上下文爆掉）；
 *  4. 宏引用条目（`{{人物:温照雪}}`）不能变成角色卡的名字。
 */
import { describe, it, expect } from 'vitest'
import { parseSimpleYaml, stCardToWorld } from './stCardToWorld'

describe('parseSimpleYaml', () => {
  it('嵌套 + 数字 + 行内对象', () => {
    const y = parseSimpleYaml([
      '主角:',
      '  境界: 炼气期',
      '  修为: 0',
      '重要人物:',
      '  沈清辞:',
      '    称号: 太虚剑宗首席',
      '    _属性: { 力道: 65, 体魄: 60 }',
    ].join('\n'))

    const hero = y['主角'] as Record<string, unknown>
    expect(hero['境界']).toBe('炼气期')
    expect(hero['修为']).toBe(0)

    const people = y['重要人物'] as Record<string, Record<string, unknown>>
    expect(Object.keys(people)).toEqual(['沈清辞'])
    expect(people['沈清辞']['称号']).toBe('太虚剑宗首席')
    expect(people['沈清辞']['_属性']).toEqual({ 力道: 65, 体魄: 60 })
  })

  it('数组项', () => {
    const y = parseSimpleYaml('外貌:\n  - 粗布道袍\n  - 白发木簪')
    expect(y['外貌']).toEqual(['粗布道袍', '白发木簪'])
  })

  it('`|-` 多行块', () => {
    const y = parseSimpleYaml([
      '神契描述: |-',
      '  能够激化他人的欲望。',
      '  神识+5',
      '下一个: 值',
    ].join('\n'))
    expect(String(y['神契描述'])).toContain('神识+5')
    expect(String(y['神契描述'])).toContain('激化他人的欲望')
    expect(y['下一个']).toBe('值')
  })

  it('坏数据不抛异常（导入路径不能因为一行写歪就崩）', () => {
    expect(() => parseSimpleYaml('::::\n- - -\n')).not.toThrow()
    expect(parseSimpleYaml('')).toEqual({})
  })
})

/** 造一张最小可用的 ST 卡 */
function mkCard(entries: unknown[]) {
  return {
    spec: 'chara_card_v3',
    data: {
      name: '测试卡',
      character_book: { name: '测试世界', entries },
    },
  }
}

describe('stCardToWorld', () => {
  const initvar = [
    '主角:',
    '  境界: 炼气期·前期',
    '  修为: 0',
    '  修为上限: 0',
    '  气血: 0',
    '  气血上限: 0',
    '  灵石: 0',
    '  灵根: 火',
    '重要人物:',
    '  沈清辞:',
    '    称号: 太虚剑宗首席',
    '    境界: 化神期·前期',
    '    势力: 太虚剑宗',
    '    关系: 中立',
    '    描述: 冰冷的剑道奇才。',
    '    _属性: { 力道: 65, 体魄: 60, 身法: 80, 灵力: 85, 神识: 75, 根骨: 70 }',
  ].join('\n')

  it('★ 停用的 [initvar] 照样读 —— 它是数据，不是正文', () => {
    const r = stCardToWorld(mkCard([
      { name: '[initvar]变量初始化', content: initvar, enabled: false },
      { name: '势力_太虚剑宗', content: '正道第一剑宗。' },
    ]))!
    expect(r.world.characters.length).toBe(1)
    expect(r.world.characters[0].name).toBe('沈清辞')
  })

  it('★ 资源从「X / X上限」成对来，上限 0 也要建条', () => {
    const r = stCardToWorld(mkCard([{ name: '[initvar]变量初始化', content: initvar }]))!
    const names = r.world.resources.map(x => x.name)
    expect(names).toContain('修为')
    expect(names).toContain('气血')
    // 只有键、不成对的（灵根/境界）不是资源
    expect(names).not.toContain('灵根')
    expect(names).not.toContain('境界')
  })

  it('六维属性从人物的 _属性 里反推', () => {
    const r = stCardToWorld(mkCard([{ name: '[initvar]变量初始化', content: initvar }]))!
    expect(r.world.attributes.map(a => a.name)).toEqual(['力道', '体魄', '身法', '灵力', '神识', '根骨'])
  })

  it('★ 角色描述必须精简（每轮全量注入，不是设定集）', () => {
    const long = '这是一段极长的描述。'.repeat(100)
    const r = stCardToWorld(mkCard([{
      name: '[initvar]变量初始化',
      content: initvar.replace('描述: 冰冷的剑道奇才。', `描述: ${long}`),
    }]))!
    expect(r.world.characters[0].description.length).toBeLessThanOrEqual(300)
  })

  it('人物卡的境界/关系/所在地落到对应字段', () => {
    const r = stCardToWorld(mkCard([{ name: '[initvar]变量初始化', content: initvar }]))!
    const c = r.world.characters[0]
    expect(c.status).toBe('化神期·前期')
    expect(c.relationship).toBe('中立')
  })

  it('★ 宏引用条目不当角色（`{{人物:温照雪}}` 是索引，不是档案）', () => {
    const r = stCardToWorld(mkCard([
      { name: '[initvar]变量初始化', content: initvar },
      { name: '人物_温照雪', content: '{{人物:温照雪}}' },
    ]))!
    const names = r.world.characters.map(c => c.name)
    expect(names).not.toContain('温照雪')
  })

  it('★ 半结构化角色条目：剥掉 <npc_x> 标签再取基本信息', () => {
    const r = stCardToWorld(mkCard([{
      name: '角色_周景贤',
      content: [
        '<npc_周景贤>',
        '角色档案:',
        '  基本信息:',
        '    姓名: 周景贤',
        '    称号: 清虚散人',
        '    身份: 武当派三代掌门',
        '    外貌:',
        '      - 洗得发白的粗布道袍。',
        '  武学信息:',
        '    内功:',
        '      - 太极神功 (绝学)',
      ].join('\n'),
    }]))!
    const c = r.world.characters[0]
    expect(c.name).toBe('周景贤')
    expect(c.description).toContain('清虚散人')
    expect(c.description).toContain('太极神功')
    // 标签行不能出现在任何字段里
    expect(c.description).not.toContain('<npc_')
  })

  it('★ 角色全文同时进 worldLore（角色卡只有三百字，细节得能被检索）', () => {
    const r = stCardToWorld(mkCard([{
      name: '角色_周景贤',
      content: '<npc_周景贤>\n角色档案:\n  基本信息:\n    称号: 清虚散人',
    }]))!
    expect(r.world.worldLore).toContain('周景贤')
    expect(r.world.worldLore).toContain('清虚散人')
  })

  it('出身槽位从势力来，且去重', () => {
    const r = stCardToWorld(mkCard([
      { name: '势力_武当派', content: 'a' },
      { name: '宗门_武当派', content: 'b' },
      { name: '势力_少林派', content: 'c' },
    ]))!
    const titles = r.world.backgrounds[0].options.map(o => o.title)
    expect(titles).toEqual(['武当派', '少林派'])
  })

  it('没有变量表时给默认六维，且机制层是开的', () => {
    const r = stCardToWorld(mkCard([{ name: '势力_武当派', content: 'a' }]))!
    expect(r.world.attributes.length).toBe(6)
    expect(r.world.enableMechanics).toBe(true)
  })

  it('没有任何条目 → null（UI 据此报"没有可转换的内容"）', () => {
    expect(stCardToWorld(mkCard([]))).toBeNull()
    expect(stCardToWorld(null)).toBeNull()
  })
})
