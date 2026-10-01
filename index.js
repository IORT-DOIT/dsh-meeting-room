// dsh-meeting-room —— 会议室插件（Host 半区）
// v4：记录员 = 每个会议室自带的内置 AI（平时不发言，目标达成时自动产出草稿，人工审核后才发布）
//     /sessions 只列顶层会话（过滤 subagent / 种子会话）
//     接口契约见 docs/（改动必须同步文档 + selftest/run.mjs + README.zh.md）
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, createReadStream, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';

const API = '/dsh-room';
// v3：状态根只放登记与设置；会议文件一律落到「分类目录/<房间 id>/」
const DEFAULT_ROOT = join(homedir(), '.dsh', 'meeting-room');
const DEFAULT_CATEGORY = join(homedir(), 'dsh', '会议');
const DEFAULT_RECORDER_PROMPT = [
  '【会议室 {{room}}】目标「{{goal}}」已达成，请你作为记录员写《会议结果》。',
  '1) 只能依据下面给出的会议记录（该目标对应的 transcript 片段），不得使用任何其他信息，不得编造。',
  '2) 只记录与会者与用户真实说过的结论/分工/待办/未决问题；记录里没有的内容一律写「记录中未涉及」。',
  '3) 按与会者分别成节：`## <成员显示名>`（没有专属结论的人写「记录中未涉及」）。',
  '4) 直接输出《会议结果》正文（Markdown），不要调用任何工具、不要输出解释性前言。',
  // v16③(c)：记录员的职责是「记结论」，不是「替某一方写文章」——只写最终共识，分歧与过程一律不展开
  '5) 只记录会议最终达成的共识、分工与待办。讨论过程、来回辩驳、被否决的方案一律不写进正文（需要时只在「未决问题」里用一句话点出分歧）。',
  '6) 不得编造：不替与会者补写他们没有说过的观点，不把某一方的长篇发言当成结论，也不得把单一与会者的主张写成全体共识（只有记录里明确被其他与会者接受/无异议的才写成共识）。',
  '7) 简洁：每一节几句话即可，能写清单就不写段落；整篇《会议结果》不要复述会议记录。',
].join('\n');
/**
 * v16③(a)：与会者「基本提示词 / 开会守则」—— 投递时注入该与会者会话的 system prompt。
 * 正规途径（子代理调研）：agent 作用域 ctx 上的 `systemPrompt.section()`（每步重算 + 恒定文本只落一次，
 * 不写进对话历史、不膨胀上下文）。只讲「怎么开会」，每一轮的具体议题仍由投递的消息给出。
 */
const CONDUCT_PROMPT = [
  '你正在参加 dsh-meeting-room 的一个会议室（你是与会者之一）。',
  '1) 围绕会议目标讨论：每轮发言都要推进当前会议目标，不要把话题带偏；当前目标与最新议题见最近那条「【会议室 …】」消息。',
  '2) 有依据再下结论：引用会议记录或文件时给出处；不确定就说不确定，不要编造事实，也不要替别人编观点。',
  '3) 达成共识就反馈：认为目标已达成、其他与会者已无异议时，用 room_goal_report 报「达成」；确实有分歧就报「有分歧」并一句话说清分歧点。整个目标完成、可以收尾时用 room_task_done。',
  '4) 小步前进：一次只解决当前分歧，发言尽量简短（除非用户要求长文），不要重复别人已经说过的内容。',
  '5) 会议文件：要交换的材料用 room_say 的 files 交给会议室，这样其他与会者与用户都能在「会议文件」里看到。',
].join('\n');
const SESSION_TITLE_TTL = 30000;
// v16⑦：底栏数字的缓存时长（投影 snapshot 是同步的，但没必要每次轮询都算）
const STATS_TTL = 4000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// v9：右侧栏「会议文件」的正文预览上限 —— 超出的文件只回前 128 KB 并打 truncated 标记
const PREVIEW_MAX_BYTES = 128 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const REASONING_LEVELS = new Set(['inherit', 'low', 'medium', 'high']);
// v6：移除 'full' —— 用户正文永不外发；已存 push='full' 的房间由载入归一化钩子变成 'off'
const PUSH_MODES = new Set(['off', 'notice']);
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESULT_STATUS = new Set(['draft', 'approved', 'superseded']);
// v4：记录员是每个会议室自带的内置 AI（不注册 agent、不进 members、不接收投递、不参与 push）
const BUILTIN_RECORDER = { kind: 'builtin', label: '记录员' };
const RECORDER_ASSIGN_REJECT = 'v4：记录员是每个会议室自带的内置 AI，不需要指派';
const RECORDER_SETTINGS_REJECT = 'v4：记录员是每个会议室自带的内置 AI，不能再配置';

// v12：会议文件夹布局 —— 房间目录里分「记录/」「附件/」两组，一个会议的文件不再乱放
const RECORDS_DIRNAME = '记录';
const ATTACHMENTS_DIRNAME = '附件';
const RESULTS_DIRNAME = '结果';
/** v12：文件保存模式（房间级）—— all=全部保存（缺省，沿用 v11 行为）；recorder=散会/发布后清掉非记录员文件 */
const SAVE_MODES = new Set(['all', 'recorder']);
const SAVE_MODE_LABEL = { all: '全部保存', recorder: '只保存记录员的记录' };
/**
 * v12①：记录员这一轮最多跑多久（毫秒）。客户端对「触发记录员」的接口用 300s 超时（见 client/client.js），
 * 宿主本身必须更早放弃并抛中文 503 —— 否则客户端只会弹一个 `signal timed out`，用户看不到任何原因。
 */
const RECORDER_TIMEOUT_MS = 240000;
/** v12①：看门狗响铃的哨兵值（用来把「等 chunk」和「等 abort」赛跑的结果区分开） */
const ABORTED = Symbol('recorder-aborted');
/**
 * v14①：会议文件暂存区 —— 会议期间与会者写出的「顶层文件」先落这里，每轮结束由宿主同步进房间「附件/」。
 * 为什么必须这样：与会者会话的 cwd 是用户桌面、沙箱缺省是 workspace-write（只许写 cwd + 临时目录），
 * 让它直接写 <房间>/附件 会被沙箱拒（file access denied under workspace-write mode），
 * 而按相对文件名写就会堆在用户桌面上 —— 用户报的正是这个 bug。临时目录各模式都可写。
 */
const STAGING_ROOT = join(tmpdir(), 'dsh-meeting-room');
/** 需要接管的工具：读写文件的那几个（路径字段都是 file_path） */
const STAGE_TOOLS = ['write', 'edit', 'read', 'read_image'];

/** 每个房间的 recorder 字段固定是这个值；永远返回新对象，调用方改不坏常量 */
function builtinRecorder() {
  return { ...BUILTIN_RECORDER };
}

/** v4：/sessions 只列顶层会话 —— 子会话 / 种子会话一律过滤 */
function isSubagentSession(header) {
  const h = header ?? {};
  if (h.origin === 'subagent') return true;
  const parent = h.parentSession;
  if (parent !== undefined && parent !== null && String(parent).trim() !== '') return true;
  if (Number(h.delegationDepth ?? 0) > 0) return true;
  if (h.isSeeded === true) return true;
  return false;
}

const Config = z.object({
  root: z.string().default(DEFAULT_ROOT).description('会议室状态根目录（只放 rooms.json / settings.json）'),
  category: z.string().default(DEFAULT_CATEGORY).description('新会议室默认的会议文件目录（其父目录即面板里的分类）'),
  roomId: z.string().default('main').description('默认（v1 兼容路径使用的）会议室的 id'),
  maxReadMessages: z.number().default(40).description('room_read 默认返回的最大消息条数'),
  maxReadChars: z.number().default(40000).description('room_read 默认返回的最大字符数'),
  autoCloseGoals: z.boolean().default(false).description('预留：全体与会者都报「达成」时是否自动完成目标'),
  autoContinueHops: z.number().default(6).description('自动接力开关：>0 = 开（已取消跳数上限，可一直接力）；0 = 关闭自动接力（只进配置，不加面板）'),
  recorderTimeoutMs: z.number().default(RECORDER_TIMEOUT_MS).description('记录员一轮没有返回任何内容的放弃时限（默认 240 秒；自测会调小，用户不用改）'),
});

// ---------------------------------------------------------------- 小工具

function safeName(name, fallback = 'file') {
  const base = basename(String(name ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || fallback;
}

function roomIdOk(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id) && id !== '.' && id !== '..';
}

/** 文件名本身是否像个正常的顶层文件名（不合法/通配/ADS 一律不拦，交给工具自己报错） */
function plainFileName(name) {
  if (!name || name === '.' || name === '..') return false;
  if (/[:*?"<>|]/.test(name)) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

/**
 * v14①：判断这次工具的路径参数要不要改写到暂存区；只有「会话 cwd 根目录下的顶层文件名」才改写。
 *   报告.md、.\报告.md        → 参与（改写）
 *   C:\Users\uyiop\Desktop\报告.md（父目录正好是会话 cwd）→ 参与
 *   sub/x.md、..\x.md、C:\其它\x.md、空、.  → 一律放行
 * 「带目录的相对路径」视为与会者在改自己的项目文件，故意不拦 —— 只解决「文件堆在桌面上」这一件事。
 */
function stageTopLevelName(raw, cwdRoot) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (isAbsolute(text)) {
    if (!cwdRoot) return null;
    if (foldPath(resolve(dirname(text))) !== foldPath(resolve(cwdRoot))) return null;
    const name = basename(text);
    return plainFileName(name) ? name : null;
  }
  let rel = text;
  while (rel.startsWith('./') || rel.startsWith('.\\')) rel = rel.slice(2);
  if (/[/\\]/.test(rel)) return null;
  return plainFileName(rel) ? rel : null;
}


function nowIso() {
  return new Date().toISOString();
}

function timeText(at) {
  const d = new Date(Number.isFinite(at) ? at : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortText(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n…（内容过长已截断，用 room_read 读取完整记录）` : t;
}

/**
 * 从《会议结果》正文里取出属于某个成员的那一节。
 * 记录员被要求在正文里按 `## <成员显示名>` 分节；「全体/通用/所有人」这类小节人人都有。
 * 取不到就返回 null（调用方回落到整篇正文，避免有人收不到东西）。
 */
const GENERIC_SECTION = /(全体|通用|所有人|共同|全部)/;
/** 小节标题与成员显示名的匹配强度：精确 > 前缀+分隔符 > 后缀+分隔符 > 包含。
 *  用打分而不是 includes，避免「实现方」抢走「另一实现方」的小节。 */
function sectionScore(title, wanted) {
  const t = String(title).trim();
  if (t === wanted) return 100;
  const rest = t.slice(wanted.length);
  if (t.startsWith(wanted) && /^[\s：:（(·、,，—-]/.test(rest)) return 70;
  const before = t.slice(0, t.length - wanted.length);
  if (t.endsWith(wanted) && /[\s：:（(·、,，—-]$/.test(before)) return 60;
  if (t.includes(wanted)) return 20;
  return 0;
}
function sectionFor(body, label) {
  const wanted = String(label ?? '').trim();
  if (!wanted) return null;
  const lines = String(body ?? '').split('\n');
  const generic = [];
  let hit = null;
  let current = null;
  for (const line of lines) {
    const head = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (head) {
      const title = head[1];
      const score = sectionScore(title, wanted);
      if (score > 0) current = { title, lines: [], score };
      else if (GENERIC_SECTION.test(title)) current = { title, lines: [], generic: true };
      else current = null;
      if (current?.generic) generic.push(current);
      else if (current && (!hit || current.score > hit.score)) hit = current;
      continue;
    }
    if (current) current.lines.push(line);
  }
  const parts = [];
  if (hit) parts.push(`## ${hit.title}\n${hit.lines.join('\n').trim()}`);
  for (const section of generic) parts.push(`## ${section.title}\n${section.lines.join('\n').trim()}`);
  const text = parts.join('\n\n').trim();
  return text === '' ? null : text;
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolvePromise({});
      try {
        const parsed = JSON.parse(text);
        resolvePromise(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        rejectPromise(Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => rejectPromise(error));
  });
}

function headers(req) {
  return req?.headers ?? {};
}

function headerText(req, name) {
  const v = headers(req)[name];
  return Array.isArray(v) ? v.join(', ') : String(v ?? '');
}

function hostIsLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const name = h.startsWith('::ffff:') ? h.slice(7) : h;
  if (LOOPBACK_HOSTS.has(name)) return true;
  return name === '127.0.0.1' || name.startsWith('127.');
}

function remoteIsLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? '';
  return hostIsLoopback(addr);
}

function isTrustedRequest(req) {
  if (!remoteIsLoopback(req)) return false;
  if (!hostIsLoopback(String(headers(req).host ?? '').split(':')[0])) return false;
  // 浏览器的跨站提示头：v1 契约，v2 重写时不能丢
  if (headerText(req, 'sec-fetch-site').trim().toLowerCase() === 'cross-site') return false;
  const origin = headerText(req, 'origin').trim();
  if (!origin) return true;
  if (origin === 'null' || origin.startsWith('file://') || origin.startsWith('app://')) return true;
  try {
    const u = new URL(origin);
    return hostIsLoopback(u.hostname);
  } catch {
    return false;
  }
}

function ensureInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return sameOrInside(t, r);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 递归合并复制（可预测：不用 fs.cp 那种 dest 已存在时多套一层的语义） */
async function copyDirMerge(from, to) {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyDirMerge(source, target);
    else if (entry.isFile()) await copyFile(source, target).catch(() => {});
  }
}

/** 把 from 里的内容并进已存在的 to（不套一层），然后删掉 from */
async function mergeDirInto(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await mergeDirInto(source, target);
    else if (entry.isFile()) await copyFile(source, target).catch(() => {});
  }
  await rm(from, { recursive: true, force: true });
  return true;
}

/** 整目录搬迁（跨卷回退合并复制 + 删源）；from 与 to 相同时什么都不做。
 *  v12：to 已存在时不能再 rename —— rename 会把 from 整个塞成 to 的子目录（实测：
 *  dir/files → 记录/结果/files），把内容并进 to 才是「搬家」的语义。
 *  v13：to 在 from 内部时直接拒绝 —— 否则合并复制会边写边读自己的新副本，无限套娃
 *  （实测把房间目录改成它自己的子目录，目录瞬间被套了几百层，请求 6 秒不返回）。 */
async function moveDir(from, to) {
  if (samePath(from, to)) return false;
  if (insidePath(to, from)) return false;
  if (!(await exists(from))) return false;
  await mkdir(dirname(to), { recursive: true });
  if (await exists(to)) return mergeDirInto(from, to);
  try {
    await rename(from, to);
    return true;
  } catch {
    return mergeDirInto(from, to);
  }
}

// ---------------------------------------------------------------- 房间全量索引

// ls -la：一次性列出目录下所有需要的文件，避免每步一次 stat
async function scanRooms(root) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { dirs: [], transcripts: new Map(), members: new Map(), roomsJson: null };
    throw error;
  }
  const transcripts = new Map(); // roomId -> {path, bytes, mtimeMs}
  const members = new Map(); // roomId -> {path, bytes, mtimeMs}
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
    if (!roomIdOk(entry.name)) continue;
    dirs.push(entry.name);
    for (const [file, into] of [
      ['transcript.jsonl', transcripts],
      ['members.json', members],
    ]) {
      const p = join(root, entry.name, file);
      if (await exists(p)) {
        const st = await stat(p);
        into.set(entry.name, { path: p, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  const roomsJson = await readJsonFile(join(root, 'rooms.json'), null);
  return { dirs, transcripts, members, roomsJson };
}

// ---------------------------------------------------------------- 会议室

class Room {
  constructor(host, id, meta = {}) {
    this.host = host;
    this.id = id;
    // v3：目录 = <category>/<id>；也可以直接给 dir（= 会议室自己的目录）；旧布局（stateRoot/<id>）在 load() 里自动搬家
    const roomDir = meta.dir
      ? resolve(String(meta.dir))
      : join(meta.category ? resolve(String(meta.category)) : host.defaultCategory, id);
    const category = dirname(roomDir);
    // v3：构造时明确给出的目录（createRoom 的 {dir} / start() 从 rooms.json 或目录里读到的 dir）
    // 在 load() 里必须优先 —— 否则「还没有 room.json 的新房间」会被 join(category,id) 覆盖掉。
    this.explicitDir = meta.dir ? resolve(String(meta.dir)) : null;
    this.setDir(roomDir);
    this.messages = [];
    this.seq = 0;
    this.members = new Map(); // sessionId -> {sessionId,label,joinedAt,role}
    this.goals = [];
    this.room = {
      id,
      title: meta.title ?? (id === host.defaultRoomId ? '主会议室' : id),
      createdAt: meta.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      status: 'open',
      closedAt: null,
      push: 'off',
      reasoning: 'inherit',
      reasoningByMember: {},
      recorder: builtinRecorder(),
      activeGoalId: null,
      reopenRequest: null,
      category: resolve(String(category)),
      dir: roomDir,
      archivedAt: null,
      prompt: null,
      // v12：文件保存模式（all=全部保存 / recorder=只保存记录员的记录）
      saveMode: 'all',
    };
    this.legacyResolution = null;
    this.loaded = false;
    this.timer = null;
    this.writeChain = Promise.resolve();
    this.sessionsCache = { at: 0, list: [], ok: false };
    // v8：自动接力是纯内存态（不写 room.json，重启归零无副作用）
    this.autoHop = 0;
    // v12：记录员在飞的一轮（同一目标不并发跑两轮）
    this.recorderInFlight = new Map();
  }

  /** 统一的路径派生：改分类目录时只改 category，路径全部由这里重算 */
  setDir(dir) {
    this.dir = dir;
    if (this.room) this.room.dir = dir; // v3：dir 落进 room.json，重启后不会被按 category 拽回去（改名过的房间尤其重要）
    this.transcriptPath = join(dir, 'transcript.jsonl');
    this.markdownPath = join(dir, 'transcript.md');
    this.membersPath = join(dir, 'members.json');
    this.roomPath = join(dir, 'room.json');
    this.goalsPath = join(dir, 'goals.json');
    // v12：房间目录里的固定两组 —— 「记录/」（记录员产出 + 会议过程档）+「附件/」（参会人上传 / 外部落进来的文件）
    this.recordsDir = join(dir, RECORDS_DIRNAME);
    this.resultsDir = join(this.recordsDir, RESULTS_DIRNAME);
    this.attachmentsDir = join(dir, ATTACHMENTS_DIRNAME);
    // v11 布局（dir/results、dir/files）—— 只在 v12 一次性迁移里读一次
    this.legacyResultsDir = join(dir, 'results');
    this.legacyFilesDir = join(dir, 'files');
    this.layoutMarkPath = join(this.recordsDir, '.v12-migrated');
    this.legacyResolutionPath = join(dir, '决议.md');
  }

  async ensureDirs() {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.resultsDir, { recursive: true });
    await mkdir(this.attachmentsDir, { recursive: true });
  }

  /**
   * v12：v11 布局（dir/files、dir/results）→ v12 布局（dir/附件、dir/记录/结果）一次性搬家。
   * 幂等：只认标记文件 records/.v12-migrated 与「旧目录是否还在」；破坏性操作（rename / rm 旧目录）只用 try 包住，
   * 失败就 warn 一句继续加载，绝不让布局整理把房间拖到打不开。
   */
  async migrateFileLayout() {
    // v12：标记只用来跳过「没有旧布局」的常规启动 —— 只要旧目录还在（用户事后把 v11 的 files/results
    // 拷回来、或上次搬到一半失败），就必须再搬一次，否则老文件会一直留在旧位置没人管。
    if ((await exists(this.layoutMarkPath)) && !(await exists(this.legacyFilesDir)) && !(await exists(this.legacyResultsDir))) {
      return false;
    }
    let moved = 0;
    try {
      for (const [from, to] of [
        [this.legacyFilesDir, this.attachmentsDir],
        [this.legacyResultsDir, this.resultsDir],
      ]) {
        if (!(await exists(from))) continue;
        await mkdir(dirname(to), { recursive: true });
        if (await moveDir(from, to)) moved += 1;
      }
      await mkdir(this.recordsDir, { recursive: true });
      await writeFile(this.layoutMarkPath, `${new Date().toISOString()} v12：会议文件移到「${RECORDS_DIRNAME}/」「${ATTACHMENTS_DIRNAME}/」\n`, 'utf8');
    } catch (error) {
      this.host.warn(`会议室 ${this.id} 整理会议文件目录失败（继续用现有布局）：${error?.message ?? error}`);
      return false;
    }
    if (moved) this.host.info?.(`会议室 ${this.id} 的会议文件已整理到「${RECORDS_DIRNAME}/」「${ATTACHMENTS_DIRNAME}/」`);
    return moved > 0;
  }

  /** v12：saveMode='recorder' 时清空附件（散会 / 结果发布后各调一次）；返回删掉的文件数 */
  async cleanupAttachments() {
    if (this.room.saveMode !== 'recorder') return 0;
    let entries = [];
    try {
      entries = await readdir(this.attachmentsDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      try {
        await rm(join(this.attachmentsDir, name), { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.host.warn(`会议室 ${this.id} 删除附件 ${name} 失败：${error?.message ?? error}`);
      }
    }
    // 旧的散会决议（v3 遗留）也属于「非记录员产物」，只在 recorder 模式下顺手清掉
    await rm(this.legacyResolutionPath, { force: true }).catch(() => {});
    return removed;
  }

  /** 旧布局 stateRoot/<id> → <category>/<id>（一次性搬家；跨卷回退复制） */
  async migrateLegacyDir(legacyDir) {
    const target = this.dir;
    if (samePath(legacyDir, target)) return false;
    const hasData = (await exists(join(legacyDir, 'room.json'))) || (await exists(join(legacyDir, 'transcript.jsonl')));
    if (!hasData) return false;
    if (await exists(join(target, 'room.json'))) return false;
    await mkdir(dirname(target), { recursive: true });
    try {
      await moveDir(legacyDir, target);
    } catch (error) {
      this.host.warn(`会议室 ${this.id} 从旧目录搬家失败（继续用新目录）：${error?.message ?? error}`);
      return false;
    }
    this.host.info?.(`会议室 ${this.id} 已从 ${legacyDir} 搬到 ${target}`);
    return true;
  }

  async load() {
    // 1) 先定位 room.json：新布局 = <category>/<id>；旧布局 = stateRoot/<id>
    const legacyDir = join(this.host.root, this.id);
    let saved = await readJsonFile(this.roomPath, null);
    let legacy = !saved;
    if (!saved && !samePath(legacyDir, this.dir)) {
      saved = await readJsonFile(join(legacyDir, 'room.json'), null);
      if (!saved) legacy = false;
    }
    let legacyRecorder = false;
    if (saved && typeof saved === 'object') {
      // v4：room.json 里的 v3 recorder（sessionId/label）不再恢复，只记下来做一次落盘清理
      legacyRecorder = saved.recorder !== undefined && saved.recorder !== null;
      for (const key of ['title', 'createdAt', 'status', 'closedAt', 'push', 'reasoning', 'activeGoalId', 'reopenRequest', 'category', 'archivedAt', 'prompt', 'saveMode']) {
        if (saved[key] !== undefined) this.room[key] = saved[key];
      }
      if (saved.reasoningByMember && typeof saved.reasoningByMember === 'object') this.room.reasoningByMember = saved.reasoningByMember;
    }
    if (typeof this.room.category !== 'string' || !this.room.category.trim()) this.room.category = this.host.defaultCategory;
    // dir 归位，优先级：构造时明确给的目录（createRoom {dir} / rooms.json 里的 dir / 扫描到的目录）
    //   → room.json 里登记的 dir（目录名可以≠房间 id，例如用户手工改过）→ 按 category 推导。
    // 任何来源都要过安全校验，绝不让索引或 room.json 把读写引到受保护位置。
    let wantDir = null;
    if (this.explicitDir) {
      try {
        wantDir = await this.host.assertSafeRealTarget(this.explicitDir);
      } catch (error) {
        this.host.warn(`会议室 ${this.id} 的目录 ${this.explicitDir} 不安全，改回按分类推导：${error?.message ?? error}`);
      }
    }
    if (!wantDir) wantDir = join(resolve(String(this.room.category)), this.id);
    if (saved && typeof saved.dir === 'string' && saved.dir.trim()) {
      const explicit = resolve(saved.dir);
      try {
        wantDir = await this.host.assertSafeRealTarget(explicit);
      } catch (error) {
        this.host.warn(`会议室 ${this.id} 登记的目录 ${explicit} 不安全，改回按分类推导：${error?.message ?? error}`);
      }
    }
    this.setDir(wantDir);
    this.room.category = dirname(wantDir);
    // 2) 旧布局搬家
    if (legacy) await this.migrateLegacyDir(legacyDir);
    await this.ensureDirs();
    await this.migrateFileLayout();
    if (!SAVE_MODES.has(this.room.saveMode)) this.room.saveMode = 'all';
    if (!PUSH_MODES.has(this.room.push)) this.room.push = 'off';
    if (!REASONING_LEVELS.has(this.room.reasoning)) this.room.reasoning = 'inherit';
    if (this.room.archivedAt !== null && !Number.isFinite(this.room.archivedAt)) this.room.archivedAt = null;
    if (typeof this.room.prompt !== 'string' || !this.room.prompt.trim()) this.room.prompt = null;
    // v4：记录员是内置 AI —— 旧数据（room.json 的 recorder、settings.json 的默认记录员）一律忽略：
    // 不报错、不丢房间、不继承任何人。
    this.room.recorder = builtinRecorder();

    const goals = await readJsonFile(this.goalsPath, null);
    if (Array.isArray(goals)) this.goals = goals.filter((g) => g && typeof g.id === 'string');
    if (!this.room.activeGoalId || !this.goals.some((g) => g.id === this.room.activeGoalId)) {
      const firstOpen = this.goals.find((g) => g.status !== 'done');
      this.room.activeGoalId = firstOpen?.id ?? null;
    }

    try {
      const text = await readFile(this.transcriptPath, 'utf8');
      this.messages = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      this.seq = this.messages.reduce((max, m) => (Number.isFinite(m?.seq) && m.seq > max ? m.seq : max), 0);
    } catch (error) {
      if (error?.code !== 'ENOENT') this.host.warn(`读取 ${this.transcriptPath} 失败：${error.message}`);
    }

    try {
      const text = await readFile(this.membersPath, 'utf8');
      const list = JSON.parse(text);
      if (Array.isArray(list)) {
        this.members = new Map(
          list
            .filter((m) => m && typeof m.sessionId === 'string')
            .map((m) => [m.sessionId, { sessionId: m.sessionId, label: m.label || `会话 ${m.sessionId.slice(0, 8)}`, joinedAt: m.joinedAt ?? Date.now(), ...(m.role && m.role !== 'recorder' ? { role: m.role } : {}) }]),
        );
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.host.warn(`读取 ${this.membersPath} 失败（成员表按空处理）：${error.message}`);
    }

    try {
      this.legacyResolution = await readFile(this.legacyResolutionPath, 'utf8');
    } catch {
      this.legacyResolution = null;
    }

    this.loaded = true;
    // 顺手把 room.json 里的 v3 recorder 字段刷新成内置记录员（失败不影响加载；下次 saveRoom 也会覆盖）
    if (legacyRecorder) await this.saveRoom().catch(() => {});
    return this;
  }

  touch() {
    this.room.updatedAt = Date.now();
    this.host.markRoomsDirty();
  }

  async saveRoom() {
    await writeJsonFile(this.roomPath, this.room);
  }

  async saveMembers() {
    await writeJsonFile(this.membersPath, [...this.members.values()]);
  }

  async saveGoals() {
    await writeJsonFile(this.goalsPath, this.goals);
  }

  // 先落盘（真源），再进内存。seq 的分配必须放进串行链内部：
  // 否则并发 append 会在 await 之前各自读到同一个 this.seq，写出重复 seq。
  async append(message) {
    const pending = this.writeChain.then(async () => {
      const record = {
        seq: this.seq + 1,
        at: Date.now(),
        kind: message.kind ?? 'chat',
        author: message.author ?? { kind: 'system', id: 'system', label: '系统' },
        text: String(message.text ?? ''),
        ...(message.files?.length ? { files: message.files } : {}),
        ...(message.data ? { data: message.data } : {}),
      };
      const line = `${JSON.stringify(record)}\n`;
      await appendFile(this.transcriptPath, line, 'utf8');
      this.messages.push(record);
      this.seq = record.seq;
      const mirror = `- #${record.seq} ${timeText(record.at)} ${record.author?.label ?? '系统'}：${record.text}${record.files?.length ? `（文件：${record.files.join('、')}）` : ''}\n`;
      await appendFile(this.markdownPath, mirror, 'utf8').catch(() => {});
      this.touch();
      return record;
    });
    // 链本身永不 reject（失败只回给调用方），避免一条错误卡死后续写入
    this.writeChain = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  /** v4：记录员视图 —— 每个房间固定自带的内置 AI，不出现在 members 里 */
  recorderView() {
    return builtinRecorder();
  }

  membersView() {
    return [...this.members.values()].map((m) => ({
      ...m,
      // v4：记录员是内置 AI，不占成员身份（旧数据里的 role:'recorder' 也不再外露）
      role: m.role && m.role !== 'recorder' ? m.role : undefined,
      // 成员级思考程度覆盖（没有就走房间级；面板据此显示每个成员的当前档位）
      reasoning: REASONING_LEVELS.has(this.room.reasoningByMember?.[m.sessionId])
        ? this.room.reasoningByMember[m.sessionId]
        : 'inherit',
      live: this.host.isLive(m.sessionId),
      // v16⑦：与会者自己的底栏数字（轮/步、token、上下文占用），取不到就是 null
      stats: this.host.statsFor(m.sessionId),
    }));
  }

  goalView(goal) {
    return {
      id: goal.id,
      text: goal.text,
      status: goal.status,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      doneAt: goal.doneAt ?? null,
      result: goal.result ? { ...goal.result, goalId: goal.id, goalText: goal.text, excerpt: goal.result.excerpt ?? '' } : null,
    };
  }

  summary() {
    const goals = this.goals;
    return {
      id: this.id,
      title: this.room.title,
      status: this.room.status,
      createdAt: this.room.createdAt,
      updatedAt: this.room.updatedAt,
      closedAt: this.room.closedAt ?? null,
      // v3：面板按 category 分组；dir 是会议文件落地点；archived 收进「已归档」组
      category: this.room.category,
      dir: this.dir,
      archived: !!this.room.archivedAt,
      archivedAt: this.room.archivedAt ?? null,
      prompt: this.room.prompt ?? null,
      // v12：文件保存模式 + 「记录/」「附件/」两个固定子目录（面板展示用，不靠客户端拼路径）
      saveMode: this.room.saveMode ?? 'all',
      recordsDir: this.recordsDir,
      resultsDir: this.resultsDir,
      attachmentsDir: this.attachmentsDir,
      memberCount: this.members.size,
      liveCount: this.membersView().filter((m) => m.live).length,
      messageCount: this.messages.length,
      seq: this.seq,
      goalCount: goals.length,
      doneGoalCount: goals.filter((g) => g.status === 'done').length,
      resultCount: goals.filter((g) => g.result).length,
      activeGoalId: this.room.activeGoalId ?? null,
      activeGoalText: this.goals.find((g) => g.id === this.room.activeGoalId)?.text ?? null,
      recorder: this.recorderView(),
      push: this.room.push,
      reasoning: this.room.reasoning,
      reopenRequest: this.room.reopenRequest ?? null,
      // v17②：挂在会议室面板上等用户批准的与会者权限请求（空数组 = 没有待批）
      approvals: this.host.pendingApprovals(this.room.id),
    };
  }

  stateView(since) {
    const sinceSeq = Number.isFinite(Number(since)) ? Number(since) : 0;
    const messages = sinceSeq > 0 ? this.messages.filter((m) => m.seq > sinceSeq) : this.messages;
    return {
      room: this.summary(),
      root: this.dir,
      seq: this.seq,
      members: this.membersView(),
      messages,
      files: this.host.fileListCached(this),
      goals: this.goals.map((g) => this.goalView(g)),
      results: this.goals.filter((g) => g.result).map((g) => this.goalView(g).result),
      push: this.room.push,
      reasoning: this.room.reasoning,
      settings: this.host.settingsView(),
      resolution: this.legacyResolutionInfo(),
    };
  }

  legacyResolutionInfo() {
    if (!this.legacyResolution) return null;
    return {
      file: this.legacyResolutionPath,
      delivered: true,
      text: this.legacyResolution,
    };
  }

  resultsView() {
    return this.goals.filter((g) => g.result).map((g) => this.goalView(g).result);
  }

  findGoal(goalId) {
    return this.goals.find((g) => g.id === goalId) ?? null;
  }

  /**
   * v12：一个目标达成/收尾后，把 activeGoalId 指到下一个还没完成的目标（没有就置空）。
   * 不这么做的话，activeGoalId 会一直指着刚 done 的那个，新目标被冷落 —— 重启 load() 才会纠正。
   */
  pickActiveGoal(exceptId) {
    if (!this.room.activeGoalId || this.room.activeGoalId === exceptId) {
      this.room.activeGoalId = this.goals.find((g) => g.status !== 'done' && g.id !== exceptId)?.id ?? null;
    }
    return this.room.activeGoalId;
  }

  // 房内解析成员：sessionId 或显示名（唯一匹配时）
  resolveMember(value) {
    const key = String(value ?? '').trim();
    if (!key) return null;
    if (this.members.has(key)) return this.members.get(key);
    const matches = [...this.members.values()].filter((m) => m.label === key);
    return matches.length === 1 ? matches[0] : null;
  }

  async appendSystem(text, kind = 'system', data) {
    return this.append({ kind, text, author: { kind: 'system', id: 'system', label: '系统' }, data });
  }

  liveMembers() {
    return this.membersView().filter((m) => m.live);
  }

  /**
   * 投递：mode='full' 全文；'notice' 只发一行提示；'archive'/off 不投。
   * targets 缺省 = 全体成员（v5：真正要投递时先按需激活会话，激活失败才进 failed）。
   * v8：senderSessionId 本人一律排除（防自环）；noticeStyle='ping' 用「有新发言」的自动接力文案。
   */
  async deliver({ text, kind, authorLabel, targets, mode, senderSessionId, latestSeq, count, noticeStyle }) {
    const failed = [];
    const delivered = [];
    let activated = 0;
    const members = (targets?.length ? targets.map((id) => this.members.get(id)).filter(Boolean) : [...this.members.values()])
      .filter((member) => !(senderSessionId && member.sessionId === senderSessionId));
    const full = text !== undefined && mode === 'full';
    // v8：自动接力的「有新发言」文案原样送达 —— 不套 【房名】作者：body，也绝不引用发言正文
    const pingText = `【会议室 ${this.room.title}】${authorLabel ?? '有人'} 有新发言（#${latestSeq ?? this.seq}）。用 room_read 看完整记录；有新意见或要回应就 room_say，没有新内容就不必发言。`;
    const body = full
      ? text
      : `【会议室 ${this.room.title}】有 ${count ?? 1} 条新消息（最新 #${latestSeq ?? this.seq}）。用 room_read 按需查看，然后简短回应；不要凭印象回答。`;
    const noticeText = kind === 'adjourn' || authorLabel === '系统' ? body : `【会议室 ${this.room.title}】${authorLabel ?? '我'}：${full ? text : body}`;
    const finalText = noticeStyle === 'ping' && mode === 'notice'
      ? pingText
      : full && authorLabel && authorLabel !== '系统'
        ? `【会议室 ${this.room.title}】${authorLabel}：${text}`
        : noticeText;
    // v14①：只在这条唤醒消息本来就要用到 room_say 时才追加一句「文件放哪」——
    // v16⑥：说法与实现对齐 —— 顶层的相对名/绝对名（含桌面）都行，宿主在这轮结束时把 cwd 顶层新增文件
    // 收进「附件/」并移走原件；只提醒别写到工作区以外。
    const fileHint = finalText.includes('room_say') && this.attachmentsDir
      ? `\n（本次会议的文件直接以相对文件名保存即可，例如 报告.md —— 写在工作区顶层的文件，插件会在这一轮结束时收进 ${this.attachmentsDir} 并从原地移走；不要写到工作区以外的地方。）`
      : '';
    for (const member of members) {
      // v5：不再要求成员会话已经 live；真要投递时先把它激活成 live agent（激活失败才记 failed）。
      const activation = await this.host.activate(member.sessionId);
      if (!activation.ok) {
        failed.push({ sessionId: member.sessionId, error: activation.error || '会话不在线' });
        continue;
      }
      if (activation.activated) activated += 1;
      try {
        const outcome = await this.host.relayWithEffort(this, member, `${finalText}${fileHint}`, {
          senderSessionId,
          // v15②：只有自动接力的 ping 才做「同一个人最多一条未领取提示」；
          // 人类发帖 / 正文投递（full）照旧每次都是一条新消息，绝不合并。
          coalesceKey: noticeStyle === 'ping' && mode === 'notice' ? `${this.room.id}|${member.sessionId}` : null,
        });
        if (outcome.ok) delivered.push(member.sessionId);
        else failed.push({ sessionId: member.sessionId, error: '会话不在线' });
        // v16⑥ 兜底：唤醒这位与会者之前，先把它上一轮写在工作区顶层的文件收进房间「附件/」
        if (outcome.ok) {
          try {
            await this.host.staging?.sweepSession?.(this, member.sessionId);
          } catch (error) {
            this.host.warn(`收拢工作区顶层文件失败：${error?.message ?? error}`);
          }
        }
      } catch (error) {
        failed.push({ sessionId: member.sessionId, error: error?.message ?? String(error) });
        this.host.warn(`投递给 ${member.sessionId} 失败：${error?.message ?? error}`);
      }
    }
    return { delivered, failed, activated };
  }

  /** 把某个目标的《会议结果》落盘为 Markdown（草稿与发布都写） */
  async saveResultFile(goal) {
    if (!goal?.result) return null;
    const dir = this.resultsDir;
    await mkdir(dir, { recursive: true });
    const path = join(dir, goal.result.file ?? `${goal.id}.md`);
    const text = `# ${goal.result.title}\n\n> 会议室：${this.room.title}　目标：${goal.text}\n> 记录员：${this.recorderView().label}（内置 AI）　状态：${goal.result.status === 'approved' ? '已发布' : '草稿'}\n> 生成时间：${timeText(goal.result.at)}\n\n${goal.result.body}\n`;
    await writeFile(path, text, 'utf8');
    this.resultPath = path;
    return path;
  }

  /** 记录员提示词：房间级覆盖 → settings.prompt → 内置默认；支持 {{room}} / {{goal}} / {{goalId}} */
  recorderPrompt(goal, note) {
    const template = String(this.room.prompt ?? '').trim() || String(this.host.settings?.prompt ?? '').trim() || DEFAULT_RECORDER_PROMPT;
    let text = template
      .replace(/\{\{room\}\}/g, String(this.room.title ?? ''))
      .replace(/\{\{goal\}\}/g, String(goal?.text ?? ''))
      .replace(/\{\{goalId\}\}/g, String(goal?.id ?? ''));
    if (note) text += `\n补充要求：${note}`;
    return text;
  }

  /**
   * 内置记录员的唯一证据：本房间的 transcript。
   * 返回真实 seq 区间 + 送给模型的文本行（从最新往老取，受 maxReadMessages / maxReadChars 限制）。
   */
  transcriptForRecorder() {
    const rawLimit = Number(this.host?.config?.maxReadMessages);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 40;
    const rawBudget = Number(this.host?.config?.maxReadChars);
    const charBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 40000;
    const picked = [];
    let chars = 0;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      const line = `#${m.seq} ${timeText(m.at)} ${m.author?.label ?? '系统'}：${String(m.text ?? '')}`;
      if (picked.length >= limit || (picked.length > 0 && chars + line.length > charBudget)) break;
      picked.push({ seq: m.seq, line });
      chars += line.length + 1;
    }
    picked.reverse();
    return {
      lines: picked.map((p) => p.line),
      seqFrom: picked.length ? picked[0].seq : 0,
      seqTo: picked.length ? picked[picked.length - 1].seq : 0,
      count: picked.length,
    };
  }

  /** provider/model 解析：默认模型 → llm.listProviders() 第一项 + llm.listModels(provider) 第一项；都失败抛 503 */
  async resolveRecorderModel(llm) {
    const errors = [];
    try {
      const sel = this.host.ctx.get?.('agentDefaultModel')?.currentSelection?.();
      const provider = String(sel?.provider ?? '').trim();
      const model = String(sel?.model ?? '').trim();
      if (provider && model) {
        return { provider, model, reasoningEffort: sel?.reasoningEffort ? String(sel.reasoningEffort) : undefined };
      }
      errors.push('默认模型没有配置 provider/model');
    } catch (error) {
      errors.push(`读取默认模型失败：${error?.message ?? error}`);
    }
    try {
      const providers = await llm.listProviders?.();
      const provider = String((Array.isArray(providers) ? providers[0] : null)?.id ?? '').trim();
      if (!provider) throw new Error('没有任何可用的 provider');
      const models = await llm.listModels?.(provider);
      const model = String((Array.isArray(models) ? models[0] : null)?.id ?? '').trim();
      if (!model) throw new Error(`provider ${provider} 没有可用模型`);
      return { provider, model };
    } catch (error) {
      errors.push(`读取模型列表失败：${error?.message ?? error}`);
      throw fail(503, `内置记录员暂时无法调用模型（${errors.join('；')}）：可以手动填写《会议结果》`);
    }
  }

  /** 调 ctx.get('llm').stream 拿正文；任何失败都抛 503（中文说明），绝不落半成品 */
  async callRecorderModel(userText) {
    const llm = this.host.ctx.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') {
      throw fail(503, '内置记录员暂时无法调用模型（宿主没有提供 llm 服务）：可以手动填写《会议结果》');
    }
    const { provider, model, reasoningEffort } = await this.resolveRecorderModel(llm);
    // v12①：看门狗时限（默认 240s；自测用 config.recorderTimeoutMs 缩短，避免真等 4 分钟）
    const watchdogMs = Number(this.host?.config?.recorderTimeoutMs) > 0 ? Number(this.host.config.recorderTimeoutMs) : RECORDER_TIMEOUT_MS;
    const options = {
      provider,
      model,
      system: '你是本次会议的记录员。只能依据用户给出的会议记录写作；记录里没有的内容写「记录中未涉及」，绝不编造、绝不推断、绝不补充常识。',
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      temperature: 0.2,
    };
    if (reasoningEffort) options.reasoningEffort = reasoningEffort;
    let out = '';
    let failure = null;
    // v12①：宿主自己看着表 —— 一轮记录员最多 watchdogMs，超时就放弃这轮并抛中文 503。
    // 没有这层时客户端只会看到自己的 `signal timed out`，用户拿不到任何原因（见 docs/v12-方案.md）。
    const stream = llm.stream(options);
    let overTime = false;
    let timer = null;
    // v12①：卡住时要真的把上游这一轮掐掉 —— 光记一个 overTime 标志是不够的：
    // `for await` 正挂在 stream.next() 上，不 abort 就得等上游自己吐完（实测卡 5 秒才回、还当成成功）。
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) options.signal = controller.signal;
    // 看门狗只在「流卡住」时救场：每收到一个 chunk 就重新计时（总时长无上限，卡住 watchdogMs 就放弃这轮）
    const armWatchdog = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        overTime = true;
        controller?.abort();
      }, watchdogMs);
      timer.unref?.();
    };
    armWatchdog();
    // v12①：这里不用 `for await` —— 它把控制权全交给上游，上游不理会 signal 时就会一直挂着
    // （自测里的卡死流实测要 5 秒后才自己吐完，还当成成功返回 200 + 半截草稿）。
    // 改成自己拉取，并把「等下一个 chunk」和「abort」赛跑：看门狗一响就立刻返回，不再等上游。
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (overTime) break;
        const signal = controller?.signal;
        const next = iterator.next();
        const chunk = signal
          ? await Promise.race([
              next,
              new Promise((resolve) => {
                const onAbort = () => resolve(ABORTED);
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
              }),
            ])
          : await next;
        if (chunk === ABORTED) break;
        if (overTime) break; // 已经放弃这轮：不再拼正文
        if (chunk?.done) break;
        armWatchdog();
        const value = chunk?.value;
        if (!value) continue;
        if (value.type === 'text-delta') out += String(value.text ?? '');
        else if (value.type === 'finish') {
          const kind = value.reason?.kind;
          if (kind === 'error' || kind === 'aborted') failure = value.reason?.failure ?? { message: '模型调用中断' };
        }
      }
    } catch (error) {
      if (!overTime) throw fail(503, `内置记录员暂时无法调用模型（${error?.message ?? error}）：可以手动填写《会议结果》`);
    } finally {
      clearTimeout(timer);
      if (overTime) {
        // 放弃这轮：尽力让上游别继续跑。**故意不 await** —— 生成器若正卡在自己内部的等待里，
        // return() 也得排到那次 next() 之后才兑现（实测能拖满 5 秒），那样看门狗就白响了。
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* ignore */ }
      }
    }
    if (overTime) {
      throw fail(503, `内置记录员这轮超过 ${Math.round(watchdogMs / 1000)} 秒没有任何返回（已放弃）：可以手动填写《会议结果》`);
    }
    if (failure) {
      throw fail(503, `内置记录员暂时无法调用模型（${failure.message ?? failure.code ?? '模型调用失败'}）：可以手动填写《会议结果》`);
    }
    const body = out.trim();
    if (!body) throw fail(503, '内置记录员暂时无法调用模型（模型没有返回任何内容）：可以手动填写《会议结果》');
    return { body, provider, model };
  }

  /**
   * v12①：记录员这一轮的失败必须留在会议记录里 —— 之前失败原因只回荡在那个 HTTP 200/503 的响应体里，
   * 用户过一会儿再看面板什么都看不到（截图里的 `signal timed out` 就是这么来的）。
   */
  async noteRecorderFailure(reason, goal) {
    const text = String(reason ?? '').trim() || '记录员没有产出内容';
    await this.appendSystem(`记录员没能整理出《会议结果》（目标：${goal?.text ?? '（无）'}）：${text}`);
  }

  /**
   * v4：目标达成后由内置记录员自动产出《会议结果》草稿。
   * 幂等：已有草稿 / 已发布的目标不再生成；失败抛 503（result 保持 pending，不写任何文件）。
   */
  async generateResultDraft(goal, note) {
    if (!goal) return { asked: false, reason: '没有进行中的会议目标', failed: [] };
    if (goal.result?.status === 'approved') {
      return { asked: false, reason: '该目标的《会议结果》已发布，不再重新生成', failed: [] };
    }
    if (goal.result?.status === 'draft') {
      return { asked: false, reason: '该目标的《会议结果》已有草稿（不重复生成）', failed: [] };
    }
    this.recorderInFlight ??= new Map();
    if (this.recorderInFlight.has(goal.id)) {
      return { asked: false, reason: '记录员正在写这份《会议结果》，请等这一轮结束', failed: [] };
    }
    this.recorderInFlight.set(goal.id, true);
    try {
      return await this.writeResultDraft(goal, note);
    } finally {
      this.recorderInFlight.delete(goal.id);
    }
  }

  async writeResultDraft(goal, note) {
    const prompt = this.recorderPrompt(goal, note);
    const evidence = this.transcriptForRecorder();
    const roster = this.membersView().map((m) => `${m.label}（${m.live ? '在线' : '离线'}）`).join('、') || '（暂无成员）';
    const userText = [
      prompt,
      '',
      `【会议记录（唯一证据，seq ${evidence.seqFrom}-${evidence.seqTo}，共 ${evidence.count} 条）】`,
      evidence.lines.length ? evidence.lines.join('\n') : '（记录为空）',
      '',
      `【与会者名单】${roster}`,
      '',
      '请直接输出《会议结果》正文（Markdown，按与会者分节）。记录里没有的内容写「记录中未涉及」。',
    ].join('\n');
    const { body, provider, model } = await this.callRecorderModel(userText);
    const title = `${goal.text} · 会议结果`;
    goal.result = {
      title,
      file: `${goal.id}.md`,
      status: 'draft',
      by: '记录员',
      at: Date.now(),
      approvedBy: null,
      publishedAt: null,
      note: null,
      body,
      excerpt: shortText(body, 200),
      evidence: { seqFrom: evidence.seqFrom, seqTo: evidence.seqTo, count: evidence.count },
      model: { provider, model },
    };
    await this.saveGoals();
    await this.saveResultFile(goal);
    await this.appendSystem(`内置记录员提交了《${title}》草稿（目标：${goal.text}），等待审核`);
    return { asked: true, reason: null, failed: [], result: this.goalView(goal).result };
  }
}

// ---------------------------------------------------------------- 宿主

// v17②：与会者的工具权限请求挂到会议室面板之后，最多等这么久；超时就 next() 交回它自己的会话审批
const APPROVAL_WAIT_MS = 120000;

class MeetingHost {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.root = config.root;
    this.defaultRoomId = config.roomId;
    // v4：分类目录（会议文件落地点）+ 全局设置（提示词）
    this.defaultCategory = resolve(String(config.category ?? DEFAULT_CATEGORY));
    this.settingsPath = join(this.root, 'settings.json');
    // v4：全局设置不再有「记录员」；settings.json 也不再持久化该字段（settingsView 仍返回 null 兼容旧客户端）
    this.settings = { category: this.defaultCategory, prompt: DEFAULT_RECORDER_PROMPT, updatedAt: 0 };
    this.rooms = new Map(); // id -> Room
    this.sessionsCache = { at: 0, list: [], ok: false };
    this.roomsDirty = false;
    this.startTimer = null;
    // v16⑦：会话底栏数字的短缓存（sessionId -> { at, value }）
    this.statsCache = new Map();
    // v17②：与会者的权限请求（callId -> 待批项），由 ctx.on('approval/request') 挂上来
    this.approvals = new Map();
    this.approvalsReady = false;
    // v18：真正注册时用的 options（诊断端点照实回报，不写死「应该是什么」）
    this.approvalOptions = null;
    // v18：审批监听最近看到的请求（环形 20 条，只读诊断用 —— 一眼看出「监听到底有没有被叫到」）
    this.approvalsSeen = [];
    this.log = ctx.logger ?? null;
  }

  warn(text) {
    try {
      this.log?.warn?.(`[dsh-meeting-room] ${text}`);
    } catch {
      /* ignore */
    }
  }

  info(text) {
    try {
      this.log?.info?.(`[dsh-meeting-room] ${text}`);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------- v17② 与会者权限请求：在会议室里实时批准 / 拒绝

  /**
   * 注册全局审批监听。只接管「本会议室成员」的请求，其余（含所有非与会者会话）一律 next()
   * 交回原审批链 —— 所以对 DSH 原有审批行为零影响。
   */
  installApprovals() {
    if (typeof this.ctx?.on !== 'function') {
      this.warn('宿主没有 ctx.on，与会者的权限请求只能在它自己的会话里批准');
      return false;
    }
    try {
      // v18（真 bug 修复）：这里必须 { prepend: true } —— 浏览器审批桥（dsh-api-remotes 转发的
      // approval/request）注册得比本插件早，而且它会**阻塞**等用户在会话页点按钮：普通注册的
      // 监听器排在它后面，永远轮不到（真机现象：请求只弹在会话页，会议室横幅根本不出现）。
      // global 只是保险（本插件 ctx 没有 scope 标记，按 dsh-scope 的过滤本来也会放行）。
      const approvalOptions = { global: true, prepend: true };
      this.ctx.on('approval/request', (req, next) => this.handleApproval(req, next), approvalOptions);
      this.approvalOptions = approvalOptions;
      this.approvalsReady = true;
      return true;
    } catch (error) {
      this.warn(`注册 approval/request 失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** sessionId 落在哪个会议室（不在任何房间就返回 null，调用方直接 next()） */
  roomOfMember(sessionId) {
    if (!sessionId) return null;
    // v18：先按原串精确比（正常情况就是它）；再按去掉 `session-` 前缀的形式比一次，
    // 防的是「房间成员 id 与 req.agent.id 前缀写法不一致」这种格式漂移。
    const key = String(sessionId);
    const bare = key.replace(/^session-/, '');
    for (const room of this.rooms.values()) {
      for (const [id, member] of room.members) {
        if (id === key || String(id).replace(/^session-/, '') === bare) return { room, member };
      }
    }
    return null;
  }

  pendingApprovals(roomId) {
    const out = [];
    for (const rec of this.approvals.values()) {
      if (roomId && rec.roomId !== roomId) continue;
      out.push({
        callId: rec.callId,
        sessionId: rec.sessionId,
        roomId: rec.roomId,
        label: rec.label,
        toolName: rec.toolName,
        reason: rec.reason,
        at: rec.at,
      });
    }
    return out;
  }

  decideApproval(callId, allow, roomId) {
    const rec = this.approvals.get(callId);
    if (!rec) return { ok: false, status: 409, error: '这个权限请求已经失效（可能已超时，交回它自己的会话审批了）' };
    if (roomId && rec.roomId !== roomId) return { ok: false, status: 404, error: '这个权限请求不属于这个会议室' };
    rec.settle(!!allow);
    return { ok: true, callId, decision: allow ? 'allow' : 'deny', label: rec.label, toolName: rec.toolName };
  }

  /** v18：只读诊断 —— 最近被审批监听看到的请求（环形 20 条） */
  recordApproval(entry) {
    this.approvalsSeen.push({ at: new Date().toISOString(), ...entry });
    if (this.approvalsSeen.length > 20) this.approvalsSeen.splice(0, this.approvalsSeen.length - 20);
  }

  /** 拦下请求挂到面板上等用户点；超时 / 请求方取消 → next()（回到 DSH 原来的审批路径） */
  handleApproval(req, next) {
    const sessionId = req?.agent?.id ? String(req.agent.id) : '';
    const toolName = String(req?.toolName ?? '') || '未知操作';
    const hit = this.roomOfMember(sessionId);
    this.recordApproval({ sessionId, toolName, callId: req?.callId ?? null, roomId: hit?.room?.id ?? null, matched: !!hit });
    if (!hit) return next();
    const callId = String(req?.callId ?? '') || `${sessionId}:${toolName}:${Date.now()}`;
    const label = hit.member.label || `会话 ${sessionId.slice(0, 8)}`;
    return new Promise((resolve) => {
      let settled = false;
      const ask = {
        callId,
        sessionId,
        roomId: hit.room.id,
        label,
        toolName,
        reason: req?.reason ? String(req.reason) : null,
        at: Date.now(),
        timer: null,
        settle: null,
      };
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (ask.timer) clearTimeout(ask.timer);
        this.approvals.delete(callId);
        if (decision === 'allow') return resolve('allowed-once');
        if (decision === 'deny') return resolve('rejected');
        if (decision === 'cancel') return resolve('cancelled');
        return resolve(next());
      };
      ask.settle = (allow) => finish(allow ? 'allow' : 'deny');
      ask.timer = setTimeout(() => finish('timeout'), APPROVAL_WAIT_MS);
      // 别让这个定时器拖住进程退出（自测里尤其明显）
      ask.timer?.unref?.();
      this.approvals.set(callId, ask);
      try {
        req?.signal?.addEventListener?.('abort', () => finish('cancel'), { once: true });
      } catch {
        /* ignore */
      }
      this.info(`与会者「${label}」请求使用 ${toolName}，已挂到会议室面板等批准`);
    });
  }

  // ------------------------------------------------------------ 设置（需求 4）

  async loadSettings() {
    const saved = await readJsonFile(this.settingsPath, null);
    if (saved && typeof saved === 'object') {
      if (typeof saved.category === 'string' && saved.category.trim()) this.settings.category = resolve(saved.category.trim());
      // v4：settings.json 里残留的 recorder 字段一律忽略（不崩、不继承）
      if (typeof saved.prompt === 'string' && saved.prompt.trim()) this.settings.prompt = saved.prompt;
      if (Number.isFinite(saved.updatedAt)) this.settings.updatedAt = saved.updatedAt;
    }
    if (!this.settings.category) this.settings.category = this.defaultCategory;
  }

  async saveSettings() {
    this.settings.updatedAt = Date.now();
    await writeJsonFile(this.settingsPath, this.settings);
    return this.settingsView();
  }

  settingsView() {
    return {
      ...this.settings,
      // v4：记录员是每个房间自带的内置 AI —— 字段保留（旧客户端读它会崩），值恒为 null
      recorder: null,
      defaultCategory: this.defaultCategory,
      defaultPrompt: DEFAULT_RECORDER_PROMPT,
    };
  }

  /** PATCH /settings：category / prompt（v4 起 recorder 不再可配置，传了就 400） */
  async updateSettings(patch = {}) {
    if (patch.category !== undefined) {
      const category = resolve(String(patch.category).trim());
      if (!String(patch.category).trim() || !isAbsolute(String(patch.category).trim())) throw fail(400, 'category 必须是绝对路径');
      const root = resolve(this.root);
      if (sameOrInside(category, root)) throw fail(400, `分类目录不能放在插件状态根里：${category}`);
      const cfgHome = this.configHome();
      if (cfgHome && sameOrInside(category, cfgHome)) {
        throw fail(400, `分类目录不能放在 DSH 配置目录内部（${cfgHome}）：${category}`);
      }
      const realCategory = realPathDeep(category);
      if (!samePath(realCategory, category)) {
        if (sameOrInside(realCategory, root)) throw fail(400, `分类目录不能放在插件状态根里：${category}`);
        if (cfgHome && sameOrInside(realCategory, cfgHome)) {
          throw fail(400, `分类目录不能放在 DSH 配置目录内部（${cfgHome}）：${category}`);
        }
      }
      for (const guard of this.identityGuards()) {
        if (await isSameLocationAsAncestor(category, guard)) {
          throw fail(400, `分类目录不能放在受保护位置（${guard}）：${category}`);
        }
      }
      this.settings.category = category;
      await mkdir(category, { recursive: true }).catch(() => {});
    }
    if (patch.recorder !== undefined) {
      // v4：全局默认记录员作废（传 {sessionId} 或 null 都算「还在配置记录员」）
      throw fail(400, RECORDER_SETTINGS_REJECT);
    }
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt ?? '').trim();
      this.settings.prompt = prompt || DEFAULT_RECORDER_PROMPT;
    }
    return this.saveSettings();
  }

  /** 会话真实标题（找不到就退回短 id） */
  async sessionLabel(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) return '';
    try {
      const list = await this.sessions(false);
      return list.find((s) => s.sessionId === id)?.label ?? '';
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ 归档 / 删除 / 目录浏览（需求 1）

  async archiveRoom(room, archived) {
    room.room.archivedAt = archived ? Date.now() : null;
    await room.saveRoom();
    room.touch();
    await room.appendSystem(archived ? '会议室已归档（记录保留，可在「已归档」组里取消归档）' : '会议室已取消归档');
    await this.flushRooms();
    return room.summary();
  }

  /** 受保护目录：绝不允许当会议室目录，也绝不删除 */
  protectedDirs() {
    return [
      resolve(this.root),
      resolve(dirname(this.root)), // 状态根的父目录（默认 = ~/.dsh）：会议室不能落到 DSH 主目录里
      resolve(this.defaultCategory),
      resolve(this.settings?.category ?? this.defaultCategory),
      resolve(homedir()),
      resolve(process.cwd()),
    ];
  }

  /** 系统级「不能当父目录」的位置：主目录、cwd、插件状态根及其父目录（分类目录不在此列，它就是正常的父目录） */
  hardParentDirs() {
    return [resolve(homedir()), resolve(process.cwd()), resolve(this.root), resolve(dirname(this.root))];
  }

  /**
   * 状态根若位于「用户主目录下的隐藏配置目录」内部（默认 `~/.dsh/meeting-room` ⇒ 配置主目录 `~/.dsh`），
   * 返回该配置主目录；否则返回 null。这类目录内部只允许放插件自己的状态，绝不许当会议室目录。
   * 注意：不把配置主目录的「父目录内部」一刀切禁掉——状态根可能被放在普通工作目录里
   * （自测/探针夹具就是这种形状），那样会连正常用法一起挡掉。
   */
  configHome() {
    const parent = resolve(dirname(this.root));
    if (!samePath(dirname(parent), homedir())) return null;
    return basename(parent).startsWith('.') ? parent : null;
  }

  /**
   * 目标目录（会议室自己的目录）安全性：
   * - 不能是盘根、主目录、cwd、状态根，也不能是主目录/cwd 的上级（避免房间文件散到关键位置）；
   * - 不能落在插件状态根 / DSH 配置目录内部（那里只放状态文件）；
   * - 父目录不能是盘根 / 主目录 / cwd / 状态根（避免直接在用户主目录或 C:\ 下凭空建房间）。
   * 所有比较都走 fold（Windows 下忽略大小写），返回的是**原始大小写**的绝对路径。
   */
  assertSafeTarget(target) {
    const next = resolve(String(target ?? '').trim() || '.');
    const root = resolve(this.root);
    if (dirname(next) === next) throw fail(400, `会议室目录不能是盘根：${next}`);
    if (sameOrInside(next, root)) throw fail(400, `会议室目录不能放在插件状态根里：${next}`);
    const cfgHome = this.configHome();
    if (cfgHome && insidePath(next, cfgHome)) {
      throw fail(400, `会议室目录不能放在 DSH 配置目录内部（${cfgHome}）：${next}`);
    }
    for (const guard of [resolve(this.defaultCategory), resolve(this.settings?.category ?? this.defaultCategory)]) {
      if (samePath(next, guard)) throw fail(400, `会议室目录不能正好是分类目录本身（房间文件会混在一起）：${next}`);
    }
    for (const guard of [resolve(homedir()), resolve(process.cwd()), root, resolve(dirname(root))]) {
      if (samePath(next, guard)) throw fail(400, `会议室目录不能是受保护位置：${next}`);
      if (insidePath(guard, next)) throw fail(400, `会议室目录不能是受保护位置的上级：${next}`);
    }
    const parent = dirname(next);
    if (dirname(parent) === parent) throw fail(400, `不能直接在盘根下建会议室：${parent}`);
    for (const guard of this.hardParentDirs()) {
      if (samePath(parent, guard)) throw fail(400, `不能直接在受保护目录下建会议室：${parent}`);
    }
    if (insidePath(parent, root)) throw fail(400, `会议室目录不能放在插件状态根里：${parent}`);
    return next;
  }

  /**
   * 在 assertSafeTarget 之上再做一次「真实路径」校验：解析软链 / junction / 8.3 短名后
   * 得到的真实位置同样必须安全（否则 `<短名>\.dsh\meeting-room` 这类等价路径仍能绕过护栏）。
   * 返回原始大小写路径，便于照常用作用户可见的目录。
   */
  async assertSafeRealTarget(target) {
    const next = this.assertSafeTarget(target);
    const real = realPathDeep(next);
    if (!samePath(real, next)) this.assertSafeTarget(real);
    // 再按「文件身份」核一次状态根 / 配置主目录：映射盘符、subst、\\?\ 前缀、短名等别名路径
    // 字符串比较拦不住，但它们指到的是同一个目录（stat 的 dev+ino 相同）。
    for (const guard of this.identityGuards()) {
      if (await isSameLocationAsAncestor(next, guard)) {
        throw fail(400, `会议室目录不能放在受保护位置（${guard}）：${next}`);
      }
    }
    return next;
  }

  /**
   * 需要用「文件身份」比对的位置：插件状态根；只有当真机形状成立（状态根位于主目录下的隐藏配置目录内）
   * 时才把它的父目录（默认 `~/.dsh`）与配置主目录也算进来 —— 否则自测/夹具里状态根与分类目录
   * 常常是同一个临时父目录下的兄弟目录，把父目录也算进来会把正常用法一起挡掉。
   */
  identityGuards() {
    const guards = [resolve(this.root)];
    if (this.configHome()) {
      guards.push(resolve(dirname(this.root)));
      guards.push(this.configHome());
    }
    return [...new Set(guards)];
  }

  /** 是否是「会议室自己的目录」：正好一层 `<分类>/<房间 id>`，且不落在受保护位置上。只有它可以被整体搬移/删除 */
  isOwnRoomDir(room, dir = room.dir) {
    const target = resolve(String(dir ?? '').trim() || '.');
    const root = resolve(this.root);
    if (dirname(target) === target) return false;
    if (basename(target) !== room.id) return false;
    if (sameOrInside(target, root)) return false;
    const cfgHome = this.configHome();
    if (cfgHome && insidePath(target, cfgHome)) return false;
    for (const guard of this.protectedDirs()) {
      if (samePath(target, guard)) return false;
      if (insidePath(guard, target)) return false;
    }
    return true;
  }

  /**
   * 是否是「本房间自己的数据目录」（比 isOwnRoomDir 宽松）：目录名可以≠房间 id，
   * 只要该目录里的 room.json 记的就是这个房间。用于「换目录时把会议文件一起搬走」。
   * 删除（purge）仍然只认更严格的 isOwnRoomDir，避免误删用户指定的共享目录。
   */
  async isRoomDataDir(room, dir = room.dir) {
    const target = resolve(String(dir ?? '').trim() || '.');
    if (this.isOwnRoomDir(room, target)) return true;
    if (dirname(target) === target) return false;
    const root = resolve(this.root);
    if (sameOrInside(target, root)) return false;
    const cfgHome = this.configHome();
    if (cfgHome && insidePath(target, cfgHome)) return false;
    for (const guard of this.protectedDirs()) {
      if (samePath(target, guard)) return false;
      if (insidePath(guard, target)) return false;
    }
    const meta = await readJsonFile(join(target, 'room.json'), null).catch(() => null);
    // 只看元数据里的 id：房间目录名可以是任意名字（F2/F4 允许 <world>/MyMeetings、<world>/renamed-x）。
    // 「搬进自己子目录」这类会毁数据的形状由 moveTargetReason 在换目录前拦掉，不靠这里认目录名。
    return !!(meta && typeof meta === 'object' && meta.id === room.id);
  }

  /**
   * v13：换目录前的整体安全闸（只在 PATCH /rooms/:id {dir} 用）。
   * 拦三种会毁数据的形状：搬进自己的子目录（边写边读自己）、搬进分类目录本身（会把别的房间一起卷走）、
   * 目标就是原目录（无意义）。返回 null 表示可以搬，否则返回中文拒绝原因。
   */
  async moveTargetReason(room, nextDir) {
    const target = resolve(String(nextDir ?? '').trim() || '.');
    const prev = resolve(room.dir);
    if (samePath(target, prev)) return null; // 同一个目录：调用方本来就会跳过
    if (insidePath(target, prev)) {
      return `不能把会议文件目录改成它自己的子目录（${target}）：房间文件会被无限复制。请选一个同级的新文件夹。`;
    }
    if (samePath(target, resolve(this.defaultCategory)) || samePath(target, resolve(this.settings?.category ?? this.defaultCategory))) {
      return `不能把会议文件目录改成分类目录本身（${target}）：那样各房间的文件会混在一起。请在分类目录下新建一个子目录。`;
    }
    // v15①：目标文件夹已经是「别的会议室」的家（里面有自己的 room.json）——直接住进去两个房间的
    // 附件/记录会混在一起，而且重启后按目录找回房间会认错人。请用户换一个文件夹或先建子文件夹。
    const meta = await readJsonFile(join(target, 'room.json'), null).catch(() => null);
    if (meta && typeof meta === 'object' && meta.id && meta.id !== room.id) {
      return `这个文件夹已经属于另一个会议室（${meta.id}）：${target}。两个会议室的「附件/」「记录/」会混在一起，请换一个文件夹，或在系统文件夹界面里新建一个子文件夹。`;
    }
    return null;
  }

  async deleteRoom(id, purge) {
    const key = String(id ?? '').trim();
    const room = this.rooms.get(key);
    if (!room) return null;
    const dir = room.dir;
    let canPurge = purge === true && this.isOwnRoomDir(room, dir);
    if (canPurge) {
      // 删除前用真实路径复校：解析短名/软链/junction，避免等价路径绕过护栏后 rm -rf 到状态根等关键位置
      const real = realPathOf(dir);
      if (!real || !this.isOwnRoomDir(room, real)) {
        canPurge = false;
        this.warn(`拒绝删除目录 ${dir}（真实路径 ${real ?? '无法解析'} 未通过安全校验），只删除登记`);
      }
    }
    if (canPurge) {
      // 再按文件身份复校：映射盘符 / subst / \\?\ 前缀等别名路径指到状态根时，字符串比较看不出来
      for (const guard of this.identityGuards()) {
        if (await isSameLocationAsAncestor(dir, guard)) {
          canPurge = false;
          this.warn(`拒绝删除目录 ${dir}（文件身份等同于 ${guard}，疑似别名路径），只删除登记`);
          break;
        }
      }
    }
    this.rooms.delete(key);
    if (room.timer) clearTimeout(room.timer);
    await this.flushRooms();
    if (canPurge) {
      await rm(dir, { recursive: true, force: true }).catch((error) => this.warn(`删除 ${dir} 失败：${error?.message ?? error}`));
    } else if (purge === true) {
      this.warn(`拒绝删除目录 ${dir}（目录名不等于房间 id 或位于受保护位置），只删除登记`);
    }
    return {
      deleted: true,
      purged: canPurge,
      dir,
      reason: purge === true && !canPurge ? '目录名与房间 id 不一致或位于受保护位置，为安全起见只删登记、未删文件' : null,
    };
  }

  async browse(target) {
    const raw = String(target ?? '').trim();
    let dir = raw ? resolve(raw) : this.settings.category;
    let st = await stat(dir).catch(() => null);
    // 路径不存在时逐级向上回退到最近存在的祖先目录（最多 12 级），便于「打开文件夹」选择器容错
    for (let i = 0; i < 12 && !st?.isDirectory() && dirname(dir) !== dir; i += 1) {
      dir = dirname(dir);
      st = await stat(dir).catch(() => null);
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: dir, parent: dirname(dir), dirs, exists: !!st?.isDirectory() };
  }

  markRoomsDirty() {
    this.roomsDirty = true;
    if (!this.startTimer) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        this.flushRooms().catch(() => {});
      }, 250);
      this.startTimer.unref?.();
    }
  }

  async flushRooms() {
    this.roomsDirty = false;
    const list = [...this.rooms.values()]
      .map((r) => ({
        id: r.id,
        title: r.room.title,
        createdAt: r.room.createdAt,
        updatedAt: r.room.updatedAt,
        status: r.room.status,
        closedAt: r.room.closedAt ?? null,
        category: r.room.category,
        dir: r.dir,
        archivedAt: r.room.archivedAt ?? null,
      }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    try {
      await writeJsonFile(join(this.root, 'rooms.json'), list);
    } catch (error) {
      this.warn(`写 rooms.json 失败：${error.message}`);
    }
  }

  /**
   * 扫描分类目录：找回「有目录有 room.json 但 rooms.json 没登记」的会议室。
   * rooms.json 只是索引，不是唯一真相 —— 手抄目录、删掉索引、从别的机器拷过来都能自愈。
   */
  async scanCategoryDirs(categories) {
    const found = new Map(); // id -> dir
    for (const category of categories) {
      const dir = resolve(String(category ?? '').trim() || '.');
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const roomDir = join(dir, entry.name);
        const meta = await readJsonFile(join(roomDir, 'room.json'), null).catch(() => null);
        if (!meta || typeof meta !== 'object') continue;
        // 房间 id 以 room.json 为准（目录名可能是用户改过的），缺失/非法才退回目录名
        const id = typeof meta.id === 'string' && roomIdOk(meta.id) ? meta.id : roomIdOk(entry.name) ? entry.name : null;
        if (!id || found.has(id)) continue;
        found.set(id, roomDir);
      }
    }
    return found;
  }

  async start() {
    await mkdir(this.root, { recursive: true });
    await this.loadSettings();
    await mkdir(this.settings.category, { recursive: true }).catch(() => {});
    const scan = await scanRooms(this.root);
    const known = new Map();
    if (Array.isArray(scan.roomsJson)) {
      for (const item of scan.roomsJson) {
        if (item && typeof item.id === 'string' && roomIdOk(item.id)) known.set(item.id, item);
      }
    }
    const discovered = new Set();
    for (const dir of scan.dirs) {
      if (scan.transcripts.has(dir) || scan.members.has(dir)) discovered.add(dir);
    }
    for (const id of known.keys()) discovered.add(id);
    discovered.add(this.defaultRoomId);

    // v3：分类目录也扫一遍（rooms.json 丢了 / 没登记的房间照样能找回来）
    const categories = new Set([this.settings.category, this.defaultCategory]);
    for (const meta of known.values()) if (typeof meta.category === 'string' && meta.category.trim()) categories.add(meta.category);
    const onDisk = await this.scanCategoryDirs(categories);
    for (const id of onDisk.keys()) discovered.add(id);

    let adopted = 0;
    for (const id of discovered) {
      const meta = known.get(id) ?? {};
      const room = new Room(this, id, {
        title: meta.title,
        createdAt: meta.createdAt,
        category: meta.category,
        // 索引里的 dir 优先（可能已改名，目录名≠房间 id），否则用目录扫描到的位置
        dir: (typeof meta.dir === 'string' && meta.dir.trim() ? meta.dir : undefined) ?? onDisk.get(id),
      });
      await room.load();
      this.rooms.set(id, room);
      if (!known.has(id)) adopted += 1;
    }
    if (!this.rooms.has(this.defaultRoomId)) {
      const room = new Room(this, this.defaultRoomId, {});
      await room.load();
      this.rooms.set(this.defaultRoomId, room);
    }
    // v3：索引里缺 dir 的老条目也要补写（否则改名过的房间重启后仍会漂）。
    // 这里直接 await 落盘，而不是等 250ms 防抖 —— 启动后索引应立刻与内存一致（自愈/补 dir 都算）。
    const indexMissingDir = [...known.values()].some((m) => typeof m.dir !== 'string' || !m.dir.trim());
    if (adopted || indexMissingDir || discovered.size !== (scan.roomsJson?.length ?? 0)) await this.flushRooms();
    this.info(
      `已就绪：状态根=${this.root}，会议文件目录=${this.settings.category}（${this.rooms.size} 个会议室：${[...this.rooms.keys()].join('、')}${adopted ? `，从目录找回 ${adopted} 个` : ''}）`,
    );
  }

  /** 取房间；默认房间走 v1 兼容路径 */
  async room(id) {
    const key = id ? String(id) : this.defaultRoomId;
    if (!roomIdOk(key)) return null;
    const cached = this.rooms.get(key);
    if (cached) return cached;
    return null;
  }

  async createRoom({ id, title, goal, category, dir, prompt }) {
    let roomId = id ? safeName(id, 'room').replace(/[^A-Za-z0-9._-]/g, '-') : `room-${Date.now().toString(36)}`;
    if (!roomIdOk(roomId)) roomId = `room-${Date.now().toString(36)}`;
    if (this.rooms.has(roomId)) {
      roomId = `${roomId}-${Math.random().toString(36).slice(2, 6)}`;
    }
    // v3：会议文件落地点。dir = 会议室自己的目录（完整路径，优先）；否则 <category>/<id>；再否则设置里的默认分类
    const wanted = String(category ?? '').trim();
    const wantedDir = String(dir ?? '').trim();
    const roomDir = await this.assertSafeRealTarget(wantedDir ? resolve(wantedDir) : join(wanted ? resolve(wanted) : this.settings.category, roomId));
    const occupied = await readJsonFile(join(roomDir, 'room.json'), null).catch(() => null);
    if (occupied && typeof occupied.id === 'string' && occupied.id !== roomId) {
      throw fail(409, `该目录已经是会议室「${occupied.id}」的目录，换一个目录`);
    }
    const room = new Room(this, roomId, { title: title ? String(title) : roomId, dir: roomDir });
    if (String(prompt ?? '').trim()) room.room.prompt = String(prompt);
    await room.load();
    await room.saveRoom();
    if (goal && String(goal).trim()) {
      const g = {
        id: randomUUID(),
        text: String(goal).trim(),
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: null,
        history: [{ at: Date.now(), by: 'user', action: 'create' }],
      };
      room.goals.push(g);
      room.room.activeGoalId = g.id;
      await room.saveGoals();
    }
    await room.saveRoom();
    this.rooms.set(roomId, room);
    await room.appendSystem(`会议室「${room.room.title}」已创建${goal ? `，会议目标：${goal}` : ''}`);
    await this.flushRooms();
    return room;
  }

  roomsView() {
    // v3：面板按分类分组，所以同分类内按更新时间倒序，分类之间按路径排序
    return [...this.rooms.values()]
      .map((r) => r.summary())
      .sort((a, b) => (a.category === b.category ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : String(a.category).localeCompare(String(b.category))));
  }

  isLive(sessionId) {
    try {
      return this.ctx.agents.get(sessionId) !== undefined;
    } catch {
      return false;
    }
  }

  agentOf(sessionId) {
    try {
      return this.ctx.agents.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * v16⑦：与会者会话底栏数字（轮/步、token、上下文占用）。
   * 数据源是宿主的投影单元（sessionStats / tokenUsage / contextPressure），照 DSH 底栏
   * 同一份口径算，不自己折日志；拿不到 Session 或投影时返回 null（面板显示「—」）。
   * 只在标注了 sessionStats 等键时才读，且整段 try/catch —— 数字失败不影响会议。
   */
  statsFor(sessionId) {
    const now = Date.now();
    if (!this.statsCache) this.statsCache = new Map();
    const cached = this.statsCache.get(sessionId);
    if (cached && now - cached.at < STATS_TTL) return cached.value;
    const value = this.computeStats(sessionId);
    this.statsCache.set(sessionId, { at: now, value });
    return value;
  }

  computeStats(sessionId) {
    try {
      const projections = this.ctx.get?.('sessionProjections');
      const session = this.agentOf(sessionId)?.session;
      if (!projections || typeof projections.snapshot !== 'function' || !session) return null;
      const snapshot = projections.snapshot(session, ['sessionStats', 'tokenUsage', 'contextPressure']);
      const values = (snapshot && snapshot.values) || {};
      const stats = values.sessionStats || null;
      const usage = values.tokenUsage || null;
      const pressure = values.contextPressure || null;
      const cachedTokens = usage ? (usage.cacheReadTokens ?? 0) : 0;
      // 与 DSH 底栏同口径：缓存命中率分母是「未缓存输入 + 缓存读 + 缓存写」
      const promptSide = usage ? (usage.uncachedInputTokens ?? 0) + cachedTokens + (usage.cacheWriteTokens ?? 0) : 0;
      const used = pressure ? (pressure.projectedTokens ?? pressure.pressureTokens ?? null) : null;
      const contextWindow = pressure?.contextWindow ?? null;
      return {
        turns: stats?.turns ?? null,
        steps: stats?.steps ?? null,
        totalTokens: usage ? promptSide + (usage.outputTokens ?? 0) : null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage ? cachedTokens : null,
        cacheHitPercent: usage && promptSide > 0 ? Math.round((cachedTokens / promptSide) * 1000) / 10 : null,
        tokensPerSecond: stats && stats.decodeMs > 0 ? Math.round((stats.decodeTokens / (stats.decodeMs / 1000)) * 10) / 10 : null,
        contextUsed: used,
        contextWindow,
        contextPercent: used !== null && contextWindow ? Math.min(100, Math.round((used / contextWindow) * 100)) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * v5：按需激活与会者会话。
   * 官方 sessionController.resolveAgent(sessionId) 与 GUI 打开会话是同一条通路
   * （内部 agents.resume + agent preset 组合），返回 { agent } | { error }。
   * 语义：只在真要投递时激活，不主动唤醒任何会话；绝不抛错。
   */
  async activate(sessionId) {
    const live = this.agentOf(sessionId);
    if (live) return { ok: true, agent: live, activated: false };
    const controller = this.ctx.get?.('sessionController');
    if (controller && typeof controller.resolveAgent === 'function') {
      try {
        const result = await controller.resolveAgent(sessionId);
        if (result && result.agent) return { ok: true, agent: result.agent, activated: true };
        return { ok: false, error: (result && result.error && result.error.message) || '会话无法激活' };
      } catch (error) {
        return { ok: false, error: (error && error.message) || String(error) };
      }
    }
    const agents = this.ctx.agents;
    if (agents && typeof agents.resume === 'function') {
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId });
        if (handle && handle.agent) return { ok: true, agent: handle.agent, activated: true };
        return { ok: false, error: '会话无法激活' };
      } catch (error) {
        return { ok: false, error: (error && error.message) || String(error) };
      }
    }
    return { ok: false, error: '宿主没有提供会话激活能力' };
  }

  relay(sessionId, text, rpcId) {
    const agent = this.agentOf(sessionId);
    if (!agent) return Promise.resolve(false);
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: rpcId ?? randomUUID() } });
    // v15②：返回消息本身（而不是 true），投递方要拿它的 id 去 agent.inbox 里认「还没被领走的那一条」
    return Promise.resolve(agent.followup(message)).then(() => message);
  }

  /**
   * 投递并（可选）只对这一轮覆盖思考程度。返回 { ok, rpcId }。
   * level 取自房间的 reasoning / reasoningByMember；'inherit' 时不注册任何钩子。
   * v15②：options.coalesceKey 非空时启用「同一位与会者最多挂一条未领取的提示」——
   * DSH 的 followup 进 next-turn 队列且每轮只领一条，反复 room_say 会在成员界面堆成
   * 多行「排队消息」（实测峰值 6 条 / 多跑 N 个轮次）。这里只要上一条还在队列里没被领走，
   * 就原地换掉它，既不长出新行、也不丢最新提醒。
   */
  relayWithEffort(room, member, text, options = {}) {
    const level = this.effort?.effective(room, member.sessionId) ?? null;
    if (level) {
      if (this.effortHintEnabled && level === 'low' && text.length > 400) {
        text = `${truncate(text, 400)}\n（本次只要简短回应，不要展开长篇推理。）`;
      }
    }
    const agent = this.agentOf(member.sessionId);
    if (!agent) return Promise.resolve({ ok: false, rpcId: randomUUID() });
    const key = options.coalesceKey ?? null;
    const slot = key ? this.pendingPings?.get(key) : null;
    if (slot && this.replacePendingPing(key, room, agent, slot, text, level)) {
      return Promise.resolve({ ok: true, rpcId: slot.rpcId, coalesced: true });
    }
    const rpcId = randomUUID();
    // v14①：这一轮里与会者写出的顶层文件收进暂存区（轮末同步进房间「附件/」）
    this.staging?.expect(room, agent, rpcId);
    if (level) this.effort.prepare(agent, rpcId, level);
    const senderSessionId = options.senderSessionId;
    const deliver = senderSessionId
      ? this.relayFromAgentWithId(member.sessionId, senderSessionId, text, rpcId)
      : this.relay(member.sessionId, text, rpcId);
    return Promise.resolve(deliver).then((message) => {
      if (message !== false && key) this.rememberPendingPing(key, rpcId, message);
      return { ok: message !== false, rpcId };
    });
  }

  /**
   * v15②：把「还在队列里、还没被领走」的那条提示原地替换成最新文案。
   * DSH 侧公开接口：agent.inbox.locate(messageId) 命中 ⇒ replace(messageId, newMessage)。
   * 换不了（队列里已经没有了 / 宿主没提供 inbox）就返回 false，调用方退化为普通 followup，
   * 语义与 v14 完全一致 —— 也就是「宁可不合并，也绝不丢提醒」。
   */
  replacePendingPing(key, room, agent, slot, text, level) {
    const inbox = agent?.inbox;
    const forget = () => { try { this.pendingPings?.delete(key); } catch { /* noop */ } };
    let pending = null;
    try {
      if (!inbox || typeof inbox.locate !== 'function' || typeof inbox.replace !== 'function') return false;
      pending = inbox.locate(slot.messageId);
    } catch {
      return false;
    }
    if (!pending) { forget(); return false; }
    // 插入事件已经把 staging/effort 的 pending 认领掉了，替换前按同一个 rpcId 重挂一遍
    try {
      this.staging?.expect(room, agent, slot.rpcId);
      if (level) this.effort.prepare(agent, slot.rpcId, level);
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { ...(slot.source ?? {}) } });
      if (!inbox.replace(slot.messageId, message)) { forget(); return false; }
      slot.messageId = message.id;
      slot.at = Date.now();
      return true;
    } catch {
      forget();
      return false;
    }
  }

  /** v15②：记下刚投出去、还等着被领走的那条提示（每个 房间+与会者 各一条）。 */
  rememberPendingPing(key, rpcId, message) {
    if (!message || typeof message !== 'object' || !message.id) return;
    if (!this.pendingPings) this.pendingPings = new Map();
    this.pendingPings.set(key, {
      rpcId,
      messageId: message.id,
      source: { ...(message.source ?? {}) },
      at: Date.now(),
    });
  }

  relayFromAgentWithId(sessionId, senderSessionId, text, rpcId) {
    const agent = this.agentOf(sessionId);
    if (!agent) return Promise.resolve(false);
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId, rpcId },
    });
    return Promise.resolve(agent.followup(message)).then(() => message);
  }

  dispose() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    for (const room of this.rooms.values()) {
      if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
      }
    }
    if (this.roomsDirty) this.flushRooms().catch(() => {});
  }

  relayFromAgent(sessionId, senderSessionId, text) {
    const agent = this.agentOf(sessionId);
    if (!agent) return Promise.resolve(false);
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId },
    });
    return Promise.resolve(agent.followup(message)).then(() => true);
  }

  /**
   * 会话清单（宿主的 sessionQuery 服务；不可用时退化为在线会话）。
   * v3 关键修复：readTitleSnapshots 返回的是 settled 结果数组
   *   [{ status:'fulfilled', value:{ session:{id,...}, title? } } | { status:'rejected', reason }]
   * v2 误读成 s.id/s.title，导致标题恒为 undefined、面板恒显示「会话 xxxxxxxx」。
   * 0.2.0-rc.1 关键修复：value.title 不是字符串，而是
   *   SessionTitleSnapshot = { title: string; messageSeqs; source; eventSeq; updatedAt }
   * 旧代码 `typeof value.title === 'string'` 永远为假 → 真名全丢、面板回落「会话 xxxxxxxx」。
   * 这里同时兼容「字符串标题」（旧版本）与「快照对象」（0.2.0-rc.1）。
   */
  async sessions(force = false) {
    if (!force && this.sessionsCache.ok && Date.now() - this.sessionsCache.at < SESSION_TITLE_TTL) return this.sessionsCache.list;
    let list = null;
    try {
      const query = this.ctx.get?.('sessionQuery');
      if (query?.listSessions) {
        const records = await query.listSessions();
        const ids = records.map((r) => r.header?.id ?? r.header?.sessionId ?? r.id).filter(Boolean);
        const titles = new Map();
        if (query.readTitleSnapshots && ids.length) {
          try {
            const snaps = await query.readTitleSnapshots(ids);
            for (const item of Array.isArray(snaps) ? snaps : []) {
              if (!item || item.status === 'rejected') continue;
              const value = item.value ?? {};
              const sid = value.session?.id ?? value.session?.sessionId ?? value.sessionId ?? item.id;
              const rawTitle = value.title ?? value.session?.title ?? item.title;
              const title =
                typeof rawTitle === 'string'
                  ? rawTitle.trim()
                  : String(rawTitle?.title ?? '').trim();
              if (sid && title) {
                // 快照里的 updatedAt（header 没有这个字段）用来给 /sessions 排序
                const updatedAt = Number(rawTitle?.updatedAt ?? value.title?.updatedAt ?? NaN);
                titles.set(sid, { title, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null });
              }
            }
          } catch (error) {
            this.warn(`读取会话标题失败（退回 id 短名）：${error?.message ?? error}`);
          }
        }
        list = records
          .map((r) => {
            const header = r.header ?? {};
            const id = header.id ?? header.sessionId ?? r.id;
            const cwd = header.cwd ?? r.cwd ?? null;
            const snap = titles.get(id);
            const createdAt = Number(header.createdAt);
            return {
              sessionId: id,
              title: snap?.title || String(header.title ?? '').trim() || `会话 ${String(id ?? '').slice(0, 8)}`,
              cwd: typeof cwd === 'string' ? cwd : null,
              live: !!r.live,
              persisted: r.persisted !== false,
              createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
              updatedAt: snap?.updatedAt ?? null,
              subagent: isSubagentSession(header),
            };
          })
          .filter((s) => s.sessionId)
          // v3 兼容：旧客户端/旧自测读 label
          .map((s) => ({ ...s, label: s.title }));
      }
    } catch (error) {
      this.warn(`sessionQuery 不可用，退化为在线会话列表：${error.message}`);
    }
    if (!list) {
      try {
        const live = this.ctx.agents.list?.() ?? [];
        list = live.map((a) => {
          const id = String(a.id ?? '');
          const title = `会话 ${id.slice(0, 8)}`;
          return { sessionId: id, title, label: title, cwd: typeof a.cwd === 'string' ? a.cwd : null, live: true, persisted: true, createdAt: null, updatedAt: null, subagent: false };
        });
      } catch {
        list = [];
      }
      /* 退化结果（sessionQuery 不可用 / 抛错）不写进缓存：
         否则 30s 内即使服务恢复，会话名与记录员 label 也会一直回落短 id。 */
      return list;
    }
    this.sessionsCache = { at: Date.now(), list, ok: true };
    return list;
  }

  /**
   * /sessions 出口（v4）：默认只列顶层会话，投影成固定字段并按「在线优先 → updatedAt 倒序」排序。
   * includeSubagents 仅供内部调试。filtered = 被过滤掉的条数。
   */
  sessionListView(all, includeSubagents = false) {
    const total = Array.isArray(all) ? all.length : 0;
    const kept = (Array.isArray(all) ? all : []).filter((s) => includeSubagents || s.subagent !== true);
    const sorted = [...kept].sort((a, b) => {
      if (!!a.live !== !!b.live) return a.live ? -1 : 1;
      const at = Number(a.updatedAt ?? a.createdAt ?? 0) || 0;
      const bt = Number(b.updatedAt ?? b.createdAt ?? 0) || 0;
      return bt - at;
    });
    const sessions = sorted.map((s) => {
      const title = String(s.title ?? '').trim() || `会话 ${String(s.sessionId ?? '').slice(0, 8)}`;
      return {
        sessionId: s.sessionId,
        title,
        cwd: s.cwd ?? null,
        live: !!s.live,
        persisted: !!s.persisted,
        updatedAt: s.updatedAt ?? s.createdAt ?? null,
        // v3 兼容：旧客户端/旧自测读 label
        label: title,
      };
    });
    return { sessions, total, filtered: total - sessions.length };
  }

  fileListCached(room) {
    return room._files ?? [];
  }

  async refreshFiles(room) {
    const names = await readdir(room.attachmentsDir).catch(() => []);
    const out = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = join(room.attachmentsDir, name);
      const st = await stat(p).catch(() => null);
      if (!st || !st.isFile()) continue;
      out.push({ name, bytes: st.size, at: st.mtimeMs });
    }
    out.sort((a, b) => b.at - a.at);
    room._files = out;
    return out;
  }

  /** 文件副本路径；只允许房间「附件/」内的真实文件 */
  roomFilePath(room, name) {
    const clean = safeName(name);
    if (!clean) return null;
    const p = join(room.attachmentsDir, clean);
    return ensureInside(room.attachmentsDir, p) ? p : null;
  }

  async copyIntoRoom(room, sourceName) {
    const raw = String(sourceName ?? '');
    const source = isAbsolute(raw) ? raw : join(process.cwd(), raw);
    if (await exists(source)) {
      const st = await stat(source).catch(() => null);
      if (!st?.isFile()) return null;
      return this.copyFileIntoRoom(room, source);
    }
    // 只给了文件名、相对 cwd 找不到：可能它本来就是本房间「附件/」里的只读副本
    // （面板上传后正是用房间内文件名回填的）。此时沿用该副本，不重复复制。
    if (!isAbsolute(raw) && !/[/\\]/.test(raw)) {
      const clean = safeName(raw);
      if (clean && (await exists(join(room.attachmentsDir, clean)))) return clean;
      // v14①：与会者的相对文件名写出来的是暂存区里的文件（它的 cwd 是桌面，不是这里）——
      // 先把暂存区同步进「附件/」，同名就不再复制一份。
      if (clean && this.staging) {
        const staged = join(this.staging.dirFor(room.id), clean);
        if (await exists(staged)) {
          await this.staging.flush(room).catch(() => 0);
          if (await exists(join(room.attachmentsDir, clean))) return clean;
          return this.copyFileIntoRoom(room, staged);
        }
      }
    }
    return null;
  }

  async copyFileIntoRoom(room, source) {
    const base = safeName(basename(source));
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 0; i < 50; i += 1) {
      const candidate = i === 0 ? base : `${stem}-${i}${ext}`;
      const target = join(room.attachmentsDir, candidate);
      try {
        await copyFile(source, target, fsConstants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') return null;
      }
    }
    return null;
  }

  async writeUniqueFile(room, name, buffer) {
    const base = safeName(name);
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 0; i < 50; i += 1) {
      const candidate = i === 0 ? base : `${stem}-${i}${ext}`;
      const target = join(room.attachmentsDir, candidate);
      try {
        await writeFile(target, buffer, { flag: 'wx' });
        return candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('同名文件过多，无法写入');
  }
}
// ---------------------------------------------------------------- 思考程度控制

// 只影响「本次会议室投递所触发的那一轮」的第一个请求：靠 agent/pre-step 认出我们投的
// 那条消息（source.rpcId），再用 agent/request（prepend，最外层）覆盖 reasoningEffort。
// 不碰会话的持久选择，也不碰全局默认模型。
class EffortControl {
  constructor(host) {
    this.host = host;
    this.states = new WeakMap();
    this.warned = new Set();
  }

  effective(room, sessionId) {
    // 成员级优先；成员显式设为 'inherit' 时回落到房间级（不是「谁都不管」）
    const memberLevel = room?.room?.reasoningByMember?.[sessionId];
    const level = REASONING_LEVELS.has(memberLevel) && memberLevel !== 'inherit' ? memberLevel : room?.room?.reasoning;
    return level && level !== 'inherit' ? level : null;
  }

  warnOnce(key, text) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host.warn(text);
  }

  async pickEffort(provider, model, level) {
    // v6：插件 ctx 是 Cordis 受限代理，直接读 `.llm` 会抛
    // 「cannot get property "llm" without inject」（inject 不含 llm），必须用 get()（与 :757 同法）
    const llm = this.host.ctx.get?.('llm');
    if (!llm?.resolveModelInfo) return null;
    let info = null;
    try {
      info = await llm.resolveModelInfo(provider, model);
    } catch {
      return null;
    }
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts) || !efforts.length) return null;
    const ids = efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean);
    if (!ids.length) return null;
    if (ids.includes(level)) return level;
    const idx = level === 'high' ? ids.length - 1 : level === 'low' ? 0 : Math.floor((ids.length - 1) / 2);
    return ids[idx] ?? null;
  }

  ensure(agent) {
    if (!agent) return null;
    const cached = this.states.get(agent);
    if (cached) return cached;
    const agentCtx = agent.ctx ?? agent.loopCtx ?? null;
    if (typeof agentCtx?.on !== 'function') return null;
    const rec = { pending: new Map(), active: null, disposers: [] };
    // agent/pre-step 是 waterfall 钩子：必须把 next()（下游钩子/默认决策）的结果原样返回。
    // 早先这里写成普通函数、既不 async 也不调用 next()，于是 waterfall 解析出 undefined，
    // agent-loop 的 `decision.kind`（dsh-agent-loop/lib/index.js:921）立刻抛
    // 「Cannot read properties of undefined (reading 'kind')」，与会者每一轮都「本轮运行失败」。
    const onPreStep = (payload, next) => {
      const messages = payload?.messages;
      if (!Array.isArray(messages)) return typeof next === 'function' ? next() : { kind: 'enter', messages: [] };
      for (const message of messages) {
        const rpc = message?.source?.rpcId ?? message?.id;
        if (rpc && rec.pending.has(rpc)) {
          rec.active = { turn: payload?.turn, level: rec.pending.get(rpc) };
          rec.pending.delete(rpc);
          break;
        }
      }
      if (typeof next !== 'function') return { kind: 'enter', messages };
      return next();
    };
    const onRequest = async (payload, next) => {
      const resolved = await next();
      if (!rec.active) return resolved;
      const active = rec.active;
      if (payload?.turn !== undefined && active.turn !== undefined && payload.turn !== active.turn) {
        rec.active = null;
        return resolved;
      }
      rec.active = null;
      const effort = await this.pickEffort(resolved?.provider, resolved?.model, active.level);
      if (!effort) {
        this.warnOnce(`effort:${resolved?.provider}/${resolved?.model}`, `模型 ${resolved?.provider}/${resolved?.model} 未声明可用的思考等级，会议室设置「${active.level}」本次未生效`);
        return resolved;
      }
      return { ...resolved, reasoningEffort: effort };
    };
    try {
      rec.disposers.push(agentCtx.on('agent/pre-step', onPreStep));
      rec.disposers.push(agentCtx.on('agent/request', onRequest, { prepend: true }));
    } catch (error) {
      this.host.warn(`注册思考程度钩子失败：${error?.message ?? error}`);
      return null;
    }
    this.states.set(agent, rec);
    return rec;
  }

  prepare(agent, rpcId, level) {
    const rec = this.ensure(agent);
    if (!rec) return false;
    rec.pending.set(rpcId, level);
    return true;
  }
}

// ---------------------------------------------------------------- 会议文件暂存区（v14①）

/**
 * v14①：把与会者在会议轮里写出的「顶层文件」收进暂存区，轮末同步进房间「附件/」。
 * 机制：
 *   1) 投递前 expect(room, agent, rpcId) —— 记下「这条投递」；
 *   2) agent/pre-step 认出这条投递（source.rpcId）→ 本轮 active（暂存区就绪）；
 *   3) 本轮内该 agent 作用域下的 write/edit/read/read_image 被同名影子工具接管，
 *      路径是「顶层文件名」时改写到暂存区（写一律改写；读/改只在暂存区真有该文件时改写）；
 *   4) agent/turn-stopping → 暂存区同步进「附件/」（同名覆盖，暂存区里的工作副本保留）。
 * 影子工具走的是官方支持的 per-agent 作用域注册（dsh-tools `register()` 按 scopeOf(ctx) 落层，
 * 「Scoped tools shadow globals」）；拿不到 agent 作用域的 tools 服务时只降级为提示，绝不抛错。
 */
class MeetingStaging {
  constructor(host) {
    this.host = host;
    this.states = new WeakMap();
    this.warned = new Set();
    /** v16⑥：只读诊断用 —— sessionId → rec（WeakMap 不可枚举，这里另存一份引用） */
    this.registry = new Map();
    /** v16⑥：只读诊断用 —— 最近发生的「搬运」事件（环形，最多 200 条） */
    this.log = [];
    /** v16⑥ 兜底：sessionId → 上次巡检时间（不依赖 agent 钩子，只在巡检点调用） */
    this.lastSweep = new Map();
  }

  dirFor(roomId) {
    return join(STAGING_ROOT, safeName(roomId, 'room'));
  }

  warnOnce(key, text) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host.warn(text);
  }

  /** 投递前登记：这条 rpcId 触发的那一轮里，顶层文件写进暂存区 */
  expect(room, agent, rpcId) {
    if (!room?.id || !agent || !rpcId) return false;
    const rec = this.ensure(agent);
    if (!rec) return false;
    rec.room = room;
    rec.pending.add(rpcId);
    // v16⑥：真机取证发现「与会者照样把文件写在桌面上」——
    // 影子工具（agent 作用域 tools 注册表）在某些宿主上拿不到，且 agent/inbox/inserted 未必来。
    // 所以开窗不再只等 inserted：投递这一刻就开窗（并记下桌面顶层快照），轮末 turn-stopping 关窗。
    this.openWindow(rec, room, agent);
    return true;
  }

  /** v16⑥：开窗 + 顶层快照（快照异步、尽力而为：只有「快照里没有」的文件才会被搬走/删除） */
  openWindow(rec, room, agent) {
    const cwdRoot = agent?.session?.header?.cwd ?? null;
    const active = {
      room,
      dir: this.dirFor(room.id),
      cwdRoot,
      startedAt: Date.now(),
      baseline: null,
      moved: [],
    };
    rec.active = active;
    if (cwdRoot) active.baseline = readdir(cwdRoot).then((names) => new Set(names)).catch(() => null);
    return active;
  }

  ensure(agent) {
    if (!agent) return null;
    const cached = this.states.get(agent);
    if (cached) return cached;
    const agentCtx = agent.ctx ?? agent.loopCtx ?? null;
    if (typeof agentCtx?.on !== 'function') return null;
    const rec = { pending: new Set(), active: null, room: null, disposers: [] };
    /**
     * v14①：用 agent/inbox/inserted 认领「这一轮是会议投递触发的」（payload 带 message.source.rpcId）。
     *   - 消息进收件箱 = agent.followup() 那一刻（dsh-agent-loop/lib/index.js:206），必然早于本轮工具调用；
     *   - 故意**不用** agent/pre-step —— 那是 EffortControl 也在用的 waterfall 钩子，再挂一枚会让
     *     「同一 agent 只注册一枚 pre-step」这类既有护栏失真，也会多一份 next() 契约风险。
     * 别人的消息（人类正文 / 非会议投递）进箱 ⇒ 立刻解除会议作用域：绝不在非会议轮改写与会者的路径。
     */
    const onInboxInserted = (payload) => {
      const message = payload?.message;
      const rpc = message?.source?.rpcId ?? message?.id;
      if (!rpc || !rec.pending.has(rpc) || !rec.room) {
        rec.active = null;
        return;
      }
      rec.pending.delete(rpc);
      // v16⑥：开窗已在投递时做过了；这里只兜底（人类插话把窗关掉之后，这条投递又来了）
      if (!rec.active) this.openWindow(rec, rec.room, agent);
    };
    // agent/turn-stopping 是 serial 事件（payload 由 agentEvents 融合了 agent）：这一轮结束就收文件
    const onTurnStopping = async () => {
      const active = rec.active;
      rec.active = null;
      if (!active) return;
      // v16⑥：轮末兜底 —— 影子工具 / 后置钩子都没接住时（例如与会者用 pwsh 写文件），
      // 用开窗快照比对顶层新增文件，一并搬进「附件/」并清掉桌面原件。
      await this.collectLeftovers(active).catch(() => 0);
      await this.flush(active.room).catch(() => {});
    };
    /**
     * v16⑥：agent 作用域的 tools/post-execute（waterfall）—— 真机上唯一可靠、且**不需要**
     * agent 作用域 tools 注册表的收口点：这里能拿到刚跑完的调用名与解析后的参数。
     * 先放行下游决策（next()），再把本次调用写出的顶层文件搬进暂存区。
     */
    const onPostExecute = async (exec, result, next) => {
      const decision = typeof next === 'function' ? await next() : { kind: 'accept', result };
      try {
        const active = rec.active;
        if (active) await this.collectExec(active, exec);
      } catch {
        /* 搬运失败绝不影响工具本身的执行结果 */
      }
      return decision;
    };
    const register = (name, handler, options) => {
      try {
        rec.disposers.push(agentCtx.on(name, handler, options));
      } catch (error) {
        this.warnOnce(`hook:${name}`, `会议文件暂存区没能挂上 ${name} 钩子：${error?.message ?? error}`);
      }
    };
    register('agent/inbox/inserted', onInboxInserted);
    register('agent/turn-stopping', onTurnStopping);
    register('tools/post-execute', onPostExecute);
    this.installShadows(agentCtx, rec);
    this.installConduct(agentCtx, rec);
    this.registry.set(String(agent.session?.header?.id ?? agent.id ?? this.registry.size), rec);
    this.states.set(agent, rec);
    return rec;
  }

  /** 只在该 agent 作用域里注册同名工具（全局注册会污染所有会话，绝不做） */
  installShadows(agentCtx, rec) {
    let tools = null;
    try {
      tools = agentCtx.tools ?? null;
    } catch {
      tools = null;
    }
    if (!tools || typeof tools.register !== 'function' || typeof tools.get !== 'function') {
      rec.tools = 'none';
      this.warnOnce('tools', '宿主没有提供 agent 作用域的工具注册能力：会议文件只提示不接管（文件仍可能落在桌面上）');
      return;
    }
    let installed = 0;
    for (const name of STAGE_TOOLS) {
      let base = null;
      try {
        base = tools.get(name);
      } catch {
        base = null;
      }
      if (!base || typeof base.execute !== 'function') continue;
      const shadow = {
        ...base,
        execute: (args, exec) => {
          const active = rec.active;
          const patched = active ? this.rewrite(name, args, active) : args;
          return base.execute(patched, exec);
        },
      };
      try {
        const dispose = tools.register(shadow);
        if (typeof dispose === 'function') rec.disposers.push(dispose);
        installed += 1;
      } catch (error) {
        this.warnOnce(`shadow:${name}`, `会议文件暂存区没能接管 ${name} 工具：${error?.message ?? error}`);
      }
    }
    rec.tools = installed > 0 ? 'on' : 'none';
  }

  /**
   * v16③(a)：给与会者注入「开会守则」。
   * 用官方途径 —— agent 作用域 ctx 上的 `systemPrompt.section({name, order, text})`：
   * 每步重算（dsh-agent-loop 的 preStep 里 assemble），恒定文本只落一次 system/message，
   * UI 看不到、也不膨胀对话历史。拿不到 systemPrompt 就静默跳过：守则注入失败绝不能影响会议。
   */
  installConduct(agentCtx, rec) {
    let systemPrompt = null;
    try {
      systemPrompt = agentCtx.systemPrompt ?? agentCtx.get?.('systemPrompt') ?? null;
    } catch {
      systemPrompt = null;
    }
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      rec.conduct = 'none';
      return;
    }
    try {
      const dispose = systemPrompt.section({ name: 'meeting-room:conduct', order: 700, text: CONDUCT_PROMPT });
      if (typeof dispose === 'function') rec.disposers.push(dispose);
      rec.conduct = 'on';
    } catch (error) {
      rec.conduct = 'none';
      this.warnOnce('conduct', `注入会议守则失败：${error?.message ?? error}`);
    }
  }

  rewrite(name, args, active) {
    if (!args || typeof args !== 'object') return args;
    const raw = args.file_path;
    if (typeof raw !== 'string') return args;
    const top = stageTopLevelName(raw, active.cwdRoot);
    if (!top) return args;
    const staged = join(active.dir, top);
    // 写：一律进暂存区（桌面上的同名旧文件因此不会被覆盖）；读/改：暂存区真有才改写，别劫持用户自己的文件
    if (name !== 'write' && !existsSync(staged)) return args;
    return { ...args, file_path: staged };
  }

  /** v16⑥：从后置钩子的 exec 里取出这次调用写的路径（不同宿主版本字段名不同，都试一遍） */  execTargetPath(exec) {
    let args = exec?.arguments ?? exec?.args ?? null;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    if (!args || typeof args !== 'object') return null;
    const raw = args.file_path ?? args.filePath ?? args.path ?? null;
    return typeof raw === 'string' && raw ? raw : null;
  }

  /** v16⑥：开窗快照（异步读到就缓存） */
  async baselineOf(active) {
    if (!active?.baseline) return null;
    const value = await active.baseline.catch(() => null);
    active.baseline = Promise.resolve(value);
    return value;
  }

  /**
   * v16⑥：把「这一轮写进会话 cwd 顶层的文件」搬进暂存区。
   * 只在写工具（write/edit）上触发；只有「本轮新建」（开窗快照里没有）的文件才删桌面原件 ——
   * 与会者改用户既有文件时只取副本，绝不删除用户自己的东西。
   */
  async collectExec(active, exec) {
    const name = String(exec?.name ?? exec?.tool?.name ?? '');
    if (name !== 'write' && name !== 'edit') return false;
    const raw = this.execTargetPath(exec);
    if (!raw || !active?.cwdRoot) return false;
    const top = stageTopLevelName(raw, active.cwdRoot);
    if (!top) return false;
    const source = join(active.cwdRoot, top);
    const st = await stat(source).catch(() => null);
    if (!st || !st.isFile()) return false;
    return this.relocate(active, top, source, name);
  }

  /** v16⑥：轮末兜底 —— 快照里没有、且是本轮新建的顶层文件一并搬走（覆盖 pwsh 等非写工具产生的文件） */
  async collectLeftovers(active) {
    if (!active?.cwdRoot) return 0;
    const baseline = await this.baselineOf(active);
    if (!baseline) return 0;
    const names = await readdir(active.cwdRoot).catch(() => null);
    if (!names) return 0;
    let moved = 0;
    for (const name of names) {
      if (baseline.has(name)) continue;
      const source = join(active.cwdRoot, name);
      const st = await stat(source).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (st.mtimeMs < active.startedAt - 2000) continue;
      if (await this.relocate(active, name, source, 'sweep')) moved += 1;
    }
    return moved;
  }

  /** v16⑥：拷贝进暂存区（同名覆盖）；本轮新建的写产物再从原处删掉 */
  async relocate(active, top, source, kind) {
    const clean = safeName(top);
    try {
      await mkdir(active.dir, { recursive: true });
      await copyFile(source, join(active.dir, clean));
    } catch {
      return false;
    }
    const baseline = await this.baselineOf(active);
    const st = await stat(source).catch(() => null);
    const fresh = baseline ? !baseline.has(top) : Boolean(st && st.mtimeMs >= active.startedAt - 2000);
    let removed = false;
    if (kind !== 'edit' && fresh) {
      try {
        await rm(source, { force: true });
        removed = true;
      } catch {
        /* 删不掉也已经在暂存区/附件里有副本 */
      }
    }
    if (!active.moved.includes(clean)) active.moved.push(clean);
    this.note({ roomId: active.room?.id ?? null, name: clean, kind, from: source, removed });
    return true;
  }

  /**
   * v16⑥ 兜底巡检（不依赖任何 agent 钩子，真机取证后的主保险）：
   * 把某位与会者工作区顶层、**上次巡检之后**新建/改动的文件收进房间「附件/」并移走原件。
   * 首次只立基线（绝不动会议之前就存在的文件）；只在 room_say 与投递两个巡检点被调用。
   */
  async sweepSession(room, sessionId) {
    if (!room?.dir || !sessionId) return 0;
    const cwd = this.host.agentOf(sessionId)?.session?.header?.cwd ?? null;
    if (!cwd) return 0;
    const now = Date.now();
    const since = this.lastSweep.get(sessionId) ?? null;
    this.lastSweep.set(sessionId, now);
    if (since === null) return 0;
    const names = await readdir(cwd).catch(() => null);
    if (!names) return 0;
    const active = { room, dir: this.dirFor(room.id), cwdRoot: cwd, startedAt: since, baseline: Promise.resolve(null), moved: [] };
    let moved = 0;
    for (const name of names) {
      const source = join(cwd, name);
      const st = await stat(source).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (st.mtimeMs <= since) continue;
      if (await this.relocate(active, name, source, 'handin')) moved += 1;
    }
    return moved;
  }

  /** v16⑥：只读诊断流水（环形 200 条） */
  note(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /** v16⑥：只读诊断快照（GET /dsh-room/staging）—— 换不了宿主时靠它一次核验接管是否生效 */
  report() {
    const members = [];
    for (const [sessionId, rec] of this.registry) {
      const active = rec?.active ?? null;
      members.push({
        sessionId,
        tools: rec?.tools ?? 'unknown',
        conduct: rec?.conduct ?? 'unknown',
        pending: rec?.pending?.size ?? 0,
        activeRoom: active?.room?.id ?? null,
        cwd: active?.cwdRoot ?? null,
        movedInWindow: active?.moved ?? [],
      });
    }
    return {
      root: STAGING_ROOT,
      stageTools: STAGE_TOOLS,
      members,
      // v16⑥ 兜底巡检覆盖到的会话（真机上一眼看出「巡检是否在跑」）
      swept: [...this.lastSweep.keys()],
      events: this.log.slice(-50),
    };
  }

  /** 把暂存区里的文件同步进房间「附件/」（同名覆盖：暂存区永远是最新版本） */
  async flush(room) {
    if (!room?.id || !room.attachmentsDir) return 0;
    const dir = this.dirFor(room.id);
    const names = await readdir(dir).catch(() => []);
    let copied = 0;
    for (const name of names) {
      const source = join(dir, name);
      const st = await stat(source).catch(() => null);
      if (!st || !st.isFile()) continue;
      try {
        await copyFile(source, join(room.attachmentsDir, safeName(name)));
        copied += 1;
      } catch {
        /* 附件目录不可写等情况不影响会议本身 */
      }
    }
    if (copied > 0) await this.host.refreshFiles(room).catch(() => {});
    return copied;
  }

  /** 散会/发布后清场：暂存区只是工作副本，产物已在「附件/」里 */
  async clear(room) {
    if (!room?.id) return;
    await rm(this.dirFor(room.id), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- HTTP 小工具

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(text);
}

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function errorStatus(error, fallback = 400) {
  const status = Number(error?.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 600 ? status : fallback;
}

// ---------------------------------------------------------------- 路径比较工具
// Windows 文件系统大小写不敏感、8.3 短名/符号链接可指向同一位置，而字符串比较是大小写敏感的。
// 所有「安全护栏」的路径比较都必须走 fold 后的比较，否则 `~/.DSH/meeting-room` 这类等价路径会绕过护栏。
const WINDOWS_PATHS = process.platform === 'win32';

/** 归一化用于比较的路径：绝对化 + Windows 下折叠大小写（返回值只用于比较，绝不用于落盘） */
function foldPath(target) {
  const abs = resolve(String(target ?? '').trim() || '.');
  return WINDOWS_PATHS ? abs.toLowerCase() : abs;
}

/** 两个路径是否指向同一位置（忽略大小写差异） */
function samePath(a, b) {
  return foldPath(a) === foldPath(b);
}

/** child 是否严格位于 parent 内部 */
function insidePath(child, parent) {
  return foldPath(child).startsWith(foldPath(parent) + sep);
}

/** child 是否等于 parent 或位于其内部 */
function sameOrInside(child, parent) {
  const c = foldPath(child);
  const p = foldPath(parent);
  return c === p || c.startsWith(p + sep);
}

/** 真实路径（解析符号链接 / junction / 8.3 短名）；不存在或不可解析时返回 null */
function realPathOf(target) {
  try {
    return realpathSync.native(resolve(String(target ?? '').trim() || '.'));
  } catch {
    return null;
  }
}

/**
 * 把「可能还不存在的目标路径」归一成真实路径：先向上找到最近存在的祖先，
 * 用 realpath 解析它（消除短名/软链/大小写），再拼回其余段。找不到就返回 resolve 后的原值。
 */
function realPathDeep(target) {
  let probe = resolve(String(target ?? '').trim() || '.');
  if (existsSync(probe)) return realPathOf(probe) ?? probe;
  const rest = [];
  for (let i = 0; i < 64; i += 1) {
    const up = dirname(probe);
    if (up === probe) break;
    rest.unshift(basename(probe));
    probe = up;
    if (existsSync(probe)) {
      const real = realPathOf(probe);
      return real ? join(real, ...rest) : join(probe, ...rest);
    }
  }
  return resolve(String(target ?? '').trim() || '.');
}

/** 文件身份（卷 + 文件索引）：同一位置的别名路径（映射盘、subst、软链、短名、大小写）会得到同一个身份 */
async function pathIdentity(target) {
  // bigint: true ⇒ st.ino/st.dev 是 BigInt，交给模板串精确转十进制。
  // 否则大 inode（本机 ≈1e16 > 2^53）会被 Number 舍入，两个相差 1 的 ino 可能变成同一个 double，
  // 使 isSameLocationAsAncestor 误判「就是受保护位置」而拒绝合法目录（v6.1 修复）。
  const st = await stat(target, { bigint: true }).catch(() => null);
  if (!st || st.ino === 0n) return null;
  return `${st.dev}:${st.ino}`;
}

/**
 * target 自己或它的任一祖先，是否**就是** ancestor 指向的那个位置（按文件身份判断，与路径写法无关）。
 * 用来补掉「映射盘符 / subst / \\?\ 前缀 / 短名」这类字符串比较拦不住的等价路径。
 */
async function isSameLocationAsAncestor(target, ancestor) {
  const id = await pathIdentity(ancestor);
  if (!id) return false;
  let probe = resolve(String(target ?? '').trim() || '.');
  for (let i = 0; i < 64; i += 1) {
    if ((await pathIdentity(probe)) === id) return true;
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return false;
}

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// v9：右侧栏预览用 —— 这些扩展名当文本读（其余交给 MIME 判断）
const PREVIEW_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.html', '.htm', '.xml', '.yml', '.yaml', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.sh', '.ps1', '.bat', '.ini',
  '.toml', '.sql', '.c', '.h', '.cpp', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.vue',
  '.svelte', '.diff', '.patch',
]);

/** v9：这个文件能不能当文本预览（扩展名白名单，或 text/* / json / xml / javascript 这类文本 MIME） */
function isTextualFile(name, mime) {
  if (PREVIEW_TEXT_EXTS.has(extname(String(name ?? '')).toLowerCase())) return true;
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type === 'application/javascript';
}

function toolOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  };
}

// ---------------------------------------------------------------- 插件入口

export const name = 'dsh-meeting-room';
export const inject = ['tools', 'webServer', 'agents'];
export { Config };

export function apply(ctx, config) {
  // v8：一次人类发言之后允许自动接力几跳；0 = 关闭。只接受真正的非负有限 number，
  // 其余（含 null/''/false/字符串）一律回落 6（Number(null)===0 会静默关闭，故不能用 Number 强转）
  const rawHops = config?.autoContinueHops;
  const autoContinueHops = typeof rawHops === 'number' && Number.isFinite(rawHops) && rawHops >= 0
    ? Math.floor(rawHops)
    : 6;
  const cfg = {
    root: config?.root ?? DEFAULT_ROOT,
    category: config?.category ?? DEFAULT_CATEGORY,
    roomId: config?.roomId ?? 'main',
    maxReadMessages: Number(config?.maxReadMessages) > 0 ? Number(config.maxReadMessages) : 40,
    maxReadChars: Number(config?.maxReadChars) > 0 ? Number(config.maxReadChars) : 40000,
    autoCloseGoals: config?.autoCloseGoals === true,
    autoContinueHops,
    // v12①：记录员看门狗时限（>0 才认，其余回落 240s）
    recorderTimeoutMs: Number(config?.recorderTimeoutMs) > 0 ? Number(config.recorderTimeoutMs) : RECORDER_TIMEOUT_MS,
  };
  const host = new MeetingHost(ctx, cfg);
  host.effort = new EffortControl(host);
  // v14①：会议文件暂存区（与会者顶层文件 → 房间「附件/」）
  host.staging = new MeetingStaging(host);
  // v17②：把「与会者的工具权限请求」接到会议室面板上（拿不到 ctx.on 就静默退回原审批链）
  host.installApprovals();
  host.effortHintEnabled = true;
  const readyPromise = host.start().catch((error) => {
    host.warn(`初始化失败：${error?.message ?? error}`);
  });
  const ready = () => readyPromise;

  const workerOf = (exec) => exec?.agent?.id ?? exec?.agent?.session?.header?.id ?? null;
  const labelOf = (exec, room) => {
    const id = workerOf(exec);
    if (!id) return '与会者';
    return room?.members.get(id)?.label ?? `会话 ${id.slice(0, 8)}`;
  };
  const requireRoomArg = async (roomId) => {
    const room = await host.room(roomId);
    if (!room) throw fail(404, `会议室不存在：${roomId ?? '(默认)'}`);
    return room;
  };

  // 工具里抛错对模型来说只是一段堆栈：统一转成一句可读的中文（HTTP 端点仍走 fail/状态码）
  const tool = (def) => defineTool({
    ...def,
    async execute(args, exec) {
      try {
        return await def.execute(args, exec);
      } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        const hint = Number(error?.statusCode ?? error?.status ?? 0) === 404 ? '（可以先调用 room_list 看现有会议室）' : '';
        return `${message}${hint}`;
      }
    },
  });

  const effort = host.effort;

  // ------------------------------------------------------------ 路由

  const routes = [];

  async function handle(req, res) {
    if (!isTrustedRequest(req)) {
      return sendJson(res, 403, { error: '只接受本机回环地址的请求' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== API && !url.pathname.startsWith(`${API}/`)) {
      return sendJson(res, 404, { error: '未知路径' });
    }
    const method = String(req.method ?? 'GET').toUpperCase();
    const seg = url.pathname.slice(API.length).split('/').filter(Boolean);
    await ready();

    // 全局：会话清单（v4：默认只列顶层会话；?includeSubagents=1 仅供内部调试）
    if (seg.length === 1 && (seg[0] === 'sessions' || seg[0] === 'candidates')) {
      if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const includeSubagents = ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeSubagents') ?? '').trim().toLowerCase());
      const list = await host.sessions(true);
      const view = host.sessionListView(list, includeSubagents);
      const def = host.rooms.get(host.defaultRoomId);
      return sendJson(res, 200, {
        sessions: view.sessions,
        // v1/v3 兼容字段（旧客户端与旧自测在用）
        candidates: view.sessions.filter((s) => s.live),
        members: def ? def.membersView() : [],
        total: view.total,
        filtered: view.filtered,
        includeSubagents,
      });
    }

    // 全局：设置（默认记录员 AI / 提示词 / 默认分类目录）
    if (seg.length === 1 && seg[0] === 'settings') {
      if (method === 'GET') {
        const view = host.settingsView();
        return sendJson(res, 200, { settings: view, defaultCategory: view.defaultCategory, defaultPrompt: view.defaultPrompt });
      }
      if (method === 'PATCH' || method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { settings: await host.updateSettings(body) });
      }
      return sendJson(res, 405, { error: '只支持 GET/PATCH' });
    }

    // 全局：目录浏览（给「换分类目录」挑路径）
    if (seg.length === 1 && seg[0] === 'browse') {
      if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      return sendJson(res, 200, await host.browse(url.searchParams.get('path')));
    }

    // 全局：会议文件暂存区 / 接管诊断（v16⑥，只读）—— 引擎换过之后拿它核验接管有没有生效
    if (seg.length === 1 && seg[0] === 'staging') {
      if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const base = host.staging?.report?.() ?? { root: STAGING_ROOT, members: [], events: [] };
      // v18：审批监听自检 —— ready=监听是否挂上；seen=最近听到的请求（matched=false 说明是别人的会话）
      return sendJson(res, 200, {
        ...base,
        approvals: { ready: !!host.approvalsReady, options: host.approvalOptions ?? null, pending: host.pendingApprovals(), seen: host.approvalsSeen.slice(-20) },
      });
    }

    // 全局：会议室集合
    if (seg[0] === 'rooms') {
      if (seg.length === 1) {
        if (method === 'GET') return sendJson(res, 200, { rooms: host.roomsView(), defaultRoomId: host.defaultRoomId });
        if (method === 'POST') {
          const body = await readJsonBody(req);
          // v4：不再有「指派记录员」；body.recorder 一律忽略（每个房间自带内置记录员）
          const room = await host.createRoom({ id: body.id, title: body.title, goal: body.goal, category: body.category, dir: body.dir, prompt: body.prompt });
          return sendJson(res, 200, { room: room.summary() });
        }
        return sendJson(res, 405, { error: '只支持 GET/POST' });
      }
      const room = await requireRoomArg(seg[1]);
      const tail = seg.slice(2);

      // /rooms/:id
      if (tail.length === 0) {
        if (method === 'GET') {
          await host.refreshFiles(room);
          return sendJson(res, 200, room.stateView(url.searchParams.get('since')));
        }
        if (method === 'DELETE') {
          const purge = ['1', 'true', 'yes'].includes(String(url.searchParams.get('purge') ?? '').toLowerCase());
          const out = await host.deleteRoom(room.id, purge);
          return sendJson(res, 200, out ?? { deleted: false });
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const patch = {};
          if (body.title !== undefined) {
            const title = String(body.title).trim();
            if (!title) throw fail(400, 'title 不能为空');
            room.room.title = title;
            patch.title = title;
          }
          if (body.push !== undefined) {
            const push = String(body.push);
            if (!PUSH_MODES.has(push)) throw fail(400, `push 只能是 ${[...PUSH_MODES].join('/')}`);
            room.room.push = push;
            patch.push = push;
          }
          if (body.reasoning !== undefined) {
            const level = String(body.reasoning);
            if (!REASONING_LEVELS.has(level)) throw fail(400, `reasoning 只能是 ${[...REASONING_LEVELS].join('/')}`);
            const sessionId = String(body.sessionId ?? '').trim();
            if (sessionId) {
              // 成员级覆盖（面板上每个与会者旁边的「思考程度」下拉走这里）
              const byMember = { ...(room.room.reasoningByMember ?? {}) };
              if (level === 'inherit') delete byMember[sessionId];
              else byMember[sessionId] = level;
              room.room.reasoningByMember = byMember;
              patch.reasoningByMember = { [sessionId]: level };
              const member = room.members.get(sessionId);
              await room.appendSystem(`${member?.label ?? `会话 ${sessionId.slice(0, 8)}`} 的思考程度改为 ${level === 'inherit' ? '跟随房间设置' : level}`);
            } else {
              room.room.reasoning = level;
              patch.reasoning = level;
              await room.appendSystem(`本会议室的思考程度改为 ${level}`);
            }
          }
          if (body.reopenRequest === null) {
            // 面板「忽略重开请求」：只清请求，不重开会议
            if (room.room.reopenRequest) {
              const who = room.room.reopenRequest.by ?? '与会者';
              room.room.reopenRequest = null;
              patch.reopenRequest = null;
              await room.appendSystem(`已忽略 ${who} 的重开请求（会议保持${room.room.status === 'closed' ? '结束' : '进行中'}）`);
            }
          }
          if (body.goal !== undefined) {
            const text = String(body.goal).trim();
            const active = room.goals.find((g) => g.id === room.room.activeGoalId);
            if (active) {
              active.text = text;
              active.updatedAt = Date.now();
              active.history.push({ at: Date.now(), by: 'user', action: 'edit' });
              await room.saveGoals();
            } else {
              const goal = { id: randomUUID(), text, status: 'active', createdAt: Date.now(), updatedAt: Date.now(), result: null, history: [{ at: Date.now(), by: 'user', action: 'create' }] };
              room.goals.push(goal);
              room.room.activeGoalId = goal.id;
              await room.saveGoals();
            }
            await room.appendSystem(`会议目标更新为：${text}`);
            patch.goal = text;
          }
          // v3：换分类目录（会议文件跟着搬）/ 归档 / 房间级记录员提示词
          if (body.category !== undefined || body.dir !== undefined) {
            const rawCat = String(body.category ?? '').trim();
            const rawDir = String(body.dir ?? '').trim();
            if (!rawDir && !rawCat) throw fail(400, 'category 不能为空');
            if (!rawDir && !isAbsolute(rawCat)) throw fail(400, 'category 必须是绝对路径');
            const nextCategory = rawDir ? dirname(resolve(rawDir)) : resolve(rawCat);
            const candidate = rawDir ? resolve(rawDir) : join(nextCategory, room.id);
            // 「目标/父级已是文件」先判（纯 stat，不落盘）——语义上比位置护栏更具体，且同样不碰内存
            const targetStat = await stat(candidate).catch(() => null);
            if (targetStat && !targetStat.isDirectory()) throw fail(400, `目标不是目录：${candidate}`);
            const parentStat = await stat(dirname(candidate)).catch(() => null);
            if (parentStat && !parentStat.isDirectory()) throw fail(400, `父级不是目录：${dirname(candidate)}`);
            // 再判位置安全：先校验后改内存，绝不把房间的 dir 改坏
            const nextDir = await host.assertSafeRealTarget(candidate);
            const blocked = await host.moveTargetReason(room, nextDir);
            if (blocked) throw fail(400, blocked);
            if (!samePath(nextDir, room.dir)) {
              const prevDir = room.dir;
              room.room.category = resolve(String(nextCategory));
              room.setDir(nextDir);
              await mkdir(dirname(nextDir), { recursive: true }).catch(() => {});
              await room.ensureDirs();
              // 只有「本房间自己的目录」才整体搬走（目录名≠房间 id 但 room.json 记的是本房间也算），
              // 避免把共享目录/受保护目录整锅端
              if (await host.isRoomDataDir(room, prevDir)) {
                await moveDir(prevDir, nextDir).catch((error) => host.warn(`搬移 ${prevDir} → ${nextDir} 失败：${error?.message ?? error}`));
              } else {
                host.warn(`旧目录 ${prevDir} 不是本房间独占目录（目录名≠${room.id}），未搬移，只切换新目录`);
              }
              await room.appendSystem(`会议文件目录改为：${nextDir}`);
              // dir 现在是重启后定位房间的依据，改完立刻落索引，不等防抖
              await host.flushRooms();
            }
            patch.category = room.room.category;
            patch.dir = room.dir;
          }
          if (body.prompt !== undefined) {
            const prompt = String(body.prompt ?? '').trim();
            room.room.prompt = prompt || null;
            patch.prompt = room.room.prompt;
          }
          // v12③：文件保存模式（全部保存 / 只保存记录员的记录）
          if (body.saveMode !== undefined) {
            const saveMode = String(body.saveMode);
            if (!SAVE_MODES.has(saveMode)) throw fail(400, `saveMode 只能是 ${[...SAVE_MODES].join('/')}`);
            if (saveMode !== room.room.saveMode) {
              room.room.saveMode = saveMode;
              await room.appendSystem(`会议文件保存方式改为：${SAVE_MODE_LABEL[saveMode]}${saveMode === 'recorder' ? `（散会或结果发布后清掉「${ATTACHMENTS_DIRNAME}/」里的参会人文件）` : ''}`);
            }
            patch.saveMode = saveMode;
          }
          if (body.archived !== undefined) {
            const archived = body.archived === true;
            room.room.archivedAt = archived ? Date.now() : null;
            patch.archived = archived;
            await room.appendSystem(archived ? '会议室已归档（记录保留）' : '会议室已取消归档');
          }
          if (Object.keys(patch).length) {
            await room.saveRoom();
            room.touch();
          }
          return sendJson(res, 200, { room: room.summary(), patch });
        }
        return sendJson(res, 405, { error: '只支持 GET/PATCH' });
      }

      switch (tail[0]) {
        case 'state': {
          if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          await host.refreshFiles(room);
          return sendJson(res, 200, room.stateView(url.searchParams.get('since')));
        }
        case 'post': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const text = String(body.text ?? '').trim();
          if (!text) throw fail(400, 'text 不能为空');
          const label = String(body.label ?? '').trim() || '我';
          let mode = String(body.mode ?? '');
          // v6：用户消息永不外发 —— 'full' 一律降级为 'notice'（老客户端兜底）；
          // 缺省 'archive'（只写进会议室记录），不再跟随房间 push，也不再认 body.pushAll→full
          if (mode === 'full') mode = 'notice';
          if (!['archive', 'notice'].includes(mode)) mode = '';
          if (!mode) mode = 'archive';
          const files = [];
          const droppedFiles = [];
          for (const raw of Array.isArray(body.files) ? body.files : []) {
            const copied = await host.copyIntoRoom(room, String(raw));
            if (copied) files.push(copied);
            else droppedFiles.push(String(raw));
          }
          const message = await room.append({ kind: 'chat', text, author: { kind: 'user', id: 'user', label }, files: files.length ? files : undefined });
          // v8：人类发言 = 新回合，自动接力计数归零（纯内存态，不落盘）
          room.autoHop = 0;
          // v13：会议已经散会 —— 用户的话照记进记录，但不再广播给与会者（否则散会后链子还会被这条消息重新点起来）。
          if (room.room.status === 'closed') {
            return sendJson(res, 200, { message, delivered: [], failed: [], activated: 0, droppedFiles, mode, relaySkipped: true });
          }
          let delivered = [];
          let failed = [];
          let activated = 0;
          if (mode !== 'archive') {
            const targets = Array.isArray(body.to) && body.to.length
              ? body.to.map(String)
              : body.pushAll === true
                ? [...room.members.keys()]
                : [];
            const outcome = await room.deliver({ text, kind: 'chat', authorLabel: label, targets, mode, latestSeq: message.seq });
            delivered = outcome.delivered;
            failed = outcome.failed;
            activated = outcome.activated ?? 0;
          }
          return sendJson(res, 200, { message, delivered, failed, activated, droppedFiles, mode });
        }
        case 'join': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId ?? '').trim();
          if (!sessionId) throw fail(400, 'sessionId 必填');
          const requestedLabel = String(body.label ?? '').trim();
          const existing = room.members.get(sessionId);
          if (existing) {
            if (requestedLabel && requestedLabel !== existing.label) {
              existing.label = requestedLabel;
              await room.saveMembers();
            }
            return sendJson(res, 200, { already: true, member: { ...existing, live: host.isLive(sessionId) }, members: room.membersView() });
          }
          const member = { sessionId, label: requestedLabel || `会话 ${sessionId.slice(0, 8)}`, joinedAt: Date.now() };
          room.members.set(sessionId, member);
          await room.saveMembers();
          await room.appendSystem(`${member.label} 加入了会议室`);
          return sendJson(res, 200, { already: false, member: { ...member, live: host.isLive(sessionId) }, members: room.membersView() });
        }
        case 'leave': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId ?? '').trim();
          if (!sessionId) throw fail(400, 'sessionId 必填');
          const existing = room.members.get(sessionId);
          if (!existing) return sendJson(res, 200, { removed: false, members: room.membersView() });
          room.members.delete(sessionId);
          await room.saveMembers();
          await room.appendSystem(`${existing.label} 离开了会议室`);
          return sendJson(res, 200, { removed: true, members: room.membersView() });
        }
        case 'kick': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const target = room.resolveMember(body.sessionId);
          if (!target) return sendJson(res, 200, { removed: false, notified: false, members: room.membersView() });
          const reason = String(body.reason ?? '').trim();
          room.members.delete(target.sessionId);
          await room.saveMembers();
          await room.appendSystem(reason ? `${target.label} 已被移出会议室（${reason}）` : `${target.label} 已被移出会议室`);
          let notified = false;
          if (body.notify === true) {
            // v5：先把被移出者激活再通知；失败只 warn，不抛。
            const activation = await host.activate(target.sessionId);
            if (!activation.ok) {
              host.warn(`通知被移出者失败：${activation.error || '会话不在线'}`);
            } else {
              try {
                await host.relay(target.sessionId, `【会议室 ${room.room.title}】你已被移出本次会议${reason ? `（${reason}）` : ''}。`);
                notified = true;
              } catch (error) {
                host.warn(`通知被移出者失败：${error?.message ?? error}`);
              }
            }
          }
          return sendJson(res, 200, { removed: true, notified, members: room.membersView() });
        }
        case 'close':
        case 'adjourn': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          // v4：旧客户端的 body.recorder 参数已无意义，读掉即可（不报错）
          await readJsonBody(req).catch(() => ({}));
          if (room.room.status === 'closed') {
            return sendJson(res, 200, { already: true, room: room.summary(), results: room.resultsView() });
          }
          const active = room.goals.find((g) => g.id === room.room.activeGoalId && g.status !== 'done');
          room.room.status = 'closed';
          room.room.closedAt = Date.now();
          await room.saveRoom();
          await room.appendSystem(`宣布散会，请${room.recorderView().label}整理会议结果`);
          let asked = { asked: false, reason: '没有进行中的会议目标', failed: [] };
          if (active) {
            try {
              asked = await room.generateResultDraft(active);
            } catch (error) {
              // 散会本身不因为模型不可用而失败：把中文原因回报给面板 + 留在会议记录里
              asked = { asked: false, reason: error?.message ?? String(error), failed: [] };
              await room.noteRecorderFailure(asked.reason, active).catch(() => {});
            }
          }
          // v14①：散会前先把与会者的暂存区同步进「附件/」（否则最后一份产物会丢在临时目录里）
          await host.staging.flush(room).catch(() => 0);
          await host.staging.clear(room);
          // v12③：saveMode='recorder' → 散会即清掉附件（记录员产出留在「记录/」）
          const removed = await room.cleanupAttachments().catch(() => 0);
          if (removed > 0) {
            await room.appendSystem(`按「${SAVE_MODE_LABEL.recorder}」设置，已清理 ${removed} 个会议附件（记录员的记录保留在「${RECORDS_DIRNAME}/」）`);
          }
          return sendJson(res, 200, {
            room: room.summary(),
            results: room.resultsView(),
            asked: asked.asked === true,
            reason: asked.reason ?? null,
            failed: asked.failed ?? [],
            cleaned: removed,
            saveMode: room.room.saveMode,
          });
        }
        // v17②：与会者的权限请求 —— GET 列出待批，POST { callId, decision:'allow'|'deny' } 回决策
        // （callId 走 body：路由不做 URL 解码，塞进路径不安全）
        case 'approvals': {
          if (method === 'GET') return sendJson(res, 200, { approvals: host.pendingApprovals(room.id) });
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET / POST' });
          const body = await readJsonBody(req);
          const decision = String(body.decision ?? body.action ?? '').trim().toLowerCase();
          if (decision !== 'allow' && decision !== 'deny') throw fail(400, 'decision 只能是 allow / deny');
          const out = host.decideApproval(String(body.callId ?? '').trim(), decision === 'allow', room.id);
          if (!out.ok) throw fail(out.status ?? 409, out.error);
          return sendJson(res, 200, { ...out, room: room.summary() });
        }
        case 'reopen': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const by = body.by === 'member' ? 'member' : 'user';
          const reason = String(body.reason ?? '').trim();
          if (by === 'member') {
            const sessionId = String(body.sessionId ?? '').trim() || workerOf({});
            const member = sessionId ? room.members.get(sessionId) : null;
            const label = String(body.label ?? '').trim() || member?.label || (sessionId ? `会话 ${sessionId.slice(0, 8)}` : '与会者');
            room.room.reopenRequest = { sessionId: sessionId || null, by: label, at: Date.now(), reason: reason || null };
            await room.saveRoom();
            await room.appendSystem(`${label} 请求重开本次会议${reason ? `：${reason}` : ''}`);
            return sendJson(res, 200, { requested: true, room: room.summary() });
          }
          const wasClosed = room.room.status === 'closed';
          const pending = room.room.reopenRequest ?? null;
          room.room.status = 'open';
          room.room.closedAt = null;
          room.room.reopenRequest = null;
          await room.saveRoom();
          if (wasClosed) await room.appendSystem('会议已重开');
          // v17①：批准重开不能只改状态 —— 房间开了，与会者却还停在原地（用户 m05432① 的真机症状：
          // 「AI 申请重开、我批准了，它们没有马上开始讨论」）。所以批准后立刻把
          // 「已重开 + 申请理由 + 当前目标 + 怎么继续」直接投给全体：mode='full' ⇒ 正文直达，
          // 不走可合并的 ping，deliver 内部会 activate 各会话并接力，等于替用户把讨论推起来。
          if (wasClosed || pending) {
            const activeGoal = room.goals.find((goal) => goal.id === room.room.activeGoalId) ?? null;
            const why = reason || String(pending?.reason ?? '').trim();
            const reopenText = [
              '会议已重开，请立即接着讨论。',
              activeGoal ? `当前会议目标：${activeGoal.text}` : '当前没有进行中的会议目标，请按会议记录里最后的议题继续。',
              why ? `重开原因（${pending?.by || '与会者'}）：${why}` : null,
              '先用 room_read 看完整记录（尤其是散会前后的结论与待办），再围绕目标继续；有结论用 room_goal_report 反馈「达成 / 有分歧」。',
            ].filter(Boolean).join('\n');
            try {
              await room.deliver({
                text: reopenText,
                kind: 'reopen',
                authorLabel: '主持人',
                targets: [...room.members.keys()],
                mode: 'full',
                latestSeq: room.seq,
              });
            } catch (error) {
              host.warn(`重开后投递失败：${error?.message ?? error}`);
            }
          }
          return sendJson(res, 200, { requested: false, reopened: true, room: room.summary() });
        }
        case 'goals': {
          if (tail.length === 1) {
            if (method === 'GET') return sendJson(res, 200, { goals: room.goals.map((g) => room.goalView(g)), activeGoalId: room.room.activeGoalId });
            if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET/POST' });
            const body = await readJsonBody(req);
            const text = String(body.text ?? '').trim();
            if (!text) throw fail(400, 'text 不能为空');
            const goal = {
              id: randomUUID(),
              text,
              status: room.room.activeGoalId ? 'open' : 'active',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              result: null,
              history: [{ at: Date.now(), by: 'user', action: 'create' }],
            };
            room.goals.push(goal);
            if (!room.room.activeGoalId || room.goals.filter((g) => g.status !== 'done').length === 1) room.room.activeGoalId = goal.id;
            await room.saveGoals();
            await room.saveRoom();
            await room.appendSystem(`新增会议目标：${text}`);
            return sendJson(res, 200, { goal: room.goalView(goal), goals: room.goals.map((g) => room.goalView(g)) });
          }
          const goal = room.findGoal(String(tail[1]));
          if (!goal) throw fail(404, `会议目标不存在：${tail[1]}`);
          const action = tail[2];
          if (!action) {
            if (method !== 'PATCH') return sendJson(res, 405, { error: '只支持 PATCH' });
            const body = await readJsonBody(req);
            if (body.text !== undefined) {
              const text = String(body.text).trim();
              if (!text) throw fail(400, 'text 不能为空');
              goal.text = text;
              goal.updatedAt = Date.now();
              goal.history.push({ at: Date.now(), by: 'user', action: 'edit' });
              await room.appendSystem(`会议目标更新为：${text}`);
            }
            if (body.status !== undefined) {
              const status = String(body.status);
              if (!['open', 'active', 'done'].includes(status)) throw fail(400, 'status 只能是 open/active/done');
              goal.status = status;
              goal.updatedAt = Date.now();
              if (status === 'active') room.room.activeGoalId = goal.id;
              goal.history.push({ at: Date.now(), by: 'user', action: `status:${status}` });
            }
            await room.saveGoals();
            await room.saveRoom();
            return sendJson(res, 200, { goal: room.goalView(goal), goals: room.goals.map((g) => room.goalView(g)) });
          }
          if (action === 'complete') {
            if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
            const body = await readJsonBody(req).catch(() => ({}));
            if (goal.status === 'done') {
              // 幂等：已有草稿/已发布就什么都不做；上次生成失败（result 仍空）时允许再试一次
              const asked = goal.result
                ? {
                    asked: false,
                    reason: goal.result.status === 'approved' ? '该目标的《会议结果》已发布，不再重新生成' : '该目标的《会议结果》已有草稿（不重复生成）',
                    failed: [],
                  }
                : await room.generateResultDraft(goal, body?.note);
              return sendJson(res, 200, {
                already: true,
                goal: room.goalView(goal),
                recorder: room.recorderView(),
                result: goal.result ? room.goalView(goal).result : null,
                asked: asked.asked === true,
                reason: asked.reason ?? null,
                failed: asked.failed ?? [],
              });
            }
            goal.status = 'done';
            goal.doneAt = Date.now();
            goal.updatedAt = Date.now();
            goal.history.push({ at: Date.now(), by: String(body?.by ?? 'user'), action: 'complete', note: body?.note ?? null });
            await room.saveGoals();
            // v12：刚达成的目标不该继续占着 activeGoalId（否则后面的目标要等重启才轮到）
            if (room.pickActiveGoal(goal.id) !== goal.id) await room.saveRoom();
            await room.appendSystem(`会议目标已达成：${goal.text}`);
            // v4：内置记录员自动产出草稿（失败抛 503，result 保持 pending、不写半成品）
            // v12①：失败原因写进会议记录 —— 光靠面板弹一次红框，用户事后什么都看不到
            let asked;
            try {
              asked = await room.generateResultDraft(goal, body?.note);
            } catch (error) {
              await room.noteRecorderFailure(error?.message ?? error, goal).catch(() => {});
              throw error;
            }
            return sendJson(res, 200, {
              goal: room.goalView(goal),
              recorder: room.recorderView(),
              result: goal.result ? room.goalView(goal).result : null,
              asked: asked.asked === true,
              reason: asked.reason ?? null,
              failed: asked.failed ?? [],
            });
          }
          if (action === 'reopen') {
            if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
            const body = await readJsonBody(req).catch(() => ({}));
            const reason = String(body?.reason ?? '').trim();
            goal.status = 'active';
            goal.updatedAt = Date.now();
            goal.history.push({ at: Date.now(), by: String(body?.by ?? 'user'), action: 'reopen', note: reason || null });
            if (goal.result) {
              goal.result.status = 'superseded';
              goal.result.note = reason || goal.result.note || null;
            }
            room.room.activeGoalId = goal.id;
            await room.saveGoals();
            await room.saveRoom();
            await room.appendSystem(`发起再议：${goal.text}${reason ? `（原因：${reason}）` : ''}`);
            return sendJson(res, 200, { goal: room.goalView(goal) });
          }
          if (action === 'result') {
            if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
            const text = goal.result?.body ?? '';
            return sendText(res, 200, text, CONTENT_TYPES['.md'] ?? 'text/markdown; charset=utf-8');
          }
          return sendJson(res, 404, { error: `未知目标操作：${action}` });
        }
        case 'results': {
          if (tail.length === 1) {
            if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
            return sendJson(res, 200, { results: room.resultsView(), recorder: room.recorderView() });
          }
          const goal = room.findGoal(String(tail[1]));
          if (!goal) throw fail(404, `会议目标不存在：${tail[1]}`);
          const action = tail[2];
          if (action === 'draft') {
            if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
            const body = await readJsonBody(req);
            const title = String(body.title ?? '').trim();
            const text = String(body.body ?? '').trim();
            if (!title) throw fail(400, 'title 不能为空');
            if (!text) throw fail(400, 'body 不能为空');
            // v4：内置记录员不出现在 members 里，无法按 sessionId 辨别「记录员本人」。
            // 这条 HTTP 通路保留给「人类 / 面板手动填写」（仍必须用户 approve 才发布），body.by 原样保留；
            // 但已发布的结果不允许被草稿覆盖（防止改写已发布内容）。
            if (goal.result && goal.result.status === 'approved') {
              throw fail(409, '这个《会议结果》已经发布过了，不能再用草稿覆盖');
            }
            const by = String(body.by ?? '').trim();
            goal.result = {
              title,
              file: `${goal.id}.md`,
              status: 'draft',
              at: Date.now(),
              approvedBy: null,
              publishedAt: null,
              note: null,
              ...(by ? { by } : {}),
              body: text,
              excerpt: shortText(text, 200),
            };
            await room.saveGoals();
            await room.saveResultFile(goal);
            await room.appendSystem(
              by === '记录员'
                ? `记录员提交了《${title}》草稿（目标：${goal.text}），等待审核`
                : `《${title}》草稿已提交（${by || '用户'}），等待审核（目标：${goal.text}）`,
            );
            return sendJson(res, 200, { result: room.goalView(goal).result });
          }
          if (action === 'approve' || action === 'reject') {
            if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
            const result = goal.result;
            if (!result) throw fail(409, '这个目标还没有《会议结果》草稿');
            const body = await readJsonBody(req).catch(() => ({}));
            const by = String(body?.by ?? 'user').trim() || 'user';
            const note = String(body?.note ?? '').trim();
            if (action === 'reject') {
              if (!note) throw fail(400, '驳回必须给出理由（note）');
              result.status = 'draft';
              result.note = `${note}（${by} ${timeText(Date.now())}）`;
              result.body = `${result.body}\n\n---\n**审核意见（${timeText(Date.now())} ${by}）：** ${note}\n`;
              await room.saveGoals();
              await room.appendSystem(`《${result.title}》被驳回：${note}`);
              // v16③(b)：驳回不能只改个状态 —— 与会者会一直停在原地。把「目标 + 驳回原因」立刻投给
              // 每位与会者（mode='full' ⇒ 正文直达，不走可合并的 ping），他们随即围绕目标重新讨论。
              const rejectText = [
                `《${result.title}》草稿被驳回，请立即围绕会议目标重新讨论。`,
                `会议目标：${goal.text}`,
                `驳回原因（${by}）：${note}`,
                '请逐条回应驳回原因：哪几条接受、哪几条不接受、准备怎么改；不要只是重复之前的结论。',
                '有结论后用 room_goal_report 反馈「达成 / 有分歧」。',
              ].join('\n');
              let rejected = { delivered: [], failed: [] };
              try {
                rejected = await room.deliver({
                  text: rejectText,
                  kind: 'reject',
                  authorLabel: '审核意见',
                  targets: [...room.members.keys()],
                  mode: 'full',
                  latestSeq: room.seq,
                });
              } catch (error) {
                host.warn(`驳回后投递失败：${error?.message ?? error}`);
              }
              return sendJson(res, 200, {
                result: room.goalView(goal).result,
                delivered: rejected.delivered ?? [],
                failed: rejected.failed ?? [],
              });
            }
            if (result.status === 'approved') {
              return sendJson(res, 409, { error: '这个《会议结果》已经发布过了', result: room.goalView(goal).result });
            }
            result.status = 'approved';
            result.approvedBy = by;
            result.publishedAt = Date.now();
            if (note) result.note = note;
            await room.saveGoals();
            await room.saveResultFile(goal);
            await room.appendSystem(`《${result.title}》审核通过并发布（目标：${goal.text}）`);
            const header = `【会议室 ${room.room.title}】会议目标「${goal.text}」的《会议结果》已发布：${result.title}`;
            // 记录员按 `## <成员显示名>` 分节；发布时把属于各人的那一节分别发给各人，
            // 抽不到专属小节就回落到整篇正文，保证没有人漏收。
            const delivered = [];
            const failed = [];
            for (const [sessionId, member] of room.members) {
              const label = String(member?.label ?? '');
              const part = sectionFor(result.body, label)
                ?? sectionFor(result.body, label.split(/[\s·-]+/)[0])
                ?? result.body;
              const outcome = await room.deliver({
                text: `${header}\n\n${part}`,
                kind: 'result',
                authorLabel: '会议结果',
                targets: [sessionId],
                mode: 'full',
                latestSeq: room.seq,
              });
              delivered.push(...outcome.delivered);
              failed.push(...outcome.failed);
            }
            // v12③：saveMode='recorder' → 结果发布即清掉附件（记录员产出刚发布，留在「记录/」）
            const cleaned = await room.cleanupAttachments().catch(() => 0);
            if (cleaned > 0) {
              await room.appendSystem(`按「${SAVE_MODE_LABEL.recorder}」设置，已清理 ${cleaned} 个会议附件（记录员的记录保留在「${RECORDS_DIRNAME}/」）`);
            }
            return sendJson(res, 200, { result: room.goalView(goal).result, delivered, failed, cleaned });
          }
          return sendJson(res, 404, { error: `未知结果操作：${action ?? '(空)'}` });
        }
        case 'result': {
          if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          const goalId = url.searchParams.get('goalId');
          const goal = goalId ? room.findGoal(goalId) : room.goals.find((g) => g.result);
          if (!goal?.result?.body) throw fail(404, '还没有《会议结果》');
          return sendText(res, 200, goal.result.body, CONTENT_TYPES['.md'] ?? 'text/markdown; charset=utf-8');
        }
        case 'recorder': {
          if (method === 'GET') {
            return sendJson(res, 200, { recorder: room.recorderView(), candidates: room.liveMembers() });
          }
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET/POST' });
          // v4：记录员是每个会议室自带的内置 AI，不接受指派。
          // 路由保留（而不是 404）是为了让旧客户端拿到明确的中文说明。
          await readJsonBody(req).catch(() => ({}));
          throw fail(400, RECORDER_ASSIGN_REJECT);
        }
        case 'reasoning': {
          if (method === 'GET') {
            const sessionId = url.searchParams.get('sessionId');
            return sendJson(res, 200, {
              reasoning: room.room.reasoning,
              memberLevel: sessionId ? room.room.reasoningByMember?.[sessionId] ?? 'inherit' : null,
              effective: sessionId ? effort.effective(room, sessionId) : null,
              options: [...REASONING_LEVELS],
            });
          }
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 GET/POST' });
          const body = await readJsonBody(req);
          const level = String(body.level ?? '');
          if (!REASONING_LEVELS.has(level)) throw fail(400, `level 只能是 ${[...REASONING_LEVELS].join('/')}`);
          const sessionId = String(body.sessionId ?? '').trim();
          if (sessionId) {
            const byMember = { ...(room.room.reasoningByMember ?? {}) };
            if (level === 'inherit') delete byMember[sessionId];
            else byMember[sessionId] = level;
            room.room.reasoningByMember = byMember;
            const member = room.members.get(sessionId);
            await room.appendSystem(`${member?.label ?? `会话 ${sessionId.slice(0, 8)}`} 的思考程度改为 ${level === 'inherit' ? '跟随房间设置' : level}`);
          } else {
            room.room.reasoning = level;
            await room.appendSystem(`与会者思考程度：${level === 'inherit' ? '跟随各自设置' : level}`);
          }
          await room.saveRoom();
          return sendJson(res, 200, { reasoning: room.room.reasoning, reasoningByMember: room.room.reasoningByMember, effectiveFor: sessionId || null, effective: sessionId ? effort.effective(room, sessionId) : null });
        }
        case 'upload': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req, MAX_UPLOAD_BYTES * 2);
          const rawName = String(body.name ?? '');
          // v1 口径：空名 / . / .. 直接 400，不做静默清洗
          if (rawName.trim() === '' || rawName.trim() === '.' || rawName.trim() === '..') {
            throw fail(400, '文件名不能为空（也不允许 . 或 ..）');
          }
          const name = safeName(rawName);
          const base64 = String(body.base64 ?? '');
          if (!base64) throw fail(400, 'base64 不能为空');
          const buffer = Buffer.from(base64, 'base64');
          if (buffer.length > MAX_UPLOAD_BYTES) throw fail(413, `文件超过 ${MAX_UPLOAD_BYTES} 字节上限`);
          const saved = await host.writeUniqueFile(room, name, buffer);
          await host.refreshFiles(room);
          await room.appendSystem(`上传了文件：${saved}`);
          return sendJson(res, 200, { name: saved, bytes: buffer.length, renamed: saved !== name || name !== rawName });
        }
        case 'raw': {
          if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          const name = url.searchParams.get('name');
          if (!name) throw fail(400, 'name 必填');
          const path = host.roomFilePath(room, name);
          if (!path) throw fail(400, '非法文件名');
          const text = await readFile(path).catch((error) => {
            if (error?.code === 'ENOENT') throw fail(404, `文件不存在：${safeName(name)}`);
            throw error;
          });
          const base = safeName(name);
          const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
          return sendText(res, 200, text, CONTENT_TYPES[extname(base).toLowerCase()] ?? 'application/octet-stream', {
            'content-disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
          });
        }
        // v9：右侧栏用的只读正文预览（文本回 text，二进制只回元信息；全程不写盘）
        case 'file': {
          if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          const name = url.searchParams.get('name');
          if (!name) throw fail(400, 'name 必填');
          const path = host.roomFilePath(room, name);
          if (!path) throw fail(400, '非法文件名');
          const base = safeName(name);
          const info = await stat(path).catch(() => null);
          if (!info || !info.isFile()) throw fail(404, `文件不存在：${base}`);
          const mime = CONTENT_TYPES[extname(base).toLowerCase()] ?? 'application/octet-stream';
          if (!isTextualFile(base, mime)) {
            return sendJson(res, 200, { name: base, bytes: info.size, mime, kind: 'binary' });
          }
          const truncated = info.size > PREVIEW_MAX_BYTES;
          let buffer;
          if (truncated) {
            const handle = await open(path, 'r');
            try {
              const chunk = Buffer.alloc(PREVIEW_MAX_BYTES);
              const { bytesRead } = await handle.read(chunk, 0, PREVIEW_MAX_BYTES, 0);
              buffer = chunk.subarray(0, bytesRead);
            } finally {
              await handle.close();
            }
          } else {
            buffer = await readFile(path);
          }
          // 截断可能正好切在多字节字符中间：只丢掉尾部替换符，不补、不编造内容
          let text = buffer.toString('utf8');
          if (truncated) text = text.replace(/\uFFFD+$/, '');
          return sendJson(res, 200, { name: base, bytes: info.size, mime, kind: 'text', truncated, text });
        }
        case 'files': {
          if (method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          return sendJson(res, 200, { files: await host.refreshFiles(room) });
        }
        case 'finalize': {
          if (method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
          const body = await readJsonBody(req);
          const title = String(body.title ?? '').trim();
          const text = String(body.body ?? '').trim();
          if (!title || !text) throw fail(400, 'title 与 body 必填');
          const statePath = join(room.dir, 'resolution-state.json');
          const state = await readJsonFile(statePath, null);
          if (state?.delivered === true && body.force !== true) {
            throw fail(409, `本次会议（${room.id}）的决议已经交付过：${join(room.dir, '决议.md')}。要覆盖重发请传 force: true`);
          }
          const content = `# ${title}\n\n> 会议室：${room.room.title}　交付时间：${new Date().toLocaleString('zh-CN')}\n\n${text}\n`;
          await writeFile(join(room.dir, '决议.md'), content, 'utf8');
          await writeJsonFile(statePath, { roomId: room.id, delivered: true, deliveredTo: [], at: Date.now(), resolution: '决议.md', skipped: false });
          room.legacyResolution = content;
          const message = await room.append({ kind: 'resolution', text: `散会：${title}`, author: { kind: 'system', id: 'system', label: '系统' } });
          return sendJson(res, 200, { file: join(room.dir, '决议.md'), message, delivered: [], failed: [] });
        }
        default:
          return sendJson(res, 404, { error: `未知端点：${tail[0]}` });
      }
    }

    // v1 兼容：/dsh-room/<legacy> 映射到默认房间（同一 req 上换 url 重新分发，
    // 不能伪造 req/req 副本：readJsonBody 依赖 IncomingMessage 的原型方法）
    if (seg.length >= 1) {
      const known = new Set(['state', 'post', 'join', 'leave', 'kick', 'close', 'adjourn', 'reopen', 'goals', 'results', 'result', 'recorder', 'reasoning', 'upload', 'raw', 'file', 'files', 'finalize']);
      if (known.has(seg[0])) {
        const original = req.url;
        req.url = `${API}/rooms/${encodeURIComponent(host.defaultRoomId)}/${seg.map((s) => encodeURIComponent(s)).join('/')}${url.search}`;
        try {
          return await handle(req, res);
        } finally {
          req.url = original;
        }
      }
    }
    return sendJson(res, 404, { error: '未知路径' });
  }

  routes.push({
    kind: 'prefix',
    path: API,
    handler: (req, res) => {
      Promise.resolve(handle(req, res)).catch((error) => {
        if (res.writableEnded) return;
        const status = errorStatus(error);
        sendJson(res, status, { error: error?.message ?? String(error) });
      });
    },
  });

  // ------------------------------------------------------------ Agent 工具

  const toolDefs = [];

  const text = (value) => String(value ?? '');

  toolDefs.push(tool({
    name: 'room_list',
    description: '列出所有会议室（含我在哪些会议室里）。开会话/找房间先看这个。',
    parameters: {},
    output: toolOutput(),
    async execute() {
      await ready();
      const list = host.roomsView();
      if (!list.length) return '当前没有任何会议室。';
      const lines = list.map((r) => {
        return `- ${r.id}｜${r.title}｜${r.status === 'closed' ? '已结束' : '进行中'}｜${r.memberCount} 人（在线 ${r.liveCount}）｜目标 ${r.doneGoalCount}/${r.goalCount}｜消息 ${r.messageCount}｜投递 ${r.push}｜思考 ${r.reasoning}｜目录 ${r.dir}${r.archived ? '｜已归档' : ''}${r.recorder ? '｜记录员（内置 AI）' : ''}${r.reopenRequest ? '｜有人请求重开' : ''}`;
      });
      return `共 ${list.length} 个会议室：\n${lines.join('\n')}`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_archive',
    description: '归档 / 取消归档一个会议室（只是收进面板底部的「已归档」组，记录与文件都保留）。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      archived: { type: 'boolean', description: 'true=归档（缺省），false=取消归档' },
    },
    output: toolOutput(),
    async execute(args) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const archived = !(args.archived === false || args.archived === 'false' || args.archived === 0 || args.archived === '0');
      const summary = await host.archiveRoom(room, archived);
      return `会议室「${summary.title}」${archived ? '已归档' : '已取消归档'}。目录：${summary.dir}`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_join',
    description: '加入一个会议室（默认房间可省略 roomId）。重复加入只会更新显示名。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      label: { type: 'string', description: '你在会议室里的显示名（建议用简短人名/身份）' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const sessionId = workerOf(exec);
      if (!sessionId) return '无法确定你的会话 id，加入失败。';
      const label = String(args.label ?? '').trim();
      const existing = room.members.get(sessionId);
      if (existing) {
        if (label && label !== existing.label) {
          existing.label = label;
          await room.saveMembers();
        }
        return `你已经在会议室「${room.room.title}」里了（显示名：${existing.label}）。`;
      }
      const member = { sessionId, label: label || `会话 ${sessionId.slice(0, 8)}`, joinedAt: Date.now() };
      room.members.set(sessionId, member);
      await room.saveMembers();
      await room.appendSystem(`${member.label} 加入了会议室`);
      return `已加入会议室「${room.room.title}」，显示名：${member.label}。当前目标：${room.goals.find((g) => g.id === room.room.activeGoalId)?.text ?? '（未设置）'}`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_leave',
    description: '退出一个会议室。',
    parameters: { roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' } },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const sessionId = workerOf(exec);
      if (!sessionId) return '无法确定你的会话 id，退出失败。';
      const existing = room.members.get(sessionId);
      if (!existing) return `你不在会议室「${room.room.title}」里，无需退出。`;
      room.members.delete(sessionId);
      await room.saveMembers();
      await room.appendSystem(`${existing.label} 离开了会议室`);
      return `已退出会议室「${room.room.title}」。`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_say',
    description: '在会议室里发言。缺省（不传 mode/to）＝写入会议记录 **并且自动接力**：提醒其他与会者来看、来回应（房间会自动往下走，不用等人催）。只想记录、不打扰任何人就显式传 mode=\'archive\'；要点名回应就传 to。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      text: { type: 'string', required: true, description: '发言内容' },
      to: { type: 'array', description: '要通知的成员 sessionId 列表（点名）', items: { type: 'string' } },
      files: { type: 'array', description: '要交接的文件（绝对路径或房间内已有文件名）', items: { type: 'string' } },
      mode: { type: 'string', description: 'archive=只归档（不打扰）；notice=只通知一行；full=把正文投给对方；不传=记录 + 自动接力', enum: ['archive', 'notice', 'full'] },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const sessionId = workerOf(exec);
      const content = String(args.text ?? '').trim();
      if (!content) return '发言内容不能为空。';
      const label = labelOf(exec, room);
      const files = [];
      const dropped = [];
      for (const raw of Array.isArray(args.files) ? args.files : []) {
        const copied = await host.copyIntoRoom(room, String(raw));
        if (copied) files.push(copied);
        else dropped.push(String(raw));
      }
      // v16⑥ 兜底（不依赖 agent 钩子）：这位与会者刚写在工作区顶层的文件，趁交作业这一刻收进房间「附件/」。
      try {
        await host.staging?.sweepSession?.(room, sessionId);
      } catch (error) {
        host.warn(`收拢工作区顶层文件失败：${error?.message ?? error}`);
      }
      const message = await room.append({
        kind: 'chat',
        text: content,
        author: sessionId ? { kind: 'agent', id: sessionId, label } : { kind: 'user', id: 'user', label },
        files: files.length ? files : undefined,
      });
      // v13：散会后不准再往下接力。以前散会只把 status 改成 closed，
      // 被唤醒的与会者照样能 room_say → 又互相提醒，链子会一直转下去。
      if (room.room.status === 'closed') {
        return `已写进会议记录 #${message.seq}，但会议已经散会（${room.id}），不再自动接力。要继续讨论请让用户重开会议（或调用 room_request_reopen）。`;
      }
      // v8：缺省（既不传 mode 也不传 to）= 归档 + 自动接力，让房间自己往下走
      // 注意：modeProvided 用原始 args.mode 判定 —— 白名单外的字符串（'ARCHIVE'/'bogus'）算「显式传了 mode」，
      // 只归档、不接力；否则会被误当成「没传 mode」而广播。
      const modeProvided = typeof args.mode === 'string' && args.mode.trim() !== '';
      const mode = ['archive', 'notice', 'full'].includes(args.mode) ? args.mode : '';
      const hasTo = Array.isArray(args.to) && args.to.length > 0;
      const cap = Number(host.config?.autoContinueHops) > 0 ? Math.floor(Number(host.config.autoContinueHops)) : 0;
      let delivered = [];
      let failed = [];
      let activated = 0;
      let relayed = 0;
      let capped = '';
      if (mode === 'notice' || mode === 'full') {
        const outcome = await room.deliver({
          text: content,
          kind: 'chat',
          authorLabel: label,
          targets: Array.isArray(args.to) ? args.to.map(String) : [],
          mode,
          latestSeq: message.seq,
          senderSessionId: sessionId ?? undefined,
        });
        delivered = outcome.delivered;
        failed = outcome.failed;
        activated = outcome.activated ?? 0;
      } else if (!modeProvided && !hasTo) {
        const others = [...room.members.values()].filter((m) => m.sessionId !== sessionId);
        if (room.room.status !== 'closed' && others.length && cap > 0) {
          // 自动接力不设跳数上限：只要没被关闭（autoContinueHops>0）就一直接力下去
          room.autoHop += 1;
          relayed = room.autoHop;
          const outcome = await room.deliver({
            kind: 'chat',
            authorLabel: label,
            targets: others.map((m) => m.sessionId),
            mode: 'notice',
            latestSeq: message.seq,
            senderSessionId: sessionId ?? undefined,
            noticeStyle: 'ping',
          });
          delivered = outcome.delivered;
          failed = outcome.failed;
          activated = outcome.activated ?? 0;
        }
      }
      const tail = relayed
        ? `已写入会议记录，并自动接力提醒 ${delivered.length} 人（第 ${relayed} 跳）。`
        : delivered.length
          ? `已通知 ${delivered.length} 人。`
          : '已写入会议记录（未打扰任何人）。';
      const warn = failed.length ? ` 投递失败：${failed.map((f) => f.sessionId.slice(0, 8)).join('、')}。` : '';
      return `#${message.seq} ${tail}${capped}${warn}${dropped.length ? ` 未登记文件：${dropped.join('、')}` : ''}`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_read',
    description: '读会议室的完整记录（会议目标、参与人、消息、文件、《会议结果》）。写结论前必须先用它读全量，不要凭印象。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      since: { type: 'number', description: '只读 seq 大于该值的消息（0=全部）' },
      limit: { type: 'number', description: '最多返回多少条消息（默认取插件配置）' },
    },
    output: toolOutput(),
    async execute(args) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      await host.refreshFiles(room);
      const since = Number(args.since) > 0 ? Number(args.since) : 0;
      const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : cfg.maxReadMessages;
      const messages = room.messages.filter((m) => m.seq > since);
      const shown = messages.slice(Math.max(0, messages.length - limit));
      const activeGoal = room.goals.find((g) => g.id === room.room.activeGoalId);
      const head = [
        `【会议室 ${room.room.title}｜${room.room.status === 'closed' ? '已结束' : '进行中'}｜id=${room.id}】`,
        `当前会议目标：${activeGoal ? activeGoal.text : '（未设置）'}`,
        `目标进展：${room.goals.length ? room.goals.map((g) => `「${g.text}」${g.status === 'done' ? `已达成${g.result ? `（结果：${g.result.title}，${g.result.status === 'approved' ? '已发布' : '草稿'}）` : '（待记录员写结果）'}` : g.status === 'active' ? '讨论中' : '未开始'}`).join('；') : '（无）'}`,
        `参与人：${room.membersView().map((m) => `${m.label}（${m.live ? '在线' : '离线'}${m.role === 'recorder' ? '，记录员' : ''}）`).join('、') || '（无）'}`,
        room.room.reopenRequest ? `重开请求：${room.room.reopenRequest.by}${room.room.reopenRequest.reason ? `（${room.room.reopenRequest.reason}）` : ''}` : null,
        room._files?.length ? `房间文件：${room._files.map((f) => f.name).join('、')}` : null,
      ].filter(Boolean);
      const body = shown.map((m) => {
        const who = m.author?.label ?? '系统';
        const files = m.files?.length ? `（文件：${m.files.join('、')}）` : '';
        return `#${m.seq} ${timeText(m.at)} ${who}：${m.text}${files}`;
      });
      const more = messages.length > shown.length ? `\n（共 ${messages.length} 条，只显示最后 ${shown.length} 条；要更早的用 since 参数）` : '';
      return truncate(`${head.join('\n')}\n\n${body.join('\n') || '（还没有消息）'}${more}`, cfg.maxReadChars);
    },
  }));

  toolDefs.push(tool({
    name: 'room_files',
    description: '列出会议室里已交接的文件。',
    parameters: { roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' } },
    output: toolOutput(),
    async execute(args) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const files = await host.refreshFiles(room);
      if (!files.length) return `会议室「${room.room.title}」里还没有文件。`;
      return files.map((f) => `- ${f.name}（${f.bytes} 字节）`).join('\n');
    },
  }));

  toolDefs.push(tool({
    name: 'room_open',
    description: '读会议室里某个文件（只读副本）的正文。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      name: { type: 'string', required: true, description: '文件名' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const path = host.roomFilePath(room, args.name);
      if (!path) return '非法文件名。';
      const content = await readFile(path, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (content === null) return `文件不存在：${safeName(args.name)}`;
      return truncate(content, Math.min(cfg.maxReadChars, 20000));
    },
  }));

  toolDefs.push(tool({
    name: 'room_goal_report',
    description: '向会议汇报当前目标是否达成：verdict 用「达成」或「有分歧」。写进会议记录，供记录员与用户判断。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      goalId: { type: 'string', description: '目标 id，缺省为当前目标' },
      verdict: { type: 'string', required: true, description: '达成 / 有分歧', enum: ['达成', '有分歧'] },
      summary: { type: 'string', required: true, description: '一句话结论与依据' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const goal = args.goalId ? room.findGoal(String(args.goalId)) : room.goals.find((g) => g.id === room.room.activeGoalId);
      if (!goal) return '没有找到对应的会议目标。';
      const label = labelOf(exec, room);
      const message = await room.append({
        kind: 'goal-report',
        text: `目标「${goal.text}」：${args.verdict} —— ${String(args.summary ?? '').trim()}`,
        author: { kind: 'agent', id: workerOf(exec) ?? 'agent', label },
        data: { goalId: goal.id, verdict: args.verdict },
      });
      return `已写入会议记录 #${message.seq}。目标「${goal.text}」仍由用户确认完成（用户点「目标已达成」后记录员会写《会议结果》）。`;
    },
  }));

  toolDefs.push(tool({
    name: 'room_result_write',
    description: '（v4：对 AI 与会者禁用）《会议结果》由每个会议室的内置记录员在目标达成时自动生成，再由用户审核发布。与会者要表达意见请用 room_goal_report / room_say；人类可在会议室面板的结果页手动填写草稿。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      goalId: { type: 'string', required: true, description: '目标 id' },
      title: { type: 'string', required: true, description: '《会议结果》标题' },
      body: { type: 'string', required: true, description: '正文（Markdown，按与会者分节）' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const goal = room.findGoal(String(args.goalId));
      if (!goal) return `会议目标不存在：${args.goalId}`;
      // v4：记录员是内置 AI（不占 sessionId），《会议结果》只能由宿主的内置记录员自动生成，
      // 或由人类在会议室面板的结果页手动填写（HTTP 通路）。AI 与会者一律不允许写结果，
      // 否则等于任何与会者都能绕过记录员改写结果（无中生有 / 覆盖已发布内容）。
      return [
        '《会议结果》由每个会议室的内置记录员在会议目标达成时自动生成，再由用户审核发布；AI 与会者不能写结果。',
        '要表达意见请用：room_goal_report（对会议目标是否达成表态）或 room_say（在会议室里发言）。',
        '如果是人类要手动填写，请在会议室面板的「结果」页操作。',
      ].join('');
    },
  }));

  toolDefs.push(tool({
    name: 'room_task_done',
    description: '宣告本次会议的任务已完成（相当于人类会话里的「任务完成」）：当前目标会立刻标记为已达成，内置记录员随即自动整理《会议结果》草稿，再由用户审核发布。只在讨论真正得出结果、你确认可以收尾时调用；调用后不能再说「还在讨论」或继续把这个目标当进行中的任务。只是汇报进展/有分歧请用 room_goal_report，不要用这个工具。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      note: { type: 'string', description: '给记录员的补充要求（可省略），例如「重点记录分工与待办」' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const sessionId = workerOf(exec);
      if (sessionId && !room.members.has(sessionId)) return '你还不在这个会议室里（先 room_join），不能宣告任务完成。';
      const goal = room.goals.find((g) => g.id === room.room.activeGoalId && g.status !== 'done');
      if (!goal) return '当前没有进行中的会议目标，不用宣告完成。';
      if (goal.result?.status === 'approved') return `目标「${goal.text}」的《会议结果》已经发布过了，不重复生成。`;
      if (goal.result?.status === 'draft') return `目标「${goal.text}」的《会议结果》已有草稿，等用户审核即可（不重复生成）。`;
      const label = labelOf(exec, room);
      const note = String(args.note ?? '').trim();
      goal.status = 'done';
      goal.doneAt = Date.now();
      goal.updatedAt = Date.now();
      goal.history.push({ at: Date.now(), by: label, action: 'complete', note: note || null, via: 'room_task_done' });
      await room.saveGoals();
      // v12：刚收尾的目标不再占着 activeGoalId（有下一个未完成目标就交给它，否则置空）
      if (room.pickActiveGoal(goal.id) !== goal.id) await room.saveRoom();
      await room.append({
        kind: 'goal-complete',
        text: `任务已完成：${goal.text}（${label} / room_task_done），请${room.recorderView().label}整理会议结果`,
        author: { kind: 'agent', id: sessionId ?? 'agent', label },
        data: { goalId: goal.id, via: 'room_task_done' },
      });
      // v12②：指令到达即自动生成草稿（仍由用户审核发布）；失败把中文原因写回会议记录让所有人看得见
      try {
        const asked = await room.generateResultDraft(goal, note);
        if (asked.asked !== true) return `已宣告任务完成（目标：${goal.text}）。${asked.reason ?? ''}`.trim();
        return `已宣告任务完成（目标：${goal.text}），记录员已提交《${goal.result?.title ?? ''}》草稿，等用户审核发布。`;
      } catch (error) {
        const reason = error?.message ?? String(error);
        await room.noteRecorderFailure(reason, goal).catch(() => {});
        return `已宣告任务完成（目标：${goal.text}），但记录员没能整理出结果：${reason}`;
      }
    },
  }));

  toolDefs.push(tool({
    name: 'room_request_reopen',
    description: '请求重开已结束的会议，或对已完成的目标发起「再议」。请求会交给用户决定。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      reason: { type: 'string', description: '为什么需要重开' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const sessionId = workerOf(exec);
      const label = labelOf(exec, room);
      const reason = String(args.reason ?? '').trim();
      room.room.reopenRequest = { sessionId: sessionId ?? null, by: label, at: Date.now(), reason: reason || null };
      await room.saveRoom();
      await room.appendSystem(`${label} 请求重开本次会议${reason ? `：${reason}` : ''}`);
      return '已把重开请求记进会议记录，等用户批准。';
    },
  }));

  toolDefs.push(tool({
    name: 'room_finalize',
    description: '（旧版遗留）为默认会议室写一份《会议决议》并通知成员。v2 请改用会议目标 + 记录员 + room_result_write。',
    parameters: {
      roomId: { type: 'string', description: '会议室 id，缺省为默认会议室' },
      title: { type: 'string', required: true, description: '决议标题' },
      body: { type: 'string', required: true, description: '决议正文' },
      force: { type: 'boolean', description: '已经交付过是否强制覆盖重发' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      await ready();
      const room = await requireRoomArg(args.roomId);
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!title || !body) return 'title 与 body 必填。';
      const statePath = join(room.dir, 'resolution-state.json');
      const state = await readJsonFile(statePath, null);
      if (state?.delivered === true && args.force !== true) {
        return `本次会议（${room.id}）的决议已经交付过：${join(room.dir, '决议.md')}。要覆盖重发请传 force: true。`;
      }
      const content = `# ${title}\n\n> 会议室：${room.room.title}　交付时间：${new Date().toLocaleString('zh-CN')}\n\n${body}\n`;
      await writeFile(join(room.dir, '决议.md'), content, 'utf8');
      await writeJsonFile(statePath, { roomId: room.id, delivered: true, deliveredTo: [], at: Date.now(), resolution: '决议.md', skipped: false });
      room.legacyResolution = content;
      const message = await room.append({ kind: 'resolution', text: `散会：${title}`, author: { kind: 'system', id: 'system', label: '系统' } });
      const outcome = await room.deliver({
        text: `【会议室 ${room.room.title}】散会。会议决议（唯一交付物）：\n\n${body}`,
        kind: 'resolution',
        authorLabel: '系统',
        targets: [...room.members.keys()],
        mode: 'full',
        latestSeq: message.seq,
      });
      return `决议已写入 #${message.seq} 并投递给 ${outcome.delivered.length} 个成员（失败 ${outcome.failed.length}）。文件：${join(room.dir, '决议.md')}`;
    },
  }));

  // ------------------------------------------------------------ 装配

  ctx.effect(() => {
    const disposers = [];
    for (const route of routes) disposers.push(ctx.webServer.register(route));
    for (const def of toolDefs) disposers.push(ctx.tools.register(def));
    return () => {
      for (const off of disposers.reverse()) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
      try {
        host.dispose();
      } catch {
        /* ignore */
      }
    };
  });

  ctx.logger?.info?.(`[dsh-meeting-room] v4 已加载：状态根=${cfg.root}，会议文件目录=${cfg.category}，默认会议室=${cfg.roomId}（记录员=内置 AI；/sessions 只列顶层会话）`);
}
