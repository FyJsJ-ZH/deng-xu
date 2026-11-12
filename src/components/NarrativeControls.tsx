import { useLibraryStore } from '@/stores/library'
import { useSessionStore } from '@/stores/session'
import { StyleChooser } from '@/components/StyleChooser'
import { AntiRoutePanel } from '@/components/AntiRoutePanel'
import { Sparkles, ScrollText, Info, Type } from 'lucide-react'

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

  /*
    「每章字数」直接改 **session 里的世界卡快照**，不改卡片库里的原卡。

    为什么不改原卡：那是这张卡的"出厂设置"，别人（或者下个月的他）
    开一张新局时不该继承这一次的临时口味。只改这一局，改完下一轮就生效，
    因为 `useGameEngine` 每轮现读 `session.world`。
  */
  const world = useSessionStore(s => s.world)
  const patchWorld = useSessionStore(s => s.patchWorld)
  const replyLength = world?.narrative?.replyLength ?? 1800

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
            那是<b className="text-text-secondary">开局前</b>的入口，导入完回到这里就能直接切。
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
          {/*
            ⚠️ 这里不能写 `**下一轮**` —— 这是 JSX 文本节点，不是 markdown，
            星号会被原样渲染出来。玩家看到的就是一行"改动\*\*下一轮\*\*生效"。
          */}
          <span>改动<b className="font-bold">下一轮</b>生效 —— 提示词每轮现拼，不用重开一局。</span>
        </p>
      </section>

      {/* ── 每轮字数 ── */}
      <section className="rounded border border-text-muted/20 bg-surface/20 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Type size={13} className="text-accent-lantern shrink-0" />
          <h2 className="text-xs font-serif font-bold text-text-primary">每轮正文目标字数</h2>
          <span className="ml-auto text-[11px] font-mono text-accent-lantern">{replyLength} 字</span>
        </div>

        {/*
          ── 这里是**唯一**的字数设置（2026-11）──

          玩家原话：「文风预设和模型一下有两个期望字数了，整合进局内菜单方便随时调整」。
          他说得对：上一轮我在模型设置里也加了一个 `replyLengthOverride`，
          而局内「笔」面板早就有这个滑块 —— 两个数、两处入口，谁也说不清哪个说了算。

          现在只留这一处。它改的是 `session.world` 的副本（`patchWorld`），
          **不动卡片库里的原卡**，下一轮就生效。
        */}
        <input
          type="range"
          min={800}
          max={6000}
          step={100}
          value={Math.min(6000, Math.max(800, replyLength))}
          onChange={e => {
            if (!world) return
            patchWorld({ narrative: { ...world.narrative, replyLength: Number(e.target.value) } })
          }}
          className="w-full accent-accent-lantern"
          aria-label="每轮正文目标字数"
        />

        <div className="flex items-center gap-2 flex-wrap text-[9px] font-mono text-text-muted">
          {[1200, 1800, 2500, 3500, 5000].map(n => (
            <button
              key={n}
              onClick={() => {
                if (!world) return
                patchWorld({ narrative: { ...world.narrative, replyLength: n } })
              }}
              className={`px-1.5 py-0.5 rounded border transition-colors
                ${replyLength === n
                  ? 'border-accent-lantern/60 text-accent-lantern bg-accent-lantern/10'
                  : 'border-text-muted/30 hover:text-text-secondary'}`}
            >
              {n}
            </button>
          ))}
        </div>

        <p className="text-[10px] text-text-muted leading-relaxed">
          这是<b className="text-text-secondary">目标值</b>，下限卡在七成 ——
          也就是说实际每轮不会少于 {Math.round(replyLength * 0.7)} 字。
          它同时决定提示词里那句「约 {replyLength} 字」和按它推算的 max_tokens
          （约 <b className="text-text-secondary">{Math.round(replyLength * 1.5)}</b> token 的正文额度）。
        </p>
        <p className="text-[10px] text-text-muted/80 leading-relaxed">
          只影响<b>这一局</b>，不改卡片库里的原卡；下一轮生效。
          调大之后每轮的<b>输出更贵更慢</b>，而且这些正文下一轮会作为历史再读一遍
          （单条已封在 2400 字，不会无限滚）。
        </p>
      </section>

      {/* ── 文风（StyleChooser 自己读写 store，外壳也是它自己的）── */}
      <StyleChooser />

      {/* ── 防降级加固（2026-11，从酒馆脚本「卢克之光」移植）── */}
      <AntiRoutePanel />

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
