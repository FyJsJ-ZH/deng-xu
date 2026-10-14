import { useEffect, useMemo, useRef, useState, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Upload, Download, Settings, Trash2, Copy, Pencil, Play,
  Users, Sliders, BookOpen, Layers, AlertTriangle, ChevronLeft, Eye, Search, X
} from 'lucide-react'
import { useLibraryStore } from '@/stores/library'
import { useUIStore } from '@/stores/ui'
import { useGameStore } from '@/stores/game'
import { useSessionStore } from '@/stores/session'
import { TutorialModal } from '@/components/TutorialModal'
import { ApiKeyModal } from '@/components/ApiKeyModal'
import { SessionSetup } from '@/components/SessionSetup'
import { lazyWithRetry } from '@/utils/lazyWithRetry'
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary'
import { SaveManager } from '@/components/SaveManager'
import { WorldPackManager } from '@/components/WorldPackManager'
import { MainMenu } from '@/components/MainMenu'
import { HeroPresets } from '@/components/HeroPresets'
import { useNavStore } from '@/stores/nav'
import { WorldbookPreview } from '@/components/WorldbookPreview'

/**
 * 世界卡编辑器懒加载。
 * 它是全项目最大的单个组件（含酒馆卡解析、头像生成、五个页签的表单），
 * 但只有用户点「新建/编辑世界卡」时才需要 —— 不该压在首屏。
 */
const CardEditor = lazyWithRetry(() =>
  import('@/components/CardEditor').then(m => ({ default: m.CardEditor }))
)
import { downloadFile, readFileAsText, timestampSuffix } from '@/utils/files'
import type { CardBundle, WorldCard } from '@/types/cards'

/**
 * 卡库首页
 *
 * 原版这里是一个写死剧本的封面页（1900 年代伦敦 + 三个固定出身）。
 * 现在它是一张张「世界卡」的卡片墙：任何题材都只是库里的一个条目。
 */
export function StartScreen() {
  const { worlds, loaded, loadError, loadWorlds, deleteWorld, duplicateWorld, importWorlds } = useLibraryStore()
  const { setCardEditorOpen, setEditingWorldId, setApiKeyModalOpen, showTutorial, setShowTutorial, llm, pendingSetup, setPendingSetup } = useUIStore()
  const { resetGame, startGame, isGameStarted } = useGameStore()
  const clearSession = useSessionStore(s => s.clearSession)

  const [setupWorldId, setSetupWorldId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmResume, setConfirmResume] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  /**
   * 首页层级。
   *
   * 之前打开网站**直接就是世界书卡片墙** —— 一种"门户大开"的感觉：
   * 新玩家一眼看到九张卡与一堆导入导出按钮，不知道自己该从哪开始，
   * 也看不出上次玩到哪了。卡片墙本质是"资料库"，不该当门厅。
   *
   * 现在：menu（主菜单）→ library（选世界开新局 / 卡片库）| worldbook（看设定）
   *
   * ⚠️ 这套层级**放在 navStore 里而不是这里**：
   *  手机返回键需要知道"上一级是什么"才能逐级后退。
   *  层级藏在组件内部状态里时，返回键没有任何东西可退，
   *  只能一路穿透回浏览器主页 —— 这个问题被玩家反馈了两次。
   */
  const view = useNavStore(s => s.view)
  const navPush = useNavStore(s => s.push)
  const navBack = useNavStore(s => s.back)
  /**
   * 卡片墙的**用途**。三个入口原先都 push 同一个 `{ name: 'library' }`，
   * 所以点哪个进去都一样、三个入口等于一个。现在由 intent 决定这一屏做什么：
   *   play / worldbook / library
   *
   * ⚠️ 还要认 `setup` 那一层带的 intent。
   * 从选角按「返回卡库」时 `nav.back()` 是异步的（history.back()），
   * 而清空选角状态是同步的 —— 中间那一下 DOM 已经回到卡片墙，
   * 但 `view` 仍是 setup。若此时只认 library，标题会从
   * 「开始新游戏」错闪成「卡片库」（实测就是这个现象）。
   */
  const libraryIntent: 'play' | 'worldbook' | 'library' =
    view.name === 'library'
      ? (view.intent ?? (view.worldbookMode ? 'worldbook' : 'library'))
      : view.name === 'setup'
        ? (view.intent ?? 'play')
        : 'library'
  const worldbookMode = libraryIntent === 'worldbook'
  /** 正在预览的世界卡 id —— 就是 worldbook 这一层本身携带的 */
  const previewId = view.name === 'worldbook' ? view.worldId : null
  /**
   * 世界书搜索与筛选。
   * 内置世界到 9 个之后列表已经变长，用户再导入几十张就会很难找 ——
   * 搜索与筛选必须和"能看到详情"一起提供。
   */
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'builtin' | 'mine' | 'mechanics' | 'narrative'>('all')

  useEffect(() => {
    loadWorlds()
  }, [loadWorlds])

  /**
   * 经过搜索与筛选之后要显示的世界卡。
   *
   * 搜索范围刻意放宽到**世界观正文与规则**：找"有没有那种带魔法的世界"时，
   * 关键词往往只出现在正文里，而不在标题或简介中。
   * 但正文很长，只取前 2000 字参与匹配，避免每次输入都全文扫描。
   */
  const visibleWorlds = useMemo(() => {
    let list = worlds
    if (worldbookMode) list = list.filter(w => w.builtin)
    if (filter === 'builtin') list = list.filter(w => w.builtin)
    else if (filter === 'mine') list = list.filter(w => !w.builtin)
    else if (filter === 'mechanics') list = list.filter(w => w.enableMechanics)
    else if (filter === 'narrative') list = list.filter(w => !w.enableMechanics)

    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(w => {
      const hay = [
        w.title, w.tagline,
        (w.worldLore || '').slice(0, 2000),
        w.rules || '',
        w.story?.mainQuest || '',
        ...(w.characters || []).map(c => c.name),
        ...(w.attributes || []).map(a => a.name),
      ].join('\n').toLowerCase()
      return hay.includes(q)
    })
  }, [worlds, worldbookMode, filter, query])

  // 首次进入时的引导
  useEffect(() => {
    if (!localStorage.getItem('hasSeenTutorial')) {
      const t = setTimeout(() => setShowTutorial(true), 800)
      return () => clearTimeout(t)
    }
  }, [setShowTutorial])

  const closeTutorial = () => {
    setShowTutorial(false)
    localStorage.setItem('hasSeenTutorial', 'true')
  }

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3200)
  }

  /**
   * 待配置的世界卡：优先用编辑器直接带来的对象（新卡可能刚落库，按 id 也能查到），
   * 查不到时退回 pendingSetup，绝不出现「空的世界卡」。
   */
  const setupWorld = useMemo(() => {
    if (pendingSetup?.world) return pendingSetup.world
    if (setupWorldId) return worlds.find(w => w.id === setupWorldId) || null
    return null
  }, [pendingSetup, setupWorldId, worlds])

  /**
   * 可继续的存档。
   *
   * 刷新后 isGameStarted 会被重置（故意的，见 game store 的 partialize），
   * 但 localStorage 里的存档其实一直都在：session 存了世界卡与玩家，
   * game 存了对话历史与全部数值。所以这里只要把它们读出来就能「继续」，
   * 完全不需要重新生成剧情。
   */
  // 注意：这里逐个字段取值，不要返回新对象。
  // zustand v4 用 Object.is 比较选择器结果，返回新对象会导致无限重渲染。
  const history = useGameStore(s => s.history)
  const gameTime = useGameStore(s => s.time)
  const saveLocation = useGameStore(s => s.location)
  const savedPlayerName = useGameStore(s => s.playerName)
  // 用于判断"这一局是否真的有内容"——开场生成失败时 history 为空，但在场角色已经写好了
  const characters = useGameStore(s => s.characters)
  const inventory = useGameStore(s => s.inventory)
  const sessionWorld = useSessionStore(s => s.world)

  /**
   * 是否显示「继续」入口。
   *
   * 原先要求 `history.length > 0`（至少推进过一轮）—— 但那会留下一个**死路**：
   * 如果开场生成失败（API Key 无效、余额不足、网络抖动），history 就是 0，
   * 而 session、在场角色、开局物品其实都已经写好了。
   * 玩家此时回到标题页会发现自己**没有任何办法回到那一局**，
   * 只能重新开一局 —— 明明点一下重试就能开始。
   *
   * 所以判据放宽：只要有会话（世界卡）就允许回去，
   * 一句叙事都没有时把文案改成「重新开始本局」而不是「继续游戏」。
   *
   * ⚠️ **2026-10 再修一次**：原先的兜底是 `characters.length > 0`，
   * 而那个条件**靠「角色卡预设为在场」撑着** —— 玩家一进选角页，
   * `present: true` 的角色就被默认勾上，于是"没有任何叙事"时它仍然成立。
   * 现在所有预设 NPC 都改成了 `present: false`（用户要求：谁在场由玩家勾选
   * 或由 AI 在开场现场决定），兜底随之失效 ——
   * **"开局过、但没勾角色、第一轮又失败"就再也回不去了**，
   * 正是这段注释开头想避免的那条死路，从另一个方向又出现了一次。
   *
   * 所以判据换成**玩家自己留下的痕迹**：叙事、在场角色、开局物品、主角档案，
   * 任一项存在就说明这一局真的开过。它们全部来自玩家的操作，
   * 不依赖任何预设默认值 —— 这样上层改再多次默认值也不会把它弄塌。
   */
  const hasSession = !!sessionWorld
  const hasProgress = history.length > 0
  const hasTrace = hasProgress
    || characters.length > 0
    || inventory.length > 0
    || !!String(savedPlayerName || '').trim()
  const canResume = hasSession && hasTrace

  const lastNarrative = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant' && history[i].content.trim()) return history[i].content.trim()
    }
    return ''
  }, [history])

  /** 存档时间：取最后一条消息的时间戳 */
  const savedAtLabel = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const ts = history[i].timestamp
      if (ts) {
        const d = new Date(ts)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      }
    }
    return ''
  }, [history])

  const fmtTime = (t: typeof gameTime) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}`
  }

  /** 继续上次的进度：状态本来就在，只需要重新打开游戏界面 */
  const handleResume = () => {
    setPendingSetup(null)
    setSetupWorldId(null)
    startGame()
  }

  /** 放弃当前存档，从头开始（真正清掉历史与数值） */
  const handleDiscardSave = () => {
    resetGame()
    clearSession()
    setConfirmResume(false)
    flash('已清除存档，可以重新开始了。')
  }

  const needsKey = !llm.apiKey && llm.provider !== 'ollama'

  // —— 导入 / 导出 ——

  const handleImport = async (files: FileList | null) => {
    if (!files?.length) return
    const collected: WorldCard[] = []
    let failed = 0

    for (const file of Array.from(files)) {
      try {
        const text = await readFileAsText(file)
        const parsed = JSON.parse(text)

        // 支持三种形态：单卡、卡包 bundle、卡数组
        if (parsed && typeof parsed === 'object' && parsed.format === 'pale-notes-bundle') {
          const bundle = parsed as CardBundle
          if (bundle.world) collected.push(bundle.world)
          else failed++
        } else if (Array.isArray(parsed)) {
          collected.push(...parsed.filter((w: any) => w && typeof w === 'object' && w.title))
        } else if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
          collected.push(parsed as WorldCard)
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }

    if (!collected.length) {
      flash('导入失败：没有识别到世界卡（请选择导出的 .world.json 或卡包文件）。')
      return
    }

    const imported = await importWorlds(collected)
    flash(`已导入 ${imported.length} 张世界卡${failed ? `，${failed} 个文件无法识别` : ''}。`)
  }

  const handleExportAll = () => {
    downloadFile(
      `world-cards-${timestampSuffix()}.json`,
      { format: 'pale-notes-bundle', version: 1, exportedAt: new Date().toISOString(), characters: [], world: undefined, worlds },
      'application/json'
    )
    flash(`已导出 ${worlds.length} 张世界卡。`)
  }

  /**
   * 点「开始」进入选角界面时，**先把上一局的残留清掉**。
   *
   * 这里才是 resetGame() 该待的地方。原先它被放在 handleLaunch（也就是
   * SessionSetup 填完所有数据、点了「开始故事」之后）—— 而 resetGame 是
   * `set({ ...INITIAL_STATE })`，会把整个 gameStore 清空。于是 SessionSetup
   * 辛苦写入的一切**全部作废**：
   *
   *   initFromWorld()      → 属性/资源定义        ✗ 被清
   *   setAspects()         → 分配好的属性点        ✗ 被清
   *   setResources()       → 资源初始值            ✗ 被清
   *   addItem() × N        → 开局物品（背景自带）  ✗ 被清
   *   addCharacter() × N   → 在场角色              ✗ 被清  ← NPC 立绘"没实现"的真相
   *   setPlayerProfile()   → 玩家档案              ✗ 被清  ← 状态栏「未命名」的真相
   *   setTime/setLocation()→ 起始时空              ✗ 被清
   *
   * 我上次只补救了 playerName，没看出其他数据同样被清 —— 所以「预设数值与物品
   * 没带进游戏」和「状态栏未命名」其实是同一个 bug 的不同表现。
   *
   * 正确的时序：**清空 → 进入选角 → 填数据 → 开始**。
   * 清空必须在选角之前，而不是之后。
   */
  const beginSetup = (worldId: string) => {
    resetGame()
    setPendingSetup(null)
    setSetupWorldId(worldId)
    // 把"选角"也记成一个层级，返回键才能从选角退回上一级。
    // 带上 intent：返回时那一瞬间 view 还是 setup，靠它才不至于把
    // 标题错闪成「卡片库」（见 libraryIntent 的注释）。
    navPush({ name: 'setup', worldId, intent: libraryIntent === 'worldbook' ? 'worldbook' : 'play' })
  }

  const handleLaunch = () => {
    if (!setupWorld) return
    /*
      这里**不要**再调 resetGame()：SessionSetup 已经把本局数据都写好了，
      再重置一次就会把它们清掉（见 beginSetup 的说明）。
      上一局的残留已在进入选角时清掉。

      也**不能**调 clearSession()：SessionSetup 已用 setSession() 写好本局会话，
      再清一次会把 world 抹成 null，于是 isGameStarted 为真而 session.world 为空，
      游戏界面卡在「尚未选择世界卡」且没有任何办法回到正常流程。
    */
    setPendingSetup(null)
    startGame()
    // 进入游戏界面 = 最深的一层，返回键要从这里逐级退回主菜单
    navPush({ name: 'game' })
  }

  if (isGameStarted) return null

  /*
    会话配置独立成一屏。
    显示条件必须**跟随路由层级**（view.name === 'setup'）而不只是 `setupWorld` ——
    否则用返回键从选角退回时 `setupWorldId` 还留着，SessionSetup 会继续渲染，
    看起来就是"返回键在选角界面没反应"。
  */
  if (setupWorld && view.name === 'setup') {
    return (
      <SessionSetup
        world={setupWorld}
        onCancel={() => {
          setSetupWorldId(null)
          setPendingSetup(null)
          // 从选角返回上一级（卡片库/世界书），而不是直接跳回主菜单
          navBack()
        }}
        onLaunch={handleLaunch}
      />
    )
  }

  /*
    「我的主角」独立一屏。放在选角之前而不是塞进选角里：
    它的定位是"提前设好"，与"这一局怎么开"是两件事，
    混在一起会让选角页更长、也更难找。
  */
  if (view.name === 'heroes') {
    return <HeroPresets onBack={() => navBack()} />
  }

  /** 主菜单视图：不渲染卡片墙，只有若干入口 */
  if (view.name === 'menu') {
    return (
      <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col relative">
        <div className="absolute inset-0 bg-neutral-900 opacity-[0.04] pointer-events-none" />
        <ApiKeyModal />
        <AnimatePresence>{showTutorial && <TutorialModal onClose={closeTutorial} />}</AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[96] px-4 py-2 bg-black/90 border border-accent-lantern/40 text-accent-lantern text-xs rounded shadow-xl max-w-[90vw]"
          >
            {toast}
          </motion.div>
        )}
        <main className="relative z-10 flex-1 overflow-y-auto">
          <MainMenu
            onContinue={handleResume}
            onNewGame={() => navPush({ name: 'library', intent: 'play' })}
            onWorldbook={() => navPush({ name: 'library', intent: 'worldbook' })}
            onLibrary={() => navPush({ name: 'library', intent: 'library' })}
            onHeroes={() => navPush({ name: 'heroes' })}
            onOpenSettings={() => setApiKeyModalOpen(true)}
            onPickWorld={id => beginSetup(id)}
          />
        </main>
      </div>
    )
  }

  /** 世界书预览：只读地看一个世界的全部设定 */
  const previewWorld = previewId ? worlds.find(w => w.id === previewId) : null
  if (view.name === 'worldbook' && previewWorld) {
    return (
      <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col relative">
        <div className="absolute inset-0 bg-neutral-900 opacity-[0.04] pointer-events-none" />
        <ApiKeyModal />
        <main className="relative z-10 flex-1 overflow-y-auto">
          <WorldbookPreview
            world={previewWorld}
            isBuiltin={previewWorld.builtin}
            onBack={navBack}
            onEdit={() => { setEditingWorldId(previewWorld.id); setCardEditorOpen(true) }}
            onStart={() => {
              setSetupWorldId(previewWorld.id)
              // 从详情页起局：详情页可能是从「开始新游戏」或「世界书」进来的，
              // 把来源原样透传给选角，返回时才回得去该去的那一屏
              navPush({ name: 'setup', worldId: previewWorld.id, intent: libraryIntent })
            }}
          />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col relative">
      <div className="absolute inset-0 bg-neutral-900 opacity-[0.04] pointer-events-none" />
      <ApiKeyModal />
      <AnimatePresence>{showTutorial && <TutorialModal onClose={closeTutorial} />}</AnimatePresence>
      <ChunkErrorBoundary label="卡片编辑器加载失败">
        <Suspense fallback={null}>
          <CardEditor />
        </Suspense>
      </ChunkErrorBoundary>

      {/* 顶栏 */}
      <header className="relative z-10 flex items-center justify-between gap-4 px-6 py-4 border-b border-text-muted/20">
        <div className="flex items-center gap-3 min-w-0">
          {/*
            返回主菜单。之前打开网站就是这一屏，没有"上一层"可回；
            加上主菜单之后，这里必须给出回去的路。
          */}
          <button
            onClick={() => navPush({ name: 'menu' })}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors shrink-0"
            title="返回主菜单"
          >
            <ChevronLeft size={14} />
            <span className="hidden sm:inline">主菜单</span>
          </button>
          <Layers size={20} className="text-accent-lantern flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="font-serif font-bold tracking-widest text-accent-lantern truncate">
                {libraryIntent === 'play' ? '开始新游戏' : libraryIntent === 'worldbook' ? '世界书' : '卡片库'}
              </h1>
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent-forge/50 text-accent-forge whitespace-nowrap flex-shrink-0">
                Z测试版
              </span>
            </div>
            <p className="text-[10px] text-text-muted font-mono truncate">
              {libraryIntent === 'play'
                ? (loaded ? `选一个世界开局 · 共 ${worlds.length} 张卡` : '正在载入世界卡…')
                : libraryIntent === 'worldbook'
                  ? (loaded ? `${worlds.filter(w => w.builtin).length} 个内置世界，点卡片看详情` : '正在载入世界书…')
                  : (loaded ? `${worlds.length} 张世界卡，可编辑与导入导出` : '正在载入卡库…')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setApiKeyModalOpen(true)}
            className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors
              ${needsKey
                ? 'border-accent-forge/50 text-accent-forge hover:bg-accent-forge/10'
                : 'border-text-muted/40 text-text-muted hover:text-accent-lantern hover:border-accent-lantern/40'}`}
            title="模型设置"
          >
            <Settings size={14} />
            {needsKey ? '未配置模型' : llm.narrativeModel}
          </button>
          <button
            onClick={() => importRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
          >
            <Upload size={14} /> <span className="hidden sm:inline">导入</span>
          </button>
          <input ref={importRef} type="file" multiple accept=".json,application/json" className="hidden"
            onChange={e => { handleImport(e.target.files); e.target.value = '' }} />
          <button
            onClick={handleExportAll}
            disabled={!worlds.length}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors disabled:opacity-40"
          >
            <Download size={14} /> 导出全部
          </button>
          <button
            onClick={() => { setEditingWorldId(null); setCardEditorOpen(true) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
          >
            <Plus size={14} /> <span className="hidden sm:inline">新建世界卡</span>
          </button>
        </div>
      </header>

      {/* 提示条 */}
      {loadError && (
        <div className="relative z-10 flex items-start gap-2 px-6 py-2 text-xs bg-accent-forge/10 border-b border-accent-forge/30 text-accent-forge">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{loadError}</span>
        </div>
      )}
      {needsKey && !loadError && (
        <div
          onClick={() => setApiKeyModalOpen(true)}
          className="relative z-10 flex items-start gap-2 px-6 py-2 text-xs bg-accent-forge/10 border-b border-accent-forge/30 text-accent-forge cursor-pointer hover:bg-accent-forge/15 transition-colors"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>还没有配置模型接口，点此填写 API Key 后才能开始游戏。</span>
        </div>
      )}

      {/* 卡片墙 */}
      <main className="relative z-10 flex-1 overflow-y-auto px-6 py-8">
        {/* 继续游戏。
            存档一直在 localStorage 里，刷新后只是没回到游戏界面 ——
            这里给一个明确的入口，避免每次刷新都要从头开始。 */}
        {canResume && sessionWorld && (
          <div className="max-w-[100rem] mx-auto mb-8">
            <div className="rounded-lg border border-accent-lantern/40 bg-accent-lantern/[0.06] overflow-hidden">
              <div className="flex flex-col md:flex-row md:items-center gap-4 p-4 md:p-5">
                {sessionWorld.cover && (
                  <img src={sessionWorld.cover} alt=""
                    className="w-full md:w-28 h-24 md:h-20 object-cover rounded border border-text-muted/30 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-lantern/20 text-accent-lantern border border-accent-lantern/40">
                      {hasProgress ? '进行中' : '尚未开场'}
                    </span>
                    <h2 className="font-serif font-bold text-lg text-text-primary truncate">
                      {sessionWorld.title}
                    </h2>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted font-mono">
                    {savedPlayerName && <span>角色：{savedPlayerName}</span>}
                    <span>{hasProgress ? `已记录 ${history.length} 条` : '还没有生成开场'}</span>
                    {saveLocation && <span>位置：{saveLocation}</span>}
                    <span>世界时间：{fmtTime(gameTime)}</span>
                    {savedAtLabel && <span>存档于 {savedAtLabel}</span>}
                  </div>
                  {lastNarrative ? (
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-2 font-serif">
                      …{lastNarrative.replace(/[#*`>]/g, '').slice(-90)}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-300/90 leading-relaxed font-serif">
                      这一局还没生成开场（上次可能是密钥或网络问题）。点右边按钮回到游戏，再点一次「重试」即可。
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={handleResume}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-accent-lantern text-black rounded hover:bg-accent-lantern/90 transition-colors"
                  >
                    <Play size={15} /> {hasProgress ? '继续游戏' : '回到这一局'}
                  </button>
                  <button
                    onClick={() => setConfirmResume(true)}
                    className="px-3 py-2.5 text-xs border border-text-muted/40 rounded text-text-muted hover:text-red-400 hover:border-red-900/50 transition-colors"
                    title="清除存档，从头开始"
                  >
                    新游戏
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!loaded && (
          <div className="text-center text-sm text-text-muted py-20">正在载入卡库…</div>
        )}

        {loaded && worlds.length === 0 && (
          <div className="max-w-md mx-auto text-center py-20 space-y-4">
            <BookOpen size={40} className="mx-auto text-text-muted" />
            <p className="text-sm text-text-secondary">卡库是空的。</p>
            <p className="text-xs text-text-muted leading-relaxed">
              新建一张世界卡来定义你的世界，或导入别人分享的卡包。
            </p>
            <button
              onClick={() => { setEditingWorldId(null); setCardEditorOpen(true) }}
              className="px-5 py-2 text-sm bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
            >
              新建世界卡
            </button>
          </div>
        )}

        {/* 搜索与筛选：列表变长之后没有它就没法用 */}
        {loaded && worlds.length > 0 && (
          <div className="max-w-[100rem] mx-auto mb-5 space-y-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索世界：标题、简介、世界观正文都能匹配…"
                className="w-full bg-black/25 border border-text-muted/30 rounded pl-9 pr-9 py-2 text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent-lantern outline-none"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                  title="清除"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {([
                { id: 'all', label: '全部' },
                { id: 'builtin', label: '内置示例' },
                { id: 'mine', label: '我创建的' },
                { id: 'mechanics', label: '机制向' },
                { id: 'narrative', label: '纯叙事' },
              ] as const).map(f => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                    filter === f.id
                      ? 'border-accent-lantern/50 bg-accent-lantern/10 text-accent-lantern'
                      : 'border-text-muted/25 text-text-muted hover:border-text-muted/50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-text-muted font-mono">
                显示 {visibleWorlds.length} / {worlds.length}
              </span>
            </div>
          </div>
        )}

        {loaded && worlds.length > 0 && visibleWorlds.length === 0 && (
          <div className="max-w-[100rem] mx-auto py-16 text-center space-y-3">
            <p className="text-sm text-text-muted">没有匹配的世界卡</p>
            <button
              onClick={() => { setQuery(''); setFilter('all') }}
              className="px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
            >
              清除筛选条件
            </button>
          </div>
        )}

        {loaded && worlds.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 max-w-[100rem] mx-auto">
            {visibleWorlds.map(world => (
              <motion.div
                key={world.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="group bg-surface/40 border border-text-muted/20 rounded-lg overflow-hidden flex flex-col hover:border-accent-lantern/40 transition-colors"
              >
                {/*
                  点封面进**世界书预览**，而不是直接开局。
                  之前点封面会直接跳到选角界面 —— 想先看看设定的人被迫
                  先进入一个"要填资料"的流程才能退出，很别扭。
                  现在：看设定 → 满意了再点「开始」。
                */}
                <button
                  onClick={() => navPush({ name: 'worldbook', worldId: world.id })}
                  className="relative block w-full h-36 overflow-hidden bg-black/40 text-left"
                  title="查看世界书详情"
                >
                  {world.cover
                    ? <img src={world.cover} alt="" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                    : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface to-black/60">
                      <span className="font-serif text-3xl text-text-muted/40">{world.title.slice(0, 1)}</span>
                    </div>}
                  <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/85 to-transparent" />
                  {world.builtin && (
                    <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 bg-black/70 border border-text-muted/40 rounded text-text-muted">
                      内置示例
                    </span>
                  )}
                  {!world.enableMechanics && (
                    <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 bg-black/70 border border-accent-mansus/40 rounded text-accent-mansus">
                      纯叙事
                    </span>
                  )}
                  {/* 悬停时提示这里可以点 */}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
                    <span className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border border-accent-lantern/50 text-accent-lantern bg-black/70">
                      <Eye size={12} /> 查看详情
                    </span>
                  </span>
                  <div className="absolute inset-x-0 bottom-0 p-3">
                    <h3 className="font-serif font-bold text-text-primary truncate">{world.title}</h3>
                  </div>
                </button>

                {/* 信息 */}
                <div className="p-3 flex-1 flex flex-col gap-3">
                  <p className="text-xs text-text-secondary leading-relaxed line-clamp-2 min-h-[2.5rem]">
                    {world.tagline || world.worldLore.replace(/[#*`>]/g, '').trim().slice(0, 70) || '（还没有写简介）'}
                  </p>

                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-muted font-mono">
                    <span className="flex items-center gap-1"><Users size={10} /> {world.characters.length} 角色</span>
                    {world.enableMechanics && (
                      <>
                        <span className="flex items-center gap-1"><Sliders size={10} /> {world.attributes.length} 属性</span>
                        <span>{world.resources.length} 资源</span>
                      </>
                    )}
                    {world.story.stages.length > 0 && (
                      <span className="flex items-center gap-1"><BookOpen size={10} /> {world.story.stages.length} 事件</span>
                    )}
                  </div>

                  <div className="mt-auto flex items-center gap-1.5 pt-2 border-t border-text-muted/10">
                    {/*
                      主操作**随用途变化**：
                        · play      —— 主按钮就是"开始"（进来就是为了开局）
                        · worldbook —— 主按钮是"看详情"，这里不给开局入口（它是设定集，不是开局器）
                        · library   —— 主按钮也是"看详情"，重点在维护而不是开局
                      这样三个入口点进来才是三件不同的事。
                    */}
                    {libraryIntent === 'play' ? (
                      <button
                        onClick={() => beginSetup(world.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
                      >
                        <Play size={12} /> 用这个世界开始
                      </button>
                    ) : (
                      <button
                        onClick={() => navPush({ name: 'worldbook', worldId: world.id })}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
                      >
                        <Eye size={12} /> 看详情
                      </button>
                    )}

                    {libraryIntent === 'play' && (
                      <button
                        onClick={() => navPush({ name: 'worldbook', worldId: world.id })}
                        title="先看看这个世界写了什么"
                        className="p-1.5 border border-text-muted/30 rounded text-text-muted hover:text-accent-lantern hover:border-accent-lantern/40 transition-colors"
                      >
                        <Eye size={13} />
                      </button>
                    )}

                    {world.builtin ? (
                      <button
                        onClick={() => duplicateWorld(world.id)}
                        title="复制一份以便修改"
                        className="p-1.5 border border-text-muted/30 rounded text-text-muted hover:text-accent-lantern hover:border-accent-lantern/40 transition-colors"
                      >
                        <Copy size={13} />
                      </button>
                    ) : (
                      <button
                        onClick={() => { setEditingWorldId(world.id); setCardEditorOpen(true) }}
                        title="编辑"
                        className="p-1.5 border border-text-muted/30 rounded text-text-muted hover:text-accent-lantern hover:border-accent-lantern/40 transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                    )}

                    <button
                      onClick={() => setConfirmDelete(world.id)}
                      title="删除"
                      className="p-1.5 border border-text-muted/30 rounded text-text-muted hover:text-red-400 hover:border-red-900/50 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {world.builtin && (
                    <p className="text-[10px] text-text-muted -mt-1">内置示例不可直接编辑，请先复制。</p>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {/* 清除存档确认 */}
      <AnimatePresence>
        {confirmResume && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[95] bg-black/80 flex items-center justify-center p-4"
          >
            <div className="bg-surface border border-text-muted/30 rounded-lg p-5 max-w-sm w-full space-y-4">
              <h3 className="font-serif font-bold text-text-primary">放弃当前存档？</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                会清除「{sessionWorld?.title}」的对话历史、数值与人物关系，无法恢复。
                <br />
                清除后可以从头开始一场新游戏。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmResume(false)}
                  className="px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:text-text-primary transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleDiscardSave}
                  className="px-3 py-1.5 text-xs bg-red-900/40 border border-red-700/60 text-red-200 rounded hover:bg-red-900/60 transition-colors"
                >
                  清除并重新开始
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 删除世界卡确认 */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[95] bg-black/80 flex items-center justify-center p-4"
          >
            <div className="bg-surface border border-text-muted/30 rounded-lg p-5 max-w-sm w-full space-y-4">
              <h3 className="font-serif font-bold text-text-primary">删除这张世界卡？</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                「{worlds.find(w => w.id === confirmDelete)?.title}」及其中的角色卡会被永久删除，无法恢复。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:text-text-primary transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={async () => {
                    const id = confirmDelete
                    setConfirmDelete(null)
                    await deleteWorld(id)
                    flash('已删除。')
                  }}
                  className="px-3 py-1.5 text-xs bg-red-900/40 border border-red-700/60 text-red-200 rounded hover:bg-red-900/60 transition-colors"
                >
                  确认删除
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 浮动提示 */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[96] px-4 py-2 bg-black/90 border border-accent-lantern/40 text-accent-lantern text-xs rounded shadow-xl max-w-[90vw]"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 底部说明 */}
      <footer className="relative z-10 px-6 py-3 border-t border-text-muted/20 text-[10px] text-text-muted text-center leading-relaxed">
        灯叙 · Z测试版 · 世界观与角色卡完全自定义，可导入 SillyTavern 角色卡 · API Key 仅保存在本地浏览器
        <br />
        基于开源项目 <span className="text-text-secondary">pale-notes</span> 改造，剥离原有题材
        <br />
        {/*
          署名是**授权要求**，不是可选项：
          人物像素立绘来自 Universal LPC Spritesheet，
          其中 OGA-BY 3.0 与 CC-BY-SA 3.0 强制要求署名。
        */}
        人物像素素材来自{' '}
        <a
          href="https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator"
          target="_blank"
          rel="noreferrer"
          className="text-text-secondary hover:text-accent-lantern underline decoration-dotted"
        >
          Universal LPC Spritesheet
        </a>
        （CC0 / OGA-BY 3.0 / CC-BY-SA 3.0）·{' '}
        <a href="./CREDITS.md" target="_blank" rel="noreferrer" className="text-text-secondary hover:text-accent-lantern underline decoration-dotted">
          完整署名
        </a>
      </footer>

      {/*
        存档管理入口。
        放在标题界面而不是设置里：这是「数据安全」入口，要能被随手看到 ——
        存档只在本机，配额满了之后写入会静默失败，用户需要一条自救路径。
      */}
      <div className="relative z-10 px-6 pb-4 max-w-xl mx-auto w-full">
        <SaveManager />
        <WorldPackManager />
      </div>
    </div>
  )
}
