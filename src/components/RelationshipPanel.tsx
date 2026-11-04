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
 * ## 两个来源，去重后排在一起
 *
 * 1. `memory.dossiers` —— 摘要 AI 与程序兜底写进去的卷宗（模型认为"该记住的"）；
 * 2. `facts` 里名字带他这个人的线索（数据 AI 当年发成 ADD_FACT 的那些）。
 *
 * 第 2 条是**历史数据**：这些线索早就存在存档里了，不会自己搬进卷宗。
 * 在这里即时归类，就不必做一次存档迁移 ——
 * 而迁移一旦写错，玩家的旧存档就回不来了。
 */
function dossierOf(
  charName: string,
  memory: ReturnType<typeof useGameStore.getState>['memory'],
  facts: ReturnType<typeof useGameStore.getState>['facts'],
  knownFacts: string[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string) => {
    const t = String(s || '').trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  const k = matchKnownKey(memory.dossiers || {}, charName)
  if (k) for (const f of memory.dossiers[k] || []) push(f)

  // 归属判断按**单个角色**遍历：只问"这条是不是他的"，不问"是谁的"
  for (const id of knownFacts) {
    const f = facts.find(x => x.id === id)
    if (!f) continue
    if (factOwner(f.name, [charName]) !== charName) continue
    push(f.name)
  }

  return out
}

export function RelationshipPanel({ className = '' }: RelationshipPanelProps) {
  const { characters, memory, facts, knownFacts } = useGameStore();
  const world = useSessionStore(s => s.world);
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedCharId(expandedCharId === id ? null : id);
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
                        <ul className="space-y-1">
                          {dossier.map((fact, i) => (
                            <li key={i} className="flex gap-1.5 text-[11px] text-text-secondary leading-relaxed font-serif">
                              <span className="text-text-muted/50 shrink-0">·</span>
                              <span className="flex-1">{fact}</span>
                            </li>
                          ))}
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
