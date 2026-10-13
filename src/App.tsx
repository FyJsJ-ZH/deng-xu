import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { ApiKeyModal } from '@/components/ApiKeyModal'
import { ChoicePanel } from '@/components/ChoicePanel'
import { StatusPanel } from '@/components/StatusPanel'
import { ChroniclePanel } from '@/components/ChroniclePanel'
import { GameMenuActions } from '@/components/GameMenuActions'
import { MobileTabBar, type MobileTab } from '@/components/MobileTabBar'
import { MobileSheet } from '@/components/MobileSheet'
import { GlobalToast } from '@/components/GlobalToast'
import { useBackNavigation } from '@/hooks/useBackNavigation'
import { useNavStore } from '@/stores/nav'
import { recordPlay } from '@/utils/recentPlays'
import { PortraitPanel } from '@/components/PortraitPanel'
import { InventoryPanel } from '@/components/InventoryPanel'
import { RelationshipPanel } from '@/components/RelationshipPanel'
import { DebugPanel } from '@/components/DebugPanel'
import { StartScreen } from '@/components/StartScreen'
import { StatusBar } from '@/components/StatusBar'
import { ChapterOverlay } from '@/components/ChapterOverlay'
import { useGameStore, MAX_TURN_SNAPSHOTS, type TokenUsage } from '@/stores/game'
import { useSessionStore } from '@/stores/session'
import { useUIStore } from '@/stores/ui'
import { useGameEngine } from '@/hooks/useGameEngine'
import { X, AlertTriangle, ChevronUp, ChevronDown, ScrollText } from 'lucide-react'
import { lazyWithRetry, appLoadedCleanly } from '@/utils/lazyWithRetry'
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary'
import { SceneBackdrop } from '@/components/SceneBackdrop'

/**
 * 叙事区懒加载。
 * 它会把 react-markdown + rehype-raw 那一整块（284 KB）拉进来，
 * 而卡库首页完全用不到。拆出去后首屏的 index chunk 能压到安全线以下，
 * 进入游戏时再多取一块 —— 每块都小到能在超时前传完。
 */
const NarrativeView = lazyWithRetry(() =>
  import('@/components/NarrativeView').then(m => ({ default: m.NarrativeView }))
)

/** 参考单价（元 / 千 token）—— DeepSeek 官方在 2026 年前后的档位，只用于给玩家一个量级感 */
const PRICE_PER_1K = { prompt: 0.001, completion: 0.002 }

/**
 * 把用量渲染成给玩家看的一行字（C9）。
 *
 * 两个刻意的取舍：
 *  1. **token 数永远显示**，金额只在拿得到单价时附在后面。单价会变（服务商调价、
 *     玩家换模型），把金额当主角迟早会出错 —— 而 token 数是客观发生的量。
 *  2. 估算值必须带 `约` 与明确标注。只有一部分端点会回 `usage`（流式响应里尤其少见），
 *     拿不到就按字符数估 —— 但**不能让玩家把估算当账单**。
 */
function formatUsage(u?: TokenUsage | null): string {
  if (!u || (!u.promptTokens && !u.completionTokens)) return '—'
  const approx = u.estimated ? '约' : ''
  const tokens = `${approx}${u.promptTokens + u.completionTokens} tok`
  const cost = (u.promptTokens / 1000) * PRICE_PER_1K.prompt
    + (u.completionTokens / 1000) * PRICE_PER_1K.completion
  const money = cost > 0 ? ` ¥${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}` : ''
  return `${tokens}${money}`
}

/** 悬浮说明：把"这个数字是怎么来的"讲清楚，而不是只给一个数 */
function tokenTooltip(u: TokenUsage | null | undefined, label: string): string {
  if (!u || (!u.promptTokens && !u.completionTokens)) return `${label}：暂无记录`
  const src = u.estimated
    ? '接口未返回 usage，数字按字符数估算（仅供参考）'
    : '取自接口返回的 usage'
  const money = (u.promptTokens / 1000) * PRICE_PER_1K.prompt
    + (u.completionTokens / 1000) * PRICE_PER_1K.completion
  return `${label}\n输入 ${u.promptTokens} tok / 输出 ${u.completionTokens} tok\n`
    + `按 DeepSeek 参考单价折算约 ¥${money.toFixed(4)}\n${src}`
}

/** 回溯可用的轮次上限（与 gameStore 保持同一个数字，只用于提示文案） */
const MAX_TURN_SNAPSHOTS_UI = MAX_TURN_SNAPSHOTS

function App() {
  const { history, resources, resourceDefs, isGameStarted, playerName, location, lastUsage, sessionUsage } = useGameStore()
  const syncWorldDefs = useGameStore(s => s.syncWorldDefs)
  const { llm } = useUIStore()
  /*
    C9：快速模式开关。
    在这里订阅的是**布尔值**（选择器只返回 fastMode），所以切换它只会让 App 重渲染一次；
    引擎侧按需读取 store 的此刻值，因此开启后**下一轮立刻生效**，不需要重挂引擎。
  */
  const fastMode = useUIStore(s => s.fastMode)
  const setFastMode = useUIStore(s => s.setFastMode)
  const world = useSessionStore(s => s.world)
  const {
    handleAction,
    retryLastAction,
    isProcessing,
    isAnalyzingData,
    currentOptions,
    streamingContent,
    streamingReasoning,
    debugDataInput,
    debugDataOutput,
    isInputAllowed,
    lastError,
    truncationWarning,
    clearTruncationWarning,
    rewindTurns,
    rewindOptions,
    rewindToTurn
  } = useGameEngine()

  /*
    手机浮层状态放在 ui store 里（见 stores/ui.ts 的说明）：
    useBackNavigation 需要订阅它才能给每个浮层压一条历史。
    否则打开抽屉后按返回会把整页退掉。
  */
  const isMobileMenuOpen = useUIStore(s => s.mobileMenuOpen)
  const setIsMobileMenuOpen = useUIStore(s => s.setMobileMenuOpen)
  const [rightPanelTab, setRightPanelTab] = useState<'inventory' | 'relationships'>('inventory')
  /**
   * 编年史浮层是否打开。
   *
   * 放在 App 的 useState 而不是 ui store：本轮任务不动 stores/**。
   * 代价是 `useBackNavigation` 看不到它（它只订阅 ui store 里的那几个浮层），
   * 所以手机返回键不会关编年史 —— 组件自己补了 Esc 出口与显眼的关闭按钮。
   */
  const [isChronicleOpen, setIsChronicleOpen] = useState(false)
  /**
   * 错误横幅是否展开。
   * 默认收起（显示两行），因为服务商原始报错很长，全量铺开在手机上要吃掉 5 行。
   */
  const [errExpanded, setErrExpanded] = useState(false)
  /**
   * 手机端当前打开的面板抽屉；null = 都关着。
   *
   * 原先这个状态只有"全屏菜单"在消费，底栏改了它却没人渲染内容，
   * 于是点底栏什么都不出现（玩家反馈「底栏无效」）。
   * 现在它直接驱动 MobileSheet。
   */
  const mobileTab = useUIStore(s => s.mobileSheet) as MobileTab | null
  const setMobileTab = useUIStore(s => s.setMobileSheet) as (t: MobileTab | null) => void

  const hasInitialized = useRef(false)

  /*
    返回键的完整逻辑搬到 useBackNavigation 里了 —— 它需要同时知道
    "应用层级"（navStore）与"浮层状态"（ui store），放在 App 里会又长又绕。
    这里只负责：浮层状态由它统一关闭。
  */
  useBackNavigation()

  /**
   * 开局状态的层级兜底。
   *
   * 正常流程里 `StartScreen.handleLaunch` 会 push 一个 `game` 层级。
   * 但**断点续玩**（刷新后从存档恢复）不会走那条路 —— 那时
   * `isGameStarted` 已经是 true，层级却停在 menu，
   * 于是返回键会以为"已经在主菜单"而要求按两次退出，
   * 玩家在游戏里第一次按返回就被要求"再按一次退出"，很困惑。
   */
  useEffect(() => {
    if (isGameStarted && useNavStore.getState().view.name !== 'game') {
      useNavStore.getState().push({ name: 'game' })
    }
  }, [isGameStarted])

  /** 打开浮层。历史哨兵由 useBackNavigation 统一维护，这里只管状态 */
  const openOverlay = useCallback((next: { tab?: MobileTab | null; menu?: boolean }) => {
    if (next.tab !== undefined) setMobileTab(next.tab)
    if (next.menu !== undefined) setIsMobileMenuOpen(next.menu)
  }, [])

  const closeOverlay = useCallback(() => {
    setMobileTab(null)
    setIsMobileMenuOpen(false)
  }, [])

  // 应用成功跑起来 8 秒后，把「模块加载失败自动重载」的计数归零，
  // 这样下次真的遇到网络故障时还能享受自动重载。
  // 放在 App 里而不是各 chunk 里：单个 chunk 成功不代表整页健康，
  // 若在重载循环中提前归零就会变成无限刷新。
  useEffect(() => {
    const t = setTimeout(() => appLoadedCleanly(), 8000)
    return () => clearTimeout(t)
  }, [])

  // 会话切换（换了世界卡）时允许重新初始化
  useEffect(() => {
    hasInitialized.current = false
  }, [world?.id])

  /**
   * 世界卡的定义变了就同步进来（B5：世界状态与世界卡分离）。
   *
   * `gameStore` 里的 `attributeDefs` / `resourceDefs` 原先只在开局那一刻拷一份，
   * 之后是**冻结的快照** —— 玩家在卡片编辑器里给世界加了一个属性，
   * 正在进行的这一局看不到它，必须重开一局才生效。
   *
   * 现在真源明确是 `session.world`，那两个字段只是渲染与结算用的缓存。
   * 这里盯着世界卡对象：**它在编辑器里被改动时就会触发**（对象引用变了），
   * 于是新属性立刻出现在状态栏里。
   *
   * ⚠️ 只在游戏进行中同步：标题页不该被世界卡的改动影响，
   * 而且开局那一刻 `initFromWorld()` 已经做过一次完整的初始化。
   */
  useEffect(() => {
    if (!world || !isGameStarted) return
    syncWorldDefs(world)
  }, [world, isGameStarted, syncWorldDefs])

  /**
   * 记录「最近玩过」。
   *
   * 只在**游戏真正开始时**与**每轮叙事结束后**写一次 —— 不是每次渲染都写，
   * 否则会疯狂访问 localStorage。
   * 放在 App 里而不是引擎里：引擎不关心"历史列表"这种事，
   * 而且这样世界卡被删掉后记录仍在（条目会标灰）。
   */
  useEffect(() => {
    if (!isGameStarted || !world) return
    recordPlay({
      worldId: world.id,
      title: world.title,
      playerName,
      turns: history.length,
      location: location || '',
    })
  }, [isGameStarted, world, playerName, history.length, location])

  // Reset initialization flag when API key changes, allowing retry
  useEffect(() => {
    if (llm.apiKey && isGameStarted && history.length === 0) {
      hasInitialized.current = false
    }
  }, [llm.apiKey, isGameStarted, history.length])

  // 开始游戏后如果还没有历史，触发生成第一幕
  useEffect(() => {
    const ready = llm.apiKey || llm.provider === 'ollama'
    if (isGameStarted && history.length === 0 && !isProcessing && !hasInitialized.current && ready) {
      hasInitialized.current = true
      handleAction('init', '开始故事').catch(() => {
        console.error('Initialization failed.')
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGameStarted, history.length, isProcessing, llm.apiKey, llm.provider])

  const narrativeMessages = history
    .filter(h => h.role === 'assistant' || h.role === 'user' || h.role === 'system')
    .map(h => ({ role: h.role, content: h.content }))

  // 一致性守卫：进了游戏界面但会话里没有世界卡（会话被清、换了浏览器、
  // 存档损坏等）时，绝不能停在游戏界面发一堆「尚未选择世界卡」——
  // 玩家没有任何按钮可点。这里直接退回卡库，让流程重新开始。
  //
  // 注意：必须顺手把 isGameStarted 置回 false。
  // 否则 StartScreen 自己的 `if (isGameStarted) return null` 会让它渲染空内容，
  // 结果是整页全白 —— 比原来的死胡同更难排查（没有报错、没有任何可点的东西）。
  if (isGameStarted && !world) {
    useGameStore.getState().returnToTitle()
    return null
  }

  if (!isGameStarted) {
    /*
      `GlobalToast` 必须也挂在这里。
      主菜单上的"再按一次返回即退出游戏"就是在这里提示的 ——
      而 `statusMessage` 原先只在游戏界面的 StatusBar 里渲染，
      于是主菜单上的提示**根本没有 DOM**，玩家看到的是"按键没反应"。
    */
    return (
      <>
        <StartScreen />
        <GlobalToast />
      </>
    )
  }

  // 主界面顶部资源速览：只取前三个资源，避免自定义资源过多时挤爆
  const quickResources = resourceDefs.slice(0, 3)

  return (
    <div className="flex h-screen h-[100dvh] w-full bg-background text-text-primary overflow-hidden relative">
      <div className="absolute inset-0 bg-neutral-900 opacity-[0.03] pointer-events-none z-0 mix-blend-overlay" />
      <div className="absolute inset-0 bg-radial-gradient from-transparent via-background/50 to-background pointer-events-none z-0" />

      <ApiKeyModal />
      <GlobalToast />
      {/* 全身立绘面板（点角色头像打开） */}
      <PortraitPanel />

      {/* 编年史浮层：桌面从左侧面板进，手机从「更多」菜单进 */}
      <ChroniclePanel open={isChronicleOpen} onClose={() => setIsChronicleOpen(false)} />

      {/* Desktop Left Panel (Status) */}
      <aside className="hidden md:block w-64 flex-shrink-0 z-10 relative border-r border-text-muted/30">
        <StatusPanel onOpenChronicle={() => setIsChronicleOpen(true)} />
      </aside>

      {/* Main Game Area */}
      <main className="flex-1 flex flex-col min-w-0 relative z-10">
        <ChapterOverlay />
        <StatusBar />

        {/*
          ── 成本 / 快速模式 / 回溯 工具条（C9 + B8）──

          为什么挤在最窄的一条里，还要默认收起用法说明：
          它是**辅助信息**，不是叙事的一部分。玩家主要想看故事，
          所以这一条的高度必须可控 —— 详细代价写在 title 与展开的提示里，
          而不是常驻铺开。
        */}
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-mono text-text-muted border-b border-text-muted/20 flex-wrap">
          <span title={tokenTooltip(lastUsage, '上一轮（叙事 + 数据结算两次调用）')}>
            本轮 <span className="text-text-secondary">{formatUsage(lastUsage)}</span>
          </span>
          <span className="opacity-40">|</span>
          <span
            className="cursor-pointer hover:text-text-secondary"
            title={`${tokenTooltip(sessionUsage, '本局累计（从开局算起，刷新后仍然保留）')}\n点击清零重新统计`}
            onClick={() => useGameStore.getState().resetSessionUsage()}
          >
            累计 <span className="text-text-secondary">{formatUsage(sessionUsage)}</span>
          </span>

          <span className="opacity-40">|</span>
          {/*
            快速模式。代价必须写在这里 —— "数值不再更新"是玩家不看提示
            绝对猜不到的事（他会以为是 bug），而不是能自己发现的体验差异。
          */}
          <label
            className="flex items-center gap-1 cursor-pointer select-none"
            title={'开启后跳过「数据结算」这一步：每轮只调用一次模型，更快更省。\n代价：属性 / 资源 / 物品 / 人物关系 / 结局选项都不再更新，只出剧情。'}
          >
            <input
              type="checkbox"
              checked={fastMode}
              onChange={e => setFastMode(e.target.checked)}
              className="accent-current"
            />
            快速模式
            {fastMode && <span className="text-amber-400">（数值与状态不再更新）</span>}
          </label>

          {/*
            回溯（B8）。只在**真的攒过快照**时出现：开局第一轮还没结束，
            列一个空下拉只会让人以为功能坏了。

            ⚠️ 选项里必须带**那一轮玩家干了什么**（`rewindOptions`）。
            原先只列「第 N 轮结束时」，而 `history` 里根本不含玩家的输入
            （只有叙事与状态变更），于是玩家面对一串编号完全想不起当时做过什么，
            也就无从判断该退回哪一轮 —— 这是"回溯"这个功能最实际的用法障碍。
          */}
          {rewindTurns.length > 0 && (
            <>
              <span className="opacity-40">|</span>
              <select
                className="bg-transparent border border-text-muted/30 rounded px-1 py-[1px] text-[10px] font-mono text-text-muted hover:text-text-primary disabled:opacity-40 max-w-[16rem]"
                value=""
                disabled={isProcessing}
                title={`回到某一轮结束时：叙事历史、三层记忆、数值（属性/资源/物品/关系/时间）都会一起回滚，之后发生的事全部作废。\n可回滚的轮次：${rewindTurns.join('、')}（更早的轮次已超出快照上限 ${MAX_TURN_SNAPSHOTS_UI}）\n下拉里显示的是**那一轮你输入的行动**。`}
                onChange={e => {
                  const t = Number(e.target.value)
                  if (!t) return
                  const opt = rewindOptions.find(o => o.turn === t)
                  /*
                    回溯是**破坏性**的（之后所有轮次作废），所以先把这一轮的
                    玩家行动原文摆出来让他确认 —— 这既是"查看上一轮输入"，
                    也是防止点错一行就毁掉几十轮。
                  */
                  if (opt?.full) {
                    const ok = window.confirm(
                      `回到第 ${t} 轮结束时？\n\n` +
                      `你在那一轮输入的行动：\n${opt.full}\n\n` +
                      `⚠️ 这一轮之后发生的事会全部作废（叙事、数值、关系、记忆一起回滚）。`,
                    )
                    if (!ok) return
                  }
                  const done = rewindToTurn(t)
                  if (!done) window.alert(`第 ${t} 轮的快照已经不在了，无法回到那一轮。`)
                }}
              >
                <option value="">回到第…轮</option>
                {[...rewindOptions].reverse().map(o => (
                  <option key={o.turn} value={o.turn}>
                    第 {o.turn} 轮 · {o.action}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {/*
          Mobile Header。
          去掉了右上角的汉堡按钮：它和底栏的「更多」是同一个入口，
          两个入口摆在屏幕上显得杂乱；资源速览保留，因为它要常驻可见。
        */}
        <header className="md:hidden h-14 border-b border-text-muted/30 flex items-center px-4 justify-between bg-surface/80 backdrop-blur z-20">
          <span className="font-serif text-accent-lantern font-bold truncate max-w-[9rem]">
            {world?.title || '冒险'}
          </span>
          <div className="flex gap-3 text-xs font-mono text-text-secondary">
            {quickResources.map(def => (
              <span key={def.id} title={def.name} style={{ color: def.color }}>
                {resources[def.id] ?? 0}
              </span>
            ))}
          </div>
        </header>

        {/*
          「更多」菜单。
          只放**设置类**操作 —— 状态/物品/人物三个面板已经由底栏的
          MobileSheet 抽屉承担，这里再放一套页签就是重复入口，
          玩家会不知道该点哪个。
        */}
        {isMobileMenuOpen && (
          <div className="md:hidden fixed inset-0 bg-background/95 z-50 flex flex-col animate-fade-in">
            <div className="h-14 border-b border-text-muted/30 flex items-center px-4 justify-between bg-surface/80 backdrop-blur">
              <span className="font-serif text-accent-lantern font-bold">菜单</span>
              <button
                onClick={closeOverlay}
                className="p-2 hover:bg-text-muted/20 rounded text-text-muted hover:text-text-primary"
                aria-label="关闭菜单"
              >
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {/*
                编年史入口放在「更多」里而不是底栏：底栏四个页签是**面板**
                （手机走查里逐个数过按钮个数，加第五个会挤且会破坏那条断言），
                而编年史是一个回看用的全屏浮层，属于"低频入口"。
              */}
              <button
                onClick={() => { setIsChronicleOpen(true); closeOverlay() }}
                className="w-full mb-3 flex items-center justify-center gap-2 p-2.5 text-sm text-text-secondary hover:text-accent-lantern hover:bg-accent-lantern/10 border border-text-muted/30 hover:border-accent-lantern/40 rounded transition-all"
              >
                <ScrollText size={15} />
                <span>编年史</span>
              </button>
              <GameMenuActions />
            </div>
          </div>
        )}

        {/*
          截断提示。
          与错误条分开：这一轮是**成功生成**的，只是可能没写完 ——
          用琥珀色警告而不是红色错误，并且可以关掉（玩家可能觉得这段没问题）。
        */}
        {truncationWarning && !lastError && (
          <div className="flex items-start gap-2 px-4 py-2 text-xs bg-amber-900/20 border-b border-amber-900/40 text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed flex-1 min-w-0">
              {truncationWarning}
            </span>
            <button
              onClick={() => retryLastAction()}
              disabled={isProcessing}
              className="shrink-0 px-2 py-0.5 text-[10px] border border-amber-400/40 rounded hover:bg-amber-500/15 transition-colors disabled:opacity-40"
            >
              {isProcessing ? '处理中…' : '重新生成'}
            </button>
            <button
              onClick={() => clearTruncationWarning()}
              className="shrink-0 p-0.5 text-amber-400/70 hover:text-amber-200 transition-colors"
              title="忽略"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/*
          错误提示。
          ⚠️ **手机上必须默认截断**：服务商的原始报错很长
          （"Authentication Fails, Your api key: **** is invalid (request_id: 8c67da0f-…)"
          ＋ 中文建议），全量铺开会占掉 5 行、把叙事区顶下去 ——
          而玩家此刻只需要知道"出错了、点重试"。
          所以：默认收成两行，点一下才展开全文。
        */}
        {lastError && (
          <div className="flex items-start gap-2 px-4 py-2 text-xs bg-red-900/20 border-b border-red-900/40 text-red-300">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div
              onClick={() => setErrExpanded(v => !v)}
              className={`leading-relaxed flex-1 min-w-0 cursor-pointer ${errExpanded ? '' : 'line-clamp-2'}`}
              title={errExpanded ? '点击收起' : '点击展开全文'}
            >
              {lastError}
            </div>
            {lastError.length > 60 && (
              <button
                onClick={() => setErrExpanded(v => !v)}
                className="shrink-0 p-0.5 text-red-400/70 hover:text-red-200 transition-colors"
                aria-label={errExpanded ? '收起错误详情' : '展开错误详情'}
              >
                {errExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            )}
            {/*
              加一个重试出口。
              之前这里只有文字：生成失败后玩家知道了原因，却没有任何可点的动作 ——
              只能自己重新输入一遍行动。而 retryLastAction 早就存在、只是没接到这里。
            */}
            <button
              onClick={() => retryLastAction()}
              disabled={isProcessing}
              className="shrink-0 px-2 py-0.5 text-[10px] border border-red-400/40 rounded hover:bg-red-500/15 transition-colors disabled:opacity-40"
            >
              {isProcessing ? '处理中…' : '重试'}
            </button>
          </div>
        )}

        {/* Narrative Scroll Area */}
        <div className="flex-1 relative min-h-0 overflow-hidden">
          {/*
            场景背景放在**这个不滚动**的容器里，它才有真实高度。
            （放进 NarrativeView 的滚动容器里会被 h-0 压成 0 高，等于没画 —— 踩过一次。）
          */}
          <SceneBackdrop />
          <ChunkErrorBoundary label="叙事区加载失败">
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-xs text-text-muted font-mono">
                  正在载入叙事区…
                </div>
              }
            >
              <NarrativeView
                messages={narrativeMessages}
                isTyping={isProcessing}
                isAnalyzingData={isAnalyzingData}
                streamingContent={streamingContent}
                streamingReasoning={streamingReasoning}
              />
            </Suspense>
          </ChunkErrorBoundary>
        </div>

        {/* Choice Area */}
        <div className="flex-shrink-0 z-10 bg-background relative">
          {!isProcessing && history.length > 1 && (
            <div className="absolute -top-10 right-6 z-20">
              <button
                onClick={retryLastAction}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-text-muted hover:text-accent-lantern border border-text-muted/30 hover:border-accent-lantern/50 rounded bg-background/80 backdrop-blur transition-all"
                title="重新生成本次回应"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" /></svg>
                重新生成
              </button>
            </div>
          )}

          <ChoicePanel
            options={currentOptions}
            disabled={isProcessing}
            isInputAllowed={isInputAllowed}
            onCustomAction={(text) => handleAction('custom_action', text)}
            onSelect={(id) => {
              const opt = currentOptions.find((o: any) => o.id === id)
              handleAction(id, opt?.text || id)
            }}
          />
        </div>

        {/*
          手机端底部标签栏。
          之前要切"物品/人物"必须先点右上角打开全屏菜单 —— 每看一次背包
          就损失一次与叙事区的视线连接，来回两步。改成常驻底栏一键直达。
          「更多」里放频率低的操作（模型设置 / 返回标题 / 素材署名）。
        */}
        <MobileTabBar
          tab={mobileTab}
          onTab={t => {
            // 再点一次已打开的页签 → 收起（符合移动端惯例）
            if (mobileTab === t) closeOverlay()
            else openOverlay({ tab: t, menu: false })
          }}
          onOpenMore={() => {
            if (isMobileMenuOpen) closeOverlay()
            else openOverlay({ menu: true, tab: null })
          }}
          moreActive={isMobileMenuOpen}
        />
      </main>

      {/*
        手机端面板抽屉：底栏点哪个就弹哪个。
        `bottom` 是底栏自己上报的高度（CSS 变量 --dx-tabbar-h），
        所以抽屉与遮罩都**不会盖住底栏** —— 底栏始终可点，
        玩家可以在三个面板之间直接切换，不用先关再开。
      */}
      {mobileTab && (
        <MobileSheet
          tab={mobileTab}
          onClose={closeOverlay}
        />
      )}

      {/* Desktop Right Panel */}
      <aside className="hidden md:flex flex-col w-72 flex-shrink-0 z-10 border-l border-text-muted/30 bg-surface/30">
        <div className="flex border-b border-text-muted/30">
          <button
            onClick={() => setRightPanelTab('inventory')}
            className={`flex-1 py-2 text-xs font-medium uppercase tracking-wider transition-colors ${rightPanelTab === 'inventory' ? 'bg-background text-accent-lantern border-b-2 border-accent-lantern' : 'text-text-muted hover:text-text-primary'}`}
          >
            物品与线索
          </button>
          <button
            onClick={() => setRightPanelTab('relationships')}
            className={`flex-1 py-2 text-xs font-medium uppercase tracking-wider transition-colors ${rightPanelTab === 'relationships' ? 'bg-background text-accent-grail border-b-2 border-accent-grail' : 'text-text-muted hover:text-text-primary'}`}
          >
            人物
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {rightPanelTab === 'inventory' ? <InventoryPanel /> : <RelationshipPanel />}
        </div>
        <DebugPanel
          dataInput={debugDataInput}
          dataOutput={debugDataOutput}
        />
      </aside>
    </div>
  )
}

export default App
