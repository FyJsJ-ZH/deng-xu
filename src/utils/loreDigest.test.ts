import { describe, it, expect } from 'vitest'
import { digestLore, renderLoreDigest, splitLore } from '@/utils/loreDigest'

/**
 * 世界书摘要器的**三个漏勺**（2026-11）。
 *
 * 玩家报：「我用的世界书和主角卡、预设加起来应该也没有十万输入，
 * 更何况还只有一千多输出」。他给的那张网关截图上是 `输入 163.4 KB`。
 *
 * 世界书摘要器本来是"按需注入"的守门人，但它有三个口子完全不设防：
 *
 *  1. **总纲**（第一个 `**标题**` 之前的内容）原样全量返回。
 *     ST 世界书转来的 lore 往往**没有** `**标题**` 分章 —— 那样整本书都是总纲，
 *     摘要器等于没起作用。
 *  2. **前两章**（`alwaysInclude`）绕过预算直接塞。
 *     头两章各五千字就是一万，比整个预算还大。
 *  3. **落选章节的索引**有多少列多少。上千条的世界书能把提示词撑成一张目录。
 *
 * 这一组就钉这三条。
 */

const cjk = (s: string) => (s.match(/[\u4e00-\u9fff]/g) || []).length

describe('世界书摘要 · 篇幅上限', () => {
  it('★ 没有 `**标题**` 的世界书：切成伪章节按需挑，而不是整本当总纲', () => {
    // 模拟 ST 世界书转来的纯文本 lore：四万字，一个标题都没有，但分了很多段
    const lore = Array.from({ length: 60 }, (_, i) =>
      `第 ${i} 段的设定正文，讲的是这座城的某个角落。`).join('\n\n')
    expect(splitLore(lore).filter(s => s.title)).toHaveLength(0)

    const d = digestLore(lore, { context: '他走进酒馆', nouns: [] })
    // 不再是一坨常驻总纲
    expect(d.preamble).toBe('')
    // 而是若干伪章节，且总量受预算约束
    const picked = d.picked.reduce((n, c) => n + cjk(c.body), 0)
    expect(picked).toBeLessThanOrEqual(9000)
    expect(d.restTotal).toBeGreaterThan(0)
  })

  it('★ 真有一段总纲且写得极长 → 截到 1500 字并写明', () => {
    const lore = '这座城的街道总是很安静。'.repeat(300) + '\n\n**第一章**\n\n正文。'
    const d = digestLore(lore, { context: '他走进酒馆', nouns: [] })
    expect(cjk(d.preamble)).toBeLessThanOrEqual(1600)
    expect(d.preamble).toContain('已按篇幅截断')
  })

  it('总纲短的时候原样保留（不该为了限长加一句废话）', () => {
    const lore = '**第一章**\n\n正文。'
    const d = digestLore(lore, { context: '', nouns: [] })
    expect(d.preamble).toBe('')
  })

  it('★ 上千章：索引最多列 60 条，并告诉模型还有多少没列', () => {
    const lore = Array.from({ length: 300 }, (_, i) => `**第${i}节**\n\n这是第 ${i} 节。`).join('\n\n')
    const d = digestLore(lore, { context: '一个专名都没提到的句子', nouns: [] })
    expect(d.rest.length).toBeLessThanOrEqual(60)
    expect(d.restTotal).toBeGreaterThan(200)
    const text = renderLoreDigest(d, '测试世界')
    expect(text).toContain('未列出')
  })

  it('★ 前两章不能独吞预算（`alwaysInclude` 也要有上限）', () => {
    const huge = '很长的一章内容。'.repeat(1200)   // ≈ 9600 汉字
    const lore = [
      `**第一章**\n\n${huge}`,
      `**第二章**\n\n${huge}`,
      '**第三章**\n\n他到了汴梁，城门口有人在卖胡饼。',
    ].join('\n\n')
    const d = digestLore(lore, { context: '他走到城门口', nouns: [], budget: 4000 })
    const picked = d.picked.reduce((n, c) => n + cjk(c.body), 0)
    expect(picked).toBeLessThanOrEqual(4000)
    // 命中的那一章仍然进得来 —— 压的是"无条件的巨无霸"，不是"该给的内容"
    expect(d.picked.some(c => c.title === '第三章')).toBe(true)
  })

  it('预算按段落算，命中段的邻段也会补进来（但总数不超）', () => {
    const lore = [
      '**城池**\n\n汴梁的城墙很厚。',
      '**漕运**\n\n漕渠从西门进来，粮船昼夜不停。',
      '**物价**\n\n一斗米要三十文。',
    ].join('\n\n')
    const d = digestLore(lore, { context: '他去汴梁看粮船', nouns: [], budget: 1000, alwaysInclude: 0 })
    expect(d.picked.length).toBeGreaterThan(0)
    expect(d.picked.reduce((n, c) => n + cjk(c.body), 0)).toBeLessThanOrEqual(1000)
  })
})
