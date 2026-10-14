/**
 * 角色卡导入 / 导出：SillyTavern V2 / V3 与通用 JSON。
 *
 * 两条设计原则：
 * 1. 解析「尽力而为」——输入是用户本地文件，任何畸形内容都返回 null 或默认卡，
 *    绝不把异常抛给 UI。
 * 2. 未识别字段统一收进 `extensions.__unknown`，导出时再提回 data 顶层，
 *    保证「导入 → 编辑 → 导出」不丢数据。
 */

import type { CharacterCard } from '@/types/cards';
import { makeId, readFileAsDataURL, readFileAsText } from '@/utils/files';

type JsonObject = Record<string, unknown>;

/** 未识别原始字段的收纳键名 */
const UNKNOWN_KEY = '__unknown';

/** 本项目内部字段：可以解析进来，但不属于 SillyTavern 规范，导出时必须剔除 */
const PROJECT_ONLY_KEYS = ['id', 'present', 'location', 'relationship', 'status', 'playable'] as const;

/** 已识别字段（同时覆盖 snake_case 与 camelCase 两种写法），其余一律算「未识别」 */
const KNOWN_KEYS = new Set<string>([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'firstMessage',
  'mes_example',
  'messageExamples',
  'creator_notes',
  'creatorNotes',
  'system_prompt',
  'systemPrompt',
  'post_history_instructions',
  'postHistoryInstructions',
  'alternate_greetings',
  'alternateGreetings',
  'tags',
  'creator',
  'character_version',
  'characterVersion',
  'extensions',
  'avatar',
  // 包装层字段：正常解包后不会出现在 data 里，列上以防畸形卡把它们当未知字段再导出
  'spec',
  'spec_version',
  'data',
  ...PROJECT_ONLY_KEYS,
]);

/** 判定「这是不是一张裸角色卡」时看的内容字段（有 name 还不够，必须有其一） */
const CONTENT_KEYS = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'firstMessage',
  'mes_example',
  'messageExamples',
  'creator_notes',
  'creatorNotes',
  'system_prompt',
  'systemPrompt',
] as const;

const DEFAULT_NAME = '未命名角色';

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 不可信 JSON 的解析边界：失败返回 null，由调用方决定降级行为 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 只接受字符串；数字/布尔在宽松 JSON 里也常见，顺手转成字符串 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 按优先级取第一个非空文本（snake_case 优先于 camelCase） */
function pickText(source: JsonObject, keys: readonly string[]): string {
  for (const key of keys) {
    const text = asText(source[key]);
    if (text) return text;
  }
  return '';
}

/** 保证得到 string[]：兼容数组、JSON 字符串数组、单个字符串、混入的非字符串元素 */
function toStringArray(value: unknown): string[] {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    candidate = parsed ?? (value.trim() ? [value] : []);
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.map((item) => (typeof item === 'string' ? item : asText(item))).filter((item) => item.length > 0);
}

/** 裸角色对象：有非空 name，且至少带一个内容字段 */
function looksLikeCharacter(obj: JsonObject): boolean {
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false;
  return CONTENT_KEYS.some((key) => key in obj);
}

/**
 * 取出真正的角色数据对象：兼容 `{ spec, data }` 包装、只带 data 的包装、以及裸对象。
 * 最多解 3 层，避免畸形卡造成无尽循环。
 */
function unwrapCardPayload(input: unknown): JsonObject | null {
  let current: unknown = input;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isPlainObject(current)) return null;
    const obj = current;
    const spec = typeof obj.spec === 'string' ? obj.spec : '';
    if ((spec === 'chara_card_v2' || spec === 'chara_card_v3') && isPlainObject(obj.data)) {
      current = obj.data;
      continue;
    }
    if (looksLikeCharacter(obj)) return obj;
    if (isPlainObject(obj.data) && looksLikeCharacter(obj.data)) {
      current = obj.data;
      continue;
    }
    return null;
  }
  return isPlainObject(current) ? current : null;
}

/** 新建一张空白角色卡；overrides 里的同名字段会覆盖默认值 */
export function createEmptyCharacter(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: makeId('char'),
    name: DEFAULT_NAME,
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    messageExamples: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    /*
      ⚠️ 默认 **不在场**（2026-10 用户要求「所有预设 NPC 都不在场」）。
      `present: true` 等于替玩家先认定"这人一开局就在你身边"，
      而那正是玩家反复打回的那种"替我的主角认亲"。
      现在谁在场由玩家在选角页勾，或者由 AI 在开场现场决定。
    */
    present: false,
    ...overrides,
  };
}

/**
 * 把 SillyTavern V2 的 `data`（或裸对象、甚至整份 `{ spec, data }`）映射成 CharacterCard。
 * 没识别出来的字段原样塞进 `extensions.__unknown`。
 */
export function fromSillyTavern(data: any, avatar?: string): CharacterCard {
  // 解不出包装时仍按普通对象尽力映射，避免连 name 都丢掉
  const source: JsonObject = unwrapCardPayload(data) ?? (isPlainObject(data) ? data : {});

  const extensions: JsonObject = isPlainObject(source.extensions) ? { ...source.extensions } : {};
  const unknown: JsonObject = isPlainObject(extensions[UNKNOWN_KEY])
    ? { ...(extensions[UNKNOWN_KEY] as JsonObject) }
    : {};
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_KEYS.has(key)) unknown[key] = value;
  }
  if (Object.keys(unknown).length > 0) extensions[UNKNOWN_KEY] = unknown;

  const card: CharacterCard = {
    id: typeof source.id === 'string' && source.id ? source.id : makeId('char'),
    name: asText(source.name).trim() || DEFAULT_NAME,
    description: pickText(source, ['description']),
    personality: pickText(source, ['personality']),
    scenario: pickText(source, ['scenario']),
    firstMessage: pickText(source, ['first_mes', 'firstMessage']),
    messageExamples: pickText(source, ['mes_example', 'messageExamples']),
    creatorNotes: pickText(source, ['creator_notes', 'creatorNotes']),
    systemPrompt: pickText(source, ['system_prompt', 'systemPrompt']),
    postHistoryInstructions: pickText(source, ['post_history_instructions', 'postHistoryInstructions']),
    alternateGreetings: toStringArray(source.alternate_greetings ?? source.alternateGreetings),
    tags: toStringArray(source.tags),
    creator: pickText(source, ['creator']),
    characterVersion: pickText(source, ['character_version', 'characterVersion']),
    present: typeof source.present === 'boolean' ? source.present : true,
  };

  // 显式传入的 avatar 优先；否则接受卡里自带的 avatar 字段
  const resolvedAvatar = avatar || asText(source.avatar);
  if (resolvedAvatar) card.avatar = resolvedAvatar;

  const location = pickText(source, ['location']);
  if (location) card.location = location;
  const relationship = pickText(source, ['relationship']);
  if (relationship) card.relationship = relationship;
  const status = pickText(source, ['status']);
  if (status) card.status = status;
  if (typeof source.playable === 'boolean') card.playable = source.playable;

  // 空 extensions 不落地，保持卡对象干净
  if (Object.keys(extensions).length > 0) card.extensions = extensions;
  return card;
}

/** 反向导出成 SillyTavern V2 结构（snake_case） */
export function toSillyTavern(card: CharacterCard): object {
  const extensions: JsonObject = isPlainObject(card.extensions) ? { ...card.extensions } : {};
  const unknown: JsonObject = isPlainObject(extensions[UNKNOWN_KEY])
    ? { ...(extensions[UNKNOWN_KEY] as JsonObject) }
    : {};
  delete extensions[UNKNOWN_KEY];

  const data: JsonObject = {
    name: card.name ?? '',
    description: card.description ?? '',
    personality: card.personality ?? '',
    scenario: card.scenario ?? '',
    first_mes: card.firstMessage ?? '',
    mes_example: card.messageExamples ?? '',
    creator_notes: card.creatorNotes ?? '',
    system_prompt: card.systemPrompt ?? '',
    post_history_instructions: card.postHistoryInstructions ?? '',
    alternate_greetings: toStringArray(card.alternateGreetings),
    tags: toStringArray(card.tags),
    creator: card.creator ?? '',
    character_version: card.characterVersion ?? '',
    extensions,
  };

  // 未知字段提回顶层（不再嵌在 __unknown 下）；已知字段优先，项目专用字段按规范不导出
  for (const [key, value] of Object.entries(unknown)) {
    if (key in data) continue;
    if (key !== 'avatar' && KNOWN_KEYS.has(key)) continue;
    data[key] = value;
  }

  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/** 判断一个值是否长得像角色卡载荷（V2/V3 包装、带 data 的包装、或裸角色对象） */
export function isSillyTavernPayload(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const spec = typeof value.spec === 'string' ? value.spec : '';
  if ((spec === 'chara_card_v2' || spec === 'chara_card_v3') && isPlainObject(value.data)) return true;
  return unwrapCardPayload(value) !== null;
}

// —— PNG 角色卡：JSON 藏在 tEXt(ccv3 / chara) 或 iTXt 数据块里 ——

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/** PNG 关键字只允许 Latin-1 可打印字符，逐字节取值即可 */
function readKeyword(bytes: Uint8Array, start: number, end: number): string {
  let keyword = '';
  for (let i = start; i < end; i += 1) keyword += String.fromCharCode(bytes[i]);
  return keyword;
}

/** 先按 UTF-8 解；出现替换字符说明是 Latin-1 旧卡，退回逐字节解码 */
function decodeUtf8OrLatin1(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  let latin1 = '';
  for (let i = 0; i < bytes.length; i += 1) latin1 += String.fromCharCode(bytes[i]);
  return latin1;
}

/** base64 → UTF-8 文本；含非法字符（说明本来就是明文）时返回 null */
function base64ToUtf8(text: string): string | null {
  const cleaned = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  const padding = cleaned.length % 4;
  const padded = padding === 0 ? cleaned : cleaned + '='.repeat(4 - padding);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // 卡里的中文是 UTF-8，按字节解码才不会乱码
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/** 卡块内容既可能是 base64(JSON)，也可能是明文 JSON */
function normalizeCardJson(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  const fromBase64 = base64ToUtf8(trimmed);
  if (fromBase64) {
    const decoded = fromBase64.replace(/^\uFEFF/, '').trim();
    if (decoded.startsWith('{') || decoded.startsWith('[')) return decoded;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  return null;
}

/** iTXt 允许 zlib 压缩；浏览器支持 DecompressionStream 时顺手解开，否则放弃 */
async function inflateZlib(bytes: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    // slice() 复制一份，避免把原缓冲区的视图交给流
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

/** tEXt 数据：`keyword\0text` */
function readTextChunk(chunk: Uint8Array): { keyword: string; payload: string } | null {
  const nul = chunk.indexOf(0);
  if (nul <= 0) return null;
  return { keyword: readKeyword(chunk, 0, nul), payload: decodeUtf8OrLatin1(chunk.subarray(nul + 1)) };
}

/** iTXt 数据：`keyword\0flag\0method\0lang\0translated\0text` */
async function readInternationalTextChunk(
  chunk: Uint8Array,
): Promise<{ keyword: string; payload: string } | null> {
  const keywordEnd = chunk.indexOf(0);
  if (keywordEnd <= 0 || keywordEnd + 3 > chunk.length) return null;
  const keyword = readKeyword(chunk, 0, keywordEnd);
  const compressed = chunk[keywordEnd + 1] === 1;
  const method = chunk[keywordEnd + 2];

  let cursor = keywordEnd + 3;
  const languageEnd = chunk.indexOf(0, cursor);
  if (languageEnd < 0) return null;
  cursor = languageEnd + 1;
  const translatedEnd = chunk.indexOf(0, cursor);
  if (translatedEnd < 0) return null;
  cursor = translatedEnd + 1;

  const body = chunk.subarray(cursor);
  if (!compressed) return { keyword, payload: decodeUtf8OrLatin1(body) };
  if (method !== 0) return null; // 只认识 zlib(deflate)，其它压缩方式直接跳过
  const inflated = await inflateZlib(body);
  return inflated === null ? null : { keyword, payload: inflated };
}

/** 遍历 PNG 数据块取出角色 JSON；ccv3 优先于 chara */
async function extractPngCardJson(buffer: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  if (!hasPngSignature(bytes)) return null;

  const view = new DataView(buffer);
  const found = new Map<string, string>();
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = readKeyword(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    // 长度越界 = 文件被截断或伪造，停止遍历（已找到的块仍然有效）
    if (length > bytes.length - dataStart - 4) break;
    const chunk = bytes.subarray(dataStart, dataStart + length);

    let entry: { keyword: string; payload: string } | null = null;
    if (type === 'tEXt') entry = readTextChunk(chunk);
    else if (type === 'iTXt') entry = await readInternationalTextChunk(chunk);

    if (entry && (entry.keyword === 'chara' || entry.keyword === 'ccv3') && !found.has(entry.keyword)) {
      const json = normalizeCardJson(entry.payload);
      if (json) found.set(entry.keyword, json);
    }

    if (type === 'IEND') break;
    offset = dataStart + length + 4;
  }

  return found.get('ccv3') ?? found.get('chara') ?? null;
}

/**
 * 解析用户选中的文件：PNG 卡走数据块解析（PNG 自身作为头像），
 * 其它一律当文本读，支持 V2/V3 包装、裸卡与本项目的宽松 JSON。
 * 不认识的内容返回 null。
 */
export async function parseCharacterFile(file: File): Promise<CharacterCard | null> {
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  try {
    if (isPng) {
      const buffer = await file.arrayBuffer();
      const json = await extractPngCardJson(buffer);
      if (!json) return null;
      const payload = unwrapCardPayload(parseJson(json));
      if (!payload) return null;
      const avatar = await readFileAsDataURL(file);
      return fromSillyTavern(payload, avatar);
    }

    const text = await readFileAsText(file);
    const payload = unwrapCardPayload(parseJson(text));
    if (!payload) return null;
    return fromSillyTavern(payload);
  } catch {
    // 坏文件不应打断导入流程
    return null;
  }
}
