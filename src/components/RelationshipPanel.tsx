import { useGameStore } from '@/stores/game';
import { useSessionStore } from '@/stores/session';
import { MapPin, ChevronDown, ChevronUp, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { CharacterAvatar } from '@/components/CharacterAvatar'
import { CharacterSprite } from '@/components/CharacterSprite'
import { PortraitTrigger } from '@/components/PortraitPanel';
import { matchKnownKey } from '@/utils/memory';
import { factOwner } from '@/utils/facts';

interface RelationshipPanelProps {
  className?: string;
}

/**
 * 卷宗里的一条：可能带标题，也可能只是一句话。
 *
 * ## 为什么要有 `title`（2026-11 第二十三轮）
 *
 * 玩家原话：「这个抽屉相当于只有个目录，或许可以在这里都每个线索中补充原本就有的线索详情」。
 *
 * 他说得准。第一版的卷宗里，来自 `dossiers` 的条目是一句话事实，
 * 而来自 `facts` 的条目**只推了 `f.name`** —— 于是玩家看到的是
 * 「诺姆的住处」「诺姆没有别的家人」两行光秃秃的标题，
 * 而真正的内容（描述）躺在 `f.description` 里，被丢掉了。
 *
 * 那正是抽屉最没用的形态：**目录没有正文**。
 *
 * 现在两来源合成同一个结构：
 *  - `facts` → `{ title: 标题, text: 详情 }`（它是"一条线索"，本来就分标题与描述）
 *  - `dossiers` → `{ text: 一句话 }`（它是一条记录，没有标题）
 */
interface DossierEntry {
  title?: string
  text: string
  /** 这条是从哪儿来的，面板上标一格小字 */
  from: 'fact' | 'memory'
}

/**
 * 一个人名下的**卷宗**：这一局里他已经确定的事。
 *
 * ## 它为什么要在这里，而不是在线索页
 *
 * 玩家截图里的那一页「线索」躺着四条：「小满的住处」「小满没有别的家人」
 * 「小满拜师」「炉边女人的警告」—— 它们和真正的悬案挤在一起。
 *
 * 但那四条不是悬案，是**这个人的底细**：玩家不会为了"小满住在哪"
 * 而改变下一个动作，他只会在跟小满说话时用上它。
 * 所以它该长在这个人的卡片里，跟着他一起被看见。
 *
 * ## 两个来源，`facts` 优先
 *
 * 1. `facts` 里名字带他这个人的线索 —— **带完整描述**，是这张卡的正文；
 * 2. `memory.dossiers` —— 摘要 AI 与程序兜底写进去的卷宗。
 *
 * 第 1 条是**历史数据**（早就躺在存档里，不会自己搬进卷宗），
 * 在这里即时归类就不必做存档迁移 —— 而迁移一旦写错，玩家旧存档就回不来。
 *
 * ⚠️ **去重按"包含"**，不是按全等：`dossiers` 里那一条往往是
 * `facts` 描述的**前 200 字**（`recordFactIntoDossier` 就是从中抄的），
 * 按全等去重会让同一件事在抽屉里出现两遍 —— 一遍长一遍短。
 */
function dossierOf(
  charName: string,
  memory: ReturnType<typeof useGameStore.getState>['memory'],
  facts: ReturnType<typeof useGameStore.getState>['facts'],
  knownFacts: string[],
): DossierEntry[] {
  const entries: DossierEntry[] = []
  const seen = new Set<string>()

  // ── ① 线索来的（带正文）──
  for (const id of knownFacts) {
    const f = facts.find(x => x.id === id)
    if (!f) continue
    // 归属判断按**单个角色**问：只问"这条是不是他的"，不问"是谁的"
    if (factOwner(f.name, [charName]) !== charName) continue
    const text = String(f.description || '').trim()
    const seenKey = `${f.name}::${text}`
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    entries.push({ title: f.name, text, from: 'fact' })
  }

  // ── ② 卷宗来的（一句话）；已经是上面某条正文的一部分就跳过 ──
  const factBlob = entries.map(e => `${e.title || ''}${e.text}`).join('\n')
  const dossierKey = matchKnownKey(memory.dossiers || {}, charName)
  for (const raw of (dossierKey ? memory.dossiers[dossierKey] || [] : [])) {
    const text = String(raw || '').trim()
    if (!text) continue
    if (seen.has(text)) continue
    /*
      包含判断只做一次"短的在长的里"：
      「诺姆还住在爷爷留下的院子……房东太太没赶他」是「诺姆住在秤钩巷后头，
      过一条水沟、有棵歪脖子树的那片，一间小屋……」的前缀 —— 那是同一件事。
      反向（长的在短的里）也查一次，因为模型偶尔会写得更啰嗦。
    */
    const dup = factBlob.includes(text)
      || entries.some(e => e.text && text.includes(e.text.slice(0, 20)) && e.text.length >= 20)
    if (dup) continue
    seen.add(text)
    entries.push({ text, from: 'memory' })
  }

  return entries
}

export function RelationshipPanel({ className = '' }: RelationshipPanelProps) {
  const { characters, memory, facts, knownFacts } = useGameStore();
  const world = useSessionStore(s => s.world);
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);
  /**
   * 卷宗里哪一条正文被展开了（key = `${charId}:${index}`）。
   *
   * 只允许展开**一条**：玩家点开它是因为想看清某件事，
   * 一次全部摊开会让整张卡变成一屏密密麻麻的字，而那时他反而找不着自己在看哪条。
   */
  const [expandedFact, setExpandedFact] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedCharId(expandedCharId === id ? null : id);
    // 收起卡片时把展开的那条也收回去，下次点开是干净的
    if (expandedCharId === id) setExpandedFact(null);
  };

  return (
    <div className={`h-full p-4 space-y-6 overflow-y-auto bg-surface/50 border-l border-text-muted/30 ${className}`}>
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-serif text-text-secondary uppercase tracking-wider">人物关系 (Relationships)</h3>
        </div>
        
        {characters.length === 0 ? (
          <div className="text-xs text-text-muted italic text-center py-8">
            尚未遇到任何角色。
          </div>
        ) : (
          <div className="space-y-2">
            {characters.map((char) => {
              const isExpanded = expandedCharId === char.id;
              const hasTags = Boolean(char.relationship) || Boolean(char.status) || Boolean(char.location);
              // 只在展开时算：卷宗要遍历 facts，收起状态下没必要做这件事
              const dossier = isExpanded ? dossierOf(char.name, memory, facts, knownFacts) : [];
              return (
                <div 
                  key={char.id} 
                  onClick={() => toggleExpand(char.id)}
                  className={`p-3 bg-background/50 rounded border transition-all duration-300 cursor-pointer group
                    ${isExpanded ? 'border-accent-grail/50 bg-background/80' : 'border-text-muted/20 hover:border-accent-grail/50'}`}
                >
                  <div className="flex items-start gap-3">
                    {/*
                      用 LPC 像素立绘替换原来的 36px 圆形几何头像。
                      立绘的信息量大得多（服装、发型、体型、姿态都能表达），
                      而且素材是 64×64 原生像素、按整数倍放大，缩小时依然锐利。
                      角色卡若自带图片，仍以自带图片优先 —— 那代表作者的明确意图。
                    */}
                    {char.avatar ? (
                      <PortraitTrigger characterId={char.id}>
                        <CharacterAvatar
                          name={char.name}
                          id={char.id}
                          avatar={char.avatar}
                          avatarId={char.avatarId}
                          style={world?.avatarStyle}
                          tone={world?.avatarTone}
                          size={48}
                        />
                      </PortraitTrigger>
                    ) : (
                      <PortraitTrigger characterId={char.id}>
                        <CharacterSprite
                          name={char.name}
                          id={char.id}
                          scale={3}
                          /*
                            ⚠️ `look` 放在最前面：它是**部件级显式外观**，
                            有它就以它为准，下面那份 profile 只用来补没写的字段。

                            这是"立绘与描述对不上"的根治办法（2026-10）：
                            原先只能靠关键词从描述里猜部件，而中文表述空间无穷，
                            正则表永远追不上。现在作者直接在卡里写部件 id。
                          */
                          look={char.look}
                          /*
                            把角色资料传进去，立绘才会**照着描述**画
                            （黑发马尾就画黑发马尾，守卫队长就穿甲）。
                            不传的话 recipeFor 只能随机挑部件 ——
                            那正是"立绘和角色描述毫无关联"的原因。
                            现在它是 `look` 的兜底：没写 look 的卡（如导入的第三方卡）才走这条路。
                          */
                          profile={{
                            name: char.name,
                            description: char.description,
                            relationship: char.relationship,
                            scenario: char.prompt,
                          }}
                          /*
                            **全身立绘**（不是头像）。
                            这里原先写着 `headOnly` —— 于是列表里只有一颗脑袋，
                            玩家反馈的"NPC 全身像素立绘没有实现"就是这个：
                            不是没画，是被裁成了头。
                            列表里用 48×72 的竖长比例，能看出服装与体型；
                            点开右边面板看更大的一张。
                          */
                          className="w-12 h-[4.5rem] bg-black/30 rounded"
                        />
                      </PortraitTrigger>
                    )}
                    <div className="flex-1">
                      <div className="flex justify-between items-start">
                          <h4 className="text-sm font-medium text-text-primary">{char.name}</h4>
                          <div className="flex items-center gap-2">
                            {char.relationship && (
                              <span className="text-[10px] px-1.5 py-0.5 bg-surface rounded text-accent-grail border border-accent-grail/20">
                                  {char.relationship}
                              </span>
                            )}
                            {isExpanded ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
                          </div>
                      </div>
                      
                      <p className={`text-xs text-text-secondary mt-1 transition-all ${isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                        {char.description}
                      </p>
                      
                      {hasTags && (
                        <div className="flex gap-2 mt-2 text-[10px] text-text-muted flex-wrap">
                            {char.location && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 bg-surface rounded border border-text-muted/20">
                                    <MapPin size={10} /> {char.location}
                                </span>
                            )}
                            {char.status && (
                              <span className="px-1.5 py-0.5 bg-surface rounded border border-text-muted/20">
                                  {char.status}
                              </span>
                            )}
                            {isExpanded && char.stats && Object.entries(char.stats).map(([key, val]) => (
                               <span key={key} className="px-1.5 py-0.5 bg-surface rounded border border-text-muted/20 uppercase">
                                  {key}: {val}
                               </span>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/*
                    卷宗（2026-11 第十一轮）—— 玩家的原话是「在相关的角色界面内
                    单独开一个抽屉来存储」。

                    它收的是**这个人的经历**，所以每条都是过去时：
                    他做过什么、身上发生过什么、答应过什么。
                    `bonds` / `relationship` 那一行是**此刻的关系**（会被覆盖），
                    这里是**攒下来的底细**（只增不减）—— 两者不能互相顶替。
                  */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-text-muted/15">
                      <div className="flex items-center gap-1.5 text-[10px] text-text-muted tracking-[0.2em] uppercase mb-1.5">
                        <ScrollText size={10} /> 卷宗
                        {dossier.length > 0 && (
                          <span className="text-text-muted/60 normal-case tracking-normal">（{dossier.length} 条）</span>
                        )}
                      </div>
                      {dossier.length === 0 ? (
                        <p className="text-[10px] text-text-muted/70 italic">还没记下他做过什么。</p>
                      ) : (
                        <ul className="space-y-2">
                          {dossier.map((entry, i) => {
                            const key = `${char.id}:${i}`
                            const open = expandedFact === key
                            /*
                              长正文默认折三行，点一下展开。
                              这一条的正文往往就是**玩家最想看的那段**
                              （「诺姆住在秤钩巷后头，过一条水沟、有棵歪脖子树的那片……」），
                              一次摊开四条会把整张卡推得很长，而玩家通常只关心其中一条。
                            */
                            const long = entry.text.length > 60
                            return (
                              <li
                                key={key}
                                className={long ? 'cursor-pointer group/fact' : ''}
                                onClick={long ? () => setExpandedFact(open ? null : key) : undefined}
                              >
                                {entry.title && (
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-[11px] text-text-primary">{entry.title}</span>
                                    {entry.from === 'fact' && (
                                      <span className="text-[9px] px-1 py-0.5 rounded-sm bg-black/30 text-text-muted/70 border border-text-muted/15 shrink-0">
                                        线索
                                      </span>
                                    )}
                                  </div>
                                )}
                                {entry.text ? (
                                  <p className={`text-[11px] text-text-secondary leading-relaxed font-serif pl-0
                                    ${open ? '' : long ? 'line-clamp-3' : ''}`}>
                                    {entry.text}
                                  </p>
                                ) : (
                                  <p className="text-[10px] text-text-muted/60 italic">（这条线索没有记录详情）</p>
                                )}
                                {long && (
                                  <span className="text-[9px] text-text-muted/50 group-hover/fact:text-text-muted">
                                    {open ? '收起' : '展开'}
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
