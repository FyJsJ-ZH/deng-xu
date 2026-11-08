import { useLibraryStore } from '@/stores/library'
import { StyleChooser } from '@/components/StyleChooser'
import { Sparkles, ScrollText, Info } from 'lucide-react'

/**
 * **局内**的叙事预设与文风切换（2026-11）。
 *
 * ## 为什么它能"立刻生效"
 *
 * 这里一个字节的提示词都不拼 —— 真正拼提示词的地方是 `useGameEngine` 每轮开头：
 *
 * ```ts
 * withNarrativePreset(activeWorld, lib.getActiveNarrativePreset(), lib.styleChoice)
 * ```
 *
 * 也就是说**每一轮都现读 store**，所以只要把 store 里那两个值改掉，
 * 下一轮就是新的。切换是零成本的，不需要重开一局。
 *
 * ## 那之前为什么只有主菜单能切
 *
 * 因为入口只做了「主菜单 → 叙事预设」那一屏（`PresetLibrary`）。
 * 玩到一半想换笔法，得退到标题、改完、再从头开始 ——
 * 而那正是玩家写顺了手感、最不想被打断的时候。
 *
 * ## 两层并存，不是一个东西
 *
 * · **叙事预设**：整套换的底盘（创作准则、任务链、每轮纪律）—— 单选
 * · **文风**：逐项调的笔法（简练 / 堆砌 / 白描……）—— 四组多选
 *
 * 换文风不该逼人重新导入一份预设，所以这里两块各自独立、各自可切。
 */
export function NarrativeControls() {
  const presets = useLibraryStore(s => s.narrativePresets)
  const activeId = useLibraryStore(s => s.activeNarrativePresetId)
  const setActive = useLibraryStore(s => s.setActiveNarrativePreset)
  const loaded = useLibraryStore(s => s.loaded)

  const active = presets.find(p => p.id === activeId)

  return (
    <div className="space-y-3">
      {/* ── 叙事预设 ── */}
      <section className="rounded border border-text-muted/20 bg-surface/20 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <ScrollText size={13} className="text-accent-lantern shrink-0" />
          <h2 className="text-xs font-serif font-bold text-text-primary">叙事预设</h2>
          <span className="text-[10px] text-text-muted">
            {active ? '已启用' : '未启用'}
          </span>
        </div>

        {!loaded ? (
          <p className="text-[10px] text-text-muted">正在读取本机预设…</p>
        ) : presets.length === 0 ? (
          <p className="text-[10px] text-text-muted leading-relaxed">
            本机还没有叙事预设。回主菜单「叙事预设」可以导入酒馆预设或从头写一份 ——
            那是**开局前**的入口，导入完回到这里就能直接切。
          </p>
        ) : (
          <select
            value={activeId}
            onChange={e => { void setActive(e.target.value) }}
            className="w-full bg-black/30 border border-text-muted/30 rounded px-2 py-1.5 text-xs text-text-primary"
          >
            <option value="">不使用预设（只用世界卡自己的规则与文风）</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}

        {active && (
          <p className="text-[10px] text-text-muted leading-relaxed">
            来源：{active.source}
          </p>
        )}

        <p className="text-[10px] text-accent-lantern/80 flex items-start gap-1 leading-relaxed">
          <Info size={10} className="mt-0.5 shrink-0" />
          <span>改动**下一轮**生效 —— 提示词每轮现拼，不用重开一局。</span>
        </p>
      </section>

      {/* ── 文风（StyleChooser 自己读写 store，外壳也是它自己的）── */}
      <StyleChooser />

      {/* ── 一句总述 ── */}
      <p className="flex items-start gap-1.5 text-[10px] text-text-muted leading-relaxed px-1">
        <Sparkles size={10} className="mt-0.5 shrink-0 text-accent-lantern/70" />
        <span>
          这两层叠在世界卡之上：世界卡是「这个世界长什么样」，预设是「怎么讲故事」，
          文风是「句子怎么写」。三层从下往上压，你刚点的这一下压在最上面。
        </span>
      </p>
    </div>
  )
}
