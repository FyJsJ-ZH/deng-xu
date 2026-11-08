import { describe, it, expect } from 'vitest'
import { coercePlayer, extractPresetList, PRESET_FORMAT, PRESET_VERSION } from '@/utils/heroPresetFile'

/**
 * 主角预设文件的解析。
 *
 * ## 这条测试守的是什么
 *
 * 2026-11 做《古夜》那张主角卡时发现：导入路径**只读七个文本字段**，
 * `look`（立绘部件）与 `avatar`（头像）被静默丢弃。
 *
 * 这在界面上看不出任何异常 —— 卡导进来了，名字、性格、背景都在，
 * 只是立绘变了个样子。而 `PlayerCard.look` 的注释写着
 * 「主角的立绘**必须**走这条路」，因为拿自由文本去猜部件命中率很低，
 * 「我自己设的主角画得不像」是最伤代入感的一件事。
 *
 * 所以这里把「导出 → 导入」的字段口径钉死。
 */
describe('coercePlayer：读得回来哪些字段', () => {
  const look = {
    head: 'heads_human_male',
    hair: 'hair_long_straight',
    hairColor: 'black',
    torso: 'torso_clothes_robe',
    note: '玄色直裰，黑长发',
  }

  it('★ 卡包形状（{ label, player }）能解', () => {
    const p = coercePlayer({
      label: '冥主·古夜',
      player: {
        name: '古夜',
        gender: '男',
        age: '不得而知',
        appearance: '玄色直裰',
        personality: '温和，内里阴狠',
        background: '玄楔教',
        extra: '苗刀·黑伤',
        look,
      },
    })
    expect(p).not.toBeNull()
    expect(p!.name).toBe('古夜')
    expect(p!.gender).toBe('男')
    expect(p!.appearance).toBe('玄色直裰')
    expect(p!.personality).toBe('温和，内里阴狠')
    expect(p!.background).toBe('玄楔教')
    expect(p!.extra).toBe('苗刀·黑伤')
  })

  it('★ look 与 avatar 都要带过来（这是补的那一条）', () => {
    const p = coercePlayer({ name: '古夜', look, avatar: 'data:image/png;base64,AAA' })
    expect(p!.look).toEqual(look)
    expect(p!.avatar).toBe('data:image/png;base64,AAA')
  })

  it('裸 PlayerCard（没有 player 包装）也能解', () => {
    const p = coercePlayer({ name: '古夜', extra: '苗刀' })
    expect(p!.name).toBe('古夜')
    expect(p!.extra).toBe('苗刀')
  })

  it('look 不是对象时忽略，不写进卡里', () => {
    const p = coercePlayer({ name: '古夜', look: '黑长发' })
    expect(p!.look).toBeUndefined()
  })

  it('look 是数组时也忽略（数组不是合法的外观对象）', () => {
    const p = coercePlayer({ name: '古夜', look: ['black'] })
    expect(p!.look).toBeUndefined()
  })

  it('七个字段全空 ⇒ null（不是主角档案）', () => {
    expect(coercePlayer({})).toBeNull()
    expect(coercePlayer({ label: '空壳' })).toBeNull()
    expect(coercePlayer(null)).toBeNull()
    expect(coercePlayer('古夜')).toBeNull()
  })

  it('只有 look、文本全空时按空壳处理（没有名字的主角落不了库）', () => {
    // 现状如此：判空只看七个文本字段。这里把它钉住，免得哪天改成"有 look 也算"，
    // 让一堆没名字的记录混进列表。
    expect(coercePlayer({ look })).toBeNull()
  })
})

describe('extractPresetList：文件形状', () => {
  it('卡包取 presets 数组', () => {
    expect(extractPresetList({ presets: [{ label: 'A' }] })).toHaveLength(1)
  })

  it('裸数组原样返回', () => {
    expect(extractPresetList([{ label: 'A' }, { label: 'B' }])).toHaveLength(2)
  })

  it('什么都没有时返回空数组（调用方据此报「文件里没有主角列表」）', () => {
    expect(extractPresetList(null)).toEqual([])
    expect(extractPresetList({})).toEqual([])
    expect(extractPresetList({ presets: 'nope' })).toEqual([])
  })
})

describe('格式常量', () => {
  it('与文件里写的一致，改了就要考虑旧文件怎么读', () => {
    expect(PRESET_FORMAT).toBe('deng-xu-hero-presets')
    expect(PRESET_VERSION).toBe(1)
  })
})
