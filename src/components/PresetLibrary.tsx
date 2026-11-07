import { useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, Sparkles, Trash2, Upload, X, Check, FileText, AlertTriangle,
} from 'lucide-react'
import { useLibraryStore } from '@/stores/library'
import type { NarrativePreset } from '@/types/cards'
import { isSillyTavernPreset, stPresetToNarrativePreset } from '@/utils/stPreset'
import { describeNarrativePreset, presetHasContent, presetWarnings } from '@/utils/narrativePreset'
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

  const [openId, setOpenId] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ text: string; bad?: boolean } | null>(null)
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

    await savePreset(preset)
    setOpenId(preset.id)
    const c = preset.counts
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
                        <div className="text-[10px] text-text-muted">
                          来源：{p.source || '（手动创建）'}
                          {p.counts.dropped.length > 0 && (
                            <span className="block mt-1 text-amber-300/80">
                              超篇幅预算未并入 {p.counts.dropped.length} 条：{p.counts.dropped.join('、')}
                            </span>
                          )}
                        </div>
                        {presetWarnings(p).map((w, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-300/90 leading-relaxed">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span>{w}</span>
                          </div>
                        ))}
                        <PresetBlock title="规则（每轮注入）" text={p.rules} budget={4000} />
                        <PresetBlock title="文风（每轮注入）" text={p.style} budget={4000} />
                        <PresetBlock title="其他条目（只存档，不注入）" text={p.lore} budget={6000} />
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

/** 一段可展开的预设正文 */
function PresetBlock({ title, text, budget }: { title: string; text: string; budget: number }) {
  const [open, setOpen] = useState(false)
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
