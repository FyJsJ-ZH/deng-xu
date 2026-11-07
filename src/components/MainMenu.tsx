import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Play, BookOpen, Library, Settings, ChevronRight, ScrollText, Sparkles, Clock, X, UserRound, Feather,
} from 'lucide-react'
import { useGameStore } from '@/stores/game'
import { useSessionStore } from '@/stores/session'
import { useLibraryStore } from '@/stores/library'
import { useUIStore } from '@/stores/ui'
import { listRecent, forgetPlay, relativeTime, type RecentPlay } from '@/utils/recentPlays'

/**
 * 主菜单 —— 打开网站后的第一屏。
 *
 * 为什么要有它：
 *  之前打开网站**直接就是世界书卡片墙**，一种"门户大开"的感觉：
 *  玩家一眼看到九张卡、一堆导入导出按钮，却不知道从哪开始，
 *  也不知道自己上次玩到哪了。卡片墙是"资料库"，不该当门厅用。
 *
 *  主菜单只回答三个问题：**继续玩 / 开新局 / 看设定**，
 *  其余（卡库管理、导入导出、世界包、存档）都收进二级入口。
 */
export interface MainMenuProps {
  onContinue: () => void
  onNewGame: () => void
  onWorldbook: () => void
  onLibrary: () => void
  /** 打开「我的主角」——提前设定主角，开局直接选用 */
  onHeroes: () => void
  /** 打开「叙事预设」——换文风 / 写作规则，全局生效 */
  onPresets: () => void
  onOpenSettings: () => void
  /** 点「最近玩过」里的某一条 → 直接用它开局 */
  onPickWorld: (worldId: string) => void
}

export function MainMenu({
  onContinue, onNewGame, onWorldbook, onLibrary, onHeroes, onPresets, onOpenSettings, onPickWorld,
}: MainMenuProps) {
  const world = useSessionStore(s => s.world)
  const history = useGameStore(s => s.history)
  const characters = useGameStore(s => s.characters)
  const playerName = useGameStore(s => s.playerName)
  const worlds = useLibraryStore(s => s.worlds)
  const loaded = useLibraryStore(s => s.loaded)
  const llm = useUIStore(s => s.llm)

  const needsKey = !llm.apiKey && llm.provider !== 'ollama'
  const hasProgress = history.length > 0
  const canContinue = !!world && (hasProgress || characters.length > 0)

  /**
   * 「我的主角」副标题要**如实反映有没有预设** ——
   * 一个空功能的入口写着"管理你的主角"会让人点进去发现什么都没有。
   * 所以没有预设时直接把它当成"去设一个"的邀请。
   */
  const presets = useLibraryStore(s => s.heroPresets)
  const heroDesc = !loaded
    ? '载入中…'
    : presets.length === 0
      ? '还没有设定过主角，点这里先设一个'
      : `${presets.length} 位主角，开新局可直接选用`

  /**
   * 「叙事预设」的副标题。
   *
   * 它必须写明**当前是不是启用中** —— 这一项的破坏力全在"悄悄生效"上：
   * 玩家几个月前导入过一份文风预设、后来忘了，会一直觉得"模型怎么越写越怪"。
   * 所以没启用时也明说"未启用"，而不是只报个数。
   */
  const narrativePresets = useLibraryStore(s => s.narrativePresets)
  const activePresetId = useLibraryStore(s => s.activeNarrativePresetId)
  const activePreset = narrativePresets.find(p => p.id === activePresetId)
  const presetDesc = !loaded
    ? '载入中…'
    : narrativePresets.length === 0
      ? '还没有预设，可导入 SillyTavern 写作预设'
      : activePreset
        ? `启用中：${activePreset.name}`
        : `未启用（${narrativePresets.length} 份可选）`

  /**
   * 「最近玩过」。
   *
   * 与上面那张「继续游戏」卡的区别必须让玩家看出来，否则会以为点了能读档：
   *   - 继续游戏 = 回到**当前存档**（唯一一局，能接着玩）
   *   - 最近玩过 = **曾玩过的世界**（多条，点了是拿这个世界的设定开新一局）
   *
   * 所以这里的措辞用「再来一局」而不是「继续」。
   */
  const [recent, setRecent] = useState<RecentPlay[]>([])
  const refreshRecent = useCallback(() => setRecent(listRecent()), [])
  useEffect(() => { refreshRecent() }, [refreshRecent])
  const worldIds = useMemo(() => new Set(worlds.map(w => w.id)), [worlds])
  // 当前存档所在的世界不重复显示（上面那张卡已经代表了它）
  const recentToShow = recent.filter(r => r.worldId !== world?.id).slice(0, 4)

  const [lastLine, setLastLine] = useState('')
  useEffect(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant' && history[i].content.trim()) {
        setLastLine(history[i].content.replace(/[#*`>]/g, '').trim().slice(-70))
        return
      }
    }
    setLastLine('')
  }, [history])

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-10 md:py-16">
      {/* 标题 */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center mb-10"
      >
        <h1 className="font-serif font-bold tracking-[0.35em] text-3xl md:text-4xl text-accent-lantern mb-3">
          灯叙
        </h1>
        <p className="text-xs text-text-muted leading-relaxed">
          题材无关的 AI 文字冒险引擎
          <span className="mx-2 text-text-muted/40">·</span>
          世界观与角色卡完全自定义
        </p>
      </motion.div>

      {/* 未配置模型时的提示 —— 这是新玩家最容易卡住的地方，放在最显眼处 */}
      {needsKey && (
        <button
          onClick={onOpenSettings}
          className="w-full mb-4 flex items-start gap-3 p-4 rounded-lg border border-accent-forge/50 bg-accent-forge/[0.07] text-left hover:bg-accent-forge/[0.12] transition-colors"
        >
          <Settings size={18} className="text-accent-forge mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-accent-forge font-bold mb-0.5">先配置模型，才能开始游戏</div>
            <p className="text-[11px] text-text-muted leading-relaxed">
              需要填入你自己的 API Key（支持 DeepSeek / OpenAI / 硅基流动 / OpenRouter / 本地 Ollama）。
              Key 只保存在你的浏览器里，不经过任何第三方服务器。
            </p>
          </div>
          <ChevronRight size={16} className="text-accent-forge/60 mt-0.5 shrink-0" />
        </button>
      )}

      {/* 继续游戏 —— 有进度时放在最上面，这是回头玩家最想要的 */}
      {canContinue && (
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          onClick={onContinue}
          className="w-full mb-3 p-5 rounded-lg border border-accent-lantern/50 bg-accent-lantern/[0.08] hover:bg-accent-lantern/[0.14] transition-colors text-left group"
        >
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-full bg-accent-lantern/15 border border-accent-lantern/40 flex items-center justify-center shrink-0">
              <Play size={18} className="text-accent-lantern translate-x-[1px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-lantern/20 text-accent-lantern border border-accent-lantern/40">
                  {hasProgress ? '进行中' : '尚未开场'}
                </span>
                <span className="font-serif font-bold text-base text-text-primary truncate">
                  {world?.title}
                </span>
              </div>
              <div className="text-[11px] text-text-muted font-mono truncate">
                {playerName && <>扮演 {playerName}　·　</>}
                {hasProgress ? `已记录 ${history.length} 条` : '开场还没生成'}
              </div>
              {lastLine && (
                <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-1 font-serif mt-1">
                  …{lastLine}
                </p>
              )}
            </div>
            <ChevronRight size={18} className="text-accent-lantern/50 shrink-0 group-hover:translate-x-0.5 transition-transform" />
          </div>
        </motion.button>
      )}

      {/*
        四个入口，各自**职责不同**（原先「开始新游戏/世界书/卡片库」三个
        点进去是同一个卡片墙，等于三个入口一个功能）：
          · 开始新游戏 —— 选世界 → 直接进选角（选角里可一键套用主角预设）
          · 我的主角   —— 提前把主角设好、存成预设，开局不必重填
          · 世界书     —— 只读地翻内置世界的设定集
          · 卡片库     —— 管理/导入导出/编辑你自己的卡
      */}
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <MenuCard
          icon={<Sparkles size={18} className="text-accent-lantern" />}
          title="开始新游戏"
          desc="挑一个世界，设定你的身份，然后开讲"
          onClick={onNewGame}
          primary
          delay={0.1}
        />
        <MenuCard
          icon={<UserRound size={18} className="text-accent-lantern" />}
          title="我的主角"
          desc={heroDesc}
          onClick={onHeroes}
          delay={0.15}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <MenuCard
          icon={<BookOpen size={18} className="text-text-muted" />}
          title="世界书"
          desc={`${loaded ? worlds.filter(w => w.builtin).length : '…'} 个内置世界，翻设定、看地图与势力`}
          onClick={onWorldbook}
          delay={0.2}
        />
        <MenuCard
          icon={<Library size={18} className="text-text-muted" />}
          title="卡片库"
          desc="管理世界卡与角色卡，导入导出与备份"
          onClick={onLibrary}
          delay={0.25}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <MenuCard
          icon={<Settings size={18} className="text-text-muted" />}
          title="模型设置"
          desc={needsKey ? '尚未配置，点此填写' : `${llm.narrativeModel}`}
          onClick={onOpenSettings}
          warn={needsKey}
          delay={0.3}
        />
        <MenuCard
          icon={<Feather size={18} className="text-text-muted" />}
          title="叙事预设"
          desc={presetDesc}
          onClick={onPresets}
          delay={0.35}
        />
      </div>

      {/*
        「最近玩过」。
        存档只保留当前这一局，开新局就覆盖 —— 所以单局存档回答不了
        "我玩过哪些世界"。这条历史跨局存在，回头玩家不用去卡片库里翻。
      */}
      {recentToShow.length > 0 && (
        <div className="mt-8">
          <div className="flex items-baseline gap-2 mb-3">
            <Clock size={13} className="text-text-muted" />
            <h2 className="text-xs font-serif font-bold text-text-secondary">最近玩过</h2>
            <span className="text-[10px] text-text-muted/70">点一条即用该世界开新一局</span>
          </div>
          <div className="space-y-1.5">
            {recentToShow.map(r => {
              const gone = !worldIds.has(r.worldId)
              return (
                <div key={r.worldId} className="group relative">
                  <button
                    onClick={() => !gone && onPickWorld(r.worldId)}
                    disabled={gone}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded border text-left transition-colors
                      ${gone
                        ? 'border-text-muted/15 bg-black/10 cursor-not-allowed opacity-50'
                        : 'border-text-muted/25 bg-black/20 hover:border-accent-lantern/40 hover:bg-accent-lantern/[0.06]'}`}
                  >
                    <span className="font-serif text-sm text-text-primary truncate flex-1">{r.title}</span>
                    <span className="text-[10px] text-text-muted font-mono shrink-0">
                      {r.turns > 0 ? `${r.turns} 条` : '未开场'}
                      <span className="mx-1.5 text-text-muted/40">·</span>
                      {relativeTime(r.at)}
                      {gone && <span className="ml-1.5 text-red-400/70">世界卡已删除</span>}
                    </span>
                    {!gone && <ChevronRight size={13} className="text-text-muted/50 shrink-0 group-hover:translate-x-0.5 transition-transform" />}
                  </button>
                  <button
                    onClick={() => { forgetPlay(r.worldId); refreshRecent() }}
                    title="从最近玩过中移除"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded text-text-muted/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 底部说明 */}
      <div className="mt-10 pt-6 border-t border-text-muted/15 text-[10px] text-text-muted/70 leading-relaxed text-center space-y-1">
        <p>进度与卡片都保存在你自己的浏览器里，不会上传到任何服务器。</p>
        <p>像素素材来自 Universal LPC Spritesheet Generator，署名见「卡片库 → 素材署名」。</p>
      </div>
    </div>
  )
}

/** 主菜单上的一张入口卡 */
function MenuCard({
  icon, title, desc, onClick, primary = false, warn = false, delay = 0,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
  primary?: boolean
  warn?: boolean
  delay?: number
}) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      onClick={onClick}
      className={`p-4 rounded-lg border text-left transition-colors group
        ${warn
          ? 'border-accent-forge/50 bg-accent-forge/[0.06] hover:bg-accent-forge/[0.12]'
          : primary
            ? 'border-accent-lantern/40 bg-accent-lantern/[0.06] hover:bg-accent-lantern/[0.12]'
            : 'border-text-muted/25 bg-black/20 hover:border-text-muted/50'}`}
    >
      <div className="flex items-center gap-2.5 mb-1.5">
        <span className="shrink-0">{icon}</span>
        <span className="font-serif font-bold text-sm text-text-primary">{title}</span>
        <ChevronRight size={14} className="ml-auto text-text-muted/50 shrink-0 group-hover:translate-x-0.5 transition-transform" />
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">{desc}</p>
    </motion.button>
  )
}

/** 供主菜单之外复用的"返回主菜单"按钮 */
export function BackToMenuButton({ onClick, label = '返回主菜单' }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
    >
      <ScrollText size={14} /> {label}
    </button>
  )
}

/** 卡片库页顶部的小统计条 */
export function LibraryStats() {
  const worlds = useLibraryStore(s => s.worlds)
  const chars = worlds.reduce((n, w) => n + (w.characters?.length || 0), 0)
  return (
    <span className="text-[10px] text-text-muted font-mono">
      {worlds.length} 个世界
      <span className="mx-1 text-text-muted/40">·</span>
      {chars} 张角色卡
    </span>
  )
}
