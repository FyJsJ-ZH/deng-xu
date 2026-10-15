import { useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ArrowRight, Play, Users, Check, Compass, UserRound, BookmarkPlus, Plus } from 'lucide-react'
import type { BackgroundSlot, HeroPreset, PlayerCard, WorldCard } from '@/types/cards'
import { useSessionStore } from '@/stores/session'
import { useGameStore } from '@/stores/game'
import { useUIStore } from '@/stores/ui'
import { useLibraryStore } from '@/stores/library'
import { useNavStore } from '@/stores/nav'

/**
 * 开局配置
 *
 * 原版的「角色创建」写死了三个出身、三个童年、三个特质，以及八种性相的加点规则。
 * 现在这里完全由世界卡驱动：槽位、选项、属性、资源、点数上限都来自卡片。
 */

interface SessionSetupProps {
  world: WorldCard
  onCancel: () => void
  onLaunch: () => void
}

const STEPS = [
  { id: 'persona', label: '扮演角色', hint: '你是谁' },
  { id: 'cast', label: '出场角色', hint: '谁会登场' },
  { id: 'background', label: '背景', hint: '你的来处' },
  { id: 'attributes', label: '属性', hint: '你的所长' }
] as const

type StepId = typeof STEPS[number]['id']

const inputCls =
  'w-full bg-black/30 border border-text-muted/30 rounded px-2 py-1.5 text-sm text-text-primary ' +
  'placeholder:text-text-muted/50 focus:border-accent-lantern outline-none'

const areaCls = `${inputCls} resize-y leading-relaxed font-serif`

/**
 * 把 pendingSetup 里的种子（可能来自"我的主角"预设）解析成
 * **在当前世界合法**的开局初值。
 *
 * ⚠️ 为什么必须过滤，不能直接照抄：
 * 预设里记的 `backgroundChoices` 的 key 是**槽位 label**、value 是**选项 id**，
 * 而这两样都是**每个世界自己在世界卡里定义的**。
 * 拿 A 世界记下的选择去开 B 世界，轻则整个槽位对不上、重则选中一个不存在的
 * 选项 id → 后面的属性加成与开局物品都会取空。
 * 所以这里逐槽校验：槽位名要对得上，选项 id 也要在本世界里真实存在，
 * 对不上就退回该槽的默认（第一个选项）。
 *
 * 属性点同理：只保留本世界确实定义过的属性 id，其余丢弃。
 */
function resolveSeed(world: WorldCard) {
  const seed = useUIStore.getState().pendingSetup

  const player: PlayerCard = {
    name: seed?.player?.name || '',
    gender: seed?.player?.gender || '',
    age: seed?.player?.age || '',
    appearance: seed?.player?.appearance || '',
    personality: seed?.player?.personality || '',
    background: seed?.player?.background || '',
    extra: seed?.player?.extra || '',
    ...(seed?.player?.avatar ? { avatar: seed.player.avatar } : {}),
  }

  // 背景：默认每槽第一个，再用预设里"对得上"的选择覆盖
  const backgroundChoices: Record<string, string> = {}
  for (const slot of world.backgrounds) {
    if (slot.options[0]) backgroundChoices[slot.label] = slot.options[0].id
  }
  for (const [label, optId] of Object.entries(seed?.backgroundChoices || {})) {
    const slot = world.backgrounds.find(s => s.label === label)
    if (slot && slot.options.some(o => o.id === optId)) {
      backgroundChoices[label] = optId
    }
  }

  // 自定义背景文本：只保留本世界真实存在的槽位
  const backgroundCustom: Record<string, string> = {}
  for (const [label, text] of Object.entries(seed?.backgroundCustom || {})) {
    if (!world.backgrounds.some(s => s.label === label)) continue
    if (typeof text === 'string' && text.trim()) backgroundCustom[label] = text
  }

  // 属性点：只认本世界定义过的属性，且不得超过该世界的点数额度
  const allocation: Record<string, number> = {}
  for (const a of world.attributes) allocation[a.id] = 0
  let budget = world.attributePoints
  for (const [id, n] of Object.entries(seed?.attributeAllocation || {})) {
    if (!(id in allocation)) continue
    const v = Math.max(0, Math.floor(Number(n) || 0))
    const take = Math.min(v, budget)
    allocation[id] = take
    budget -= take
  }

  return { player, backgroundChoices, backgroundCustom, allocation }
}

export function SessionSetup({ world, onCancel, onLaunch }: SessionSetupProps) {
  const setSession = useSessionStore(s => s.setSession)
  const initFromWorld = useGameStore(s => s.initFromWorld)
  const [step, setStep] = useState<StepId>('persona')

  /**
   * 玩家档案初值**必须来自 pendingSetup**。
   *
   * 之前这里是硬编码空值，于是从「卡片编辑器 → 保存并开始」进入时，
   * player.name 是空串 → 存档里主角叫「未命名」，且所有档案字段被空值覆盖。
   *
   * 另外这里必须用 **ref 镜像**（见下面的 playerRef）：
   * 点「开始故事」时 handleLaunch 会先调 initFromWorld()，那会触发 App 重渲染，
   * 而 isGameStarted 尚未置位、SessionSetup 仍是当前视图 ——
   * 组件重挂载后 useState 初值被重新求值，用户刚填的名字就丢了。
   * 症状正是"主角叫未命名"。ref 不随重挂载重置，所以读它才可靠。
   *
   * `resolveSeed` 在这里被调用一次，之后不再变 —— 重挂载会重新求值，
   * 但那时 pendingSetup 还是同一份，结果一致（幂等）。
   */
  const seedInit = resolveSeed(world)
  const [player, setPlayerState] = useState<PlayerCard>(() => seedInit.player)

  /**
   * player 的 ref 镜像 + 一个不会丢的 setter。
   * handleLaunch 读 playerRef.current 而不是闭包里的 player ——
   * 原因见上方 useState 的注释（重挂载会重置 state）。
   */
  const playerRef = useRef(player)
  const patchPlayer = (patch: Partial<PlayerCard>) => {
    playerRef.current = { ...playerRef.current, ...patch }
    setPlayerState(playerRef.current)
  }
  /** 供 handleLaunch 读取当前档案（永远是最新的，且不随重挂载丢失） */
  const currentPlayer = () => playerRef.current

  // 默认把所有标记为「在场」的角色卡都选上
  const [activeIds, setActiveIds] = useState<string[]>(
    () => world.characters.filter(c => c.present).map(c => c.id)
  )

  // 每个背景槽位默认选第一个；带预设时用预设里对得上的选择覆盖（见 resolveSeed）
  const [backgroundChoices, setBackgroundChoices] = useState<Record<string, string>>(
    () => seedInit.backgroundChoices
  )

  const [allocation, setAllocation] = useState<Record<string, number>>(
    () => seedInit.allocation
  )

  /*
    ── 「我自己写」的文本 ──

    ⚠️ 用 **ref 镜像**而不是纯 state，理由与上面 player 那一段完全相同：
    `handleLaunch` 里会先调 `initFromWorld()`，那会触发重渲染 → 本组件重挂载 →
    `useState` 初值被重新求值。玩家在这里手打的一段话会在那一刻被清空。

    而"我写了两百字，一点开始就没了"是这套流程里最劝退的一种 bug ——
    它比任何显示错误都更让人不想再开一局。所以新加的这块一开始就用 ref。
  */
  const [backgroundCustom, setBackgroundCustomState] = useState<Record<string, string>>(
    () => seedInit.backgroundCustom
  )
  const backgroundCustomRef = useRef<Record<string, string>>(backgroundCustom)
  const patchBackgroundCustom = (label: string, text: string) => {
    backgroundCustomRef.current = { ...backgroundCustomRef.current, [label]: text }
    setBackgroundCustomState(backgroundCustomRef.current)
  }
  /** 供 handleLaunch 读取（永远最新，且不随重挂载丢） */
  const currentCustomTexts = () => backgroundCustomRef.current

  // patchPlayer 已在上面定义（同时写 ref 与 state，见那里的注释）

  /** 预设快捷条用到的库状态与动作 */
  const heroPresets = useLibraryStore(s => s.heroPresets)
  const saveHeroPreset = useLibraryStore(s => s.saveHeroPreset)
  const createHeroPreset = useLibraryStore(s => s.createHeroPreset)
  const navPush = useNavStore(s => s.push)
  /** 套用/保存后的轻提示（两秒后自己消失，不打断填写） */
  const [presetFlash, setPresetFlash] = useState<string | null>(null)

  /*
    ── 主角预设：套用 / 保存 ──
    两个方向都要有，缺一个这功能就不成立：
      · applyPreset  —— 把预设灌进当前表单（含本世界的出身与加点）
      · saveAsPreset —— 把当前表单存成预设，下次不必重填
    套用只负责"填好初值"，填完仍可继续改，不做任何锁定。
  */
  const applyPreset = (preset: HeroPreset) => {
    patchPlayer({ ...preset.player })
    // 背景选择：只认本世界真实存在的槽位与选项（理由见 resolveSeed 的注释）
    const byWorldBg = preset.choices?.byWorld?.[world.id]?.backgroundChoices
    const defBg = preset.choices?.default?.backgroundChoices
    const merged = { ...(defBg || {}), ...(byWorldBg || {}) }
    const nextBg: Record<string, string> = { ...backgroundChoices }
    for (const [label, optId] of Object.entries(merged)) {
      const slot = world.backgrounds.find(s => s.label === label)
      if (slot && slot.options.some(o => o.id === optId)) nextBg[label] = optId
    }
    setBackgroundChoices(nextBg)

    // 自定义背景文本：同样只认本世界的槽位，并且**整份替换**而不是合并 ——
    // 预设存的是"那一套主角设定"，把上一套残留的自定义文本留下会串味。
    const byWorldCustom = preset.choices?.byWorld?.[world.id]?.backgroundCustom
    const defCustom = preset.choices?.default?.backgroundCustom
    const mergedCustom = { ...(defCustom || {}), ...(byWorldCustom || {}) }
    const nextCustom: Record<string, string> = {}
    for (const [label, text] of Object.entries(mergedCustom)) {
      if (!world.backgrounds.some(s => s.label === label)) continue
      if (typeof text === 'string' && text.trim()) nextCustom[label] = text
    }
    backgroundCustomRef.current = nextCustom
    setBackgroundCustomState(nextCustom)

    // 属性点同理：只认本世界的属性 id，且不超额度
    const byWorldAlloc = preset.choices?.byWorld?.[world.id]?.attributeAllocation
    const defAlloc = preset.choices?.default?.attributeAllocation
    const mergedAlloc = { ...(defAlloc || {}), ...(byWorldAlloc || {}) }
    const nextAlloc: Record<string, number> = {}
    for (const a of world.attributes) nextAlloc[a.id] = 0
    let budget = world.attributePoints
    for (const [id, n] of Object.entries(mergedAlloc)) {
      if (!(id in nextAlloc)) continue
      const take = Math.min(Math.max(0, Math.floor(Number(n) || 0)), budget)
      nextAlloc[id] = take
      budget -= take
    }
    setAllocation(nextAlloc)
    setPresetFlash(`已套用「${preset.label}」`)
    setTimeout(() => setPresetFlash(null), 2000)
  }

  /**
   * 把当前表单存成预设。
   *
   * 同名则更新（并把"这个世界的出身与加点"记进去），否则新建 ——
   * 这样玩家在同一世界里反复开局，第二次起连出身都不必重选。
   */
  const saveAsPreset = async () => {
    const me = currentPlayer()
    const label = (me.name || '').trim() || '我的主角'
    const existing = heroPresets.find(p => p.label === label)
    const choices = {
      ...(existing?.choices || {}),
      byWorld: {
        ...(existing?.choices?.byWorld || {}),
        [world.id]: {
          backgroundChoices,
          backgroundCustom: currentCustomTexts(),
          attributeAllocation: allocation,
        },
      },
    }
    if (existing) {
      await saveHeroPreset({ ...existing, label, player: me, choices })
    } else {
      const created = await createHeroPreset(label, me)
      await saveHeroPreset({ ...created, choices })
    }
    setPresetFlash(`已存为预设「${label}」，下次开局可直接套用`)
    setTimeout(() => setPresetFlash(null), 2200)
  }

  const totalAllocated = useMemo(
    () => Object.values(allocation).reduce((a, b) => a + b, 0),
    [allocation]
  )
  const remaining = world.attributePoints - totalAllocated

  /**
   * 该槽位**当前真正生效**的选项。
   *
   * ⚠️ 选了「我自己写」却一个字没写 ⇒ 返回 `null`（当作这个槽位没选）。
   *
   * 这一条要与提示词层严格一致 —— `describeBackgroundChoices` 与
   * `useGameEngine` 的 `bgLines` 在同样的情形下都会跳过该槽位。
   * 若只有提示词层跳过、属性层照给，会出现"他凭空多了两点智识，
   * 而 AI 完全不知道这来路是什么"这种最难解释的状态。
   */
  const effectiveOption = (slot: BackgroundSlot) => {
    const option = slot.options.find(o => o.id === backgroundChoices[slot.label])
    if (!option) return null
    if (option.custom && !(backgroundCustom[slot.label] || '').trim()) return null
    return option
  }

  /** 汇总最终数值：属性点 + 背景加成；资源 = 初始值 + 背景加成 */
  const finalStats = useMemo(() => {
    const attributes: Record<string, number> = { ...allocation }
    const resources: Record<string, number> = {}
    world.resources.forEach(r => { resources[r.id] = r.initial })

    world.backgrounds.forEach(slot => {
      const option = effectiveOption(slot)
      if (!option) return
      Object.entries(option.attributeBonus || {}).forEach(([k, v]) => {
        if (k in attributes) attributes[k] += v
      })
      Object.entries(option.resourceBonus || {}).forEach(([k, v]) => {
        if (k in resources) resources[k] += v
      })
    })

    // 资源上下限夹取，避免背景加成把上限撑破
    world.resources.forEach(r => {
      resources[r.id] = Math.max(0, resources[r.id])
      if (typeof r.max === 'number') resources[r.id] = Math.min(resources[r.id], r.max)
    })

    return { attributes, resources }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation, backgroundChoices, backgroundCustom, world])

  /** 背景带来的开局物品 */
  const startingItems = useMemo(() => {
    const ids = new Set<string>()
    world.backgrounds.forEach(slot => {
      effectiveOption(slot)?.startingItems?.forEach(id => ids.add(id))
    })
    return world.items.filter(i => ids.has(i.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundChoices, backgroundCustom, world])

  const stepIndex = STEPS.findIndex(s => s.id === step)
  const activeCharacters = world.characters.filter(c => activeIds.includes(c.id))

  const canLaunch = world.enableMechanics ? remaining >= 0 : true

  const handleLaunch = () => {
    /*
      从 ref 取玩家档案，不要用闭包里的 `player`。

      initFromWorld() 会触发重渲染 → SessionSetup 重挂载 → useState 初值被重新求值，
      闭包里的 player 于是退回空值。症状就是主角在状态栏显示「未命名」，
      而 session 里却存着正确的名字（两条路径读了不同的东西）。
      ref 不随重挂载重置，所以这里必须读它。
    */
    const p = currentPlayer()

    // 1. 装载数值体系（定义属性与资源）
    initFromWorld(world)

    // 2. 写入玩家档案
    useGameStore.getState().setPlayerProfile(
      p.name.trim() || '无名者',
      p.gender,
      p.appearance,
      p.avatar
    )

    // 3. 应用属性、资源与背景
    useGameStore.getState().setAspects(finalStats.attributes)
    useGameStore.getState().setResources(finalStats.resources)

    // 4. 记录背景选择到 story 状态
    const [firstSlot, ...restSlots] = world.backgrounds
    const firstChoice = firstSlot ? backgroundChoices[firstSlot.label] : null
    useGameStore.getState().setStoryState({
      origin: firstChoice,
      childhood: restSlots[0] ? backgroundChoices[restSlots[0].label] : null,
      uniqueTrait: restSlots[1] ? backgroundChoices[restSlots[1].label] : null
    })

    // 5. 开局物品
    startingItems.forEach(item => {
      useGameStore.getState().addItem({ ...item, tags: [...item.tags] })
    })

    // 6. 在场角色写进关系面板，并带上角色卡提示词
    activeCharacters.forEach(card => {
      useGameStore.getState().addCharacter({
        id: card.id,
        name: card.name,
        description: card.description,
        relationship: card.relationship || '未知',
        status: card.status || '正常',
        location: card.location,
        avatar: card.avatar,
        /*
          ⚠️ **这一行是立绘能不能照卡片画的关键**（2026-10）。
          世界卡里每个角色都写了 `look`（部件级显式外观），但如果不在这里透传进 store，
          `char.look` 就是 undefined，立绘会**静默退回关键词推断** ——
          47 张卡辛苦写的部件全部白写，而且症状是"看起来大致正常但总有几个不对"，
          极难联想到是这里漏了一个字段。我是靠逐环追查才发现的。
        */
        look: card.look,
        // 把角色卡的核心资料压成一段提示词，引擎会注入叙事 AI
        prompt: [card.personality, card.scenario, card.messageExamples]
          .filter(Boolean)
          .join('\n')
      })
    })

    // 7. 起始时间与地点：世界卡没有定义纪元，用中性默认值
    useGameStore.getState().setTime({ year: 1, month: 1, day: 1, hour: 9, minute: 0 })
    const firstCharacterLocation = activeCharacters.find(c => c.location)?.location
    useGameStore.getState().setLocation(firstCharacterLocation || world.title)

    // 8. 建立会话
    setSession({
      world,
      player: p.name.trim() ? p : { ...p, name: '无名者' },
      activeCharacterIds: activeIds,
      backgroundChoices,
      /*
        ⚠️ 读 **ref** 而不是 state：上面第 1 步的 `initFromWorld()` 会触发重渲染 →
        本组件重挂载 → `backgroundCustom` 这个 state 被重置成初值。
        玩家手打的那段话就在那一刻丢掉了。原因与 player 完全相同。
      */
      backgroundCustom: currentCustomTexts(),
      attributeAllocation: allocation
    })

    onLaunch()
  }


  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-background text-text-primary flex flex-col">
      {/* 顶栏 */}
      <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-text-muted/20">
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent-lantern transition-colors"
        >
          <ArrowLeft size={14} /> 返回卡库
        </button>
        <div className="text-center min-w-0">
          <h1 className="font-serif font-bold text-accent-lantern truncate">{world.title}</h1>
          <p className="text-[10px] text-text-muted font-mono truncate">{world.tagline || '角色创建'}</p>
        </div>
        <div className="w-20" />
      </header>

      {/* 步骤指示 */}
      <div className="flex items-center justify-center gap-2 py-4 border-b border-text-muted/10">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors
              ${step === s.id
                ? 'bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern'
                : i < stepIndex
                  ? 'text-text-secondary hover:text-accent-lantern'
                  : 'text-text-muted hover:text-text-secondary'}`}
          >
            <span className="font-mono opacity-60">{i + 1}</span>
            <span className="hidden sm:inline">{s.label}</span>
            {i < stepIndex && <Check size={12} className="text-accent-lantern/70" />}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <main className="flex-1 overflow-y-auto px-6 py-8">
        <div className="max-w-4xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="space-y-6"
            >
              {/* ==== 扮演角色 ==== */}
              {step === 'persona' && (
                <>
                  <div>
                    <h2 className="font-serif text-2xl font-bold">你要扮演谁？</h2>
                    <p className="text-xs text-text-muted mt-1">
                      这些信息会注入提示词，AI 会据此使用正确的代称并呼应你的外貌与性格。
                    </p>
                  </div>

                  {/*
                    ── 主角预设快捷条 ──
                    这里是"提前设定主角"落地的地方：设过一次之后再开新局，
                    点一下就把整份档案（名字/性别/年龄/外貌/性格/背景）填好，
                    连同**在同一个世界里**记过的出身与加点一起套上。
                    没有预设时不显示这一条，避免给新玩家一个空功能的干扰。
                  */}
                  {heroPresets.length > 0 && (
                    <div className="rounded border border-text-muted/25 bg-black/15 px-3 py-2.5 space-y-2">
                      <div className="flex items-center gap-2">
                        <UserRound size={13} className="text-accent-lantern" />
                        <span className="text-xs text-text-secondary">用已设好的主角</span>
                        <span className="text-[10px] text-text-muted">（点一下套用，仍可继续改）</span>
                        <button
                          onClick={() => navPush({ name: 'heroes' })}
                          className="ml-auto text-[10px] text-text-muted hover:text-accent-lantern transition-colors"
                        >
                          管理我的主角
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {heroPresets.map(p => (
                          <button
                            key={p.id}
                            onClick={() => applyPreset(p)}
                            className="px-2.5 py-1 text-[11px] rounded border border-text-muted/35
                              hover:border-accent-lantern/60 hover:text-accent-lantern transition-colors
                              max-w-[14rem] truncate"
                            title={`${p.label}　${p.player.name || '未命名'}${p.player.gender ? ' · ' + p.player.gender : ''}`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid md:grid-cols-[10rem_1fr] gap-6">
                    {/*
                      主角**不生成立绘、也不上传头像**。
                      原因见 PortraitPanel 的说明：从名字随机出来的那张脸
                      与玩家填的「外貌」描述无关，等于展示一个陌生人；
                      自定义头像又与像素风格冲突。
                      主角是玩家自己 —— 用右边的文字描述表达就够了。
                    */}
                    <div className="hidden md:flex flex-col items-center justify-center gap-3 rounded border border-dashed border-text-muted/25 bg-black/15 p-4">
                      <Compass size={36} className="text-accent-lantern/50" />
                      <p className="text-[10px] text-text-muted text-center leading-relaxed">
                        主角不设立绘
                        <br />
                        右侧的外貌与性格描述
                        <br />
                        会直接注入叙事提示词
                      </p>
                    </div>

                    <div className="space-y-4">
                      {/* 手机上单列堆叠：「性别 / 代称」这类标签在三列窄格里会折行 */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <label className="block space-y-1 min-w-0">
                          <span className="block text-xs text-text-secondary whitespace-nowrap">姓名</span>
                          <input className={`${inputCls} min-w-0`} value={player.name}
                            onChange={e => patchPlayer({ name: e.target.value })} placeholder="你的名字" />
                        </label>
                        <label className="block space-y-1 min-w-0">
                          <span className="block text-xs text-text-secondary whitespace-nowrap">性别 / 代称</span>
                          <input className={`${inputCls} min-w-0`} value={player.gender}
                            onChange={e => patchPlayer({ gender: e.target.value })} placeholder="可留空" />
                        </label>
                        <label className="block space-y-1 min-w-0">
                          <span className="block text-xs text-text-secondary whitespace-nowrap">年龄</span>
                          <input className={`${inputCls} min-w-0`} value={player.age}
                            onChange={e => patchPlayer({ age: e.target.value })} placeholder="可留空" />
                        </label>
                      </div>

                      <label className="block space-y-1">
                        <span className="text-xs text-text-secondary">外貌</span>
                        <textarea className={`${areaCls} h-20`} value={player.appearance}
                          onChange={e => patchPlayer({ appearance: e.target.value })}
                          placeholder="AI 会在动作描写里呼应这些特征。" />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs text-text-secondary">性格</span>
                        <textarea className={`${areaCls} h-16`} value={player.personality}
                          onChange={e => patchPlayer({ personality: e.target.value })} />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs text-text-secondary">背景故事</span>
                        <textarea className={`${areaCls} h-20`} value={player.background}
                          onChange={e => patchPlayer({ background: e.target.value })}
                          placeholder="你的经历、身份、为何出现在这里。" />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs text-text-secondary">其他补充</span>
                        <textarea className={`${areaCls} h-14`} value={player.extra}
                          onChange={e => patchPlayer({ extra: e.target.value })}
                          placeholder="任何希望 AI 知道的事。" />
                      </label>

                      {/*
                        存为预设 —— 填好之后就地存下来，
                        下次开新局（任何世界）点一下就能套用，不必再填一遍。
                      */}
                      <div className="flex items-center gap-3 flex-wrap pt-1">
                        <button
                          onClick={saveAsPreset}
                          disabled={!player.name.trim()}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border
                            border-text-muted/40 text-text-secondary hover:border-accent-lantern/60
                            hover:text-accent-lantern transition-colors disabled:opacity-40
                            disabled:cursor-not-allowed"
                          title={player.name.trim() ? '把这份档案存下来，下次开局可直接套用' : '先填个名字再存'}
                        >
                          <BookmarkPlus size={13} />
                          存为我的主角
                        </button>
                        <span className="text-[10px] text-text-muted">
                          存下后，下一个世界开新局时点一下就能套用这份档案
                        </span>
                      </div>

                      {presetFlash && (
                        <div className="flex items-center gap-1.5 text-[11px] text-accent-lantern
                          bg-accent-lantern/10 border border-accent-lantern/30 rounded px-2.5 py-1.5">
                          <Check size={12} />
                          {presetFlash}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* ==== 出场角色 ==== */}
              {step === 'cast' && (
                <>
                  <div>
                    <h2 className="font-serif text-2xl font-bold">谁会登场？</h2>
                    <p className="text-xs text-text-muted mt-1">
                      选中的角色会作为「出场角色档案」注入提示词，并在关系面板里出现。
                    </p>
                  </div>

                  {world.characters.length === 0 ? (
                    <div className="p-8 text-center text-sm text-text-muted border border-dashed border-text-muted/20 rounded">
                      这个世界卡还没有角色卡。你可以直接开始，让 AI 自行生成 NPC；
                      <br />
                      也可以返回卡库编辑世界卡，导入 SillyTavern 角色卡。
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          onClick={() => setActiveIds(world.characters.map(c => c.id))}
                          className="text-accent-lantern hover:underline"
                        >
                          全选
                        </button>
                        <span className="text-text-muted">|</span>
                        <button onClick={() => setActiveIds([])} className="text-text-muted hover:text-text-secondary">
                          全不选
                        </button>
                        <span className="ml-auto text-text-muted">已选 {activeIds.length} / {world.characters.length}</span>
                      </div>

                      <div className="grid sm:grid-cols-2 gap-3">
                        {world.characters.map(card => {
                          const on = activeIds.includes(card.id)
                          return (
                            <button
                              key={card.id}
                              onClick={() => setActiveIds(prev =>
                                on ? prev.filter(id => id !== card.id) : [...prev, card.id]
                              )}
                              className={`text-left p-3 rounded border transition-colors flex gap-3
                                ${on
                                  ? 'bg-accent-lantern/10 border-accent-lantern/40'
                                  : 'bg-black/20 border-text-muted/20 hover:border-text-muted/40 opacity-70'}`}
                            >
                              {card.avatar
                                ? <img src={card.avatar} alt="" className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
                                : <div className="w-12 h-12 rounded-full bg-surface flex items-center justify-center flex-shrink-0 text-text-muted">
                                  <Users size={18} />
                                </div>}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm text-text-primary truncate">{card.name}</span>
                                  {on && <Check size={12} className="text-accent-lantern flex-shrink-0" />}
                                </div>
                                {card.relationship && (
                                  <div className="text-[10px] text-text-muted truncate">{card.relationship}</div>
                                )}
                                <p className="text-xs text-text-secondary mt-1 line-clamp-2 leading-relaxed">
                                  {card.description || card.personality || '（暂无描述）'}
                                </p>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* ==== 背景 ==== */}
              {step === 'background' && (
                <>
                  <div>
                    <h2 className="font-serif text-2xl font-bold">你的来处</h2>
                    <p className="text-xs text-text-muted mt-1">
                      由世界卡定义的背景槽位：它决定他的属性与资源加成、开局随身，
                      也决定他在故事里认得出什么、习惯怎么做、别人怎么待他 —— 这些每一轮都参与 AI 的叙事。
                    </p>
                  </div>

                  {world.backgrounds.length === 0 ? (
                    <div className="p-8 text-center text-sm text-text-muted border border-dashed border-text-muted/20 rounded">
                      这个世界卡没有定义背景槽位，直接进入下一步即可。
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {world.backgrounds.map(slot => (
                        <div key={slot.label} className="space-y-3">
                          <h3 className="text-sm font-bold text-accent-lantern border-b border-text-muted/20 pb-2">
                            {slot.label}
                          </h3>
                          <div className="grid sm:grid-cols-2 gap-3">
                            {slot.options.map(option => {
                              const on = backgroundChoices[slot.label] === option.id
                              /*
                                ── 「我自己写」项（`custom: true`）──
                                它占满整行、虚线边框，选中后展开一个文本框。
                                玩家的文本走 `backgroundCustom` 进 session，
                                再由 `describeBackgroundChoices` 原样取代该槽位的标题与说明
                                —— 与预设项**完全同一条链路**，不是"补充说明"。

                                为什么要开这道门（2026-10 玩家第三次打回）：
                                预设选项再宽也终究是个封闭清单，想演清单外角色的人
                                只能挑一个最接近的，然后被 AI 照着那个身份写下去。
                              */
                              return (
                                <div key={option.id} className={`space-y-2 ${option.custom ? 'sm:col-span-2' : ''}`}>
                                  <button
                                    onClick={() => setBackgroundChoices(prev => ({ ...prev, [slot.label]: option.id }))}
                                    className={`w-full text-left p-3 rounded transition-colors
                                      ${option.custom ? 'border border-dashed' : 'border'}
                                      ${on
                                        ? 'bg-accent-lantern/10 border-accent-lantern/40'
                                        : 'bg-black/20 border-text-muted/20 hover:border-text-muted/40'}`}
                                  >
                                    <div className="flex items-center gap-2">
                                      {option.custom && <Plus size={12} className="text-accent-lantern flex-shrink-0" />}
                                      <span className={`text-sm font-bold ${option.custom ? 'text-accent-lantern' : 'text-text-primary'}`}>
                                        {option.title}
                                      </span>
                                      {on && <Check size={12} className="text-accent-lantern" />}
                                    </div>
                                    {option.description && (
                                      <p className="text-xs text-text-secondary mt-1 leading-relaxed">{option.description}</p>
                                    )}
                                    <div className="flex flex-wrap gap-2 mt-2">
                                      {Object.entries(option.attributeBonus || {}).map(([k, v]) => {
                                        const def = world.attributes.find(a => a.id === k)
                                        if (!def || !v) return null
                                        return (
                                          <span key={k} className="text-[10px] px-1.5 py-0.5 rounded border"
                                            style={{ color: def.color, borderColor: `${def.color}55` }}>
                                            {def.name} {v > 0 ? '+' : ''}{v}
                                          </span>
                                        )
                                      })}
                                      {Object.entries(option.resourceBonus || {}).map(([k, v]) => {
                                        const def = world.resources.find(r => r.id === k)
                                        if (!def || !v) return null
                                        return (
                                          <span key={k} className="text-[10px] px-1.5 py-0.5 rounded border"
                                            style={{ color: def.color, borderColor: `${def.color}55` }}>
                                            {def.name} {v > 0 ? '+' : ''}{v}
                                          </span>
                                        )
                                      })}
                                    </div>
                                  </button>
                                  {option.custom && on && (
                                    <>
                                      <textarea
                                        className="w-full bg-black/40 border border-accent-lantern/30 rounded p-3 text-sm
                                          text-text-primary leading-relaxed resize-y focus:outline-none focus:border-accent-lantern/60"
                                        rows={4}
                                        placeholder="他在这里是谁？写下他的来路、营生、立场，或者他此刻的处境。写多少算多少 —— AI 会照它写。"
                                        value={backgroundCustom[slot.label] || ''}
                                        onChange={e => patchBackgroundCustom(slot.label, e.target.value)}
                                      />
                                      {/*
                                        空着的时候要说话。
                                        因为引擎那边的规则是"选了自填却没写 ⇒ 当作没选这个槽位"
                                        （见 describeBackgroundChoices），所以空着**不会有任何效果** ——
                                        但玩家看不出来，他只会觉得"我选了啊"。这里把后果讲明白。
                                      */}
                                      {!(backgroundCustom[slot.label] || '').trim() && (
                                        <p className="text-[11px] text-amber-400/90 mt-1.5">
                                          还没写。空着的话，这一槽不会有任何内容 —— 他既不会因此获得属性，
                                          AI 也不会知道他的来路。写一句也行。
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              )
                            })}
                            {slot.options.length === 0 && (
                              <div className="text-xs text-text-muted italic">该槽位暂无选项。</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ==== 属性 ==== */}
              {step === 'attributes' && (
                <>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <h2 className="font-serif text-2xl font-bold">
                        {world.enableMechanics ? '你的所长' : '属性分配'}
                      </h2>
                      <p className="text-xs text-text-muted mt-1">
                        {world.enableMechanics
                          ? `可自由分配 ${world.attributePoints} 点。属性是他**做得到什么、做不到什么**的天花板：高的地方他是内行，低的地方他会失手 —— AI 每一轮都照着这个写。`
                          : '这个世界卡关闭了机制层，数值不会生效。'}
                      </p>
                    </div>
                    {world.enableMechanics && (
                      <div className="text-right flex-shrink-0">
                        <div className="text-[10px] text-text-muted">剩余点数</div>
                        <div className={`text-2xl font-mono font-bold ${remaining === 0 ? 'text-green-500' : remaining < 0 ? 'text-red-400' : 'text-accent-lantern'}`}>
                          {remaining}
                        </div>
                      </div>
                    )}
                  </div>

                  {world.enableMechanics && (
                    <>
                      <div className="grid sm:grid-cols-2 gap-3">
                        {world.attributes.map(def => {
                          const value = finalStats.attributes[def.id] ?? 0
                          const manual = allocation[def.id] ?? 0
                          return (
                            <div key={def.id} className="p-3 rounded border border-text-muted/20 bg-black/20 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="font-bold" style={{ color: def.color }}>{def.name}</span>
                                <span className="font-mono text-xl" style={{ color: def.color }}>{value}</span>
                              </div>
                              {def.description && (
                                <p className="text-[10px] text-text-secondary leading-relaxed">{def.description}</p>
                              )}
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  onClick={() => setAllocation(prev => ({ ...prev, [def.id]: Math.max(0, (prev[def.id] || 0) - 1) }))}
                                  disabled={manual === 0}
                                  className="flex-1 py-1 text-sm bg-surface/40 rounded hover:bg-surface/60 disabled:opacity-20"
                                >
                                  −
                                </button>
                                <span className="text-[10px] text-text-muted w-16 text-center font-mono">
                                  已加 {manual}
                                </span>
                                <button
                                  onClick={() => setAllocation(prev => ({ ...prev, [def.id]: (prev[def.id] || 0) + 1 }))}
                                  disabled={remaining <= 0}
                                  className="flex-1 py-1 text-sm bg-surface/40 rounded hover:bg-surface/60 disabled:opacity-20"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* 资源预览 */}
                      <div className="pt-4 border-t border-text-muted/20 space-y-3">
                        <h3 className="text-sm font-bold text-accent-lantern">开局数值</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {world.resources.map(def => {
                            const value = finalStats.resources[def.id] ?? 0
                            const pct = typeof def.max === 'number' && def.max > 0
                              ? Math.min(100, (value / def.max) * 100)
                              : 100
                            return (
                              <div key={def.id} className="p-3 rounded border border-text-muted/20 bg-black/20 space-y-1.5">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-text-secondary">{def.name}</span>
                                  <span className="font-mono" style={{ color: def.color }}>
                                    {value}{typeof def.max === 'number' ? ` / ${def.max}` : ''}
                                  </span>
                                </div>
                                {typeof def.max === 'number' && (
                                  <div className="h-1.5 bg-surface/40 rounded-full overflow-hidden">
                                    <div className="h-full rounded-full transition-all"
                                      style={{ width: `${pct}%`, backgroundColor: def.color }} />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      {/* 开局物品 */}
                      {startingItems.length > 0 && (
                        <div className="pt-4 border-t border-text-muted/20 space-y-3">
                          <h3 className="text-sm font-bold text-accent-lantern">开局携带</h3>
                          <div className="grid sm:grid-cols-2 gap-2">
                            {startingItems.map(item => (
                              <div key={item.id} className="p-2 rounded border border-text-muted/20 bg-black/20">
                                <div className="text-xs text-text-primary">{item.name}</div>
                                <div className="text-[10px] text-text-muted mt-0.5 leading-relaxed">{item.description}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/*
                    ── 开局处境预览 ──
                    ⚠️ 这里显示的**不是**这一局的第一幕，而是"这类处境通常是什么样"的**素材**。
                    第一幕由 AI 结合**你自己填的主角设定**现场创作 ——
                    所以文案必须说清楚这件事，否则玩家会以为"点进去就是这出戏"，
                    又会觉得自己的自设被顶掉了（这正是玩家打过回票的那件事）。
                  */}
                  {(() => {
                    const slotLabel = world.story.openerSlot
                    const slot = slotLabel ? world.backgrounds.find(s => s.label === slotLabel) : null
                    // openingSeeds 已扁平化：直接「选项 id → 素材」
                    const map = world.story.openingSeeds
                    const chosenId = slotLabel ? backgroundChoices[slotLabel] : undefined
                    const opt = slot?.options.find(o => o.id === chosenId)
                    const seed = (opt && map ? (map[opt.id] ?? map[opt.title] ?? '') : '').trim()
                    const carried = (opt?.startingItems || [])
                      .map(id => world.items.find(i => i.id === id)?.name)
                      .filter((x): x is string => !!x)

                    return (
                      <div className="pt-4 border-t border-text-muted/20 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-bold text-accent-lantern">开局处境</h3>
                          {opt && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-lantern/10 text-accent-lantern border border-accent-lantern/30">
                              {slotLabel}：{opt.title}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-text-muted leading-relaxed">
                          ⓘ 第一幕由 AI 结合你自己填的主角设定现场创作。下面这段只是这类环境的
                          气味、行话与价钱，它不规定你现在在哪、正在做什么。
                          你在「扮演角色」里写的身份与职位优先于这里的任何说法。
                        </p>
                        {seed && (
                          <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap font-serif">
                            {seed}
                          </p>
                        )}
                        {carried.length > 0 && (
                          <p className="text-[10px] text-text-muted">开局随身：{carried.join('、')}</p>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* 底部导航 */}
      <footer className="flex items-center justify-between gap-4 px-6 py-4 border-t border-text-muted/20">
        <button
          onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id)}
          disabled={stepIndex === 0}
          className="flex items-center gap-1.5 px-4 py-2 text-sm border border-text-muted/40 rounded hover:text-accent-lantern hover:border-accent-lantern/40 transition-colors disabled:opacity-30 disabled:hover:text-text-muted"
        >
          <ArrowLeft size={14} /> 上一步
        </button>

        <div className="flex items-center gap-3">
          {!canLaunch && (
            <span className="text-xs text-red-400">还有 {Math.abs(remaining)} 点未分配完</span>
          )}
          {stepIndex < STEPS.length - 1 ? (
            <button
              onClick={() => setStep(STEPS[stepIndex + 1].id)}
              className="flex items-center gap-1.5 px-5 py-2 text-sm bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
            >
              下一步 <ArrowRight size={14} />
            </button>
          ) : (
            <button
              onClick={handleLaunch}
              disabled={!canLaunch}
              className="flex items-center gap-1.5 px-6 py-2 text-sm bg-accent-lantern text-black font-bold rounded hover:bg-accent-lantern/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={14} /> 开始故事
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

export default SessionSetup
