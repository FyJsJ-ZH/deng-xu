import { describe, it, expect } from 'vitest'
import { digestLore, renderLoreDigest, splitLore } from '@/utils/loreDigest'

/**
 * 世界书按需注入（`loreDigest`）的测试。
 *
 * ## 这里防的是哪一类错
 *
 * 本功能的目标是"把这一轮真用得上的章节摆到模型眼前，而不是把五万字整份塞过去"。
 * 它有两种**反方向**的坏法：
 *
 *  1. **挑得太少 / 永远挑同样的几节** —— 体积是省了，但"按需"名存实亡：
 *     玩家在边镇从军，看到的还是汴梁的坊市那一节。
 *     这正是我第一版的真实错误：只拿 `collectWorldProperNouns` 的产物当检索键，
 *     而那份清单里**几乎不含地名**（`worldLore` 正文里的「汴梁」不加引号），
 *     于是任何情境都命中不了，每次都只返回 `alwaysInclude` 的那两节。
 *
 *  2. **挑得太多** —— 预算形同虚设，又退化成整份注入。
 *
 * 所以下面两条最关键：**不同情境必须挑出不同的章节**，以及**预算真的卡得住**。
 */

const LORE = [
  '这是世界的总纲。三百年来的纪年与基本法则，常驻不删。',
  '',
  '**第一章 舆图与疆域：两京十三道**',
  '天下分十三道，首都是汴梁。北边有云中镇与雁门，常年驻军。米价一石六百文。',
  '',
  '**第二章 军制：禁军与边军**',
  '云中镇的边军按粮与刀算，雁门是其前沿。都头、指挥使层层节制，军报要十五日。',
  '',
  '**第三章 市井与物价**',
  '汴梁的州桥夜市到三更才散。一碗汤饼八文，一处两间门面的宅子月租一贯。',
  '',
  '**第四章 海商与季风**',
  '南洋的季风一年两至，商船候风而行，与内陆的驿路毫无关系。',
].join('\n')

describe('splitLore · 按章节标题切分', () => {
  it('第一个标题之前的内容是总纲（title 为空串）', () => {
    const s = splitLore(LORE)
    expect(s[0].title).toBe('')
    expect(s[0].body).toContain('总纲')
    expect(s).toHaveLength(5)
  })

  it('只认**行首独占一行**的 `**标题**`', () => {
    const lore = [
      '开头。',
      '**第一章 真的标题**',
      '正文，这里有一句行内**加粗**不该被当成标题。',
    ].join('\n')
    const s = splitLore(lore)
    expect(s.map(x => x.title)).toEqual(['', '第一章 真的标题'])
    // 行内加粗留在正文里
    expect(s[1].body).toContain('行内**加粗**')
  })

  it('没有章节时，整篇就是总纲', () => {
    const s = splitLore('一段没有分章的世界观。')
    expect(s).toHaveLength(1)
    expect(s[0].title).toBe('')
  })

  it('空字符串返回空数组', () => {
    expect(splitLore('')).toEqual([])
  })
})

describe('digestLore · 按情境挑章节', () => {
  it('★ 不同情境挑出**不同**的章节（这是"按需"的全部意义）', () => {
    const city = digestLore(LORE, {
      context: '我在汴梁的州桥打听汤饼的价钱',
      nouns: [],
    })
    const front = digestLore(LORE, {
      context: '我在云中镇当差，去雁门送一封军报',
      nouns: [],
    })
    const cityTitles = city.picked.map(s => s.title).join('|')
    const frontTitles = front.picked.map(s => s.title).join('|')
    expect(cityTitles).not.toBe(frontTitles)

    // 汴梁那一轮要能挑到讲物价/市井与舆图的那两节
    expect(cityTitles).toContain('市井与物价')
    // 云中镇那一轮要能挑到军制
    expect(frontTitles).toContain('军制')
  })

  it('命中了哪些检索键要如实报出来（排查"为什么没挑中"全靠它）', () => {
    const d = digestLore(LORE, { context: '云中镇', nouns: [] })
    expect(d.hits).toContain('云中镇')
  })

  it('★ 预算真的卡得住（否则又退化成整份注入）', () => {
    // 每节正文约 40 汉字，给 80 的预算 ⇒ 除强制节外放不下几节
    const d = digestLore(LORE, { context: '汴梁 云中镇 雁门 汤饼 季风', nouns: [], budget: 80, alwaysInclude: 1 })
    const pickedCjk = d.picked.reduce((n, s) => n + (s.body.match(/[\u4e00-\u9fff]/g) || []).length, 0)
    expect(pickedCjk).toBeLessThan(400)   // 只比预算大出强制节那一份
  })

  it('靠前的章节无条件保留（它们通常是舆图与势力这类底子）', () => {
    const d = digestLore(LORE, { context: '完全无关的一句话', nouns: [], alwaysInclude: 2 })
    expect(d.picked.map(s => s.title)).toContain('第一章 舆图与疆域：两京十三道')
    expect(d.picked.map(s => s.title)).toContain('第二章 军制：禁军与边军')
  })

  it('一个专名都没命中时也有保底（不能让模型手里完全没有世界）', () => {
    const d = digestLore(LORE, { context: '与这个世界毫无关系的一句话', nouns: [] })
    expect(d.picked.length).toBeGreaterThan(0)
  })

  it('外部专名（角色名 / 物品名）同样能命中', () => {
    const d = digestLore(LORE, { context: '我问裴无咎军报的事', nouns: ['军报'] })
    expect(d.picked.map(s => s.title)).toContain('第二章 军制：禁军与边军')
  })

  it('落选的章节全部进索引，一个都不能丢', () => {
    const d = digestLore(LORE, { context: '汴梁', nouns: [] })
    const picked = new Set(d.picked.map(s => s.title))
    const allTitles = splitLore(LORE).filter(s => s.title).map(s => s.title)
    const restTitles = d.rest.map(r => r.title)
    expect([...picked, ...restTitles].sort()).toEqual(allTitles.sort())
  })

  it('展开的章节保持**原文顺序**（读起来与世界书结构一致）', () => {
    const d = digestLore(LORE, { context: '汴梁 云中镇 雁门 汤饼 季风', nouns: [] })
    const idx = d.picked.map(s => splitLore(LORE).indexOf(s))
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('空世界书不崩', () => {
    const d = digestLore('', { context: '随便', nouns: [] })
    expect(d.picked).toEqual([])
    expect(d.preamble).toBe('')
  })
})

describe('renderLoreDigest · 渲染成提示词', () => {
  it('含总纲、展开章节、以及**落选章节的索引**', () => {
    const d = digestLore(LORE, { context: '汴梁', nouns: [] })
    const text = renderLoreDigest(d, '测试世界')
    expect(text).toContain('总纲')
    expect(text).toContain('市井与物价')
    expect(text).toContain('世界书的其他章节')
  })

  it('★ 必须写明"落选章节不要凭空断言"', () => {
    /*
      少了这句，模型会把这个**残缺的**世界书当成全部：
      玩家问起没展开的侧面时，它要么说"这里没有"，
      要么现编一个与那一节冲突的答案 —— 两者都比"多注入几千字"更糟。
    */
    const d = digestLore(LORE, { context: '汴梁', nouns: [] })
    const text = renderLoreDigest(d, '测试世界')
    expect(text).toContain('不要凭空断言')
  })

  it('落选章节的提要非空（有提要模型才知道那一节大概讲什么）', () => {
    const d = digestLore(LORE, { context: '汴梁', nouns: [] })
    for (const r of d.rest) expect(r.gist.length).toBeGreaterThan(0)
  })
})
