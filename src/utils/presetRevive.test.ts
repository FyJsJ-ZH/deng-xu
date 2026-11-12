import { describe, it, expect } from 'vitest'
import {
  reviveBudgetDroppedEntries, withNarrativePreset, renderPresetEntries, dedupePresetsBySource,
} from '@/utils/narrativePreset'
import type { NarrativePreset, PresetEntry, WorldCard } from '@/types/cards'

/**
 * 旧预算遗留的 `dropped` 条目（2026-11）。
 *
 * 预算从 2600 抬到 20000 之后，**已经躺在库里的那份预设不会自己变**：
 * 当年因为超预算被丢掉的条目仍然是「没勾」的状态，界面上挂着「超预算」角标。
 * 玩家要的是"完完整整的生效"，所以读库时唤醒一次。
 *
 * 关键边界：**玩家自己关掉的条目不许被唤醒** —— 它没有 `dropped` 标记。
 */

const entry = (id: string, patch: Partial<PresetEntry> = {}): PresetEntry => ({
  id, name: `条目${id}`, kind: 'rules', content: `内容${id}`, enabled: true, ...patch,
})

const preset = (entries: PresetEntry[]): NarrativePreset => ({
  id: 'p1', name: '旧预设', source: 'old.json',
  rules: '', style: '', lore: '', entries,
  counts: { total: 0, rules: 0, style: 0, other: 0, dropped: ['条目b'] },
  createdAt: 0, updatedAt: 0,
})

describe('唤醒被预算丢掉的条目', () => {
  it('★ dropped + 未勾 → 勾回来，并清掉角标', () => {
    const { presets, changed } = reviveBudgetDroppedEntries([
      preset([
        entry('a'),
        entry('b', { enabled: false, dropped: true }),
      ]),
    ])
    expect(changed).toBe(true)
    const b = presets[0].entries!.find(e => e.id === 'b')!
    expect(b.enabled).toBe(true)
    expect(b.dropped).toBe(false)
    // 快照跟着重算：这条现在真的会注入
    expect(presets[0].rules).toContain('内容b')
    expect(presets[0].counts.dropped).toEqual([])
  })

  it('★ 玩家手动关掉的（没有 dropped 标记）不许动', () => {
    const { presets, changed } = reviveBudgetDroppedEntries([
      preset([entry('a'), entry('b', { enabled: false })]),
    ])
    expect(changed).toBe(false)
    expect(presets[0].entries!.find(e => e.id === 'b')!.enabled).toBe(false)
  })

  it('没有 entries 的旧预设原样返回', () => {
    const p: NarrativePreset = { ...preset([]), entries: undefined }
    const { presets, changed } = reviveBudgetDroppedEntries([p])
    expect(changed).toBe(false)
    expect(presets[0]).toBe(p)
  })

  it('★ 唤醒之后，注入的文本里真的有那一条', () => {
    const { presets } = reviveBudgetDroppedEntries([
      preset([entry('a'), entry('b', { enabled: false, dropped: true })]),
    ])
    expect(renderPresetEntries(presets[0], 'rules')).toContain('【条目b】')
    const world = { narrative: { customStyle: '' }, rules: '' } as unknown as WorldCard
    expect(withNarrativePreset(world, presets[0]).rules).toContain('内容b')
  })
})

/**
 * 同一份文件被导入多次留下的副本（2026-11，玩家报「预设时有时无」）。
 *
 * `saveNarrativePreset` 的"同文件覆盖"判据写错过一次，每次导入都多存一份。
 * 两个同名预设并排躺在同一个展开区里，`activeId` 只指向其中一份 ——
 * 玩家在另一份里改了半天没反应，而他看起来完全一样。
 */
describe('合并重复导入的副本', () => {
  const p = (id: string, source: string, updatedAt: number, content: string): NarrativePreset => ({
    id, name: 'Izumi 1029', source,
    rules: '', style: '', lore: '',
    entries: [entry('a', { content })],
    counts: { total: 1, rules: 1, style: 0, other: 0, dropped: [] },
    createdAt: 1, updatedAt,
  })

  it('★ 同 source 只留最近更新的那份', () => {
    const { presets, removed } = dedupePresetsBySource(
      [p('x1', 'Izumi.json', 100, '旧内容'), p('x2', 'Izumi.json', 200, '新内容')],
      '',
    )
    expect(removed).toBe(1)
    expect(presets).toHaveLength(1)
    expect(presets[0].id).toBe('x2')
    expect(presets[0].entries![0].content).toBe('新内容')
  })

  it('★ activeId 指着被合并掉的那份 → 改指到留下的，而不是变成"没启用"', () => {
    const { activeId } = dedupePresetsBySource(
      [p('x1', 'Izumi.json', 100, '旧'), p('x2', 'Izumi.json', 200, '新')],
      'x1',
    )
    expect(activeId).toBe('x2')
  })

  it('不同文件、或没有 source 的，一份都不动', () => {
    const { presets, removed } = dedupePresetsBySource(
      [p('a', 'A.json', 1, '甲'), p('b', 'B.json', 2, '乙'), p('c', '', 3, '丙')],
      'a',
    )
    expect(removed).toBe(0)
    expect(presets).toHaveLength(3)
  })
})
