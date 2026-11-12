import { describe, it, expect } from 'vitest'
import { reviveBudgetDroppedEntries, withNarrativePreset, renderPresetEntries } from '@/utils/narrativePreset'
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
