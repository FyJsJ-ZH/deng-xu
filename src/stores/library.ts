import { create } from 'zustand';
import type { WorldCard, HeroPreset, PlayerCard } from '@/types/cards';
import { makeId } from '@/utils/files';
import { createKVStore, isIdbAvailable } from '@/utils/idb';
import { loadBuiltinWorlds, missingBuiltinIds } from '@/data/builtinWorldIds';
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
        const firstRun = worlds === null;
        const missing = missingBuiltinIds((worlds ?? []).map(w => w.id), removedBuiltinCache);

        let needSeed = false;
        if (firstRun || missing.length) {
          /*
            ⚠️ 走 `loadBuiltinWorlds`（按 id **动态**加载，每个世界各成一个 chunk），
            **不要** import `@/data/builtinWorlds` —— 那个模块静态拉入全部八张卡
            （约 2.5 MB 源码 / gzip 640 KB），等于把它们整块塞进首屏包。
            这里只取缺的那几张：老玩家升级时通常只需下四个 chunk。
          */
          const add = await loadBuiltinWorlds(missing);
          if (add.length || firstRun) {
            worlds = [...(worlds ?? []), ...deepClone(add)];
            needSeed = true;
          }
        }

        /*
          ⚠️ `worlds` 的类型是 `WorldCard[] | null`（null = 首次运行），
          但走到这里它一定是个数组：上面那条分支保证了"缺卡就补"。
          这里**显式归一化**而不是依赖类型收窄 —— 它同时挡掉一个边角情况：
          首次运行、但每一张内置卡都在"删过的"名单里（换过设备又清过库），
          那时 `add` 是空的，`worlds` 会一直是 null，直接塞进 store 会让下游 `w.id` 崩。
        */
        set({ worlds: worlds ?? [], heroPresets: presets, loaded: true, loadError: error });
        if (needSeed) await queuePersist();
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
  };
});
