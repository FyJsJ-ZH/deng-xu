import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft, UserRound, Plus, Trash2, Copy, Check, Sparkles, Pencil, X,
  Download, Upload, AlertCircle,
} from 'lucide-react'
import type { HeroPreset, PlayerCard } from '@/types/cards'
import { useLibraryStore } from '@/stores/library'
import { useNavStore } from '@/stores/nav'
import { downloadFile, readFileAsText, safeFilename, timestampSuffix, makeId } from '@/utils/files'
import { PRESET_FORMAT, PRESET_VERSION, coercePlayer, extractPresetList } from '@/utils/heroPresetFile'

/**
 * 「我的主角」——提前设定主角。
 *
 * ## 解决的问题
 *
 * 原先的流程是：选世界 → 进选角 → **每次都从空白开始手填**名字、性别、
 * 年龄、外貌、性格、背景，再逐槽选出身。玩第二局时这些几乎一模一样，
 * 却要重填一遍；换一个世界想沿用同一个主角，更是从头再来。
 *
 * ## 设计取舍
 *
 * · **预设只存主角档案，不绑定世界。** 同一个主角可以拿去任何世界开局 ——
 *   这是最常见的诉求（"我每次都演同一个人"）。出身/际遇这类**世界相关**的
 *   选择另存一层（`HeroPreset.choices.byWorld`），换世界时自动忽略对不上的。
 * · **不做预览立绘。** 主角立绘在游戏里由档案推断生成，这里再画一份
 *   要重复一整套推断逻辑、且会与游戏里看到的不一致。所以只列文字档案。
 * · **空状态要能直接新建。** 第一次进来必须是"点一下就能开始填"，
 *   而不是先看一个空列表再找按钮。
 */
interface HeroPresetsProps {
  onBack: () => void
}

const inputCls =
  'w-full px-2.5 py-1.5 text-xs bg-black/30 border border-text-muted/30 rounded ' +
  'focus:border-accent-lantern/60 focus:outline-none transition-colors'
const areaCls = inputCls + ' resize-y leading-relaxed'

/** 空白主角档案 —— 所有字段都给空串，避免 undefined 渗进提示词 */
const EMPTY_PLAYER: PlayerCard = {
  name: '', gender: '', age: '', appearance: '', personality: '', background: '', extra: '',
}

/** 一句话概括一个预设，列表里方便扫 */
function summarize(p: HeroPreset): string {
  const bits = [p.player.gender, p.player.age].filter(Boolean)
  const who = bits.length ? bits.join(' · ') : '未填性别年龄'
  const nm = p.player.name || '未命名'
  return `${nm}　${who}`
}

/*
  ══ 主角卡的导出 / 导入 ══

  为什么要做：预设只存在**本机浏览器**里（IndexedDB），所以换电脑、换浏览器、
  清理站点数据都会丢。玩家把主角当"我的角色"来养，丢了会很恼火。

  格式刻意与**世界书导出**（`official-worldbook.json`）保持同一套习惯：
  带 `format` + `version`，将来字段变了也能兼容旧文件。

  ⚠️ 导入的语义是**追加**，不是覆盖：
  每条都分配新 id，label 撞名就加后缀。理由见下 ——
  玩家导入别人的主角包时，绝不该弄丢自己已有的主角。

  ⚠️ 解析与格式常量都搬去了 `utils/heroPresetFile.ts` —— 内嵌在组件里时
  它没法被单测覆盖，而它恰好漏过一次（look / avatar 在导入时被丢掉）。
*/
/** 把若干主角导出成一个 JSON 文件 */
function exportPresets(list: HeroPreset[], filename: string): void {
  downloadFile(filename, {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    exportedAt: new Date().toISOString(),
    count: list.length,
    presets: list,
  })
}

interface ImportResult { added: number; skipped: number; error?: string }

/**
 * 解析导入文件并**追加**到预设列表。
 *
 * 之所以每条都换新 id：`saveHeroPreset` 是按 id upsert 的，
 * 若沿用文件里的 id，导入别人的包就可能**静默覆盖**同 id 的自己人。
 * label 撞名时加「· 导入」后缀，避免列表里出现两个一模一样的名字。
 */
async function importPresets(
  file: File,
  existingLabels: Set<string>,
  save: (p: HeroPreset) => Promise<void>,
): Promise<ImportResult> {
  let data: unknown
  try {
    data = JSON.parse(await readFileAsText(file))
  } catch {
    return { added: 0, skipped: 0, error: '这不是一个合法的 JSON 文件' }
  }

  const raw = extractPresetList(data)
  if (!raw.length) {
    return { added: 0, skipped: 0, error: '文件里没有主角列表（缺少 presets 数组）' }
  }

  let added = 0, skipped = 0
  const taken = new Set(existingLabels)
  for (const item of raw) {
    const player = coercePlayer(item)
    if (!player) { skipped++; continue }
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    let label = (typeof o.label === 'string' && o.label.trim())
      || player.name.trim() || '未命名主角'
    if (taken.has(label)) label = `${label} · 导入`
    let n = 2
    while (taken.has(label)) label = `${label.replace(/ · 导入(\d+)?$/, '')} · 导入${n++}`
    taken.add(label)
    await save({
      id: makeId('hero'),
      label,
      player,
      // 世界相关的选择也带过来（引擎会逐槽校验，对不上的自动退回默认）
      choices: (o.choices && typeof o.choices === 'object') ? o.choices as HeroPreset['choices'] : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    added++
  }
  return { added, skipped }
}

export function HeroPresets({ onBack }: HeroPresetsProps) {
  const presets = useLibraryStore(s => s.heroPresets)
  const loaded = useLibraryStore(s => s.loaded)
  const saveHeroPreset = useLibraryStore(s => s.saveHeroPreset)
  const deleteHeroPreset = useLibraryStore(s => s.deleteHeroPreset)
  const duplicateHeroPreset = useLibraryStore(s => s.duplicateHeroPreset)
  const createHeroPreset = useLibraryStore(s => s.createHeroPreset)
  const navPush = useNavStore(s => s.push)

  /** null = 没在编辑；否则是正在编辑的草稿（含新建） */
  const [draft, setDraft] = useState<{ id: string | null; label: string; player: PlayerCard } | null>(null)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  /** 导入/导出的结果提示（成功与失败共用一条，失败时变红） */
  const [ioFlash, setIoFlash] = useState<{ text: string; bad?: boolean } | null>(null)
  const flashIO = (text: string, bad = false) => {
    setIoFlash({ text, bad })
    setTimeout(() => setIoFlash(null), 4000)
  }

  /** 导出单个主角 */
  const exportOne = (p: HeroPreset) =>
    exportPresets([p], `主角-${safeFilename(p.label)}-${timestampSuffix()}.json`)

  /** 导出全部主角 */
  const exportAll = () =>
    exportPresets(presets, `我的主角-${presets.length}位-${timestampSuffix()}.json`)

  /** 选文件并导入 */
  const importFromPicker = () => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = '.json,application/json'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      const r = await importPresets(f, new Set(presets.map(p => p.label)), saveHeroPreset)
      if (r.error) { flashIO(r.error, true); return }
      const extra = r.skipped ? `，跳过 ${r.skipped} 条无法识别的记录` : ''
      flashIO(r.added ? `已导入 ${r.added} 位主角${extra}` : `没有导入任何主角${extra}`, !r.added)
    }
    inp.click()
  }

  const startNew = () =>
    setDraft({ id: null, label: '', player: { ...EMPTY_PLAYER } })

  const startEdit = (p: HeroPreset) =>
    setDraft({ id: p.id, label: p.label, player: { ...p.player } })

  const patch = (patchIn: Partial<PlayerCard>) =>
    setDraft(d => (d ? { ...d, player: { ...d.player, ...patchIn } } : d))

  const save = async () => {
    if (!draft) return
    const label = draft.label.trim() || draft.player.name.trim() || '未命名主角'
    if (draft.id) {
      // 编辑既有预设：保留它的 choices（那些是世界相关的选择记录）
      const cur = presets.find(p => p.id === draft!.id)
      await saveHeroPreset({
        ...(cur as HeroPreset),
        label,
        player: draft.player,
      })
    } else {
      await createHeroPreset(label, draft.player)
    }
    setDraft(null)
    setSavedFlash(label)
    setTimeout(() => setSavedFlash(null), 2200)
  }

  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col">
      {/* ── 顶栏 ── */}
      <header className="sticky top-0 z-20 border-b border-text-muted/20 bg-background/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-text-muted/40 rounded
              hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors shrink-0"
            title="返回上一级"
          >
            <ChevronLeft size={14} />
            <span className="hidden sm:inline">返回</span>
          </button>
          <UserRound size={20} className="text-accent-lantern flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-serif font-bold tracking-widest text-accent-lantern truncate">我的主角</h1>
            <p className="text-[10px] text-text-muted font-mono truncate">
              {loaded ? `${presets.length} 位主角 · 开局时可直接选用，不必重填` : '正在载入…'}
            </p>
          </div>
          {!draft && (
            <div className="flex items-center gap-1.5 shrink-0">
              {/*
                导入/导出放在顶栏：主角档案只存在本机，换机器或清缓存就会丢，
                所以"带走一份"必须是一眼能看到的动作，而不是藏在某个菜单里。
              */}
              <button
                onClick={importFromPicker}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border
                  border-text-muted/40 hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
                title="从 JSON 文件导入主角（追加，不会覆盖已有的）"
              >
                <Upload size={13} />
                <span className="hidden sm:inline">导入</span>
              </button>
              <button
                onClick={exportAll}
                disabled={presets.length === 0}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border
                  border-text-muted/40 hover:border-accent-lantern/50 hover:text-accent-lantern
                  transition-colors disabled:opacity-30 disabled:hover:border-text-muted/40
                  disabled:hover:text-text-primary"
                title={presets.length ? `把 ${presets.length} 位主角导出成一个文件` : '还没有主角可导出'}
              >
                <Download size={13} />
                <span className="hidden sm:inline">导出全部</span>
              </button>
              <button
                onClick={startNew}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-accent-lantern/50
                  text-accent-lantern hover:bg-accent-lantern/10 transition-colors"
              >
                <Plus size={14} />
                <span className="hidden sm:inline">新建主角</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-5 space-y-4">

          {savedFlash && (
            <div className="flex items-center gap-2 text-xs text-accent-lantern bg-accent-lantern/10
              border border-accent-lantern/30 rounded px-3 py-2">
              <Check size={14} />
              已保存「{savedFlash}」。开新局时会自动套用。
            </div>
          )}

          {ioFlash && (
            <div className={`flex items-center gap-2 text-xs rounded px-3 py-2 border ${
              ioFlash.bad
                ? 'text-red-300 bg-red-500/10 border-red-500/30'
                : 'text-accent-lantern bg-accent-lantern/10 border-accent-lantern/30'
            }`}>
              {ioFlash.bad ? <AlertCircle size={14} /> : <Check size={14} />}
              {ioFlash.text}
            </div>
          )}

          {/*
            编辑区。
            放在列表**上方**而不是弹窗：这些字段里有五个长文本框，
            弹窗在手机上会把可视区压得只剩一两行，写起来很难受。
          */}
          {draft && (
            <motion.section
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg border border-accent-lantern/30 bg-black/20 p-4 space-y-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-serif text-sm text-accent-lantern">
                  {draft.id ? '编辑主角' : '新建主角'}
                </h2>
                <button
                  onClick={() => setDraft(null)}
                  className="p-1 text-text-muted hover:text-text-primary transition-colors"
                  title="取消"
                >
                  <X size={14} />
                </button>
              </div>

              <label className="block space-y-1">
                <span className="text-xs text-text-secondary">预设名（列表里显示，随便起）</span>
                <input
                  className={inputCls}
                  value={draft.label}
                  onChange={e => setDraft(d => (d ? { ...d, label: e.target.value } : d))}
                  placeholder="例如「我的惯用主角」"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block space-y-1 min-w-0">
                  <span className="block text-xs text-text-secondary whitespace-nowrap">姓名</span>
                  <input className={`${inputCls} min-w-0`} value={draft.player.name}
                    onChange={e => patch({ name: e.target.value })} placeholder="你的名字" />
                </label>
                <label className="block space-y-1 min-w-0">
                  <span className="block text-xs text-text-secondary whitespace-nowrap">性别 / 代称</span>
                  <input className={`${inputCls} min-w-0`} value={draft.player.gender}
                    onChange={e => patch({ gender: e.target.value })} placeholder="可留空" />
                </label>
                <label className="block space-y-1 min-w-0">
                  <span className="block text-xs text-text-secondary whitespace-nowrap">年龄</span>
                  <input className={`${inputCls} min-w-0`} value={draft.player.age}
                    onChange={e => patch({ age: e.target.value })} placeholder="可留空" />
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-xs text-text-secondary">外貌</span>
                <textarea className={`${areaCls} h-20`} value={draft.player.appearance}
                  onChange={e => patch({ appearance: e.target.value })}
                  placeholder="AI 会在动作描写里呼应这些特征；也会据此生成立绘。" />
              </label>

              <label className="block space-y-1">
                <span className="text-xs text-text-secondary">性格</span>
                <textarea className={`${areaCls} h-16`} value={draft.player.personality}
                  onChange={e => patch({ personality: e.target.value })} />
              </label>

              <label className="block space-y-1">
                <span className="text-xs text-text-secondary">背景故事</span>
                <textarea className={`${areaCls} h-20`} value={draft.player.background}
                  onChange={e => patch({ background: e.target.value })}
                  placeholder="你的经历、身份、为何出现在这里。" />
              </label>

              <label className="block space-y-1">
                <span className="text-xs text-text-secondary">其他补充</span>
                <textarea className={`${areaCls} h-14`} value={draft.player.extra}
                  onChange={e => patch({ extra: e.target.value })}
                  placeholder="任何希望 AI 知道的事。" />
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={save}
                  disabled={!draft.label.trim() && !draft.player.name.trim()}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent-lantern/20
                    border border-accent-lantern/50 text-accent-lantern hover:bg-accent-lantern/30
                    transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Check size={14} />
                  保存
                </button>
                <span className="text-[10px] text-text-muted">
                  至少要填一个「预设名」或「姓名」
                </span>
              </div>
            </motion.section>
          )}

          {/* ── 列表 / 空状态 ── */}
          {presets.length === 0 && !draft ? (
            <div className="rounded-lg border border-dashed border-text-muted/30 px-6 py-12 text-center space-y-3">
              <UserRound size={28} className="mx-auto text-text-muted/60" />
              <p className="text-sm text-text-secondary font-serif">还没有设定过主角</p>
              <p className="text-xs text-text-muted leading-relaxed max-w-md mx-auto">
                在这里先把主角设好存下来，之后每次开新游戏都能一键套用，
                不必重复填名字、外貌与来历。同一个主角可以拿去任何世界开局。
              </p>
              <button
                onClick={startNew}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs rounded border
                  border-accent-lantern/50 text-accent-lantern hover:bg-accent-lantern/10 transition-colors"
              >
                <Plus size={14} />
                设定第一位主角
              </button>
            </div>
          ) : (
            <ul className="space-y-2">
              {presets.map(p => (
                <li key={p.id}>
                  <div className="rounded-lg border border-text-muted/25 bg-black/20 px-4 py-3
                    flex items-start gap-3 hover:border-accent-lantern/40 transition-colors">
                    <div className="w-9 h-9 rounded-full bg-accent-lantern/10 border border-accent-lantern/30
                      flex items-center justify-center shrink-0 mt-0.5">
                      <UserRound size={16} className="text-accent-lantern" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-serif text-sm text-text-primary truncate">{p.label}</span>
                        <span className="text-[10px] text-text-muted font-mono">{summarize(p)}</span>
                      </div>
                      {p.player.appearance && (
                        <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-2 mt-1">
                          {p.player.appearance}
                        </p>
                      )}
                      {p.player.background && (
                        <p className="text-[11px] text-text-muted leading-relaxed line-clamp-1 mt-0.5">
                          {p.player.background}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { navPush({ name: 'library', intent: 'play' }) }}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border
                          border-accent-lantern/40 text-accent-lantern hover:bg-accent-lantern/10 transition-colors"
                        title="挑一个世界，用这位主角开局"
                      >
                        <Sparkles size={12} />
                        开局
                      </button>
                      <button
                        onClick={() => startEdit(p)}
                        className="p-1.5 text-text-muted hover:text-accent-lantern transition-colors"
                        title="编辑"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => duplicateHeroPreset(p.id)}
                        className="p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                        title="复制一份"
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        onClick={() => exportOne(p)}
                        className="p-1.5 text-text-muted hover:text-accent-lantern transition-colors"
                        title="导出这一位主角（JSON）"
                      >
                        <Download size={13} />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`删除「${p.label}」？这不会影响任何已开始的游戏。`)) {
                            deleteHeroPreset(p.id)
                          }
                        }}
                        className="p-1.5 text-text-muted hover:text-red-400 transition-colors"
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[10px] text-text-muted/80 leading-relaxed pt-1">
            主角预设保存在本机浏览器里，不会上传。它只记主角档案；
            某一局选的出身、属性点这类**世界相关**的选择，会在你用它开局时
            尽量沿用同一个世界里记过的选择，换世界则自动退回默认。
          </p>
        </div>
      </main>
    </div>
  )
}
