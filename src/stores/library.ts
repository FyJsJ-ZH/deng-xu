import { create } from 'zustand';
import type { WorldCard, HeroPreset, PlayerCard, NarrativePreset } from '@/types/cards';
import { EMPTY_STYLE_CHOICE, styleById, type StyleChoice } from '@/data/narrativeStyles';
import { makeId } from '@/utils/files';
import { createKVStore, isIdbAvailable } from '@/utils/idb';
import { BUILTIN_WORLD_IDS, loadBuiltinWorlds, missingBuiltinIds, retireBuiltinWorlds } from '@/data/builtinWorldIds';
import { BUILTIN_STAMP } from '@/data/builtinStamp';
import { normalizeWorldCard } from '@/utils/worldCard';

/**
 * 卡片库为什么落在 IndexedDB 而不是 localStorage：
 * 角色卡可以内嵌 base64 头像、世界卡可以带封面，几张卡就能顶破 localStorage 的 5MB；
 * 而且 persist 每次变更都要整体序列化写盘，大对象下会明显卡主线程。
 * 这里自己按「读一次 / 整体写回」的方式管理，写入不经过 React 渲染。
 */

/** 整个卡片库存成一个 JSON 字符串：单键写入天然原子，不会读到写了一半的数组 */
const WORLDS_KEY = 'worlds';
/**
 * 主角预设**单独一个键**，不塞进 WORLDS_KEY。
 *
 * 为什么分开：两者的生命周期完全不同 —— 世界卡可能被整批导入/删除/覆盖，
 * 而玩家精心设定的主角不该因为"清空卡片库"就一起消失。
 */
const PRESETS_KEY = 'heroPresets';
/**
 * 玩家**主动删掉**的内置世界 id。
 *
 * ## 为什么需要第三个键
 *
 * 内置卡现在有两套逻辑会碰到它们，而这两套逻辑天生打架：
 *
 *  1. **缺卡补齐** —— 库里缺了某张内置卡就补回来。
 *     没有它的话，2026-10 新增的四张卡对**已经玩过的人**永远不可见
 *     （原先只在"首次运行"播种，老玩家的库早就不是 null 了）。
 *  2. **用户的删除** —— 删了就该没了。
 *
 * 少了这个键，第 1 条会把第 2 条刚删掉的卡在下次启动时原样塞回来，
 * 玩家看到的是"删除无效"。所以删内置卡时在这里记一笔。
 */
const REMOVED_BUILTIN_KEY = 'removedBuiltinWorlds';

/**
 * 叙事预设（文风 / 规则包）的键。
 *
 * ## 为什么又是**一个新的键**（2026-11 第二十九轮）
 *
 * 玩家把 ST 的写作预设丢进来，说「或许可以像世界书或卡片库一样，存储预设并可切换」。
 * 上一版把它转成**世界卡**塞进 `WORLDS_KEY`，于是它跟真世界混在一张卡片墙上：
 * 点进去开一局，世界是空的；而且世界卡是"一局一个"，换世界就得重做一遍。
 *
 * 预设是**玩家口味**，不是作品 —— 换任何一个世界都想沿用同一套文风。
 * 所以它独立成键，全局只启用一份，叠加在**当前世界**上。
 *
 * 结构与 `PRESETS_KEY` 一样：`{ presets: [...], activeId: string }`。
 * 两个字段放**同一个键**里，是因为它们必须一起生效 ——
 * 分两个键写，中间断一次就会出现"激活了一份不存在的预设"。
 */
const NARRATIVE_PRESETS_KEY = 'narrativePresets';

/**
 * 上次播种内置卡时用的**内容指纹**（见 `data/builtinStamp.ts`）。
 *
 * ## 为什么还缺第四个键（2026-10 第十一轮，玩家第三次说「改了没生效」）
 *
 * 玩家的原话：
 * > 「我打开网页用起来输出的字数没变化……依然是 800 字」
 *
 * 不是构建的问题，也不是缓存的问题：源码改了、线上 bundle 里确实是新值，
 * 可 `REMOVED_BUILTIN_KEY` 那套逻辑只补「**缺 id**」的卡 ——
 * 老玩家库里 `builtin_london1905` 这个 id 一直都在，于是这张卡
 * **永远停在第一次播种时的样子**。
 *
 * 所以再加一个键记「我上次是按哪个版本播的」。指纹一变，已存在的内置卡
 * 也整批换成新的。它只碰**内置卡**：玩家自建的卡不动，
 * 玩家主动删过的内置卡也不会因为换戳而复活。
 *
 * 写失败不影响使用，只是下次启动会再刷一遍。
 */
const BUILTIN_STAMP_KEY = 'builtinStamp';

/**
 * `REMOVED_BUILTIN_KEY` 的内存副本。
 * 只由 `loadWorlds` 写入、由 `deleteWorld` 追加 —— 不放进 store state，
 * 因为它是**内部记账**，UI 不该看见、也不该因为它的变化触发重渲染。
 */
let removedBuiltinCache: string[] = [];

const kv = createKVStore('pale-notes', 'kv');

/**
 * 深拷贝：store 里保存的对象不能和外部共享引用，
 * 否则调用方拿到 `saveWorld` 的入参后随手一改，就把 store 里的状态也改了（还不会触发重渲染）。
 * structuredClone 不可用（老浏览器）时退回 JSON 往返。
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 含函数/Proxy 等不可克隆成员，退回 JSON
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** 降级提示文案：区分「本来就没有 IndexedDB」和「本来好好的、刚刚写失败了」 */
function idbDownMessage(wasAvailable: boolean): string {
  return wasAvailable
    ? 'IndexedDB 写入失败，已降级为内存存储：本次改动刷新页面后会丢失。'
    : 'IndexedDB 不可用，世界卡只保存在内存中：刷新页面后会丢失。';
}

/**
 * 模块级 in-flight Promise。
 * React StrictMode 会把 effect 跑两遍，而两次调用都发生在第一次 await 之前，
 * 只靠 state.loaded 去重是拦不住的，所以用同一个 Promise 让它们共享这次载入。
 */
let loadInFlight: Promise<void> | null = null;

/**
 * 写回串行化：并发整体写回会互相覆盖，
 * 而每次都读「当前」状态再写，串成一条链后最后一次写一定是最新数据。
 */
let writeChain: Promise<void> = Promise.resolve();

export interface LibraryState {
  worlds: WorldCard[];
  /** 是否已完成首次载入（区分「库里是空的」和「还没读」） */
  loaded: boolean;
  loadError: string | null;

  /**
   * 主角预设（「提前设定主角」）。与世界卡一起在首次载入时读出，
   * 但存在**另一个 kv 键**里，互不影响。
   */
  heroPresets: HeroPreset[];
  /** 保存（按 id 新增或替换，新卡排最前） */
  saveHeroPreset: (preset: HeroPreset) => Promise<void>;
  /** 更新预设内嵌的主角档案 */
  updateHeroPresetPlayer: (id: string, player: PlayerCard) => Promise<void>;
  deleteHeroPreset: (id: string) => Promise<void>;
  /** 复制一份预设（改个名字再存，便于派生） */
  duplicateHeroPreset: (id: string, label?: string) => Promise<HeroPreset | null>;
  getHeroPreset: (id: string) => HeroPreset | undefined;
  /** 以现有资料新建一个预设（不开游戏也能先设主角） */
  createHeroPreset: (label: string, player: PlayerCard) => Promise<HeroPreset>;

  // ── 叙事预设（文风 / 规则包，可切换）────────────────────────────
  /** 全部叙事预设，最近导入的在最前 */
  narrativePresets: NarrativePreset[];
  /**
   * 当前启用的那份的 id；`''` = 不启用任何预设。
   *
   * 刻意做成单一 id 而不是 `enabled: boolean` 数组：
   * 文风的指令是**互相排斥**的（「简练网文」与「超细腻大段描写」同时开，
   * 模型只能二选一地瞎猜）。全局只留一份，语义清楚，玩家也不必调试玄学。
   */
  activeNarrativePresetId: string;
  /** 新增或就地替换（按 id 匹配）；第一次导入会自动启用 */
  saveNarrativePreset: (preset: NarrativePreset, options?: { activate?: boolean }) => Promise<void>;
  deleteNarrativePreset: (id: string) => Promise<void>;
  /** 切换启用项；传 `''` 表示都不用 */
  setActiveNarrativePreset: (id: string) => Promise<void>;
  /** 同 getWorld：返回库内引用，请当只读用 */
  getNarrativePreset: (id: string) => NarrativePreset | undefined;
  /** 当前启用的那份（没有就是 undefined） */
  getActiveNarrativePreset: () => NarrativePreset | undefined;
  /**
   * 玩家现拨的**文风开关**（核心单选 + 附加/基础/纠偏多选）。
   *
   * 它的层级比预设更高：预设是"别人整套给我的"，文风选择是"我自己要的那一档"。
   * 两者同时生效 —— 预设提供规则与文风底盘，选择覆盖文风。
   *
   * 与预设放在**同一个 kv 键**里（见 NARRATIVE_PRESETS_KEY）：
   * 它们叠在一起才构成完整的"怎么写"，分开存迟早出现半套配置。
   */
  styleChoice: StyleChoice;
  setStyleChoice: (next: StyleChoice) => Promise<void>;

  /** 从 IndexedDB 载入全部世界卡；首次运行会写入内置示例卡 */
  loadWorlds: () => Promise<void>;
  /** 新增或整体替换（按 id 匹配） */
  saveWorld: (world: WorldCard) => Promise<void>;
  /** 局部更新，自动刷新 updatedAt */
  updateWorld: (id: string, patch: Partial<WorldCard>) => Promise<void>;
  deleteWorld: (id: string) => Promise<void>;
  duplicateWorld: (id: string) => Promise<WorldCard | null>;
  getWorld: (id: string) => WorldCard | undefined;
  /** 导出用：所有世界卡的快照 */
  exportAll: () => WorldCard[];
  /** 导入一批世界卡（id 冲突时重新分配 id），返回导入进来的卡 */
  importWorlds: (worlds: WorldCard[]) => Promise<WorldCard[]>;
}

export const useLibraryStore = create<LibraryState>()((set, get) => {
  /**
   * 把当前内存状态写回 IndexedDB。永不 reject：
   * 写失败只落到 loadError（UI 能提示），绝不把异常丢给调用方，
   * 否则一个「保存」按钮的点击就会变成未捕获的 Promise 异常。
   */
  async function persist(): Promise<void> {
    const wasAvailable = isIdbAvailable();
    try {
      // 在这里才取 state：写入排队期间状态可能又变了，取最新的才是对的
      await kv.set(WORLDS_KEY, JSON.stringify(get().worlds));
      if (!isIdbAvailable()) {
        // kv 层已经把失败的 IndexedDB 降级掉了，如实告诉用户「这次没落盘」
        set({ loadError: idbDownMessage(wasAvailable) });
      } else if (get().loadError) {
        set({ loadError: null }); // 这次写成功了，上次的错误提示可以撤掉
      }
    } catch (err) {
      set({ loadError: `世界卡写回失败：${describeError(err)}` });
    }
  }

  function queuePersist(): Promise<void> {
    writeChain = writeChain.then(persist);
    return writeChain;
  }

  /**
   * 主角预设的写回，和 persist() 共用同一条 writeChain。
   *
   * ⚠️ 必须共用：预设与世界卡存在**两个键**里，但写入是异步排队的。
   * 若各写各的链，两次写入可能交错，导致后写的那次覆盖掉先写的内容
   * （"刚存的主角下次打开不见了"）。串在一条链上就天然有序。
   */
  async function persistPresets(): Promise<void> {
    const wasAvailable = isIdbAvailable();
    try {
      await kv.set(PRESETS_KEY, JSON.stringify(get().heroPresets));
      if (!isIdbAvailable()) {
        set({ loadError: idbDownMessage(wasAvailable) });
      } else if (get().loadError) {
        set({ loadError: null });
      }
    } catch (err) {
      set({ loadError: `主角预设写回失败：${describeError(err)}` });
    }
  }

  function queuePersistPresets(): Promise<void> {
    writeChain = writeChain.then(persistPresets);
    return writeChain;
  }

  /**
   * 叙事预设的写回。同样共用 `writeChain` —— 三个键（世界卡 / 主角 / 预设）
   * 的写入必须有序，否则"刚切换的预设下次打开又变回去了"。
   */
  async function persistNarrativePresets(): Promise<void> {
    const wasAvailable = isIdbAvailable();
    try {
      await kv.set(NARRATIVE_PRESETS_KEY, JSON.stringify({
        presets: get().narrativePresets,
        activeId: get().activeNarrativePresetId,
        style: get().styleChoice,
      }));
      if (!isIdbAvailable()) {
        set({ loadError: idbDownMessage(wasAvailable) });
      } else if (get().loadError) {
        set({ loadError: null });
      }
    } catch (err) {
      set({ loadError: `叙事预设写回失败：${describeError(err)}` });
    }
  }

  function queuePersistNarrativePresets(): Promise<void> {
    writeChain = writeChain.then(persistNarrativePresets);
    return writeChain;
  }

  /** 叙事预设改动统一入口：先同步改内存（UI 立刻响应），再排队写回 */
  async function commitNarrativePresets(
    presets: NarrativePreset[],
    activeId: string,
    styleChoice: StyleChoice = get().styleChoice,
  ): Promise<void> {
    set({ narrativePresets: presets, activeNarrativePresetId: activeId, styleChoice });
    await queuePersistNarrativePresets();
  }

  /** 预设改动统一入口：先同步改内存，再排队写回 */
  async function commitPresets(presets: HeroPreset[]): Promise<void> {
    set({ heroPresets: presets });
    await queuePersistPresets();
  }

  /** 新增或就地替换一份预设；新的排最前（列表天然按最近保存排序） */
  async function commitPreset(next: HeroPreset): Promise<void> {
    const current = get().heroPresets;
    const index = current.findIndex((p) => p.id === next.id);
    if (index === -1) {
      await commitPresets([next, ...current]);
      return;
    }
    const presets = current.slice();
    presets[index] = next;
    await commitPresets(presets);
  }

  /** 所有改动都走这里：先同步改内存（UI 立刻响应），再异步写回 */
  async function commitWorlds(worlds: WorldCard[]): Promise<void> {
    set({ worlds });
    await queuePersist();
  }

  /** 新增或就地替换一张卡；新卡放最前面，列表天然按最近保存排序 */
  async function commitWorld(next: WorldCard): Promise<void> {
    const current = get().worlds;
    const index = current.findIndex((w) => w.id === next.id);
    if (index === -1) {
      await commitWorlds([next, ...current]);
      return;
    }
    const worlds = current.slice();
    worlds[index] = next;
    await commitWorlds(worlds);
  }

  return {
    worlds: [],
    heroPresets: [],
    narrativePresets: [],
    activeNarrativePresetId: '',
    styleChoice: { ...EMPTY_STYLE_CHOICE },
    loaded: false,
    loadError: null,

    loadWorlds: async () => {
      if (get().loaded) return;
      if (loadInFlight) return loadInFlight;
      loadInFlight = (async () => {
        let worlds: WorldCard[] | null = null;
        let error: string | null = null;
        /*
          主角预设顺手一起读出。它**不参与**下面的"首次运行播入内置卡"逻辑 ——
          预设的初始值就是空数组（没有人天生有一个预设好的主角），
          空数组是合法状态，不需要 seed，也不能因为空就报错。
        */
        let presets: HeroPreset[] = [];
        try {
          const rawP = await kv.get<unknown>(PRESETS_KEY);
          if (typeof rawP === 'string' && rawP.trim()) {
            const parsedP: unknown = JSON.parse(rawP);
            if (Array.isArray(parsedP)) presets = parsedP as HeroPreset[];
          } else if (Array.isArray(rawP)) {
            presets = rawP as HeroPreset[];
          }
        } catch {
          // 预设读失败不该影响世界卡可用性：当作"还没有预设"，不覆盖 error
        }

        /*
          叙事预设一并读出（见 NARRATIVE_PRESETS_KEY）。
          同样不参与下面的内置卡播种逻辑：初始值就是空数组。
          activeId 指向一份**已不存在**的预设时按"没启用"处理 ——
          这只会出现在手动改过 IndexedDB 或跨版本迁移的情况下，
          留着它会让每次构建提示词都去找一个空对象。
        */
        let narrativePresets: NarrativePreset[] = [];
        let activeNarrativePresetId = '';
        let styleChoice: StyleChoice = { ...EMPTY_STYLE_CHOICE };
        try {
          const rawN = await kv.get<unknown>(NARRATIVE_PRESETS_KEY);
          const parsedN = typeof rawN === 'string' && rawN.trim() ? JSON.parse(rawN) : rawN;
          if (parsedN && typeof parsedN === 'object' && !Array.isArray(parsedN)) {
            const o = parsedN as { presets?: unknown; activeId?: unknown; style?: unknown };
            if (Array.isArray(o.presets)) {
              narrativePresets = (o.presets as NarrativePreset[]).filter(
                (p): p is NarrativePreset =>
                  !!p && typeof p === 'object' && typeof p.id === 'string',
              );
            }
            if (typeof o.activeId === 'string') activeNarrativePresetId = o.activeId;
            /*
              文风选择的**逐字段**归一化，不整块信任存档：
              某个 id 后来被我从库里删掉（或改了名），整块塞进去会让
              渲染时查不到那条、静默少一段。这里把不认识的 id 直接扔掉。
            */
            const s = o.style as Partial<StyleChoice> | undefined;
            if (s && typeof s === 'object') {
              const only = (list: unknown): string[] =>
                Array.isArray(list)
                  ? list.filter((x): x is string => typeof x === 'string' && !!styleById(x))
                  : [];
              styleChoice = {
                core: typeof s.core === 'string' && s.core && styleById(s.core) ? s.core : '',
                extra: only(s.extra),
                base: only(s.base),
                polish: only(s.polish),
              };
            }
          }
        } catch {
          // 同主角预设：读不出来就当没有，不影响开游戏
        }
        if (activeNarrativePresetId && !narrativePresets.some(p => p.id === activeNarrativePresetId)) {
          activeNarrativePresetId = '';
        }

        try {
          const raw = await kv.get<unknown>(WORLDS_KEY);
          if (typeof raw === 'string' && raw.trim()) {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              worlds = parsed as WorldCard[];
            } else {
              error = '世界卡存档格式不正确（不是数组），已回退到内置示例卡。';
            }
          } else if (Array.isArray(raw)) {
            // 容错：万一有旧版本直接把对象塞进 kv，而不是 JSON 字符串
            worlds = raw as WorldCard[];
          }
          // raw 缺失 / 空字符串 = 首次运行，交给下面播入内置卡
        } catch (err) {
          error = `读取世界卡库失败：${describeError(err)}`;
        }

        /*
          ── 读「玩家删过的内置卡」──
          读失败一律按"没删过"处理：宁可多补一张内置卡（他还能再删一次），
          也不要因为一个辅助键读不出来，就让所有新世界都对他不可见。
        */
        try {
          const rawR = await kv.get<unknown>(REMOVED_BUILTIN_KEY);
          const parsedR = typeof rawR === 'string' && rawR.trim() ? JSON.parse(rawR) : rawR;
          removedBuiltinCache = Array.isArray(parsedR)
            ? parsedR.filter((x): x is string => typeof x === 'string')
            : [];
        } catch {
          removedBuiltinCache = [];
        }

        // 注意：读到空数组不算「首次运行」（`worlds === null` 才算）。
        // 用户自己删光了卡，再把内置卡塞回去会显得删除操作没生效。
        const firstRun = worlds === null

        /*
          ── 清退：已经从内置清单里撤下的世界卡 ──

          为什么非要有这一步：`missingBuiltinIds` 只回答"清单里缺哪些"，
          而**清单里没有的 id 它根本不会提**。所以撤掉一张内置卡之后，
          玩家库里那张 `builtin: true` 的旧卡会一直躺在卡片墙上 ——
          表现为"我改了版本，怎么还是十张"。

          判定在 `retireBuiltinWorlds` 里（纯函数，有单测）：只清原装的，
          副本（`builtin !== true`）与 `editedByUser` 的稿子都留下。
        */
        let retiredCount = 0
        if (worlds) {
          const r = retireBuiltinWorlds(worlds)
          worlds = r.kept
          retiredCount = r.removed
        }

        const haveIds = (worlds ?? []).map(w => w.id);
        const missing = missingBuiltinIds(haveIds, removedBuiltinCache);

        /*
          ── 读「上次播种用的指纹」，决定要不要把**已有的**内置卡也换新 ──
          读不到（老库第一次升到这一版）就当作"不知道"，于是走一次全量刷新 ——
          这一次刷新正是把 800 字那张卡换成 1800 的那一刻。
        */
        let storedStamp: string | null = null;
        try {
          const rawS = await kv.get<unknown>(BUILTIN_STAMP_KEY);
          storedStamp = typeof rawS === 'string' && rawS.trim() ? rawS : null;
        } catch {
          storedStamp = null;
        }

        /*
          已经存在、但内容已过期的内置卡。
          排除玩家**删过**的（尊重删除），也排除 `builtin !== true` 的
          （那是 duplicate 出来的副本，属于他自己的东西，不许覆盖），
          还要排除 `editedByUser` 的（他在编辑器里亲手动过这张内置卡 —— 见 updateWorld）。
        */
        const stale = firstRun || storedStamp === BUILTIN_STAMP
          ? []
          : BUILTIN_WORLD_IDS.filter(id =>
              haveIds.includes(id)
              && !removedBuiltinCache.includes(id)
              && !worlds?.find(w => w.id === id)?.editedByUser,
            );

        const refresh = [...new Set([...missing, ...stale])];

        // 清退也算"库变了"，必须落盘 —— 否则下次打开又看到那张卡
        let needSeed = retiredCount > 0;
        if (firstRun || refresh.length) {
          /*
            ⚠️ 走 `loadBuiltinWorlds`（按 id **动态**加载，每个世界各成一个 chunk），
            **不要** import `@/data/builtinWorlds` —— 那个模块静态拉入全部九张卡
            （约 2.5 MB 源码 / gzip 640 KB），等于把它们整块塞进首屏包。
            平时只下缺的那几个 chunk；只有指纹变了才一次性全下。
          */
          const fresh = await loadBuiltinWorlds(refresh);
          if (fresh.length || firstRun) {
            if (firstRun || !worlds) {
              worlds = deepClone(fresh);
            } else {
              /*
                **就地替换**，其余保持原顺序与原位置。
                直接 `concat` 会让刷新过的卡全跑到列表末尾 ——
                玩家眼里就是"我的卡片顺序怎么全乱了"，而这件事没人会报成 bug。
              */
              const byId = new Map(fresh.map(w => [w.id, w]));
              const next: WorldCard[] = [];
              for (const w of worlds) {
                // `editedByUser` 的也跳过：他改过，刷新就等于把改动抹掉
                const replacement = w.builtin === true && !w.editedByUser ? byId.get(w.id) : undefined;
                if (replacement) {
                  next.push(deepClone(replacement));
                  byId.delete(w.id);
                } else {
                  next.push(w);
                }
              }
              // 剩下的都是"真正新加的内置卡"，追加到末尾（与播种时一致）
              for (const w of byId.values()) next.push(deepClone(w));
              worlds = next;
            }
            needSeed = true;
          }
        }

        /*
          ⚠️ `worlds` 的类型是 `WorldCard[] | null`（null = 首次运行），
          但走到这里它一定是个数组：上面那条分支保证了"缺卡就补"。
          这里**显式归一化**而不是依赖类型收窄 —— 它同时挡掉一个边角情况：
          首次运行、但每一张内置卡都在"删过的"名单里（换过设备又清过库），
          那时 `fresh` 是空的，`worlds` 会一直是 null，直接塞进 store 会让下游 `w.id` 崩。
        */
        set({
          worlds: worlds ?? [],
          heroPresets: presets,
          narrativePresets,
          activeNarrativePresetId,
          styleChoice,
          loaded: true,
          loadError: error,
        });
        if (needSeed) await queuePersist();
        if (storedStamp !== BUILTIN_STAMP) {
          /*
            写戳放在**写卡之后**。
            顺序反过来（先写戳再写卡）有个很难查的坏结局：卡没落盘、戳却落盘了，
            下次启动会以为"已经是最新"，于是旧卡永远留着 —— 正是这一轮要修的那个病。
            现在这个顺序最坏也只是多刷一次。
          */
          try {
            await kv.set(BUILTIN_STAMP_KEY, BUILTIN_STAMP);
          } catch {
            // 写不进去就下次启动再刷一次，不影响这次使用
          }
        }
      })();

      try {
        await loadInFlight;
      } finally {
        loadInFlight = null;
      }
    },

    saveWorld: async (world) => {
      await commitWorld(deepClone(world));
    },

    updateWorld: async (id, patch) => {
      const current = get().worlds.find((w) => w.id === id);
      if (!current) return; // 卡已不在（可能刚被删），静默忽略，别把脏数据写回去
      const safePatch = deepClone(patch);
      await commitWorld({
        ...current,
        ...safePatch,
        /*
          ⚠️ **玩家亲手动过的内置卡，从此不再自动更新。**

          没有这一行会出什么事：他在编辑器里把某张内置卡的措辞调了，
          下次内容指纹一变（比如我改了九张卡的篇幅），整批刷新就把它盖回去了 ——
          而他不会知道是自己的改动没了，只会觉得"我明明改过"。

          判据放在**写入时**而不是读取时：
          - 写入时打标记，一次就够，之后每次刷新都能看见；
          - 读取时比对差异需要保存一份"原始内置版"作参照，那是另一份数据要维护。

          代价说清楚：这张卡以后就停在玩家改的那一版，不再跟官方更新。
          想跟更新，duplicate 一份去改（副本 `builtin === false`，本来就不受影响）。
        */
        editedByUser: current.builtin === true ? true : current.editedByUser,
        // id / createdAt 不接受 patch 覆盖，updatedAt 一律刷新
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      });
    },

    deleteWorld: async (id) => {
      const before = get().worlds;
      const target = before.find((w) => w.id === id);
      const worlds = before.filter((w) => w.id !== id);
      if (worlds.length === before.length) return; // 没删到东西就不必整体写回
      await commitWorlds(worlds);

      /*
        删的是**内置卡**时记一笔（见 REMOVED_BUILTIN_KEY）。
        不记的话，下次启动的"缺卡补齐"会把它原样塞回来 —— 玩家看到的是
        "删除按钮坏了"。用户自己导入或复制的卡不必记：那些 id 不在内置清单里。
      */
      if (target?.builtin === true && !removedBuiltinCache.includes(id)) {
        removedBuiltinCache = [...removedBuiltinCache, id];
        // 与卡片库共用一条写链，保证两个键的写入有序（同 persistPresets 的理由）
        writeChain = writeChain
          .then(() => kv.set(REMOVED_BUILTIN_KEY, JSON.stringify(removedBuiltinCache)))
          // 辅助键写失败不值得打扰玩家：最坏是下次启动把这张卡补回来一次
          .catch(() => undefined);
        await writeChain;
      }
    },

    duplicateWorld: async (id) => {
      const source = get().worlds.find((w) => w.id === id);
      if (!source) return null;
      const now = Date.now();
      const copy = deepClone(source);
      copy.id = makeId('world');
      copy.title = `${source.title} 副本`;
      copy.createdAt = now;
      copy.updatedAt = now;
      copy.builtin = false; // 副本是用户自己的卡，不该继续显示成内置只读卡
      await commitWorld(copy);
      // 返回副本的拷贝而不是 store 里那一个：调用方改返回值不能影响库里的卡
      return deepClone(copy);
    },

    /**
     * 读取单张卡。这里刻意返回 store 内的引用（不拷贝）：
     * 它常被用在渲染路径上，而卡片可能带几百 KB 的 base64，
     * 每次渲染都深拷贝一次会直接卡住列表。请当只读用；
     * 需要可安全改动的副本用 duplicateWorld 或 exportAll。
     */
    getWorld: (id) => get().worlds.find((w) => w.id === id),

    exportAll: () => deepClone(get().worlds),

    importWorlds: async (worlds) => {
      if (!Array.isArray(worlds) || worlds.length === 0) return [];
      const used = new Set(get().worlds.map((w) => w.id));
      const now = Date.now();
      const imported: WorldCard[] = [];

      for (const raw of worlds) {
        if (!raw || typeof raw !== 'object') continue;
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!title) continue; // 没有标题的卡在列表里无法区分，直接丢弃

        /*
          ⚠️ 必须过一道 `normalizeWorldCard`。
          导入的卡可能来自旧版本的世界包（`story.opening` 还没改名、
          `openingSeeds` 还是两层嵌套），那些字段在新代码里会**静默失效** ——
          氛围文本读得到但编辑器看不到，开场素材则直接取不到、退回世界基调。
          迁移放在这里是因为 `importWorlds` 是**所有**导入路径的唯一收口。
        */
        const card = normalizeWorldCard(deepClone(raw));
        // 缺 id，或与本库已有 id 撞车，都换新 id：
        // 导入包来自别人的库，id 撞了会让两张卡互相覆盖。
        if (typeof card.id !== 'string' || !card.id.trim() || used.has(card.id)) {
          card.id = makeId('world');
        }
        used.add(card.id);
        card.title = title;
        card.createdAt = typeof card.createdAt === 'number' ? card.createdAt : now;
        card.updatedAt = typeof card.updatedAt === 'number' ? card.updatedAt : now;
        card.builtin = card.builtin === true; // 只认明确的 true，否则算用户自己的卡（可自由编辑）
        imported.push(card);
      }

      if (imported.length === 0) return [];
      await commitWorlds([...imported, ...get().worlds]);
      return imported.map((card) => deepClone(card));
    },

    // ── 主角预设（「提前设定主角」）────────────────────────────────
    /*
      这些操作都**只动 PRESETS_KEY**，不碰世界卡 ——
      玩家清理卡片库、导入别人的世界包，都不该弄丢自己设好的主角。
    */
    saveHeroPreset: async (preset) => {
      const now = Date.now();
      // 深拷贝：调用方通常是组件的 state，直接存引用会让后续编辑连带改到库里
      await commitPreset({
        ...deepClone(preset),
        id: preset.id || makeId('hero'),
        createdAt: preset.createdAt || now,
        updatedAt: now,
      });
    },

    updateHeroPresetPlayer: async (id, player) => {
      const cur = get().heroPresets.find((p) => p.id === id);
      if (!cur) return;
      await commitPreset({ ...cur, player: deepClone(player), updatedAt: Date.now() });
    },

    deleteHeroPreset: async (id) => {
      await commitPresets(get().heroPresets.filter((p) => p.id !== id));
    },

    duplicateHeroPreset: async (id, label) => {
      const cur = get().heroPresets.find((p) => p.id === id);
      if (!cur) return null;
      const now = Date.now();
      const copy: HeroPreset = {
        ...deepClone(cur),
        id: makeId('hero'),
        label: label || `${cur.label} 副本`,
        createdAt: now,
        updatedAt: now,
      };
      await commitPreset(copy);
      return copy;
    },

    /** 同 getWorld：返回库内引用，请当只读用 */
    getHeroPreset: (id) => get().heroPresets.find((p) => p.id === id),

    createHeroPreset: async (label, player) => {
      const now = Date.now();
      const preset: HeroPreset = {
        id: makeId('hero'),
        label: label.trim() || player.name.trim() || '未命名主角',
        player: deepClone(player),
        createdAt: now,
        updatedAt: now,
      };
      await commitPreset(preset);
      return preset;
    },

    // ── 叙事预设（文风 / 规则包，可切换）──────────────────────────
    saveNarrativePreset: async (preset, options) => {
      const now = Date.now();
      const list = get().narrativePresets;
      const next: NarrativePreset = {
        ...deepClone(preset),
        id: preset.id || makeId('preset'),
        createdAt: preset.createdAt || now,
        updatedAt: now,
      };
      const index = list.findIndex((p) => p.id === next.id);
      // 新导入的排最前（列表天然按最近导入排序），替换则原地不动
      const presets = index === -1
        ? [next, ...list]
        : list.map((p) => (p.id === next.id ? next : p));

      /*
        **第一次导入自动启用。**
        玩家拖一份预设进来，期待的立刻是"下一轮就照这个写"，
        而不是"存进去了，还得自己再点一下启用"。
        已经有激活项时不动他的选择 —— 那是他自己挑的。
      */
      const activate = options?.activate ?? !get().activeNarrativePresetId;
      await commitNarrativePresets(presets, activate ? next.id : get().activeNarrativePresetId);
    },

    deleteNarrativePreset: async (id) => {
      const before = get().narrativePresets;
      const presets = before.filter((p) => p.id !== id);
      if (presets.length === before.length) return;
      // 删掉的正好是启用中的那份 → 回到"不用预设"，别让 activeId 悬空
      const activeId = get().activeNarrativePresetId === id ? '' : get().activeNarrativePresetId;
      await commitNarrativePresets(presets, activeId);
    },

    setActiveNarrativePreset: async (id) => {
      if (id && !get().narrativePresets.some((p) => p.id === id)) return;
      if (get().activeNarrativePresetId === id) return;
      await commitNarrativePresets(get().narrativePresets, id);
    },

    getNarrativePreset: (id) => get().narrativePresets.find((p) => p.id === id),

    getActiveNarrativePreset: () => {
      const id = get().activeNarrativePresetId;
      if (!id) return undefined;
      return get().narrativePresets.find((p) => p.id === id);
    },

    setStyleChoice: async (next) => {
      // 只在真的变了才写：滑块式的开关点两下会连写两次，IndexedDB 没必要跟着跑
      const cur = get().styleChoice;
      if (
        cur.core === next.core
        && cur.extra.join() === next.extra.join()
        && cur.base.join() === next.base.join()
        && cur.polish.join() === next.polish.join()
      ) return;
      await commitNarrativePresets(get().narrativePresets, get().activeNarrativePresetId, next);
    },
  };
});
