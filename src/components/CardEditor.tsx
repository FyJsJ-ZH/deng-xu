import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Plus, Trash2, Upload, Download, UserPlus, Save, Copy, Play,
  Globe, Sliders, BookOpen, Users, Wand2, Image as ImageIcon
} from 'lucide-react'
import type { BackgroundOption, BackgroundSlot, CharacterCard, ItemTemplate, LoreTemplate, WorldCard } from '@/types/cards'
import { useLibraryStore } from '@/stores/library'
import { useUIStore } from '@/stores/ui'
import { createEmptyCharacter, parseCharacterFile, toSillyTavern } from '@/utils/cardIO'
import { downloadFile, makeId, readFileAsDataURL, safeFilename, timestampSuffix } from '@/utils/files'
import { WORLD_TONES, WORLD_TONE_IDS, toneAccent } from '@/utils/worldTone'
import { generateScene } from '@/utils/sceneArt'

/**
 * 世界卡编辑器
 *
 * 这是「脱离特定题材」的核心界面：原本写死在代码里的世界设定、八种性相、
 * 三种资源、剧本事件，现在全部在这里由用户编辑。
 */

const TABS = [
  { id: 'basic', label: '基础', icon: Globe },
  { id: 'lore', label: '世界观', icon: BookOpen },
  { id: 'mechanics', label: '机制', icon: Sliders },
  { id: 'narrative', label: '文风', icon: Wand2 },
  { id: 'characters', label: '角色卡', icon: Users }
] as const

type TabId = typeof TABS[number]['id']

const PALETTE = ['#eab308', '#ef4444', '#3b82f6', '#a855f7', '#22c55e', '#f97316', '#14b8a6', '#64748b']

/** 新建世界的空壳 */
export function createEmptyWorld(): WorldCard {
  const now = Date.now()
  return {
    id: makeId('world'),
    title: '未命名世界',
    tagline: '',
    cover: undefined,
    worldLore: '',
    rules: '',
    attributes: [
      { id: 'might', name: '武力', description: '体魄与搏斗', color: PALETTE[1] },
      { id: 'wits', name: '智识', description: '推理与学识', color: PALETTE[2] },
      { id: 'charm', name: '魅力', description: '言辞与影响力', color: PALETTE[3] }
    ],
    resources: [
      { id: 'health', name: '生命', description: '肉体承受的伤害', initial: 5, max: 5, color: PALETTE[1], critical: true },
      { id: 'energy', name: '精力', description: '行动与专注的储备', initial: 5, max: 5, color: PALETTE[0] }
    ],
    backgrounds: [
      {
        label: '出身',
        options: [
          { id: 'origin_a', title: '选项一', description: '描述这个出身。', attributeBonus: {}, startingItems: [] },
          { id: 'origin_b', title: '选项二', description: '描述这个出身。', attributeBonus: {} }
        ]
      }
    ],
    attributePoints: 4,
    items: [],
    lores: [],
    story: {
      atmosphere: '',
      mainQuest: '',
      enableStages: false,
      stages: [],
      enableChoices: true,
      urgencyAfterTurns: 4
    },
    narrative: {
      // 与内置世界卡的规范一致：第三人称、过去时（2026-10 用户要求）
      pov: 'third',
      tense: 'past',
      replyLength: 600,
      customStyle: ''
    },
    characters: [],
    enableMechanics: true,
    avatarStyle: 'ink',
    createdAt: now,
    updatedAt: now,
    builtin: false
  }
}

// —— 通用小控件 ——

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    // min-w-0：作为 grid/flex 子项时允许收缩，否则长 placeholder 会把列撑宽
    <label className="block space-y-1 min-w-0">
      {/* whitespace-nowrap：中文标签在窄列里折行会让同一行各字段的输入框高低不齐 */}
      <span className="block text-xs text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-text-muted">{hint}</span>}
    </label>
  )
}

const inputCls =
  'w-full bg-black/30 border border-text-muted/30 rounded px-2 py-1.5 text-sm text-text-primary ' +
  'placeholder:text-text-muted/50 focus:border-accent-lantern outline-none'

const areaCls = `${inputCls} resize-y leading-relaxed font-serif`

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-text-muted/20 pb-2 mb-3">
      <h4 className="text-sm font-bold text-accent-lantern tracking-wide">{children}</h4>
      {action}
    </div>
  )
}

function IconButton({ onClick, title, children, danger }: {
  onClick: () => void; title: string; children: React.ReactNode; danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded border transition-colors ${danger
        ? 'border-red-900/40 text-red-400/80 hover:bg-red-900/20 hover:text-red-300'
        : 'border-text-muted/30 text-text-muted hover:text-accent-lantern hover:border-accent-lantern/40'}`}
    >
      {children}
    </button>
  )
}

export function CardEditor() {
  const { isCardEditorOpen, setCardEditorOpen, editingWorldId, setEditingWorldId } = useUIStore()
  const { saveWorld, getWorld } = useLibraryStore()

  const [draft, setDraft] = useState<WorldCard | null>(null)
  const [tab, setTab] = useState<TabId>('basic')
  const [status, setStatus] = useState<string | null>(null)
  const [editingCharId, setEditingCharId] = useState<string | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  // 打开时装载草稿：编辑已有卡则深拷贝一份，避免边改边污染库里的卡
  useEffect(() => {
    if (!isCardEditorOpen) return
    if (editingWorldId) {
      const existing = getWorld(editingWorldId)
      if (existing) {
        setDraft(JSON.parse(JSON.stringify(existing)))
        setTab('basic')
        setEditingCharId(null)
        return
      }
    }
    setDraft(createEmptyWorld())
    setTab('basic')
    setEditingCharId(null)
    // getWorld 是稳定引用，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCardEditorOpen, editingWorldId])

  const editingChar = useMemo(
    () => draft?.characters.find(c => c.id === editingCharId) || null,
    [draft, editingCharId]
  )

  if (!isCardEditorOpen || !draft) return null

  const patch = (p: Partial<WorldCard>) => setDraft(d => (d ? { ...d, ...p } : d))
  const patchStory = (p: Partial<WorldCard['story']>) => setDraft(d => (d ? { ...d, story: { ...d.story, ...p } } : d))
  const patchNarrative = (p: Partial<WorldCard['narrative']>) => setDraft(d => (d ? { ...d, narrative: { ...d.narrative, ...p } } : d))

  const patchChar = (id: string, p: Partial<CharacterCard>) => setDraft(d => {
    if (!d) return d
    return { ...d, characters: d.characters.map(c => (c.id === id ? { ...c, ...p } : c)) }
  })

  const handleSave = async () => {
    if (!draft.title.trim()) {
      setStatus('请先填写世界名称。')
      return
    }
    await saveWorld({ ...draft, updatedAt: Date.now() })
    setStatus('已保存。')
    setTimeout(() => {
      setCardEditorOpen(false)
      setEditingWorldId(null)
    }, 600)
  }

  /**
   * 保存并直接进入开局配置。
   * 关键点：先把卡写进卡片库，再把它作为 pendingSetup 交给 StartScreen。
   * 不能只传 id 让 StartScreen 去库里查 —— 新建卡若还没落库就会查不到而卡死。
   */
  const handleSaveAndStart = async () => {
    if (!draft.title.trim()) {
      setStatus('请先填写世界名称。')
      return
    }
    const toSave = { ...draft, updatedAt: Date.now() }
    await saveWorld(toSave)
    useUIStore.getState().setPendingSetup({ world: toSave })
    setCardEditorOpen(false)
    setEditingWorldId(null)
  }

  const handleExportWorld = () => {
    downloadFile(`${safeFilename(draft.title)}-${timestampSuffix()}.world.json`, {
      format: 'pale-notes-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      world: draft
    })
  }

  /** 导入角色卡：PNG（SillyTavern V2/V3）或 JSON 都能吃 */
  const handleImportCharacters = async (files: FileList | null) => {
    if (!files?.length) return
    const added: CharacterCard[] = []
    let failed = 0
    for (const file of Array.from(files)) {
      const card = await parseCharacterFile(file)
      if (card) added.push(card)
      else failed++
    }
    if (added.length) {
      setDraft(d => (d ? { ...d, characters: [...d.characters, ...added] } : d))
      setEditingCharId(added[0].id)
    }
    setStatus(
      added.length
        ? `已导入 ${added.length} 张角色卡${failed ? `，${failed} 个文件无法识别` : ''}。`
        : '导入失败：没有可识别的角色卡文件。'
    )
  }

  const handleCoverUpload = async (file: File | undefined) => {
    if (!file) return
    const dataUrl = await readFileAsDataURL(file)
    patch({ cover: dataUrl })
  }

  const handleAvatarUpload = async (file: File | undefined) => {
    if (!file || !editingChar) return
    const dataUrl = await readFileAsDataURL(file)
    patchChar(editingChar.id, { avatar: dataUrl })
  }

  // —— 机制：属性 / 资源 / 背景 / 物品 / 知识 的增删 ——

  const addAttribute = () => patch({
    attributes: [...draft.attributes, {
      id: `attr_${draft.attributes.length + 1}`,
      name: `属性 ${draft.attributes.length + 1}`,
      description: '',
      color: PALETTE[draft.attributes.length % PALETTE.length]
    }]
  })

  const updateAttribute = (i: number, p: Partial<WorldCard['attributes'][number]>) =>
    patch({ attributes: draft.attributes.map((a, idx) => (idx === i ? { ...a, ...p } : a)) })

  const addResource = () => patch({
    resources: [...draft.resources, {
      id: `res_${draft.resources.length + 1}`,
      name: `资源 ${draft.resources.length + 1}`,
      description: '',
      initial: 5,
      max: 5,
      color: PALETTE[draft.resources.length % PALETTE.length]
    }]
  })

  const updateResource = (i: number, p: Partial<WorldCard['resources'][number]>) =>
    patch({ resources: draft.resources.map((r, idx) => (idx === i ? { ...r, ...p } : r)) })

  const addBackgroundSlot = () => patch({
    backgrounds: [...draft.backgrounds, { label: `槽位 ${draft.backgrounds.length + 1}`, options: [] }]
  })

  const updateSlot = (i: number, p: Partial<BackgroundSlot>) =>
    patch({ backgrounds: draft.backgrounds.map((s, idx) => (idx === i ? { ...s, ...p } : s)) })

  const addBackgroundOption = (i: number) => {
    const opt: BackgroundOption = {
      id: makeId('bg'),
      title: '新选项',
      description: '',
      attributeBonus: {},
      startingItems: []
    }
    updateSlot(i, { options: [...draft.backgrounds[i].options, opt] })
  }

  const updateBackgroundOption = (slotIdx: number, optIdx: number, p: Partial<BackgroundOption>) => {
    const options = draft.backgrounds[slotIdx].options.map((o, idx) => (idx === optIdx ? { ...o, ...p } : o))
    updateSlot(slotIdx, { options })
  }

  const addItem = () => patch({
    items: [...draft.items, { id: makeId('item'), name: '新物品', description: '', tags: [] }]
  })

  const updateItem = (i: number, p: Partial<ItemTemplate>) =>
    patch({ items: draft.items.map((it, idx) => (idx === i ? { ...it, ...p } : it)) })

  const addLore = () => patch({
    lores: [...draft.lores, { id: makeId('lore'), name: '新知识', description: '', attribute: draft.attributes[0]?.id, level: 1 }]
  })

  const updateLore = (i: number, p: Partial<LoreTemplate>) =>
    patch({ lores: draft.lores.map((l, idx) => (idx === i ? { ...l, ...p } : l)) })

  return (
    <div className="fixed inset-0 z-[90] bg-black/90 backdrop-blur-sm flex items-stretch md:items-center justify-center p-0 md:p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-background border border-text-muted/30 md:rounded-lg w-full max-w-6xl flex flex-col h-full md:h-[92vh] overflow-hidden shadow-2xl"
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-text-muted/30 bg-surface/50">
          <div className="min-w-0">
            <h2 className="font-serif font-bold text-accent-lantern truncate">
              {editingWorldId ? '编辑世界卡' : '新建世界卡'}
            </h2>
            <p className="text-[10px] text-text-muted font-mono truncate">
              {draft.title || '未命名世界'} · {draft.characters.length} 角色 · {draft.attributes.length} 属性 · {draft.resources.length} 资源
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {status && <span className="text-xs text-accent-lantern hidden md:inline">{status}</span>}
            <button
              onClick={handleExportWorld}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
            >
              <Download size={14} /> 导出
            </button>
            <button
              onClick={handleSaveAndStart}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/15 transition-colors"
              title="保存本卡并进入开局配置"
            >
              <Play size={14} /> <span className="hidden sm:inline">保存并开始</span>
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-lantern/15 border border-accent-lantern/40 text-accent-lantern rounded hover:bg-accent-lantern/25 transition-colors"
            >
              <Save size={14} /> 保存
            </button>
            <button
              onClick={() => { setCardEditorOpen(false); setEditingWorldId(null) }}
              className="p-1.5 text-text-muted hover:text-text-primary transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        <div className="flex border-b border-text-muted/30 bg-surface/20 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs whitespace-nowrap border-b-2 transition-colors
                  ${tab === t.id
                    ? 'border-accent-lantern text-accent-lantern bg-black/20'
                    : 'border-transparent text-text-muted hover:text-text-secondary'}`}
              >
                <Icon size={14} /> {t.label}
              </button>
            )
          })}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* ============ 基础 ============ */}
          {tab === 'basic' && (
            <div className="space-y-5 max-w-3xl">
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="世界名称" hint="会显示在标题与叙事提示词里">
                  <input className={inputCls} value={draft.title}
                    onChange={e => patch({ title: e.target.value })} placeholder="例如：灰烬回响" />
                </Field>
                <Field label="一句话简介">
                  <input className={inputCls} value={draft.tagline}
                    onChange={e => patch({ tagline: e.target.value })} placeholder="例如：在神明死后留下的废墟上…" />
                </Field>
              </div>

              <Field label="封面图（可选）">
                <div className="flex items-center gap-3">
                  {draft.cover
                    ? <img src={draft.cover} alt="cover" className="w-32 h-20 object-cover rounded border border-text-muted/30" />
                    : <div className="w-32 h-20 rounded border border-dashed border-text-muted/30 flex items-center justify-center text-text-muted"><ImageIcon size={18} /></div>}
                  <div className="space-y-2">
                    <label className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors cursor-pointer w-fit">
                      <Upload size={14} /> 上传封面
                      <input type="file" accept="image/*" className="hidden"
                        onChange={e => handleCoverUpload(e.target.files?.[0])} />
                    </label>
                    {draft.cover && (
                      <button onClick={() => patch({ cover: undefined })}
                        className="block text-[10px] text-text-muted hover:text-red-400 transition-colors">移除封面</button>
                    )}
                  </div>
                </div>
              </Field>

              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-4">
                <SectionTitle>世界色调</SectionTitle>
                <p className="text-[10px] text-text-muted -mt-1">
                  决定本世界**像素场景背景**的配色（同一张山岭，冷色调与暖色调观感差别很大）。
                  <br />
                  人物立绘不受此项影响 —— 立绘是 LPC 像素素材，始终保留发色 / 肤色 / 衣色的完整变化范围。
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {WORLD_TONE_IDS.map(id => {
                    const def = WORLD_TONES[id]
                    const on = (draft.avatarStyle || 'ink') === id
                    /*
                      预览用**真实像素场景**，不再用旧的几何头像。
                      以前这里渲染 generateAvatar()，但那条渲染路径早已退化为
                      "角色卡没自带图片时的极小兜底"，主路径是 LPC 像素立绘 ——
                      于是这个选择器在展示一种玩家基本看不到的东西。
                    */
                    const scene = generateScene('s10', id, draft.avatarTone)
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => patch({ avatarStyle: id })}
                        className={`p-2 rounded border transition-colors text-left
                          ${on ? 'bg-accent-lantern/10 border-accent-lantern/50' : 'bg-black/20 border-text-muted/20 hover:border-text-muted/40'}`}
                      >
                        <img
                          src={scene.dataUrl}
                          alt={def.label}
                          className="w-full aspect-video rounded border border-black/40"
                          style={{ imageRendering: 'pixelated' }}
                        />
                        <div className={`mt-1.5 text-[11px] ${on ? 'text-accent-lantern' : 'text-text-secondary'}`}>
                          {def.label}
                        </div>
                        <div className="mt-0.5 text-[9px] text-text-muted leading-snug">{def.hint}</div>
                      </button>
                    )
                  })}
                </div>

                <Field label="色调点缀色（可选）" hint="覆盖场景里的灯火、水面等点缀色；留空则用所选色调自带的颜色">
                  <div className="flex items-center gap-2">
                    <input type="color" value={draft.avatarTone || toneAccent(draft.avatarStyle)}
                      onChange={e => patch({ avatarTone: e.target.value })}
                      className="w-8 h-8 bg-transparent border border-text-muted/30 rounded cursor-pointer" />
                    <input className={`${inputCls} w-32 font-mono text-xs min-w-0`} value={draft.avatarTone || ''}
                      onChange={e => patch({ avatarTone: e.target.value || undefined })} placeholder="留空=默认" />
                    {draft.avatarTone && (
                      <button type="button" onClick={() => patch({ avatarTone: undefined })}
                        className="text-[10px] text-text-muted hover:text-red-400 transition-colors">清除</button>
                    )}
                  </div>
                </Field>
              </div>

              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-3">
                <SectionTitle>机制层开关</SectionTitle>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={draft.enableMechanics}
                    onChange={e => patch({ enableMechanics: e.target.checked })}
                    className="mt-0.5 accent-yellow-500" />
                  <span className="text-xs text-text-secondary leading-relaxed">
                    <b className="text-text-primary">启用属性 / 资源 / 物品 / 线索结算</b><br />
                    关闭后引擎只做纯叙事与选项生成，不再维护任何数值 —— 相当于一个纯粹的对话式角色扮演。
                    此时「机制」页的配置会被忽略。
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ============ 世界观 ============ */}
          {tab === 'lore' && (
            <div className="space-y-5 max-w-4xl">
              <Field
                label="世界观设定"
                hint="这是 AI 最重要的依据。建议写清：时代背景、地理、势力、专有名词、日常生活的样子。"
              >
                <textarea className={`${areaCls} h-72`} value={draft.worldLore}
                  onChange={e => patch({ worldLore: e.target.value })}
                  placeholder={'**世界背景**\n\n这里是这个世界的时代、地点与基本面貌…\n\n**势力**\n- 势力A：…\n- 势力B：…'} />
              </Field>

              <Field
                label="世界规则与硬性约束"
                hint="写清「什么是不可能的」和「必须使用什么术语」，比堆砌形容词更能防止模型跑题。"
              >
                <textarea className={`${areaCls} h-40`} value={draft.rules}
                  onChange={e => patch({ rules: e.target.value })}
                  placeholder={'1. 这个世界没有魔法，超自然仅限于…\n2. 使用「遗物」「共鸣」等术语，不要出现现代科技词汇。\n3. 死人不会说话。'} />
              </Field>

              <div className="grid md:grid-cols-2 gap-4">
                {/*
                  ⚠️ 标签从「主线目标」改为「长期目标（可选）」。
                  这个字段在沙盒世界里是"几个宏大宽泛的方向"，
                  不是必须推进的主线；叫"主线目标"会引导作者写成任务书。
                */}
                <Field label="长期目标（可选，可留空）" hint="写几个宽泛的方向即可，不要写成任务书；留空则完全由玩家自己找方向">
                  <textarea className={`${areaCls} h-28`} value={draft.story.mainQuest}
                    onChange={e => patchStory({ mainQuest: e.target.value })}
                    placeholder={'**以下都是可选的。** 你可以在镇上当一辈子伙计，把日子过下去，这不算玩错。若想往大处走：\n· 挣一份自己的家业\n· 查清那件事的真相\n· 成为某一方离不开的人'} />
                </Field>
                {/*
                  ⚠️ 开场的措辞要强调"这是**场景骨架**，不是逐字剧本"。
                  玩家反馈过"选了半天背景，开场一模一样" —— 根因是引擎原先
                  把这段当固定剧本发下去，背景选择根本没进去。
                  现在引擎会连同所选背景一起交给 AI（见 openingByBackground），
                  所以作者这里应当只写**舞台与局势**，
                  把"主角此刻为什么在这里"留给背景去决定。
                */}
                {/*
                  ⚠️ 字段是 `atmosphere`，**不是** `opening`。
                  `opening` 是改名前的老名字，引擎读的是 `atmosphere || opening`
                  这个兜底 —— 所以这里写错字段时"跑起来看着没问题"，
                  但实际上：内置卡（已有 atmosphere）在编辑器里改这段**完全无效**，
                  而被遮蔽的正是玩家以为自己刚写下的文字。
                */}
                <Field
                  label="世界氛围（可留空）"
                  hint="写这个世界的时间感、地标、气味、物价与规矩；它是每一轮叙事的底色，不是第一幕的剧本"
                >
                  <textarea className={`${areaCls} h-28`} value={draft.story.atmosphere}
                    onChange={e => patchStory({ atmosphere: e.target.value })}
                    placeholder={'米价一石六百文，一碗汤饼八文；东京的坊市不闭，西京日落即闭市。\n（写"底色"就够：时间感、地标、气味、物价、规矩。\n第一幕由 AI 结合玩家自设的主角现场创作，不必在这里写死。）'} />
                </Field>
              </div>

              {/*
                「开局处境」—— 只读展示 + 选择处境槽位。
                ⚠️ 这里写的是**素材**（这类处境通常是什么样），**不是写死的第一幕**。
                第一幕由 AI 结合玩家自设的主角现场创作 ——
                所以文案不能说成"专属第一幕"，否则作者会往这里写剧本，
                又会把玩家的自设顶掉。
              */}
              {(() => {
                const slotLabel = draft.story.openerSlot
                const slots = draft.backgrounds || []
                // openingSeeds 已扁平化：直接「选项 id → 素材」
                const map = draft.story.openingSeeds
                const openerSlot = slots.find(s => s.label === slotLabel)
                const rows = openerSlot
                  ? openerSlot.options.map(o => ({
                      title: o.title,
                      text: (map?.[o.id] ?? map?.[o.title] ?? '').trim(),
                    }))
                  : []
                const covered = rows.filter(r => r.text).length
                return (
                  <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-3">
                    <SectionTitle>
                      开局处境（素材）
                      <span className="ml-2 text-[10px] font-normal text-text-muted">
                        {openerSlot
                          ? `${covered} / ${rows.length} 个处境已有素材`
                          : '未指定处境槽位'}
                      </span>
                    </SectionTitle>

                    <Field
                      label="处境槽位"
                      hint="哪个背景槽位描述「主角大致处在什么场合、什么层级」。它的每个选项应给一段素材（这类处境通常的样子），不要写成固定剧本、也不要预设具体官职与上司 —— 玩家的自设优先。"
                    >
                      <select
                        className={inputCls}
                        value={slotLabel || ''}
                        onChange={e => patchStory({ openerSlot: e.target.value || undefined })}
                      >
                        <option value="">（不指定）</option>
                        {slots.map(s => (
                          <option key={s.label} value={s.label}>
                            {s.label}（{s.options.length} 项）
                          </option>
                        ))}
                      </select>
                    </Field>

                    {rows.length > 0 && (
                      <div className="max-h-56 overflow-y-auto space-y-2">
                        {rows.map(r => (
                          <div key={r.title} className="text-[11px] leading-relaxed">
                            <span className="text-text-primary">{r.title}</span>
                            {r.text
                              ? <span className="text-text-secondary"> —— {r.text}</span>
                              : <span className="text-accent-forge"> —— 未写（AI 只按世界基调创作）</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-3">
                <SectionTitle
                  action={
                    <button onClick={() => patchStory({
                      stages: [...draft.story.stages, {
                        id: makeId('stage'),
                        title: `第 ${draft.story.stages.length + 1} 幕`,
                        text: '',
                        isStatic: false,
                        triggers: [{ type: 'chapter_start', chapterId: draft.story.stages.length + 1 }],
                        options: [],
                        chapterId: draft.story.stages.length + 1
                      }]
                    })} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                      <Plus size={12} /> 添加章节卡事件
                    </button>
                  }
                >
                  章节卡事件（可选）
                </SectionTitle>
                <p className="text-[10px] text-text-muted -mt-1">
                  用于插入由你亲手写的固定剧情节点。不写也完全可以，故事会完全由 AI 驱动。
                </p>

                {draft.story.stages.length === 0 && (
                  <div className="text-xs text-text-muted italic py-3 text-center border border-dashed border-text-muted/20 rounded">
                    没有章节卡事件 —— 故事将完全由 AI 自由推进。
                  </div>
                )}

                {draft.story.stages.map((stage, si) => (
                  <div key={stage.id} className="p-3 bg-black/30 border border-text-muted/20 rounded space-y-3">
                    <div className="flex items-center gap-2">
                      <input className={`${inputCls} flex-1`} value={stage.title || ''}
                        onChange={e => patchStory({
                          stages: draft.story.stages.map((s, i) => i === si ? { ...s, title: e.target.value } : s)
                        })}
                        placeholder="事件标题" />
                      <IconButton danger title="删除事件" onClick={() => patchStory({
                        stages: draft.story.stages.filter((_, i) => i !== si)
                      })}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>

                    {/* 手机上单列堆叠：三列在窄屏只有 ~100px，「所属章节」「触发类型」会折行错位 */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Field label="所属章节">
                        <input type="number" className={`${inputCls} min-w-0`} value={stage.chapterId ?? 1}
                          onChange={e => patchStory({
                            stages: draft.story.stages.map((s, i) => i === si ? { ...s, chapterId: Number(e.target.value) } : s)
                          })} />
                      </Field>
                      <Field label="触发类型">
                        <select className={`${inputCls} min-w-0`}
                          value={stage.triggers[0]?.type ?? 'chapter_start'}
                          onChange={e => {
                            const type = e.target.value as any
                            const trigger = type === 'chapter_start'
                              ? { type, chapterId: stage.chapterId ?? 1 }
                              : type === 'has_item'
                                ? { type, itemId: '' }
                                : { type, tag: '' }
                            patchStory({
                              stages: draft.story.stages.map((s, i) => i === si ? { ...s, triggers: [trigger as any] } : s)
                            })
                          }}>
                          <option value="chapter_start">进入章节</option>
                          <option value="has_item">持有物品</option>
                          <option value="has_tag">拥有标记</option>
                        </select>
                      </Field>
                      <Field label="触发参数">
                        {stage.triggers[0]?.type === 'has_item' ? (
                          <input className={inputCls} value={(stage.triggers[0] as any).itemId || ''}
                            onChange={e => patchStory({
                              stages: draft.story.stages.map((s, i) => i === si
                                ? { ...s, triggers: [{ type: 'has_item', itemId: e.target.value } as any] } : s)
                            })} placeholder="物品 id" />
                        ) : stage.triggers[0]?.type === 'has_tag' ? (
                          <input className={inputCls} value={(stage.triggers[0] as any).tag || ''}
                            onChange={e => patchStory({
                              stages: draft.story.stages.map((s, i) => i === si
                                ? { ...s, triggers: [{ type: 'has_tag', tag: e.target.value } as any] } : s)
                            })} placeholder="标记名" />
                        ) : (
                          <input type="number" className={inputCls} value={(stage.triggers[0] as any).chapterId ?? 1}
                            onChange={e => patchStory({
                              stages: draft.story.stages.map((s, i) => i === si
                                ? { ...s, triggers: [{ type: 'chapter_start', chapterId: Number(e.target.value) } as any] } : s)
                            })} />
                        )}
                      </Field>
                    </div>

                    <Field label="事件内容" hint="这段文字会作为指令交给叙事 AI 详细演绎，不要写成结果，写成情境。">
                      <textarea className={`${areaCls} h-24`} value={stage.text}
                        onChange={e => patchStory({
                          stages: draft.story.stages.map((s, i) => i === si ? { ...s, text: e.target.value } : s)
                        })} />
                    </Field>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-text-secondary">事件选项</span>
                        <button onClick={() => patchStory({
                          stages: draft.story.stages.map((s, i) => i === si
                            ? {
                              ...s, options: [...s.options, {
                                id: makeId('opt'), text: '新选项',
                                style: draft.attributes[0]?.id || 'neutral'
                              }]
                            } : s)
                        })} className="text-[10px] text-accent-lantern hover:underline">+ 添加选项</button>
                      </div>
                      {stage.options.map((opt, oi) => (
                        <div key={opt.id} className="flex items-center gap-2">
                          <input className={`${inputCls} flex-1`} value={opt.text}
                            onChange={e => patchStory({
                              stages: draft.story.stages.map((s, i) => i === si
                                ? { ...s, options: s.options.map((o, j) => j === oi ? { ...o, text: e.target.value } : o) } : s)
                            })} />
                          <select className={`${inputCls} w-28`} value={opt.style || 'neutral'}
                            onChange={e => patchStory({
                              stages: draft.story.stages.map((s, i) => i === si
                                ? { ...s, options: s.options.map((o, j) => j === oi ? { ...o, style: e.target.value } : o) } : s)
                            })}>
                            <option value="neutral">中性</option>
                            {draft.attributes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <IconButton danger title="删除选项" onClick={() => patchStory({
                            stages: draft.story.stages.map((s, i) => i === si
                              ? { ...s, options: s.options.filter((_, j) => j !== oi) } : s)
                          })}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============ 机制 ============ */}
          {tab === 'mechanics' && (
            <div className="space-y-6 max-w-4xl">
              {!draft.enableMechanics && (
                <div className="p-3 bg-accent-forge/10 border border-accent-forge/30 rounded text-xs text-accent-forge">
                  机制层已关闭（在「基础」页可开启）。以下配置不会生效。
                </div>
              )}

              {/* 属性 */}
              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded">
                <SectionTitle action={
                  <button onClick={addAttribute} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                    <Plus size={12} /> 添加属性
                  </button>
                }>
                  属性维度
                </SectionTitle>
                <p className="text-[10px] text-text-muted mb-3 -mt-1">
                  AI 会依据这些维度判断玩家的行动风格并给相应的成长。id 用于内部结算，请用英文小写。
                </p>
                <div className="space-y-2">
                  {draft.attributes.map((a, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-2 p-2 rounded border border-text-muted/15 bg-black/20 md:flex-nowrap md:border-transparent md:bg-transparent md:p-0"
                    >
                      <input type="color" value={a.color || '#888888'}
                        onChange={e => updateAttribute(i, { color: e.target.value })}
                        className="w-8 h-8 shrink-0 bg-transparent border border-text-muted/30 rounded cursor-pointer" />
                      <input className={`${inputCls} min-w-0 flex-1 basis-24`} value={a.name}
                        onChange={e => updateAttribute(i, { name: e.target.value })} placeholder="显示名" />
                      <input className={`${inputCls} font-mono text-xs min-w-0 flex-1 basis-24`} value={a.id}
                        onChange={e => updateAttribute(i, { id: e.target.value })} placeholder="id" />
                      <IconButton danger title="删除属性"
                        onClick={() => patch({ attributes: draft.attributes.filter((_, j) => j !== i) })}>
                        <Trash2 size={14} />
                      </IconButton>
                      {/* 说明单独占一行（手机上），桌面上挤回同一行 */}
                      <input className={`${inputCls} w-full min-w-0 md:w-auto md:flex-1 md:basis-40`} value={a.description || ''}
                        onChange={e => updateAttribute(i, { description: e.target.value })}
                        placeholder="说明（会写进提示词，告诉 AI 这个属性代表什么）" />
                    </div>
                  ))}
                  {draft.attributes.length === 0 && (
                    <div className="text-xs text-text-muted italic py-2">没有定义属性，AI 将不做属性成长。</div>
                  )}
                </div>
              </div>

              {/* 资源 */}
              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded">
                <SectionTitle action={
                  <button onClick={addResource} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                    <Plus size={12} /> 添加资源
                  </button>
                }>
                  资源条
                </SectionTitle>
                <p className="text-[10px] text-text-muted mb-3 -mt-1">
                  上限留空表示无上限（例如金钱）。勾选「致命」会让 AI 在归零时把故事引向结局。
                </p>
                <div className="space-y-2">
                  {draft.resources.map((r, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-2 p-2 rounded border border-text-muted/15 bg-black/20 md:flex-nowrap md:border-transparent md:bg-transparent md:p-0"
                    >
                      <input type="color" value={r.color || '#888888'}
                        onChange={e => updateResource(i, { color: e.target.value })}
                        className="w-8 h-8 shrink-0 bg-transparent border border-text-muted/30 rounded cursor-pointer" />
                      <input className={`${inputCls} min-w-0 flex-1 basis-24`} value={r.name}
                        onChange={e => updateResource(i, { name: e.target.value })} placeholder="显示名" />
                      <input className={`${inputCls} font-mono text-xs min-w-0 flex-1 basis-24`} value={r.id}
                        onChange={e => updateResource(i, { id: e.target.value })} placeholder="id" />

                      {/*
                        数值字段必须让 <input> 自己当 flex 子项。
                        曾把 input 套在 label 里，label 是 flex 容器、宽度受限于所在格子，
                        而 Tailwind 的 input{width:100%} 只能撑到 label 宽度，
                        减去「初始」两个字的宽度后就只剩 21px —— 输入了什么也看不见。
                      */}
                      <label className="flex items-center gap-1 text-[10px] text-text-secondary whitespace-nowrap shrink-0">
                        初始
                        <input type="number" inputMode="numeric"
                          className={`${inputCls} !w-16 shrink-0`} value={r.initial}
                          onChange={e => updateResource(i, { initial: Number(e.target.value) })} />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-text-secondary whitespace-nowrap shrink-0">
                        上限
                        <input type="number" inputMode="numeric"
                          className={`${inputCls} !w-16 shrink-0`}
                          value={r.max ?? ''} placeholder="∞"
                          onChange={e => updateResource(i, {
                            max: e.target.value === '' ? undefined : Number(e.target.value)
                          })} />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-text-secondary whitespace-nowrap shrink-0">
                        <input type="checkbox" checked={!!r.critical}
                          onChange={e => updateResource(i, { critical: e.target.checked })}
                          className="accent-yellow-500" />
                        致命
                      </label>

                      <IconButton danger title="删除资源"
                        onClick={() => patch({ resources: draft.resources.filter((_, j) => j !== i) })}>
                        <Trash2 size={14} />
                      </IconButton>

                      {/* 说明单独占一行（手机上），桌面上挤回同一行 */}
                      <input className={`${inputCls} w-full min-w-0 md:w-auto md:flex-1 md:basis-40`} value={r.description || ''}
                        onChange={e => updateResource(i, { description: e.target.value })} placeholder="说明" />
                    </div>
                  ))}
                </div>
              </div>

              {/* 属性点 */}
              <Field label="开局可分配属性点" hint="创建角色时玩家可以自由分配的点数">
                <input type="number" className={`${inputCls} w-32`} value={draft.attributePoints}
                  onChange={e => patch({ attributePoints: Number(e.target.value) })} />
              </Field>

              {/* 背景槽位 */}
              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-3">
                <SectionTitle action={
                  <button onClick={addBackgroundSlot} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                    <Plus size={12} /> 添加槽位
                  </button>
                }>
                  开局背景槽位
                </SectionTitle>
                <p className="text-[10px] text-text-muted -mt-1">
                  类似「出身 / 童年 / 特质」。每个槽位让玩家选一项，可带属性与资源加成。
                </p>

                {draft.backgrounds.map((slot, si) => (
                  <div key={si} className="p-3 bg-black/30 border border-text-muted/20 rounded space-y-3">
                    <div className="flex items-center gap-2">
                      <input className={`${inputCls} flex-1`} value={slot.label}
                        onChange={e => updateSlot(si, { label: e.target.value })} placeholder="槽位名，如「出身」" />
                      <button onClick={() => addBackgroundOption(si)}
                        className="text-[10px] text-accent-lantern hover:underline whitespace-nowrap">+ 选项</button>
                      <IconButton danger title="删除槽位"
                        onClick={() => patch({ backgrounds: draft.backgrounds.filter((_, i) => i !== si) })}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>

                    {slot.options.map((opt, oi) => (
                      <div key={opt.id} className="p-2 bg-black/20 rounded space-y-2">
                        <div className="flex items-center gap-2">
                          <input className={`${inputCls} flex-1`} value={opt.title}
                            onChange={e => updateBackgroundOption(si, oi, { title: e.target.value })} placeholder="标题" />
                          <IconButton danger title="删除选项" onClick={() => {
                            updateSlot(si, { options: slot.options.filter((_, i) => i !== oi) })
                          }}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                        <input className={inputCls} value={opt.description || ''}
                          onChange={e => updateBackgroundOption(si, oi, { description: e.target.value })} placeholder="描述" />
                        <div className="flex flex-wrap gap-3">
                          {draft.attributes.map(a => (
                            <label key={a.id} className="flex items-center gap-1 text-[10px] text-text-secondary">
                              {a.name}
                              <input type="number" className={`${inputCls} w-14`}
                                value={opt.attributeBonus?.[a.id] ?? 0}
                                onChange={e => updateBackgroundOption(si, oi, {
                                  attributeBonus: { ...opt.attributeBonus, [a.id]: Number(e.target.value) }
                                })} />
                            </label>
                          ))}
                          {draft.resources.map(r => (
                            <label key={r.id} className="flex items-center gap-1 text-[10px] text-text-secondary">
                              {r.name}
                              <input type="number" className={`${inputCls} w-14`}
                                value={opt.resourceBonus?.[r.id] ?? 0}
                                onChange={e => updateBackgroundOption(si, oi, {
                                  resourceBonus: { ...opt.resourceBonus, [r.id]: Number(e.target.value) }
                                })} />
                            </label>
                          ))}
                        </div>

                        {/*
                          开局携带物品的勾选。
                          之前这一块完全没有 UI —— 数据类型里有 startingItems、运行期也会发道具，
                          但没有地方能设置它，所以自定义世界卡的「预置物品」永远拿不到手上，
                          看起来就是"物品和背景毫无关系"。这里把它接上。
                        */}
                        <div className="pt-1 border-t border-text-muted/10">
                          <div className="text-[10px] text-text-secondary mb-1.5">
                            开局携带物品
                            {draft.items.length === 0 && (
                              <span className="text-text-muted">（先在下方「预置物品」里添加物品）</span>
                            )}
                          </div>
                          {draft.items.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {draft.items.map(it => {
                                const on = (opt.startingItems || []).includes(it.id)
                                return (
                                  <button
                                    key={it.id}
                                    type="button"
                                    onClick={() => {
                                      const cur = opt.startingItems || []
                                      updateBackgroundOption(si, oi, {
                                        startingItems: on ? cur.filter(x => x !== it.id) : [...cur, it.id]
                                      })
                                    }}
                                    className={`text-[10px] px-2 py-1 rounded border transition-colors
                                      ${on
                                        ? 'bg-accent-lantern/15 border-accent-lantern/50 text-accent-lantern'
                                        : 'bg-black/20 border-text-muted/20 text-text-muted hover:border-text-muted/40'}`}
                                    title={it.description}
                                  >
                                    {on ? '✓ ' : '+ '}{it.name}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {slot.options.length === 0 && (
                      <div className="text-[10px] text-text-muted italic">该槽位还没有选项。</div>
                    )}
                  </div>
                ))}
              </div>

              {/* 物品与知识 */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="p-4 bg-surface/20 border border-text-muted/20 rounded">
                  <SectionTitle action={
                    <button onClick={addItem} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                      <Plus size={12} /> 添加
                    </button>
                  }>
                    预置物品
                  </SectionTitle>
                  <p className="text-[10px] text-text-muted -mt-1 mb-2">
                    这里只是<b className="text-text-secondary">登记物品模板</b>，不会自动发给玩家。
                    要让某个出身/背景带来物品，请在上面每个背景选项里勾选「开局携带物品」。
                    AI 在剧情中也会参考这些模板来发道具。
                  </p>
                  <div className="space-y-2">
                    {draft.items.map((it, i) => (
                      <div key={i} className="grid grid-cols-[1fr_2rem] md:grid-cols-[8rem_1fr_2rem] gap-2 items-center p-2 rounded border border-text-muted/15 bg-black/20 md:border-transparent md:bg-transparent md:p-0">
                        <input className={`${inputCls} min-w-0`} value={it.name}
                          onChange={e => updateItem(i, { name: e.target.value })} placeholder="名称" />
                        <input className={`${inputCls} col-span-2 md:col-span-1 min-w-0`} value={it.description}
                          onChange={e => updateItem(i, { description: e.target.value })} placeholder="描述" />
                        <IconButton danger title="删除"
                          onClick={() => patch({ items: draft.items.filter((_, j) => j !== i) })}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    ))}
                    {draft.items.length === 0 && <div className="text-[10px] text-text-muted italic">暂无预置物品。</div>}
                  </div>
                </div>

                <div className="p-4 bg-surface/20 border border-text-muted/20 rounded">
                  <SectionTitle action={
                    <button onClick={addLore} className="flex items-center gap-1 text-[10px] text-accent-lantern hover:underline">
                      <Plus size={12} /> 添加
                    </button>
                  }>
                    预置知识
                  </SectionTitle>
                  <p className="text-[10px] text-text-muted -mt-1 mb-2">
                    登记这个世界里存在的知识/技艺。玩家在剧情中习得后，会出现在「知识」栏里。
                  </p>
                  <div className="space-y-2">
                    {draft.lores.map((l, i) => (
                      <div key={i} className="grid grid-cols-[1fr_2rem] md:grid-cols-[8rem_1fr_2rem] gap-2 items-center p-2 rounded border border-text-muted/15 bg-black/20 md:border-transparent md:bg-transparent md:p-0">
                        <input className={`${inputCls} min-w-0`} value={l.name}
                          onChange={e => updateLore(i, { name: e.target.value })} placeholder="名称" />
                        <input className={`${inputCls} col-span-2 md:col-span-1 min-w-0`} value={l.description}
                          onChange={e => updateLore(i, { description: e.target.value })} placeholder="描述" />
                        <IconButton danger title="删除"
                          onClick={() => patch({ lores: draft.lores.filter((_, j) => j !== i) })}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    ))}
                    {draft.lores.length === 0 && <div className="text-[10px] text-text-muted italic">暂无预置知识。</div>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============ 文风 ============ */}
          {tab === 'narrative' && (
            <div className="space-y-5 max-w-3xl">
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="叙事人称">
                  <select className={inputCls} value={draft.narrative.pov}
                    onChange={e => patchNarrative({ pov: e.target.value as any })}>
                    <option value="second">第二人称（你）</option>
                    <option value="first">第一人称（我）</option>
                    <option value="third">第三人称（他/她）</option>
                  </select>
                </Field>
                <Field label="叙事时态">
                  <select className={inputCls} value={draft.narrative.tense}
                    onChange={e => patchNarrative({ tense: e.target.value as any })}>
                    <option value="present">现在时</option>
                    <option value="past">过去时</option>
                  </select>
                </Field>
              </div>

              <Field label={`单次回复目标字数：${draft.narrative.replyLength}`} hint="太短会显得敷衍，太长会拖慢节奏并更贵">
                <input type="range" min={150} max={1500} step={50} value={draft.narrative.replyLength}
                  onChange={e => patchNarrative({ replyLength: Number(e.target.value) })}
                  className="w-full accent-yellow-500" />
              </Field>

              <Field label="额外文风要求" hint="例如「文风阴冷克制，避免华丽辞藻」「多用短句与对话」">
                <textarea className={`${areaCls} h-28`} value={draft.narrative.customStyle}
                  onChange={e => patchNarrative({ customStyle: e.target.value })} />
              </Field>

              <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-4">
                <SectionTitle>玩法选项</SectionTitle>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={draft.story.enableChoices}
                    onChange={e => patchStory({ enableChoices: e.target.checked })}
                    className="mt-0.5 accent-yellow-500" />
                  <span className="text-xs text-text-secondary leading-relaxed">
                    <b className="text-text-primary">生成建议行动选项</b><br />
                    关闭后只保留自由输入框，玩家完全靠自己描述行动。
                  </span>
                </label>

                <Field label="催促阈值（回合）" hint="玩家在同一情节点逗留超过这么多回合就提醒 AI 推进局势；填 0 关闭">
                  <input type="number" className={`${inputCls} w-32`} value={draft.story.urgencyAfterTurns}
                    onChange={e => patchStory({ urgencyAfterTurns: Number(e.target.value) })} />
                </Field>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={draft.story.enableStages}
                    onChange={e => patchStory({ enableStages: e.target.checked })}
                    className="mt-0.5 accent-yellow-500" />
                  <span className="text-xs text-text-secondary leading-relaxed">
                    <b className="text-text-primary">启用章节卡事件</b><br />
                    开启后「世界观」页里写的固定剧情节点会被自动触发。
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ============ 角色卡 ============ */}
          {tab === 'characters' && (
            <div className="grid lg:grid-cols-[16rem_1fr] gap-5 h-full">
              {/* 左：角色列表 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => {
                    // 新建的角色默认**不在场**（与项目规范一致：谁在场由玩家勾或 AI 定）
                    const c = createEmptyCharacter({ present: false })
                    patch({ characters: [...draft.characters, c] })
                    setEditingCharId(c.id)
                  }} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-accent-lantern/10 border border-accent-lantern/30 text-accent-lantern rounded hover:bg-accent-lantern/20 transition-colors">
                    <UserPlus size={14} /> 新建
                  </button>
                  <button onClick={() => importRef.current?.click()}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors">
                    <Upload size={14} /> 导入
                  </button>
                  <input ref={importRef} type="file" multiple
                    accept=".json,.png,image/png,application/json" className="hidden"
                    onChange={e => { handleImportCharacters(e.target.files); e.target.value = '' }} />
                </div>
                <p className="text-[10px] text-text-muted leading-relaxed">
                  支持导入 SillyTavern 的 <b>PNG</b> 角色卡与 <b>JSON</b> 卡。
                </p>

                <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
                  {draft.characters.map(c => (
                    <button key={c.id} onClick={() => setEditingCharId(c.id)}
                      className={`w-full text-left p-2 rounded border transition-colors flex items-center gap-2
                        ${editingCharId === c.id
                          ? 'bg-accent-lantern/10 border-accent-lantern/50'
                          : 'bg-black/20 border-text-muted/20 hover:border-text-muted/40'}`}>
                      {c.avatar
                        ? <img src={c.avatar} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                        : <div className="w-8 h-8 rounded-full bg-surface flex items-center justify-center flex-shrink-0 text-text-muted text-xs">
                          {c.name.slice(0, 1)}
                        </div>}
                      <div className="min-w-0">
                        <div className="text-xs text-text-primary truncate">{c.name}</div>
                        <div className="text-[10px] text-text-muted truncate">
                          {c.present ? '在场' : '未登场'}{c.relationship ? ` · ${c.relationship}` : ''}
                        </div>
                      </div>
                    </button>
                  ))}
                  {draft.characters.length === 0 && (
                    <div className="text-[10px] text-text-muted italic p-3 border border-dashed border-text-muted/20 rounded text-center">
                      还没有角色卡。<br />可以手动新建，或导入现成的酒馆卡。
                    </div>
                  )}
                </div>
              </div>

              {/* 右：角色详情 */}
              <div className="min-w-0">
                {!editingChar ? (
                  <div className="h-full flex items-center justify-center text-xs text-text-muted italic border border-dashed border-text-muted/20 rounded min-h-[20rem]">
                    从左侧选择一张角色卡开始编辑
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/*
                      布局要点：
                      - 头像、表单、删除按钮用 flex 排；表单列加 min-w-0，
                        否则 flex 子项的最小内容宽度会把输入框挤扁。
                      - 手机上前两行各占满整行，从第三行起 2 列。
                        原来三个字段硬塞一行（每列约 100px），
                        「与玩家关系」四个字会折成两行，导致输入框高度参差不齐。
                      - Field 的 label 用 whitespace-nowrap 防止再出现折行错位。
                    */}
                    <div className="flex flex-col md:flex-row items-start gap-4">
                      <div className="flex items-center md:block gap-3 flex-shrink-0 w-full md:w-auto">
                        {editingChar.avatar
                          ? <img src={editingChar.avatar} alt="" className="w-20 h-20 rounded object-cover border border-text-muted/30 flex-shrink-0" />
                          : <div className="w-20 h-20 rounded border border-dashed border-text-muted/30 flex items-center justify-center text-text-muted flex-shrink-0">
                            <ImageIcon size={20} />
                          </div>}
                        <label className="text-[10px] text-text-muted hover:text-accent-lantern cursor-pointer md:block md:text-center md:mt-1">
                          上传头像
                          <input type="file" accept="image/*" className="hidden"
                            onChange={e => handleAvatarUpload(e.target.files?.[0])} />
                        </label>
                      </div>

                      <div className="flex-1 w-full min-w-0 space-y-3">
                        {/* 删除按钮与角色名同一行，避免孤零零占一整行 */}
                        <div className="flex items-end gap-2">
                          <div className="flex-1 min-w-0">
                            <Field label="角色名">
                              <input className={`${inputCls} min-w-0`} value={editingChar.name}
                                onChange={e => patchChar(editingChar.id, { name: e.target.value })} />
                            </Field>
                          </div>
                          <div className="flex-shrink-0 pb-0.5">
                            <IconButton danger title="删除这张角色卡" onClick={() => {
                              patch({ characters: draft.characters.filter(c => c.id !== editingChar.id) })
                              setEditingCharId(null)
                            }}>
                              <Trash2 size={14} />
                            </IconButton>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <Field label="与玩家关系">
                            <input className={`${inputCls} min-w-0`} value={editingChar.relationship || ''}
                              onChange={e => patchChar(editingChar.id, { relationship: e.target.value })} placeholder="如：导师" />
                          </Field>
                          <Field label="初始状态">
                            <input className={`${inputCls} min-w-0`} value={editingChar.status || ''}
                              onChange={e => patchChar(editingChar.id, { status: e.target.value })} placeholder="如：健康" />
                          </Field>
                          <Field label="初始地点">
                            <input className={`${inputCls} min-w-0 sm:col-span-2`} value={editingChar.location || ''}
                              onChange={e => patchChar(editingChar.id, { location: e.target.value })} placeholder="如：灰港 · 慢钟旅店" />
                          </Field>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-4 text-xs">
                      <label className="flex items-center gap-2 cursor-pointer text-text-secondary">
                        <input type="checkbox" checked={editingChar.present}
                          onChange={e => patchChar(editingChar.id, { present: e.target.checked })}
                          className="accent-yellow-500" />
                        开局即在场
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer text-text-secondary">
                        <input type="checkbox" checked={!!editingChar.playable}
                          onChange={e => patchChar(editingChar.id, { playable: e.target.checked })}
                          className="accent-yellow-500" />
                        由玩家扮演
                      </label>
                      <button
                        onClick={() => downloadFile(
                          `${safeFilename(editingChar.name)}-${timestampSuffix()}.card.json`,
                          toSillyTavern(editingChar)
                        )}
                        className="flex items-center gap-1 text-text-muted hover:text-accent-lantern transition-colors">
                        <Copy size={12} /> 导出为酒馆卡
                      </button>
                    </div>

                    <Field label="设定（description）" hint="外貌、身份、经历等客观事实">
                      <textarea className={`${areaCls} h-24`} value={editingChar.description}
                        onChange={e => patchChar(editingChar.id, { description: e.target.value })} />
                    </Field>

                    <Field label="性格（personality）">
                      <textarea className={`${areaCls} h-20`} value={editingChar.personality}
                        onChange={e => patchChar(editingChar.id, { personality: e.target.value })} />
                    </Field>

                    <Field label="相关情境（scenario）" hint="这个角色通常出现在什么场合">
                      <textarea className={`${areaCls} h-16`} value={editingChar.scenario}
                        onChange={e => patchChar(editingChar.id, { scenario: e.target.value })} />
                    </Field>

                    <Field label="开场白（first message）" hint="注意：本引擎的首幕由 AI 生成，这里主要作为语气参考">
                      <textarea className={`${areaCls} h-20`} value={editingChar.firstMessage}
                        onChange={e => patchChar(editingChar.id, { firstMessage: e.target.value })} />
                    </Field>

                    <Field label="对话示例（message examples）" hint="写 1~3 组示例最能塑造说话风格，格式自由">
                      <textarea className={`${areaCls} h-28`} value={editingChar.messageExamples}
                        onChange={e => patchChar(editingChar.id, { messageExamples: e.target.value })} />
                    </Field>

                    <Field label="专属指令（system prompt）" hint="对该角色的额外约束，优先级较高">
                      <textarea className={`${areaCls} h-16`} value={editingChar.systemPrompt}
                        onChange={e => patchChar(editingChar.id, { systemPrompt: e.target.value })} />
                    </Field>

                    <Field label="其他要求（post history instructions）">
                      <textarea className={`${areaCls} h-16`} value={editingChar.postHistoryInstructions}
                        onChange={e => patchChar(editingChar.id, { postHistoryInstructions: e.target.value })} />
                    </Field>

                    <div className="grid md:grid-cols-2 gap-4">
                      <Field label="标签" hint="用逗号分隔">
                        <input className={inputCls} value={editingChar.tags.join(', ')}
                          onChange={e => patchChar(editingChar.id, {
                            tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                          })} />
                      </Field>
                      <Field label="作者 / 版本">
                        <div className="flex gap-2">
                          <input className={inputCls} value={editingChar.creator}
                            onChange={e => patchChar(editingChar.id, { creator: e.target.value })} placeholder="作者" />
                          <input className={`${inputCls} w-24`} value={editingChar.characterVersion}
                            onChange={e => patchChar(editingChar.id, { characterVersion: e.target.value })} placeholder="版本" />
                        </div>
                      </Field>
                    </div>

                    <Field label="作者备注（creator notes）">
                      <textarea className={`${areaCls} h-14`} value={editingChar.creatorNotes}
                        onChange={e => patchChar(editingChar.id, { creatorNotes: e.target.value })} />
                    </Field>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部状态条（移动端显示保存反馈） */}
        <AnimatePresence>
          {status && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden px-5 py-2 text-xs text-accent-lantern bg-black/40 border-t border-text-muted/30"
            >
              {status}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
