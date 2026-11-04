import { useGameStore } from '@/stores/game';
import type { Fact, Lore } from '@/stores/game';
import { Package, Search, BookOpen, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { factOwner } from '@/utils/facts';

const ALL_CATEGORY = { id: 'all', label: '全部' };
const MAX_CATEGORIES = 8;

type TabType = 'items' | 'clues' | 'lores';

interface InventoryPanelProps {
  className?: string;
}

export function InventoryPanel({ className = '' }: InventoryPanelProps) {
  const { inventory, knownFacts, masteredLores, facts, lores, characters } = useGameStore();
  const [activeTab, setActiveTab] = useState<TabType>('items');
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  /**
   * 归属某个角色的线索默认**收起来**（2026-11 第十一轮）。
   *
   * 玩家报的是「线索出现频繁」。截图里那一页确实挤满了
   * 「小满的住处」「小满没有别的家人」「小满拜师」—— 它们不是悬案，
   * 是那个人的底细，而底细该在他的人物卡里（见 RelationshipPanel 的"卷宗"）。
   *
   * 但**不删**：判错的时候（「小满的爷爷留下的怀表」其实是一条真线索）
   * 玩家得能找回来。所以收起来，并明确写出收了几条、点一下就能看。
   */
  const [showOwnedClues, setShowOwnedClues] = useState(false);

  // 物品分类不再写死，直接从现有物品的 tags 推导
  const categories = useMemo(() => {
    const tags: string[] = [];
    for (const item of inventory) {
      for (const tag of item.tags ?? []) {
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length >= MAX_CATEGORIES) break;
      }
      if (tags.length >= MAX_CATEGORIES) break;
    }
    return [ALL_CATEGORY, ...tags.map(tag => ({ id: tag, label: tag }))];
  }, [inventory]);

  // 分类消失后自动退回「全部」，避免筛出空白
  const activeFilter = categories.some(cat => cat.id === filter) ? filter : 'all';

  const query = searchQuery.toLowerCase();

  const filteredInventory = inventory.filter(item => {
    const matchesCategory = activeFilter === 'all' || (item.tags ?? []).includes(activeFilter);
    const matchesSearch = item.name.toLowerCase().includes(query) ||
                          item.description.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  /*
    线索按**归属**分两拨：不带人名的（悬案本身）直接列，
    带人名的（「小满的住处」）收进折叠区。

    分类用 `factOwner` 现算，不写进存档 ——
    存量线索早已躺在旧存档里，改数据要迁移，而迁移写错就回不来。
    现算的代价只是每次渲染遍历一遍角色名，几十条的量级可以忽略。
  */
  const clueBuckets = knownFacts
    .map(factId => facts.find(f => f.id === factId) ?? { id: factId, name: '未知线索', description: '（暂无描述）' })
    .filter(clue =>
      clue.name.toLowerCase().includes(query) ||
      clue.description.toLowerCase().includes(query)
    )
    .map(clue => ({ clue, owner: factOwner(clue.name, characters.map(c => c.name)) }))

  const freeClues: Fact[] = clueBuckets.filter(b => !b.owner).map(b => b.clue)
  const ownedClues = clueBuckets.filter(b => b.owner)
  const visibleClues: Fact[] = showOwnedClues ? [...freeClues, ...ownedClues.map(b => b.clue)] : freeClues;

  const filteredLores: Lore[] = masteredLores
    .map(loreId => lores.find(l => l.id === loreId) ?? { id: loreId, name: '未知知识', description: '（暂无描述）', principle: '', level: 0 })
    .filter(lore =>
      lore.name.toLowerCase().includes(query) ||
      lore.description.toLowerCase().includes(query)
    );

  const renderItems = () => (
    <>
      {/* Search & Filter */}
      <div className="space-y-2 pb-2">
        <div className="relative">
            <input 
                type="text" 
                placeholder="搜索物品..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-black/20 border border-text-muted/20 rounded-sm px-2 py-1 text-xs text-text-primary focus:border-accent-lantern/50 outline-none"
            />
            <Search size={12} className="absolute right-2 top-1.5 text-text-muted" />
        </div>
        <div className="flex flex-wrap gap-1">
            {categories.map(cat => (
            <button
                key={cat.id}
                onClick={() => setFilter(cat.id)}
                className={`
                text-[10px] px-2 py-1 rounded-sm border transition-all duration-300
                ${activeFilter === cat.id 
                    ? 'bg-accent-lantern/10 border-accent-lantern text-accent-lantern shadow-[0_0_10px_rgba(234,179,8,0.1)]' 
                    : 'bg-black/20 border-text-muted/10 text-text-muted hover:border-text-muted/50 hover:text-text-secondary'}
                `}
            >
                {cat.label}
            </button>
            ))}
        </div>
      </div>
      
      {filteredInventory.length === 0 ? (
        <div className="text-xs text-text-muted italic text-center py-8 border border-dashed border-text-muted/10 rounded-sm bg-black/10">
          {searchQuery ? '没有找到匹配的物品。' : (activeFilter === 'all' ? '你的口袋空空如也。' : '该分类下没有物品。')}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredInventory.map((item) => {
            const isExpanded = expandedItemId === item.id;
            return (
              <div 
                key={item.id} 
                onClick={() => setExpandedItemId(isExpanded ? null : item.id)}
                className={`p-3 bg-black/20 rounded-sm border transition-all duration-300 group hover:bg-black/30 cursor-pointer
                  ${isExpanded ? 'border-accent-lantern/30 bg-black/40' : 'border-text-muted/10 hover:border-accent-lantern/30'}`}
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-black/20 rounded-sm text-text-muted group-hover:text-accent-lantern transition-colors border border-white/5">
                    <Package size={16} />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-serif text-text-primary group-hover:text-accent-lantern transition-colors">{item.name}</h4>
                    <p className={`text-xs text-text-secondary mt-1 font-serif opacity-80 ${isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                      {item.description}
                    </p>
                    {item.tags.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {item.tags.map(tag => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-black/20 rounded-sm text-text-muted border border-text-muted/10 uppercase tracking-wider">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  const renderClues = () => {
    return (
    <div className="space-y-2">
      <div className="relative mb-2">
            <input 
                type="text" 
                placeholder="搜索线索..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-black/20 border border-text-muted/20 rounded-sm px-2 py-1 text-xs text-text-primary focus:border-accent-moth/50 outline-none"
            />
            <Search size={12} className="absolute right-2 top-1.5 text-text-muted" />
      </div>

      {visibleClues.length === 0 && !ownedClues.length ? (
        <div className="text-xs text-text-muted italic text-center py-8 border border-dashed border-text-muted/10 rounded-sm bg-black/10">
          {searchQuery ? '没有找到匹配的线索。' : '你还没有发现任何线索。'}
        </div>
      ) : (
        <>
          {visibleClues.length === 0 ? (
            <div className="text-xs text-text-muted italic text-center py-6 border border-dashed border-text-muted/10 rounded-sm bg-black/10">
              {searchQuery ? '没有找到匹配的线索。' : '还没有不属于某个人的线索。'}
            </div>
          ) : visibleClues.map((clue) => {
            /*
              一条线索如果记在某人名下（`showOwnedClues` 打开时才会走到这里），
              标一行"记在谁名下" —— 让玩家知道自己看的是底细，不是悬案。
            */
            const owner = factOwner(clue.name, characters.map(c => c.name))
            return (
              <div key={clue.id} className="p-3 bg-black/20 rounded-sm border border-text-muted/10 hover:border-accent-moth/30 transition-all duration-300 group hover:bg-black/30">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-black/20 rounded-sm text-text-muted group-hover:text-accent-moth transition-colors border border-white/5">
                    <Search size={16} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 className="text-sm font-serif text-text-primary group-hover:text-accent-moth transition-colors">{clue.name}</h4>
                      {owner && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-black/30 rounded-sm text-text-muted border border-text-muted/15 shrink-0">
                          {owner} 的事
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-secondary mt-1 font-serif opacity-80">{clue.description}</p>
                  </div>
                </div>
              </div>
            )
          })}

          {/*
            折叠区：这些线索记在某个人的名下，属于"底细"不属于"悬案"。
            不删，只收 —— 判错的时候玩家得能找回来。
          */}
          {ownedClues.length > 0 && !searchQuery && (
            <button
              onClick={() => setShowOwnedClues(v => !v)}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] text-text-muted hover:text-text-secondary border border-dashed border-text-muted/15 rounded-sm transition-colors"
              title="这些是某个人的底细，已收进他的人物卷宗"
            >
              <Users size={10} />
              {showOwnedClues
                ? `收起 ${ownedClues.length} 条记在某人名下的`
                : `${ownedClues.length} 条记在某人名下（已收进人物卷宗）`}
            </button>
          )}
        </>
      )}
    </div>
  );
  };

  const renderLores = () => {
    return (
    <div className="space-y-2">
      <div className="relative mb-2">
            <input 
                type="text" 
                placeholder="搜索知识..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-black/20 border border-text-muted/20 rounded-sm px-2 py-1 text-xs text-text-primary focus:border-accent-mansus/50 outline-none"
            />
            <Search size={12} className="absolute right-2 top-1.5 text-text-muted" />
      </div>

      {filteredLores.length === 0 ? (
        <div className="text-xs text-text-muted italic text-center py-8 border border-dashed border-text-muted/10 rounded-sm bg-black/10">
          {searchQuery ? '没有找到匹配的知识。' : '你尚未掌握任何知识。'}
        </div>
      ) : (
        filteredLores.map((lore) => {
          return (
            <div key={lore.id} className="p-3 bg-black/20 rounded-sm border border-text-muted/10 hover:border-accent-mansus/30 transition-all duration-300 group hover:bg-black/30">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-black/20 rounded-sm text-text-muted group-hover:text-accent-mansus transition-colors border border-white/5">
                  <BookOpen size={16} />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-serif text-text-primary group-hover:text-accent-mansus transition-colors">{lore.name}</h4>
                  <p className="text-xs text-text-secondary mt-1 font-serif opacity-80">{lore.description}</p>
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {lore.principle && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-black/20 rounded-sm text-accent-mansus border border-accent-mansus/20 uppercase tracking-wider">
                        {lore.principle}
                      </span>
                    )}
                    {lore.level > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-black/20 rounded-sm text-text-muted border border-text-muted/10 uppercase tracking-wider">
                        Lv.{lore.level}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
  };

  return (
    <div className={`h-full p-4 space-y-6 overflow-y-auto bg-surface/30 border-l border-text-muted/20 backdrop-blur-sm flex flex-col ${className}`}>
      <section className="space-y-3 flex-1">
        <div className="flex items-center justify-between border-b border-text-muted/20 pb-2">
          <h3 className="text-xs font-serif text-text-muted uppercase tracking-[0.2em]">
            {activeTab === 'items' && '物品栏'}
            {activeTab === 'clues' && '线索'}
            {activeTab === 'lores' && '知识'}
          </h3>
        </div>

        {/* Main Tabs */}
        <div className="flex gap-1 bg-black/20 p-1 rounded-sm mb-4">
          <button
            onClick={() => setActiveTab('items')}
            className={`flex-1 py-1.5 text-xs font-serif transition-all rounded-sm flex items-center justify-center gap-2
              ${activeTab === 'items' 
                ? 'bg-surface/40 text-text-primary shadow-sm' 
                : 'text-text-muted hover:text-text-secondary hover:bg-surface/10'}
            `}
          >
            <Package size={12} />
            <span>物品</span>
          </button>
          <button
            onClick={() => setActiveTab('clues')}
            className={`flex-1 py-1.5 text-xs font-serif transition-all rounded-sm flex items-center justify-center gap-2
              ${activeTab === 'clues' 
                ? 'bg-surface/40 text-text-primary shadow-sm' 
                : 'text-text-muted hover:text-text-secondary hover:bg-surface/10'}
            `}
          >
            <Search size={12} />
            <span>线索</span>
          </button>
          <button
            onClick={() => setActiveTab('lores')}
            className={`flex-1 py-1.5 text-xs font-serif transition-all rounded-sm flex items-center justify-center gap-2
              ${activeTab === 'lores' 
                ? 'bg-surface/40 text-text-primary shadow-sm' 
                : 'text-text-muted hover:text-text-secondary hover:bg-surface/10'}
            `}
          >
            <BookOpen size={12} />
            <span>知识</span>
          </button>
        </div>

        {activeTab === 'items' && renderItems()}
        {activeTab === 'clues' && renderClues()}
        {activeTab === 'lores' && renderLores()}
      </section>
    </div>
  );
}
