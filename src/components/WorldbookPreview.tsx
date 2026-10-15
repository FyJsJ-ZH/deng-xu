import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronLeft, ChevronDown, ChevronRight, Pencil, Play, Users, Boxes, MapPin, ScrollText,
  Sparkles, Compass, BookOpen, Swords, Package, Settings as Settings2, Search, Library,
} from 'lucide-react'
import type { WorldCard } from '@/types/cards'
import { CharacterSprite } from '@/components/CharacterSprite'

/**
 * 世界书预览 —— **只读地**看一个世界的全部设定。
 *
 * 为什么需要它：
 *  在这之前，想知道一张世界卡里写了什么，唯一的办法是**打开卡片编辑器**。
 *  编辑器是"改"的地方，不是"读"的地方：它满屏输入框、按钮是保存/删除，
 *  只想看看设定的人会不知所措，也容易误改。
 *
 * ## 为什么把「资料」拆成单独一栏（2026-10 玩家反馈）
 *
 * 玩家原话：
 *   「把机制栏内的背景槽位与预置物品，知识单独拿出来做成一栏并优化使用体验，
 *     **不然在世界书内容量大的时候非常杂乱**」
 *
 * 他说得对，而且根子在**结构**上：原先「概览」一栏里塞了
 * 长期目标 + 属性 + 资源 + 开局背景 + 预置物品 + 开场基调 + 开局处境素材，
 * 而每一块都是**全量展开**的 —— 帷幕纪年有 79 个背景选项、63 件物品、
 * 18 条知识、22 段开场素材，于是概览页长得像一份没有目录的附录。
 *
 * 所以现在：
 *   · **概览**只留"一眼看清这是什么世界"的东西（目标方向、属性、资源、开场基调）；
 *   · **资料**接纳一切"可查阅的清单"：开局背景 / 预置物品 / 知识条目，
 *     并且带**搜索**与**折叠**（默认收起，点开才展开）—— 清单本身不该占满屏幕。
 */
export function WorldbookPreview({
  world,
  onBack,
  onEdit,
  onStart,
  isBuiltin,
}: {
  world: WorldCard
  onBack: () => void
  onEdit?: () => void
  onStart: () => void
  isBuiltin?: boolean
}) {
  const [tab, setTab] = useState<'overview' | 'people' | 'world' | 'data'>('overview')
  /** 资料栏的搜索词（跨背景/物品/知识过滤） */
  const [q, setQ] = useState('')

  const tabs = useMemo(() => ([
    { id: 'overview' as const, label: '概览', icon: <ScrollText size={13} /> },
    { id: 'people' as const, label: `人物 (${world.characters?.length || 0})`, icon: <Users size={13} /> },
    { id: 'world' as const, label: '设定', icon: <Compass size={13} /> },
    /*
      「资料」栏的计数放在标签上，玩家一眼就知道里面有多少东西 ——
      内容量大的世界（帷幕：79 背景选项 / 63 物品 / 18 知识）尤其需要。
    */
    {
      id: 'data' as const,
      label: `资料 (${(world.backgrounds || []).reduce((n, s) => n + s.options.length, 0)
        + (world.items?.length || 0) + (world.lores?.length || 0)})`,
      icon: <Library size={13} />,
    },
  ]), [world.characters, world.backgrounds, world.items, world.lores])

  return (
    <div className="max-w-4xl mx-auto w-full px-6 py-8">
      {/* 顶栏 */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
        >
          <ChevronLeft size={14} /> 返回
        </button>
        <div className="flex items-center gap-2">
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
            >
              <Pencil size={13} /> 编辑
            </button>
          )}
          <button
            onClick={onStart}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold bg-accent-lantern text-black rounded hover:bg-accent-lantern/90 transition-colors"
          >
            <Play size={13} /> 用这个世界开始
          </button>
        </div>
      </div>

      {/* 头部：封面 + 标题 + 一句话简介 */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6"
      >
        <div className="flex flex-col sm:flex-row gap-5">
          {world.cover && (
            <img src={world.cover} alt=""
              className="w-full sm:w-52 h-32 object-cover rounded border border-text-muted/30 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {isBuiltin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent-forge/50 text-accent-forge">
                  内置示例
                </span>
              )}
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                world.enableMechanics
                  ? 'border-accent-lantern/40 text-accent-lantern'
                  : 'border-text-muted/40 text-text-muted'
              }`}>
                {world.enableMechanics ? '机制向' : '纯叙事'}
              </span>
            </div>
            <h1 className="font-serif font-bold text-2xl text-text-primary mb-2">{world.title}</h1>
            {world.tagline && (
              <p className="text-sm text-text-secondary leading-relaxed font-serif italic">
                {world.tagline}
              </p>
            )}
          </div>
        </div>
      </motion.div>

      {/*
        分页。
        ⚠️ 手机上**必须能横向滚动**：四个标签（概览 / 人物(N) / 设定 / 资料(N)）
        在 390px 宽里塞不下 —— 挤成一团会点错，溢出则会顶破布局。
        所以用 overflow-x-auto + shrink-0，并让内边距在窄屏收窄。
      */}
      <div className="flex border-b border-text-muted/20 mb-6 overflow-x-auto no-scrollbar">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-xs transition-colors border-b-2 -mb-px shrink-0 whitespace-nowrap ${
              tab === t.id
                ? 'text-accent-lantern border-accent-lantern'
                : 'text-text-muted border-transparent hover:text-text-secondary'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── 概览 ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {world.story?.mainQuest && (
            /*
              ⚠️ 标签不能叫「主线目标」。
              内置的三个世界是**沙盒**：这些内容是"若干宏大宽泛的可选方向"，
              不是必须推进的主线。叫"主线目标"会让玩家以为有通关路线，
              也会让作者照着"写一个任务"来填这个字段。
            */
            <Panel icon={<Swords size={14} />} title="长期目标（可选）" hint="沙盒里可以追求的方向，不是必须做的事">
              <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{world.story.mainQuest}</p>
            </Panel>
          )}

          {world.enableMechanics && (
            <div className="grid sm:grid-cols-2 gap-4">
              <Panel icon={<Sparkles size={14} />} title={`属性（${world.attributes.length}）`} hint={`开局可分配 ${world.attributePoints} 点`}>
                {world.attributes.length === 0
                  ? <Empty>这个世界没有定义属性</Empty>
                  : (
                    <div className="space-y-1.5">
                      {world.attributes.map(a => (
                        <div key={a.id} className="flex items-baseline gap-2">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{ background: a.color }} />
                          <span className="text-xs text-text-primary shrink-0">{a.name}</span>
                          {a.description && <span className="text-[10px] text-text-muted truncate">{a.description}</span>}
                        </div>
                      ))}
                    </div>
                  )}
              </Panel>
              <Panel icon={<Boxes size={14} />} title={`资源（${world.resources.length}）`}>
                {world.resources.length === 0
                  ? <Empty>这个世界没有定义资源</Empty>
                  : (
                    <div className="space-y-1.5">
                      {world.resources.map(r => (
                        <div key={r.id} className="flex items-baseline gap-2">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{ background: r.color }} />
                          <span className="text-xs text-text-primary shrink-0">{r.name}</span>
                          <span className="text-[10px] text-text-muted font-mono">
                            初始 {r.initial}{typeof r.max === 'number' ? ` / 上限 ${r.max}` : ''}
                            {r.critical ? ' · 归零即结局' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
              </Panel>
            </div>
          )}

          {(world.story?.atmosphere || world.story?.opening) && (
            <Panel
              icon={<BookOpen size={14} />}
              title="世界氛围"
              hint="第一幕由 AI 依据「你自设的主角」＋所选处境现场创作，这一段只是世界的氛围参考"
            >
              <Prose text={world.story.atmosphere || world.story.opening || ''} />
            </Panel>
          )}

          {/*
            ⚠️ 这里原来还堆着「开局背景」「预置物品」「开局处境素材」三块全量清单，
            再加「设定」栏里的「知识条目」—— 加起来上千行，概览页因此长得像附录。
            它们现在都搬到「资料」栏，并配了搜索与折叠。
            概览只留"一眼看清这是什么世界"的内容。
          */}
          <p className="text-[11px] text-text-muted leading-relaxed px-1">
            背景槽位、预置物品与知识条目已移到
            <button
              onClick={() => setTab('data')}
              className="text-accent-lantern hover:underline decoration-dotted mx-1"
            >
              资料
            </button>
            栏（那里可以搜索与折叠，长清单不再把这一页撑开）。
          </p>
        </div>
      )}

      {/* ── 人物 ── */}
      {tab === 'people' && (
        <div className="space-y-4">
          {(world.characters?.length || 0) === 0 ? (
            <Empty>这张世界卡没有内置角色卡，游戏里的 NPC 会由 AI 依据世界观生成。</Empty>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {world.characters.map(c => (
                <div key={c.id} className="flex gap-3 p-3 rounded border border-text-muted/20 bg-black/20">
                  <CharacterSprite
                    name={c.name}
                    id={c.id}
                    /* 部件级显式外观优先；profile 只补没写的字段 */
                    look={c.look}
                    profile={{ name: c.name, description: c.description, personality: c.personality, scenario: c.scenario }}
                    headOnly
                    scale={4}
                    className="w-14 h-14 rounded bg-black/30 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary font-serif mb-1">{c.name}</div>
                    {c.description && (
                      <p className="text-[10px] text-text-muted leading-relaxed line-clamp-4">{c.description}</p>
                    )}
                    {c.personality && (
                      <p className="text-[10px] text-text-muted/70 leading-relaxed line-clamp-2 mt-1">
                        性格：{c.personality}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 设定 ── */}
      {tab === 'world' && (
        <div className="space-y-6">
          {world.worldLore && (
            <Panel icon={<MapPin size={14} />} title="世界观">
              <Prose text={world.worldLore} />
            </Panel>
          )}
          {world.rules && (
            <Panel icon={<ScrollText size={14} />} title="世界规则" hint="写给 AI 的硬性约束">
              <Prose text={world.rules} />
            </Panel>
          )}
          {world.narrative?.customStyle && (
            <Panel icon={<Sparkles size={14} />} title="叙事文风" hint="写给叙事 AI 的写作要求">
              <Prose text={world.narrative.customStyle} />
            </Panel>
          )}
          <Panel icon={<Settings2 size={14} />} title="叙事参数">
            <div className="text-[11px] text-text-muted font-mono space-y-0.5">
              <div>人称：{world.narrative?.pov === 'second' ? '第二人称' : world.narrative?.pov === 'first' ? '第一人称' : '第三人称'}</div>
              <div>时态：{world.narrative?.tense === 'present' ? '现在时' : '过去时'}</div>
              <div>期望篇幅：约 {world.narrative?.replyLength || 500} 字</div>
              <div>机制层：{world.enableMechanics ? '开启' : '关闭'}</div>
              <div>章节卡事件：{world.story?.enableStages ? '开启' : '关闭'}</div>
            </div>
          </Panel>

          {/* 世界书下载入口：想照着做自己世界的人会需要 */}
          <div className="p-4 rounded border border-text-muted/20 bg-black/20">
            <div className="text-xs text-text-secondary mb-2">想照着写自己的世界？</div>
            {/*
              ⚠️ 链接必须带 `?v=<build>`。
              `official-worldbook.json` 放在 `public/` 下，**文件名不带 hash**，
              所以它和 index.html 一样会被缓存十分钟 —— 用户点"下载"可能拿到上一版。
              带上构建标识，就等于每次下载都绕开缓存拿最新的。
              （`__DX_BUILD__` 由 scripts/vite-plugin-build-version.ts 注入，见那里的注释。）
            */}
            <a href={`./official-worldbook.json?v=${(window as unknown as { __DX_BUILD__?: string }).__DX_BUILD__ || ''}`} download
              className="inline-flex items-center gap-1.5 text-[11px] text-accent-lantern hover:underline decoration-dotted">
              <ScrollText size={12} /> 下载官方世界书（含全部内置世界，可直接导入回来）
            </a>
          </div>
        </div>
      )}

      {/*
        ═══ 资料 ═══
        一切"可查阅的清单"都住在这里：开局背景、预置物品、知识条目。
        设计目标是**内容量大也不杂乱**，所以三件事一起做：
          1. **分区块**且默认**折叠**（点标题才展开）——清单不该占满屏幕；
          2. **搜索**（跨三区过滤）——想知道"有没有一件叫音叉的东西"时不用翻；
          3. **分组**（背景按槽位、物品按标签、知识按关联属性）——长列表有层次。
      */}
      {tab === 'data' && (() => {
        const kw = q.trim().toLowerCase()
        const hit = (...parts: (string | undefined)[]) =>
          !kw || parts.some(p => (p || '').toLowerCase().includes(kw))

        const bgSlots = (world.backgrounds || []).map(slot => ({
          ...slot,
          options: slot.options.filter(o => hit(o.title, o.description)),
        })).filter(s => s.options.length > 0)

        const itemGroups = new Map<string, typeof world.items>()
        for (const it of world.items || []) {
          if (!hit(it.name, it.description)) continue
          const key = (it.tags && it.tags[0]) || '其他'
          if (!itemGroups.has(key)) itemGroups.set(key, [])
          itemGroups.get(key)!.push(it)
        }

        const loreGroups = new Map<string, typeof world.lores>()
        for (const l of world.lores || []) {
          if (!hit(l.name, l.description)) continue
          const def = world.attributes?.find(a => a.id === l.attribute)
          const key = def?.name || '通用'
          if (!loreGroups.has(key)) loreGroups.set(key, [])
          loreGroups.get(key)!.push(l)
        }

        // openingSeeds 已扁平化：直接「选项 id → 素材」
        const seedMap = world.story?.openingSeeds
        const nBg = bgSlots.reduce((n, s) => n + s.options.length, 0)
        const nItem = [...itemGroups.values()].reduce((n, a) => n + a.length, 0)
        const nLore = [...loreGroups.values()].reduce((n, a) => n + a.length, 0)

        return (
          <div className="space-y-4">
            {/* 搜索条（粘性，滚动时一直在） */}
            <div className="sticky top-0 z-10 -mx-1 px-1 pt-1 pb-2 bg-bg/95 backdrop-blur-sm border-b border-text-muted/20">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="搜背景、物品、知识……"
                  className="w-full pl-8 pr-3 py-2 text-xs rounded bg-black/30 border border-text-muted/30
                             text-text-primary placeholder:text-text-muted/50 focus:border-accent-lantern outline-none"
                />
              </div>
              <div className="flex items-center gap-3 mt-2 text-[10px] text-text-muted">
                <span>背景 {nBg}</span><span>·</span>
                <span>物品 {nItem}</span><span>·</span>
                <span>知识 {nLore}</span>
                {kw && (
                  <button onClick={() => setQ('')} className="ml-auto text-accent-lantern hover:underline">
                    清空搜索
                  </button>
                )}
              </div>
            </div>

            {/* ① 开局背景（按槽位分组，可折叠） */}
            {bgSlots.length > 0 && (
              <CollapsiblePanel
                icon={<Compass size={14} />}
                title={`开局背景（${bgSlots.length} 个槽位 / ${nBg} 个身份）`}
                hint="背景是方向，不是履历 —— 你自设的身份与职位优先于这里的任何说法"
                defaultOpen
              >
                <div className="space-y-3">
                  {bgSlots.map(slot => (
                    <SlotGroup
                      key={slot.label}
                      label={slot.label}
                      isOpener={slot.label === world.story?.openerSlot}
                      count={slot.options.length}
                    >
                      <div className="grid sm:grid-cols-2 gap-2">
                        {slot.options.map(o => {
                          const seed = (seedMap?.[o.id] ?? seedMap?.[o.title] ?? '').trim()
                          const carried = (o.startingItems || [])
                            .map(id => world.items?.find(i => i.id === id)?.name)
                            .filter((x): x is string => !!x)
                          return (
                            <div key={o.id}
                              className={`p-2.5 rounded border bg-black/20
                                ${o.custom ? 'border-dashed border-accent-lantern/40' : 'border-text-muted/20'}`}>
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-xs text-text-primary">{o.title}</span>
                                {/*
                                  「我自己写」项要有标记：它在选角页长成什么样（虚线框 + 展开一个文本框）
                                  跟普通选项完全不同，预览里不标出来，作者会以为它就是个普通选项。
                                */}
                                {o.custom && (
                                  <span className="text-[9px] px-1 rounded border border-accent-lantern/40 text-accent-lantern">
                                    自填
                                  </span>
                                )}
                              </div>
                              {o.description && (
                                <div className="text-[10px] text-text-muted leading-relaxed">{o.description}</div>
                              )}
                              {o.attributeBonus && Object.keys(o.attributeBonus).length > 0 && (
                                <div className="text-[10px] text-accent-lantern/70 font-mono mt-1">
                                  {Object.entries(o.attributeBonus).map(([k, v]) => {
                                    const def = world.attributes.find(a => a.id === k)
                                    return `${def?.name || k}${v >= 0 ? '+' : ''}${v}`
                                  }).join('　')}
                                </div>
                              )}
                              {carried.length > 0 && (
                                <div className="text-[10px] text-text-muted/80 mt-1">随身：{carried.join('、')}</div>
                              )}
                              {/* 开场素材：只在是"处境槽位"时出现，且默认收起 */}
                              {seed && (
                                <details className="mt-1.5">
                                  <summary className="text-[10px] text-accent-lantern/80 cursor-pointer list-none
                                                       hover:text-accent-lantern select-none">
                                    ▸ 这类处境的开场素材
                                  </summary>
                                  <p className="text-[10px] text-text-secondary leading-relaxed mt-1 pl-2
                                                border-l border-accent-lantern/25 whitespace-pre-wrap">
                                    {seed}
                                  </p>
                                </details>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </SlotGroup>
                  ))}
                </div>
              </CollapsiblePanel>
            )}

            {/* ② 预置物品（按标签分组，可折叠） */}
            {nItem > 0 && (
              <CollapsiblePanel
                icon={<Package size={14} />}
                title={`预置物品（${nItem}）`}
                hint="背景决定你开局携带哪几件；也说明这个世界都有些什么东西"
              >
                <div className="space-y-3">
                  {[...itemGroups.entries()].map(([tag, list]) => (
                    <SlotGroup key={tag} label={tag} count={list.length}>
                      <div className="grid sm:grid-cols-2 gap-2">
                        {list.map(i => (
                          <div key={i.id} className="p-2.5 rounded border border-text-muted/20 bg-black/20">
                            <div className="text-xs text-text-primary mb-0.5">{i.name}</div>
                            <div className="text-[10px] text-text-muted leading-relaxed">{i.description}</div>
                          </div>
                        ))}
                      </div>
                    </SlotGroup>
                  ))}
                </div>
              </CollapsiblePanel>
            )}

            {/* ③ 知识条目（按关联属性分组，可折叠） */}
            {nLore > 0 && (
              <CollapsiblePanel
                icon={<BookOpen size={14} />}
                title={`知识条目（${nLore}）`}
                hint="世界里可以被了解的事；有些要靠特定属性才看得出门道"
              >
                <div className="space-y-3">
                  {[...loreGroups.entries()].map(([group, list]) => (
                    <SlotGroup key={group} label={group} count={list.length}>
                      <div className="space-y-2">
                        {list.map(l => (
                          <div key={l.id}>
                            <div className="text-xs text-text-primary">{l.name}</div>
                            <div className="text-[10px] text-text-muted leading-relaxed">{l.description}</div>
                          </div>
                        ))}
                      </div>
                    </SlotGroup>
                  ))}
                </div>
              </CollapsiblePanel>
            )}

            {nBg + nItem + nLore === 0 && (
              <Panel icon={<Library size={14} />} title="资料">
                <Empty>{kw ? `没有匹配「${q}」的内容。` : '这个世界没有背景槽位、物品或知识条目。'}</Empty>
              </Panel>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ─── 小组件 ───

function Panel({
  icon, title, hint, children,
}: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="p-4 rounded border border-text-muted/20 bg-surface/20">
      <div className="flex items-baseline gap-2 mb-3 flex-wrap">
        <span className="text-accent-lantern/80 shrink-0">{icon}</span>
        <h2 className="text-sm font-serif font-bold text-text-primary">{title}</h2>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-text-muted/70 italic leading-relaxed">{children}</p>
}

/**
 * 可折叠的 Panel。
 *
 * ⚠️ 为什么必须有它：原先的 `Panel` 是**全量展开**的，而「资料」栏里的清单
 * 在世界书内容量大时会到几百上千行（帷幕纪年：79 个背景选项 + 63 件物品 + 18 条知识）。
 * 玩家原话是「在世界书内容量大的时候非常杂乱」——
 * 只要清单默认铺开，再好的排版也救不回来。**默认收起，点开才展开。**
 */
function CollapsiblePanel({
  icon, title, hint, children, defaultOpen = false,
}: {
  icon: React.ReactNode; title: string; hint?: string
  children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded border border-text-muted/20 bg-surface/20 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-accent-lantern/80 shrink-0">{icon}</span>
        <h2 className="text-sm font-serif font-bold text-text-primary">{title}</h2>
        {hint && <span className="text-[10px] text-text-muted truncate hidden sm:inline">{hint}</span>}
        <span className="ml-auto text-text-muted shrink-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  )
}

/** 「资料」栏里的二级分组（一个背景槽位 / 一个物品标签 / 一个知识分类） */
function SlotGroup({
  label, count, isOpener, children,
}: {
  label: string; count: number; isOpener?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded border border-text-muted/15 bg-black/15">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-[10px] text-accent-lantern/80">{label}</span>
        {isOpener && (
          <span className="text-[9px] px-1 py-px rounded border border-accent-lantern/30 text-accent-lantern/80">
            决定开场
          </span>
        )}
        <span className="text-[10px] text-text-muted">{count}</span>
        <span className="ml-auto text-text-muted">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

/**
 * 世界观正文的渲染。
 * 原文用 `**加粗**` 与空行分段，这里做一个最简渲染：
 * 不引入 markdown 依赖（预览页不值得再拉一个 chunk）。
 */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => (
        <p key={i} className="text-xs text-text-secondary leading-relaxed font-serif whitespace-pre-wrap">
          {b.split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
            /^\*\*[^*]+\*\*$/.test(seg)
              ? <strong key={j} className="text-text-primary">{seg.slice(2, -2)}</strong>
              : <span key={j}>{seg}</span>
          )}
        </p>
      ))}
    </div>
  )
}
