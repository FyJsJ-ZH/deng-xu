import { describe, it, expect } from 'vitest'
import { NARRATIVE_STYLES, stylesOf, styleById } from './narrativeStyles'

/**
 * 文风库的**数据自洽**。
 *
 * 这些错都不会报错，只会静默失效 ——
 * 冲突 id 写错，玩家永远看不到那条提示；标签没包对，注入的是一段裸文本；
 * id 重复，后一个把前一个顶掉，玩家选了没反应。
 */
describe('文风库 · 数据自洽', () => {
  it('id 唯一', () => {
    const ids = NARRATIVE_STYLES.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('conflicts 指向的 id 都真实存在（写错了会静默失效）', () => {
    const ids = new Set(NARRATIVE_STYLES.map(s => s.id))
    const bad: string[] = []
    for (const s of NARRATIVE_STYLES) {
      for (const c of s.conflicts || []) {
        if (!ids.has(c)) bad.push(`${s.id} → ${c}`)
      }
    }
    expect(bad, `这些 conflicts 指向了不存在的文风：${bad.join('、')}`).toEqual([])
  })

  it('每条文风都有明确的开头标记（XML 标签或 markdown 标题，不能是一段裸文本）', () => {
    // ⚠️ 注意不是所有条目都用 XML 标签：`polish-dialogue` 是 `# 台词准则：` 开头的
    // markdown 标题。所以判据是「有结构标记」，不是「必须是标签」。
    for (const s of NARRATIVE_STYLES) {
      const head = s.text.trim()
      expect(head.startsWith('<') || head.startsWith('#'), `${s.id} 缺少开头标记`).toBe(true)
    }
  })

  it('四组都非空（UI 上有四个页签，空组会显出空页）', () => {
    for (const g of ['core', 'extra', 'base', 'polish'] as const) {
      expect(stylesOf(g).length, `${g} 组是空的`).toBeGreaterThan(0)
    }
  })

  /*
    ── 从原项目《苍白卷宗》搬来的那一档（2026-11）──

    它值得单独钉一条：这一档的存在本身就是玩家的要求
    （「把原作的提示词连同文风装进本项目」），
    哪天被人顺手删掉，单测要说话。
  */
  it('★ 「苍白卷宗」文风在，且在核心组（单选位）', () => {
    const s = styleById('pale-notes')
    expect(s, '找不到 id 为 pale-notes 的文风').toBeTruthy()
    expect(s!.group).toBe('core')
    expect(s!.name).toContain('苍白卷宗')
    // 它的三条骨架，缺一条就不再是那个腔调
    expect(s!.text).toContain('清晰第一，风格第二')
    expect(s!.text).toContain('物理事实优先')
    expect(s!.text).toContain('不升华')
  })
})
