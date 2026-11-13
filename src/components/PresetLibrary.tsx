import { useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, Sparkles, Trash2, Upload, X, Check, FileText, AlertTriangle,
  Pencil, Plus, Save,
} from 'lucide-react'
import { useLibraryStore } from '@/stores/library'
import type { NarrativePreset, PresetEntry } from '@/types/cards'
import { isSillyTavernPreset, stPresetToNarrativePreset } from '@/utils/stPreset'
import {
  describeNarrativePreset, presetHasContent, presetWarnings, presetEntryStats,
} from '@/utils/narrativePreset'
import { StyleChooser } from '@/components/StyleChooser'
import { downloadFile, timestampSuffix } from '@/utils/files'

/**
 * 叙事预设库 —— 「怎么写」的那一摞，可切换。
 *
 * ## 它跟卡片库的分工
 *
 * | | 卡片库 / 世界书 | 叙事预设 |
 * |---|---|---|
 * | 管什么 | **写什么**：地名、人物、势力、物价 | **怎么写**：文风、句式禁令、对白规范 |
 * | 生命周期 | 一局一个，跟着存档走 | 全局一份，跨世界、跨局 |
 * | 换掉的代价 | 重开一局 | 下一轮就变 |
 *
 * 玩家原话：「或许可以像世界书或卡片库一样，存储预设并可切换」。
 * 所以这里是**列表 + 单选**，不是编辑器 —— 预设的内容由原作者的 ST 文件决定，
 * 本作只负责把它拆成"规则 / 文风"两段并叠到你当前的世界卡上。
 *
 * ## 为什么只能启用一份
 *
 * 文风指令天然互斥：「简练网文」与「超细腻大段描写」同时生效，
 * 模型只能二选一地瞎猜，而玩家会以为是模型不听话。
 * 单选把这件事变成不可能，省掉一整套调试玄学。
 */
export function PresetLibrary({ onBack }: { onBack: () => void }) {
  const presets = useLibraryStore(s => s.narrativePresets)
  const activeId = useLibraryStore(s => s.activeNarrativePresetId)
  const loaded = useLibraryStore(s => s.loaded)
  const savePreset = useLibraryStore(s => s.saveNarrativePreset)
  const deletePreset = useLibraryStore(s => s.deleteNarrativePreset)
  const setActive = useLibraryStore(s => s.setActiveNarrativePreset)
  const renamePreset = useLibraryStore(s => s.renameNarrativePreset)

  const [openId, setOpenId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ text: string; bad?: boolean } | null>(null)
  /** 正在改名的预设：`{ id, value }`，null = 没人在改名 */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const say = (text: string, bad = false) => {
    setFlash({ text, bad })
    setTimeout(() => setFlash(null), 6000)
  }

  const active = useMemo(
    () => presets.find(p => p.id === activeId),
    [presets, activeId],
  )

  /**
   * 导入一份预设。
   *
   * 认两种东西：
   *  1. **SillyTavern 提示词预设**（`prompts` + `prompt_order`）—— 网上能下到的那种；
   *  2. 本页导出的预设包（`format: deng-xu-narrative-presets`）—— 自己带走的备份。
   *
   * 刻意**不认**世界书：那种文件走「卡片库 → 导入」，两边混着认会让玩家
   * 在错误的页面里得到一个"导入成功但什么都没变"。
   */
  const handleFile = async (file: File | undefined) => {
    if (!file) return
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      say('这个文件不是合法 JSON。', true)
      return
    }

    // 自己导出的包：里面可能有好几份
    const asPack = raw as { format?: string; presets?: unknown }
    if (asPack?.format === 'deng-xu-narrative-presets' && Array.isArray(asPack.presets)) {
      let n = 0
      for (const item of asPack.presets) {
        const p = item as NarrativePreset
        if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue
        await savePreset({ ...p, id: '' }, { activate: false })
        n++
      }
      say(n ? `已导入 ${n} 份预设。` : '这个包里没有可用的预设。', !n)
      return
    }

    if (!isSillyTavernPreset(raw)) {
      say(
        '这不是 SillyTavern 的提示词预设。'
        + '（预设里应当是 `prompts` 数组 + `prompt_order`；'
        + '带 `entries` 的那种是世界书，请到「卡片库 → 导入世界包」里用。）',
        true,
      )
      return
    }

    const preset = stPresetToNarrativePreset(raw, file.name)
    if (!preset) {
      say('这份预设里没有可用的条目（全被停用，或只剥出了空占位）。', true)
      return
    }

    /*
      同一个文件再导入一次 = 覆盖那一份（2026-11）。
      玩家修顺序需要重新导入，而这句提示得让他知道"是更新了一份，不是又多了一份"。
    */
    const sameSource = presets.find(p => p.source && p.source === preset.source)
    await savePreset(preset)
    setOpenId(sameSource?.id || preset.id)
    const c = preset.counts
    if (sameSource) {
      say(
        `已用这个文件更新《${sameSource.name}》：${c.total} 条启用条目，`
        + '条目顺序已按文件里的 prompt_order 重排。'
        + '（同一份文件再导入是覆盖，不是新增；你在这个页面里的手改会被替换掉。）',
      )
      return
    }
    say(
      `已导入《${preset.name}》：${c.total} 条启用条目 —— `
      + `规则 ${c.rules} 条、文风 ${c.style} 条、其余 ${c.other} 条（只存档，不注入）。`
      + (c.dropped.length ? `　超篇幅预算未并入 ${c.dropped.length} 条。` : '')
      + '已自动启用，下一轮生成即生效。',
    )
  }

  const exportAll = () => {
    if (!presets.length) return
    const payload = {
      format: 'deng-xu-narrative-presets',
      version: 1,
      exportedAt: Date.now(),
      presets,
    }
    downloadFile(`叙事预设-${presets.length}份-${timestampSuffix()}.json`, payload)
    say(`已导出 ${presets.length} 份预设。`)
  }

  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col">
      <header className="sticky top-0 z-20 border-b border-text-muted/20 bg-background/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-text-muted/40 rounded
              hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors shrink-0"
            title="返回上一级"
          >
            <ChevronLeft size={14} />
            <span className="hidden sm:inline">返回</span>
          </button>
          <Sparkles size={20} className="text-accent-lantern flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-serif font-bold tracking-widest text-accent-lantern truncate">叙事预设</h1>
            <p className="text-[10px] text-text-muted font-mono truncate">
              {loaded
                ? `${presets.length} 份 · ${active ? `启用中：${active.name}` : '未启用任何预设'}`
                : '正在载入…'}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border
                border-text-muted/40 hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
              title="导入 SillyTavern 提示词预设（.json）"
            >
              <Upload size={13} />
              <span className="hidden sm:inline">导入</span>
            </button>
            <button
              onClick={exportAll}
              disabled={!presets.length}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border
                border-text-muted/40 hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors
                disabled:opacity-30 disabled:hover:border-text-muted/40 disabled:hover:text-text-primary"
              title={presets.length ? '把全部预设导出成一个文件' : '还没有预设可导出'}
            >
              <Download size={13} />
              <span className="hidden sm:inline">导出</span>
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = '' }}
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-4">
          {/* 说明：先说清"它会影响什么"，否则玩家只能靠猜 */}
          <div className="rounded border border-text-muted/20 bg-surface/20 p-3 space-y-2">
            <p className="text-[11px] text-text-secondary leading-relaxed">
              预设管的是<b className="text-text-primary">怎么写</b>（文风、句式禁令、对白规范），
              世界卡管的是<b className="text-text-primary">写什么</b>（地点、人物、势力）。
              两者互不覆盖：<b>换世界不丢文风，换文风不改世界卡</b>。
            </p>
            <p className="text-[10px] text-text-muted leading-relaxed">
              全局同时只启用一份，下一轮生成即生效，不必重开一局。
              「规则」与「文风」两段会叠在你当前的世界卡上；其余条目只存档、不注入
              （作者说明、越狱串、实验性玩法的开关那些，注入进去只会互相打架）。
            </p>
          </div>

          {/* 文风在最上面：它比预设更常调（今天想写轻一点，不必换整套预设） */}
          <StyleChooser />

          {/* 「不用预设」永远是列表里的第一项：不启用也是一种合法的选择 */}
          <button
            onClick={() => { void setActive('') }}
            className={`w-full flex items-center gap-3 px-3 py-3 rounded border text-left transition-colors
              ${!activeId
                ? 'border-accent-lantern/50 bg-accent-lantern/[0.08]'
                : 'border-text-muted/20 hover:border-text-muted/40'}`}
          >
            <span className={`w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center
              ${!activeId ? 'border-accent-lantern' : 'border-text-muted/50'}`}>
              {!activeId && <span className="w-1.5 h-1.5 rounded-full bg-accent-lantern" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-serif text-text-primary">不使用预设</div>
              <div className="text-[10px] text-text-muted">只按世界卡自己的规则与文风来写</div>
            </div>
          </button>

          {presets.length === 0 ? (
            <div className="text-center py-10 space-y-3">
              <FileText size={28} className="mx-auto text-text-muted/40" />
              <p className="text-xs text-text-muted leading-relaxed">
                还没有预设。<br />
                点右上角「导入」，选一份 SillyTavern 的<b>提示词预设</b>（.json）。
              </p>
              <p className="text-[10px] text-text-muted/70 leading-relaxed max-w-md mx-auto">
                注意区分：带 <code className="text-text-secondary">{'{ prompts: [...], prompt_order: [...] }'}</code> 的是预设；
                带 <code className="text-text-secondary">{'{ entries: [...] }'}</code> 的是世界书，请到卡片库里导入。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {presets.map(p => {
                const on = p.id === activeId
                const open = openId === p.id
                return (
                  <div
                    key={p.id}
                    className={`rounded border transition-colors
                      ${on ? 'border-accent-lantern/50 bg-accent-lantern/[0.06]' : 'border-text-muted/20'}`}
                  >
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <button
                        onClick={() => { void setActive(on ? '' : p.id) }}
                        className="flex items-center gap-3 min-w-0 flex-1 text-left"
                        title={on ? '取消启用' : '启用这份预设'}
                      >
                        <span className={`w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center
                          ${on ? 'border-accent-lantern' : 'border-text-muted/50'}`}>
                          {on && <span className="w-1.5 h-1.5 rounded-full bg-accent-lantern" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-sm font-serif truncate ${on ? 'text-accent-lantern' : 'text-text-primary'}`}>
                              {p.name}
                            </span>
                            {on && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-accent-lantern/20 text-accent-lantern border border-accent-lantern/40 shrink-0">
                                启用中
                              </span>
                            )}
                            {!presetHasContent(p) && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 shrink-0">
                                没有可注入的内容
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-text-muted font-mono truncate">
                            {describeNarrativePreset(p)}
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={() => setOpenId(open ? null : p.id)}
                        className="p-1.5 rounded text-text-muted hover:text-accent-lantern shrink-0"
                        title={open ? '收起内容' : '查看内容'}
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button
                        onClick={() => { void deletePreset(p.id) }}
                        className="p-1.5 rounded text-text-muted/50 hover:text-red-400 shrink-0"
                        title="删除这份预设"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {open && (
                      <div className="px-3 pb-3 space-y-2 border-t border-text-muted/15 pt-2">
                        {/* 改名（2026-11 第三十八轮）：导入时名字取自文件名，一堆 "预设 (3).json" 分不清谁是谁 */}
                        <div className="flex items-center gap-2 text-[10px] text-text-muted">
                          <span className="shrink-0">名称</span>
                          {renaming?.id === p.id ? (
                            <>
                              <input
                                autoFocus
                                value={renaming.value}
                                onChange={e => setRenaming({ id: p.id, value: e.target.value })}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') { void renamePreset(p.id, renaming.value); setRenaming(null) }
                                  if (e.key === 'Escape') setRenaming(null)
                                }}
                                className="flex-1 min-w-0 px-1.5 py-0.5 rounded bg-black/40 border border-accent-lantern/40
                                  text-[11px] text-text-primary outline-none focus:border-accent-lantern"
                                aria-label="预设名称"
                              />
                              <button
                                onClick={() => { void renamePreset(p.id, renaming.value); setRenaming(null) }}
                                className="p-1 rounded text-emerald-400/80 hover:text-emerald-300 shrink-0"
                                title="保存名字"
                              >
                                <Save size={11} />
                              </button>
                              <button
                                onClick={() => setRenaming(null)}
                                className="p-1 rounded text-text-muted hover:text-text-secondary shrink-0"
                                title="放弃"
                              >
                                <X size={11} />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className={`truncate ${on ? 'text-accent-lantern' : 'text-text-secondary'}`}>{p.name}</span>
                              <button
                                onClick={() => setRenaming({ id: p.id, value: p.name })}
                                className="p-1 rounded text-text-muted/60 hover:text-accent-lantern shrink-0"
                                title="改个名字"
                                aria-label="重命名这份预设"
                              >
                                <Pencil size={11} />
                              </button>
                            </>
                          )}
                        </div>
                        <div className="text-[10px] text-text-muted">
                          来源：{p.source || '（手动创建）'}
                          {p.counts.dropped.length > 0 && (
                            <span className="block mt-1 text-amber-300/80">
                              超篇幅预算未并入 {p.counts.dropped.length} 条：{p.counts.dropped.join('、')}
                            </span>
                          )}
                        </div>
                        {/*
                          旧数据提示（2026-11）：`order` 是这一轮才加的字段。
                          之前导入的预设是按「规则/文风/存档」重排过的，
                          那个顺序已经不是作者的原序列 —— 让玩家知道重导一次就好，
                          而不是自己一条条往上挪。
                        */}
                        {!!p.entries?.length && !p.entries.every(e => typeof e.order === 'number') && (
                          <div className="flex items-start gap-1.5 text-[10px] text-amber-300/90 leading-relaxed">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span>
                              这份是旧版导入的：条目顺序当年按分类重排过，不是文件里的原顺序。
                              把同一个 .json 再导入一次就能重排（同名文件会<b>覆盖</b>这一份，不会多出一份）。
                            </span>
                          </div>
                        )}
                        {presetWarnings(p).map((w, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-300/90 leading-relaxed">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span>{w}</span>
                          </div>
                        ))}
                        {p.entries?.length ? (
                          <PresetEntries preset={p} onSay={say} />
                        ) : (
                          <>
                            <div className="text-[10px] text-amber-300/80 leading-relaxed">
                              这份预设是旧版导入的：内容已经拼成一整块，不能逐条勾选。
                              重新导入同一个 .json 就能拿到逐条开关。
                            </div>
                            <PresetBlock title="规则（每轮注入）" text={p.rules} budget={4000} />
                            <PresetBlock title="文风（每轮注入）" text={p.style} budget={4000} />
                            <PresetBlock title="其他条目（只存档，不注入）" text={p.lore} budget={6000} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {flash && (
            <div className={`flex items-start gap-1.5 text-[11px] leading-relaxed px-1
              ${flash.bad ? 'text-red-400' : 'text-emerald-400'}`}>
              {flash.bad ? <X size={12} className="mt-0.5 shrink-0" /> : <Check size={12} className="mt-0.5 shrink-0" />}
              <span>{flash.text}</span>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * 逐条勾选（2026-11 第三十七轮）。
 *
 * 玩家原话：「现在的酒馆预设都有勾选功能，但本项目没有可自定义的选项，
 * 导入以后就固定了，加入这个功能。」
 *
 * 三条 UX 决定，都是为了"点一下就知道结果"：
 *
 *  1. **勾掉的行变淡而不是消失** —— 酒馆里也是留在原位。
 *     它得还在那儿，玩家才知道自己关了什么，也才点得回来。
 *  2. **每类顶上写清"勾了几条 / 共几条 / 多少字"** ——
 *     规则与文风是每轮全量注入的，字数就是成本，得让他看见自己在加什么。
 *  3. **超预算的条目单独标灰 + 「超预算」角标**，而不是藏起来：
 *     它内容一个字都没丢，玩家想要就自己勾上。
 */
const KIND_META: Record<PresetEntry['kind'], { title: string; hint: string; badge: string }> = {
  rules: { title: '规则', hint: '每轮注入', badge: 'bg-accent-lantern/15 text-accent-lantern/90 border-accent-lantern/30' },
  style: { title: '文风', hint: '每轮注入', badge: 'bg-sky-500/15 text-sky-300/90 border-sky-500/30' },
  /*
    贴尾：这一类的条目**贴在生成点之前**发出去（历史之后的最后一条 system），
    也就是酒馆 `post_history_instructions` 那一格 —— 破甲 / 输出格式 / 字数 / 收尾。
    见 `types/cards.ts` 里 `PresetEntry.kind` 的说明。
  */
  tail: { title: '贴尾', hint: '贴在生成点之前（破甲 / 格式）', badge: 'bg-rose-500/15 text-rose-300/90 border-rose-500/30' },
  other: { title: '存档', hint: '只存档，不注入', badge: 'bg-text-muted/15 text-text-muted border-text-muted/30' },
}

function PresetEntries({
  preset, onSay,
}: {
  preset: NarrativePreset
  onSay: (text: string, bad?: boolean) => void
}) {
  const toggleEntry = useLibraryStore(s => s.toggleNarrativePresetEntry)
  const setEntries = useLibraryStore(s => s.setNarrativePresetEntries)
  const updateEntry = useLibraryStore(s => s.updateNarrativePresetEntry)
  const addEntry = useLibraryStore(s => s.addNarrativePresetEntry)
  const deleteEntry = useLibraryStore(s => s.deleteNarrativePresetEntry)

  const [openId, setOpenId] = useState<string | null>(null)
  /**
   * 正在编辑的那一条。
   *
   * 放在这一层而不是行内，是为了**新增条目后能自动进入编辑态** ——
   * 加了空白的一条却要玩家再点一次「编辑」，等于让他对着一个控件猜下一步。
   */
  const [draft, setDraft] = useState<{
    id: string
    name: string
    content: string
    kind: PresetEntry['kind']
  } | null>(null)

  /**
   * ── 一个**线性**清单，照酒馆 `prompt_order` 的原始顺序（2026-11）──
   *
   * 上一版按「规则 / 文风 / 存档」分三组显示，玩家原话是
   * 「连预设的顺序都是错乱的」—— 他说得对：酒馆里那是一条序列，
   * 分组显示等于把作者的"先说什么、后说什么"拆掉了。
   *
   * 现在只按 `order` 排；`kind` 退成每行一个小徽标（它还决定注入到哪儿，
   * 但不再决定"排第几"）。
   */
  const entries = useMemo(
    () => (preset.entries || [])
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i))
      .map(({ e }) => e),
    [preset.entries],
  )
  const stats = presetEntryStats(preset)
  const onTotal = stats.rules.on + stats.style.on + stats.tail.on + stats.other.on
  const injectChars = stats.rules.chars + stats.style.chars + stats.tail.chars

  const beginEdit = (e: PresetEntry) => {
    setOpenId(e.id)
    setDraft({ id: e.id, name: e.name, content: e.content, kind: e.kind })
  }

  const commitDraft = () => {
    if (!draft) return
    void updateEntry(preset.id, draft.id, { name: draft.name, content: draft.content, kind: draft.kind })
    setDraft(null)
    onSay('已保存。下一轮生成即生效。')
  }

  const addOne = async (kind: PresetEntry['kind']) => {
    const id = await addEntry(preset.id, kind)
    if (!id) return
    setOpenId(id)
    setDraft({ id, name: '新条目', content: '', kind })
  }

  return (
    <div className="space-y-2">
      {/* 工具条：总数、按类批量开关、顺序说明 */}
      <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-text-muted">
        <span className="font-mono">{onTotal}/{entries.length} 条勾选 · 每轮注入 {injectChars} 字</span>
        {(['rules', 'style', 'tail', 'other'] as const).map(kind => {
          const st = stats[kind]
          if (!st.all) return null
          const allOn = st.on === st.all
          return (
            <button
              key={kind}
              onClick={() => { void setEntries(preset.id, !allOn, kind) }}
              data-preset-kind={kind}
              aria-label={`${allOn ? '全关' : '全勾'}${KIND_META[kind].title}`}
              className={`px-1.5 py-0.5 rounded border transition-colors
                ${KIND_META[kind].badge} hover:brightness-125`}
              title={allOn
                ? `把「${KIND_META[kind].title}」这一类全关掉`
                : `把「${KIND_META[kind].title}」这一类全勾上`}
            >
              {KIND_META[kind].title} {st.on}/{st.all}
            </button>
          )
        })}
        <span className="text-[9px] text-text-muted/60 ml-auto">顺序＝酒馆里的原始顺序</span>
      </div>

      <div className="rounded border border-text-muted/20 bg-black/20 overflow-hidden divide-y divide-text-muted/10">
        {entries.map(e => (
          <PresetEntryRow
            key={e.id}
            entry={e}
            open={openId === e.id}
            editing={draft?.id === e.id}
            draft={draft?.id === e.id ? draft : null}
            onToggle={() => { void toggleEntry(preset.id, e.id) }}
            onExpand={() => setOpenId(openId === e.id ? null : e.id)}
            onEdit={() => beginEdit(e)}
            onDraftChange={patch => setDraft(d => (d && d.id === e.id ? { ...d, ...patch } : d))}
            onSave={commitDraft}
            onCancel={() => setDraft(null)}
            onDelete={() => {
              void deleteEntry(preset.id, e.id)
              if (draft?.id === e.id) setDraft(null)
              onSay(`已删除「${e.name}」。`)
            }}
          />
        ))}
        <button
          onClick={() => { void addOne('rules') }}
          data-add-kind="rules"
          className="w-full flex items-center justify-center gap-1 text-[10px] py-1.5
            text-text-muted hover:text-accent-lantern transition-colors"
          title="加一条（默认是「规则」，保存前可以改落点）"
        >
          <Plus size={11} />
          添加一条
        </button>
      </div>
    </div>
  )
}

function PresetEntryRow({
  entry, open, editing, draft, onToggle, onExpand, onEdit, onDraftChange, onSave, onCancel, onDelete,
}: {
  entry: PresetEntry
  open: boolean
  editing: boolean
  draft: { id: string; name: string; content: string; kind: PresetEntry['kind'] } | null
  onToggle: () => void
  onExpand: () => void
  onEdit: () => void
  onDraftChange: (patch: { name?: string; content?: string; kind?: PresetEntry['kind'] }) => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  /** 删除要点两下：这条是真扔，不是"取消勾选"那种可逆操作 */
  const [confirmDel, setConfirmDel] = useState(false)
  const dim = !entry.enabled && !editing

  return (
    <div className={`px-2 py-1.5 ${dim ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2">
        <button
          onClick={onToggle}
          role="checkbox"
          aria-checked={entry.enabled}
          aria-label={entry.name}
          data-entry-id={entry.id}
          title={entry.enabled ? '取消勾选（下一轮起不再注入）' : '勾上（下一轮起生效）'}
          className={`mt-0.5 w-3.5 h-3.5 rounded-[3px] border shrink-0 flex items-center justify-center transition-colors
            ${entry.enabled
              ? 'border-accent-lantern/60 bg-accent-lantern/20 text-accent-lantern'
              : 'border-text-muted/70 bg-black/30 text-transparent hover:border-text-muted'}`}
        >
          <Check size={9} strokeWidth={3} />
        </button>

        <button onClick={onExpand} className="min-w-0 flex-1 text-left" title={open ? '收起这一条' : '看这一条的内容'}>
          <span className={`text-[11px] break-words ${entry.enabled ? 'text-text-secondary' : 'text-text-muted'}`}>
            {editing && draft ? draft.name || '（未命名）' : entry.name}
          </span>
          <span className="text-[9px] text-text-muted/70 font-mono ml-1.5">
            {(editing && draft ? draft.content : entry.content).length} 字
          </span>
          {entry.dropped && (
            <span className="text-[9px] px-1 py-0.5 ml-1.5 rounded bg-amber-500/15 text-amber-300/90 border border-amber-500/30 whitespace-nowrap">
              超预算
            </span>
          )}
        </button>

        {/*
          落点徽标（2026-11）：列表不再按类分组，所以「这条会不会进提示词」
          得靠这个小标签一眼看出来 —— 规则/文风是每轮注入，存档不注入。
        */}
        <span
          className={`mt-0.5 text-[9px] px-1 py-0.5 rounded border whitespace-nowrap shrink-0
            ${KIND_META[editing && draft ? draft.kind : entry.kind].badge}`}
          title={KIND_META[editing && draft ? draft.kind : entry.kind].hint}
        >
          {KIND_META[editing && draft ? draft.kind : entry.kind].title}
        </span>

        {!editing && (
          <button
            onClick={onEdit}
            className="p-0.5 text-text-muted hover:text-accent-lantern shrink-0"
            title="改这一条的名字、正文与落点"
            aria-label={`编辑 ${entry.name}`}
            data-edit-id={entry.id}
          >
            <Pencil size={11} />
          </button>
        )}

        <button onClick={onExpand} className="p-0.5 text-text-muted/50 hover:text-accent-lantern shrink-0">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>

      {open && !editing && (
        <pre className="mt-1.5 px-2 py-1.5 rounded bg-black/30 text-[10px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words max-h-56 overflow-y-auto font-sans">
          {entry.content || '（这一条没有正文）'}
        </pre>
      )}

      {open && editing && draft && (
        <div className="mt-1.5 space-y-1.5">
          <input
            autoFocus
            value={draft.name}
            onChange={e => onDraftChange({ name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
            placeholder="这一条的名字（会成为注入时的【小标题】）"
            aria-label="条目名称"
            className="w-full px-2 py-1 rounded bg-black/40 border border-accent-lantern/30 text-[11px]
              text-text-primary outline-none focus:border-accent-lantern"
          />
          <textarea
            value={draft.content}
            onChange={e => onDraftChange({ content: e.target.value })}
            onKeyDown={e => {
              // Esc 放弃、Ctrl/Cmd+Enter 保存 —— 手机上没有 Esc，按钮在下面
              if (e.key === 'Escape') onCancel()
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave()
            }}
            rows={8}
            spellCheck={false}
            placeholder="这一条的正文。留空等于不注入，但条目本身会留着。"
            aria-label="条目正文"
            className="w-full px-2 py-1.5 rounded bg-black/40 border border-accent-lantern/30 text-[11px] leading-relaxed
              text-text-secondary outline-none focus:border-accent-lantern resize-y min-h-[140px] font-sans"
          />
          {/* 落点：这条到底是规则、文风，还是只存档 */}
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-text-muted">
            <span className="shrink-0">注入到</span>
            {(['rules', 'style', 'tail', 'other'] as const).map(k => {
              const picked = draft.kind === k
              return (
                <button
                  key={k}
                  onClick={() => onDraftChange({ kind: k })}
                  data-draft-kind={k}
                  aria-pressed={picked}
                  className={`px-1.5 py-0.5 rounded border transition-colors
                    ${picked
                      ? 'border-accent-lantern/60 text-accent-lantern bg-accent-lantern/10'
                      : 'border-text-muted/30 text-text-muted hover:text-text-secondary'}`}
                  title={k === 'other'
                    ? '只存档：留在库里给人看，不进提示词'
                    : k === 'tail'
                      ? '贴在生成点之前：破甲、输出格式、字数要求、收尾规矩该放这儿'
                      : '每轮注入提示词'}
                >
                  {KIND_META[k].title}
                </button>
              )
            })}
            <span className="text-[9px] text-text-muted/60">
              {draft.kind === 'other'
                ? '只存档，不注入'
                : draft.kind === 'tail'
                  ? '贴尾：历史之后、正文之前'
                  : '每轮注入'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={onSave}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-accent-lantern/50
                text-accent-lantern hover:bg-accent-lantern/10"
            >
              <Save size={11} />
              保存
            </button>
            <button
              onClick={onCancel}
              className="px-2 py-1 text-[10px] rounded border border-text-muted/40 text-text-muted hover:text-text-secondary"
            >
              取消
            </button>
            <span className="text-[9px] text-text-muted/60 font-mono">
              Ctrl/⌘+Enter 保存 · Esc 取消
            </span>
            <button
              onClick={() => {
                if (!confirmDel) { setConfirmDel(true); return }
                setConfirmDel(false)
                onDelete()
              }}
              className={`ml-auto flex items-center gap-1 px-2 py-1 text-[10px] rounded border transition-colors
                ${confirmDel
                  ? 'border-red-500/60 text-red-300 bg-red-500/10'
                  : 'border-text-muted/40 text-text-muted/70 hover:text-red-400 hover:border-red-500/40'}`}
              title={confirmDel ? '再点一次就真的删掉' : '删掉这一条（与"取消勾选"不同，删了就回不来）'}
              data-delete-id={entry.id}
            >
              <Trash2 size={11} />
              {confirmDel ? '确认删除' : '删除'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 一段可展开的预设正文 */
function PresetBlock({ title, text, budget }: { title: string; text: string; budget: number }) {  const [open, setOpen] = useState(false)
  const body = text.trim()
  if (!body) return null
  const long = body.length > budget
  const shown = open || !long ? body : body.slice(0, budget)
  return (
    <div className="rounded border border-text-muted/20 bg-black/20">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-text-muted/15">
        <span className="text-[10px] font-serif text-text-secondary">{title}</span>
        <span className="text-[9px] text-text-muted font-mono ml-auto">{body.length} 字</span>
      </div>
      <pre className="px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words max-h-72 overflow-y-auto font-sans">
        {shown}
        {long && !open && '…'}
      </pre>
      {long && (
        <button
          onClick={() => setOpen(v => !v)}
          className="w-full text-[10px] text-text-muted hover:text-accent-lantern py-1 border-t border-text-muted/15"
        >
          {open ? '收起' : `展开全文（${body.length} 字）`}
        </button>
      )}
    </div>
  )
}
