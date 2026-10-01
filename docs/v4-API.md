# dsh-meeting-room v4 API 契约

> v4 = 在 v3（分类面板 / 聊天室界面 / 真实会话名 / 记录员默认 AI + 提示词 / 文件离开桌面）
> 之上，落实 2026-09-29 的六条需求：**单入口「会议室」、右侧直接出内容、内置记录员（不再指派）、
> 邀请列表只列顶层会话、聊天气泡与官方主题色、记录员提示词仍可改**。
>
> 本文件是 v4 / v4.1 实现与客户端 / 自测的**唯一契约**。数据源快照（冻结）：
> `index.js`（v4.1）134372 B / 2897 行 / SHA1 `C8250D239BC376823F2281BD5A62559162050DB6`、
> `client/client.js`（v4 起未改）92891 B / 1704 行 / SHA1 `7096458392AE701B58B5EA489477627261E53EEE`、
> `selftest/run.mjs` 167690 B / 3100 行 / SHA1 `3D8CFA441786031E5B2741889921D3A6EBBC64D5`。
> 文中每个行号都已逐条打开源码核对（见 §13）。**v4.1 只在 `EffortControl` 加了钩子契约（`:1636-1653`）与守卫，`index.js` 里该处之后的锚点已整体 +6 行。**

## 1. 六条 v4 需求 → 落地位置

| # | 需求 | 实现 | 锚点 |
|---|---|---|---|
| 1 | 设置 / 新建 / 会议室合并为**一个**左侧入口 | `sidebar.panellist` 只注册 1 条 `dsh-meeting-room`；分类树 / 房间列表 / 新建 / 设置全在面板内部 | `client.js:593-601`（`desiredRows`）、`:628-650`（`applyRoomRows`） |
| 2 | 点入口 / 房间，右侧直接出内容 | 面板内 state 导航 `goInternal()`；只有宿主不在本插件面板时才 `layout.selectPanel(PANEL_ID)` 一次 | `client.js:504-511`、`:654-663`、`:705-728` |
| 3 | 「策划会议」等界面颜色与主 UI 一致 | 全量改用官方主题 token（`--dsw-alias-*` / `--dsw-specific-*`） | `client.js:36-52`（常量表）、`:89-99`（消息行 / 气泡） |
| 4 | 记录员 = 每个会议室**自带的内置 AI**，不由用户指派 | `recorderView()` 恒返回 `{kind:'builtin',label:'记录员'}`；指派端点 / 设置项一律 `400`；目标达成时由内置记录员自动生成草稿 | `index.js:38-40`、`:529-531`、`:2416-2425`、`:925-928`、`:790-831` |
| 5 | 邀请列表是**真会话名**，且只列顶层会话 | `GET /sessions` 过滤子会话 / 种子会话，投影 `title` 等字段，另返回 `{total, filtered}` | `index.js:43-51`、`:1483-1506`、`:1884-1900` |
| 6 | 聊天页去方框、我的消息靠右、与会者名字分色 | `S.msg` 无 `border`；`author.kind==='user'` 整行 `alignItems:'flex-end'` + 气泡底色；名字按稳定哈希取 6 色调色板 | `client.js:89-94`、`:144-155`、`:1235-1258` |

## 2. 目录模型（沿用 v3，未回退）

| 概念 | 默认值 | 说明 |
|---|---|---|
| 状态根 `root` | `~/.dsh/meeting-room`（`index.js:16`） | 只放 `rooms.json`、`settings.json` |
| 默认分类 `category` | `~/dsh/会议`（`index.js:17`） | 新会议室默认「会议文件放置位置」的父目录 |
| 房间分类 `category` | = `defaultCategory` | 绝对路径；面板按它分组（一个分类 = 一个可折叠组） |
| 房间目录 `dir` | `join(category, id)` | 该房间全部会议文件的落地目录 |

- 路径护栏（`assertSafeTarget` / `assertSafeRealTarget` / `isOwnRoomDir` / `isRoomDataDir`）**未回退**：
  房间目录 / 分类目录指向受保护位置（状态根及其父目录、用户主目录、进程工作目录、盘根，或它们的上级）→ `400`；
  状态根在 `~/.dsh/meeting-room`（主目录下的隐藏配置目录内）时，`~/.dsh` 内部任何位置一律 `400`，且不 `mkdir`、不改内存、不登记。
- 路径比较一律**折叠大小写 + 解析真实路径 + 文件身份（`dev:ino`）**：大小写翻转、8.3 短名、软链 / junction、`\\?\` 前缀、subst 映射盘都不能绕过。
- `PATCH /rooms/:id {category|dir}` 顺序：先判「目标/父级已是文件」（`400 目标不是目录` / `400 父级不是目录`），再判位置安全；两者都不碰内存。
- 搬移只用较宽的 `isRoomDataDir`（目录名 == 房间 id，**或**该目录 `room.json` 里的 `id` 是本房间）；
  `DELETE ?purge=1` 只用严格的 `isOwnRoomDir`（目录名必须 == 房间 id），不满足 → 只删登记并回 `{deleted:true, purged:false, reason}`。
- 索引自愈 / 旧布局一次性迁移 / `dir` 持久化（`room.json` + `rooms.json`）：同 v3，见 `docs/v3-API.md` §1。

## 3. 设置 `settings.json`

```json
{
  "category": "C:\\Users\\uyiop\\dsh\\会议",
  "prompt": "【会议室 {{room}}】目标「{{goal}}」已达成，请你作为记录员写《会议结果》。…",
  "updatedAt": 1790000000000
}
```

- **v4：`settings.json` 不再有 `recorder` 字段**。`MeetingHost.settings` 只有三字段（`index.js:846`）；
  `saveSettings()` 直接写 `this.settings`（`:883-887`）；`loadSettings()` 里残留的 `recorder` 字段**忽略**（不崩、不继承，`:872-881`）。
- `settingsView()` 仍返回 `recorder: null`（只为兼容旧客户端读该字段，`index.js:889-897`）。
- `PATCH /settings` 带 `recorder`（任何形状，含 `null`）→ **400** `v4：记录员是每个会议室自带的内置 AI，不能再配置`（`:925-928`，常量 `:35`）。
- `PATCH /settings {category}` 只改默认分类并 `mkdir`，不搬已有房间；不是绝对路径 / 落在状态根或 DSH 配置目录内 → `400`。
- `prompt` 空串 = 恢复内置默认 `DEFAULT_RECORDER_PROMPT`（`:18-24`、`:929-932`）。

## 4. 内置记录员与草稿生成（v4 核心）

### 4.1 身份

- 每个房间恒有 `recorderView() → { kind: 'builtin', label: '记录员' }`（`index.js:38-40`、`:529-531`）；
  `RoomSummary.recorder`（`:582`）与 `room.room.recorder`（`:428`）都是这个值。
- 记录员**不注册 agent、不进 `members`、不接收任何投递、不参与 push**（`:32` 注释 + `membersView()` 剥离旧 `role:'recorder'`，`:533-544`）。
- **没有**任何「指派记录员」的写通路：
  - `GET /rooms/:id/recorder` → `{ recorder, candidates: 在线成员 }`（`index.js:2417-2419`）；
  - `POST /rooms/:id/recorder` → **400** `v4：记录员是每个会议室自带的内置 AI，不需要指派`（`:2420-2424`；路由保留是为了让旧客户端拿到中文说明，而不是 404）；
  - `PATCH|POST /settings {recorder}` → **400**（`:925-928`）；
  - `POST /rooms {recorder}` → **忽略**（不是错误，``:1927-1928`）。

### 4.2 提示词

- `recorderPrompt(goal, note)`：`room.prompt`（房间级覆盖）→ `settings.prompt` → 内置默认（`index.js:684-692`）。
  占位符 `{{room}}` / `{{goal}}` / `{{goalId}}`；带 `note` 时模板后追加一行 `补充要求：<note>`。
- 内置默认提示词（`index.js:18-24`）：

```
【会议室 {{room}}】目标「{{goal}}」已达成，请你作为记录员写《会议结果》。
1) 只能依据下面给出的会议记录（该目标对应的 transcript 片段），不得使用任何其他信息，不得编造。
2) 只记录与会者与用户真实说过的结论/分工/待办/未决问题；记录里没有的内容一律写「记录中未涉及」。
3) 按与会者分别成节：`## <成员显示名>`（没有专属结论的人写「记录中未涉及」）。
4) 直接输出《会议结果》正文（Markdown），不要调用任何工具、不要输出解释性前言。
```

### 4.3 证据：`transcriptForRecorder()`

`index.js:698-719`：从**最新往老**取本房间消息，条数上限 `config.maxReadMessages`（默认 40）、字符上限 `config.maxReadChars`（默认 40000）；
每行格式 ``#<seq> <时间> <显示名>：<正文>``；返回真实 `{ lines, seqFrom, seqTo, count }`（无消息时 `seqFrom=seqTo=0, count=0`）。

### 4.4 模型解析与调用

- `resolveRecorderModel(llm)`（`index.js:722-747`）：先 `ctx.get('agentDefaultModel')?.currentSelection()` 取 `provider`/`model`
  （有 `reasoningEffort` 会一并带上）；取不到再 `llm.listProviders()[0]` + `llm.listModels(provider)[0]`；都失败 → `503`。
- `callRecorderModel(userText)`（`index.js:750-784`）：`ctx.get('llm')` 不存在或没有 `stream` → `503`；
  调用 `llm.stream({ provider, model, system, messages: [{role:'user',content:[{type:'text',text}]}], temperature: 0.2 })`，
  `system` = `你是本次会议的记录员。只能依据用户给出的会议记录写作；记录里没有的内容写「记录中未涉及」，绝不编造、绝不推断、绝不补充常识。`；
  流里 `finish.reason.kind === 'error' | 'aborted'`、抛异常、正文为空 → 一律 `503`（中文原因 + 「可以手动填写《会议结果》」）。

### 4.5 产物与触发

`generateResultDraft(goal, note)`（`index.js:790-831`）在两条路径被调用：

| 触发 | 位置 | 行为 |
|---|---|---|
| 目标标记达成 `POST /rooms/:id/goals/:gid/complete` | `:2252-2290` | 目标置 `done` 并落盘 → 调 `generateResultDraft`；失败时 `503` 直接抛给调用方（目标已是 `done`，但 `result` 仍为空） |
| 散会 `POST /rooms/:id/close`（别名 `adjourn`） | `:2151-2180` | 房间置 `closed` + 系统消息 → 有 active 目标才生成；**模型失败不让散会失败**，改为回 `200 { asked:false, reason }` |

产物（写入 `goals.json`，正文另落 `results/<goalId>.md`，`:813-829`）：

```ts
goal.result = {
  title: '<目标文本> · 会议结果',
  file: '<goalId>.md',
  status: 'draft',
  by: '记录员',
  at: number, approvedBy: null, publishedAt: null, note: null,
  body: string, excerpt: string,                       // excerpt = 正文前 200 字
  evidence: { seqFrom, seqTo, count },                 // 真实 transcript seq 区间
  model: { provider, model },
}
```

- **幂等**：`goal.result.status === 'approved'` → 直接返回「已发布，不再重新生成」；`==='draft'` → 「已有草稿（不重复生成）」；`result` 为空才真去调模型（`:792-797`、`:2255-2263`）。
- **失败不落半成品**：任何 `503` 都在写 `goals.json` / `results/<gid>.md` 之前抛出。
- 落草稿时追加系统消息：`内置记录员提交了《<title>》草稿（目标：<文本>），等待审核`（`:829`）。
- **发布仍必须人工审核**：`approve` 通过后才 `status='approved'` 并逐成员分节投递（`:2358-2405`）。

### 4.6 越权收口（v4 语义修复，务必保持）

| 入口 | v4 行为 |
|---|---|
| 工具 `room_result_write` | **对 AI 与会者一律禁用**：只 `return` 中文提示（结果由内置记录员自动生成、由用户审核发布；要表达意见用 `room_goal_report` / `room_say`；人类在面板「结果」页手动填写）。**工具数仍是 12**（`index.js:2783-2807`） |
| `POST /rooms/:id/results/:gid/draft` | 保留给**人类 / 面板**手动填写（必须 `title` + `body`）；已 `approved` 再写 → **409** `这个《会议结果》已经发布过了，不能再用草稿覆盖`（`:2323-2335`）；手动草稿的系统行按 `by` 区分（`:2351-2355`）：`by==='记录员'` → `记录员提交了《<title>》草稿（目标：<文本>），等待审核`，否则 → `《<title>》草稿已提交（<by 或 用户>），等待审核（目标：<文本>）` |
| `POST /rooms/:id/results/:gid/approve` | 已 `approved` 再 approve → **409** `这个《会议结果》已经发布过了`（`:2374-2376`） |

## 5. 端点总表

统一前缀 `/dsh-room`（`index.js:14`），单一 `{kind:'prefix'}` 路由。所有请求要求回环来源（`Host`/`Origin` 校验、`sec-fetch-site: cross-site` 拒绝）。
v1 兼容写法是 **`/dsh-room/<旧端点>`**（无房间段，映射到默认房间 `config.roomId`，默认 `main`），支持
`state|post|join|leave|kick|close|adjourn|reopen|goals|results|result|recorder|reasoning|upload|raw|files|finalize`。
**没有** `/dsh-meeting-room` 前缀。JSON 收发；出错 `{ error }` + 4xx/5xx。

### 5.1 总览与设置

| 方法 | 路径 | 请求 | 响应 / v4 说明 |
|---|---|---|---|
| GET | `/rooms` | – | `{ rooms: RoomSummary[], defaultRoomId }`（含已归档，按 `category` 再按 `updatedAt` 倒序） |
| POST | `/rooms` | `{ id?, title?, goal?, category?, dir?, prompt? }` | `{ room }`；**v4：`recorder` 参数被忽略** |
| GET | `/settings` | – | `{ settings, defaultCategory, defaultPrompt }`；`settings.recorder` 恒 `null` |
| PATCH · POST | `/settings` | `{ category?, prompt? }` | `{ settings }`；**v4：带 `recorder` → 400** |
| GET | `/sessions` | `?includeSubagents=1`（仅内部调试） | `{ sessions, candidates, members, total, filtered, includeSubagents }`，见 §7；`/candidates` 是同一端点别名 |
| GET | `/browse` | `?path=` | `{ path, parent, dirs: [{name,path}], exists }`，逐级回退到最近存在的祖先 |
| GET | `/rooms/:id` | `?since=N` | 无 `since` 时等同 `/state` |
| GET | `/rooms/:id/state` | `?since=N` | `{ room, root, seq, members, messages, files, goals, results, push, reasoning, settings, resolution }`（`root` = 房间文件目录，`resolution` 只在 v1 旧房间非 null）（`:589-606`） |

### 5.2 房间

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| PATCH | `/rooms/:id` | `{ title?, push?, reasoning?, sessionId?, reopenRequest?, goal?, category?, dir?, prompt?, archived? }` | v4 不再处理 `recorder`（传了也只是被忽略）；`dir` 改动立即落索引 |
| DELETE | `/rooms/:id` | `?purge=1`（也认 `true`/`yes`） | `{ deleted, purged, dir }`；`purge` 仅在「目录名 == 房间 id 且不在受保护位置」时真删 |
| POST | `/rooms/:id/close`（别名 `/adjourn`） | body 读掉但忽略（旧 `recorder` 参数无意义） | 散会 → `{ room, results, asked, reason, failed }`；已结束 → `{ already:true, ... }`；模型不可用时 `asked:false` + 中文 `reason`，**散会本身仍 200** |
| POST | `/rooms/:id/reopen` | `{ by?, reason?, sessionId?, label? }` | `by:'user'`（默认）直接重开 `{ requested:false, reopened:true }`；`by:'member'` 只写 `reopenRequest` `{ requested:true }` |
| POST | `/rooms/:id/finalize` | `{ title, body, force? }` | v1 遗留：写 `<dir>/决议.md` + 门闩 `resolution-state.json`；已交付且无 `force` 再调 → 409 |

### 5.3 成员 / 消息 / 文件

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| POST | `/rooms/:id/join` | `{ sessionId?, label? }` | 幂等（重复加入回 `already:true` 并只更新显示名） |
| POST | `/rooms/:id/leave` | `{ sessionId? }` | 不在册 → `{ removed:false }`；**v4：不再有「记录员退出会清空记录员」** |
| POST | `/rooms/:id/kick` | `{ sessionId?, reason?, notify? }` | `sessionId` 也接受唯一显示名；`notify:true` 且在线才投通知 |
| POST | `/rooms/:id/post` | `{ text*, label?, mode?, to?, files?, pushAll? }` | `{ message, delivered, failed, droppedFiles, mode }`；`mode ∈ archive/notice/full`，缺省 = `pushAll===true?'full':room.push==='off'?'archive':room.push` |
| POST | `/rooms/:id/reasoning` | `{ level, sessionId? }` | `{ reasoning, reasoningByMember, effectiveFor, effective }`；成员级 `inherit` = 删覆盖 |
| POST | `/rooms/:id/upload` | `{ name*, base64* }` | `{ name, bytes, renamed }`；> 8 MiB → 413 |
| GET | `/rooms/:id/raw` | `?name=` | 原始内容（可读版记录 = `?name=transcript.md`） |
| GET | `/rooms/:id/files` | – | `{ files: [{ name, bytes, at }] }`（`at` = mtime 毫秒） |

### 5.4 目标 / 记录员 / 结果

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| GET · POST | `/rooms/:id/goals` | `{ text* }`（POST） | `{ goals, activeGoalId }`；无 active 时新目标自动激活 |
| PATCH | `/rooms/:id/goals/:gid` | `{ text?, status? }` | `status ∈ open/active/done`；`status:'active'` 同时切换当前目标（**没有** `active` 布尔字段） |
| POST | `/rooms/:id/goals/:gid/complete` | `{ note?, by? }` | 标记达成 + 内置记录员生成草稿 → `{ goal, recorder, result, asked, reason, failed }`；已 `done` → `{ already:true, ... }` 且不重复生成；模型不可用 → **503** |
| POST | `/rooms/:id/goals/:gid/reopen` | `{ reason? }` | 再议：目标回 `active`，旧结果标 `superseded` |
| GET | `/rooms/:id/recorder` | – | `{ recorder, candidates: 在线成员 }`（`recorder` 恒内置） |
| POST | `/rooms/:id/recorder` | – | **恒 400**（v4：不需要指派） |
| GET | `/rooms/:id/results` | – | `{ results, recorder }` |
| GET | `/rooms/:id/result` | `?goalId=` | 正文 markdown；不传 `goalId` 取第一个有结果的目标 |
| POST | `/rooms/:id/results/:gid/draft` | `{ title*, body*, by? }` | 手动草稿（人类/面板）；已发布 → **409** |
| POST | `/rooms/:id/results/:gid/approve` | `{ by?, note? }` | 发布 + 逐成员按 `## <显示名>` 分节投递 → `{ result, delivered, failed }`；已发布 → 409 |
| POST | `/rooms/:id/results/:gid/reject` | `{ note*, by? }` | 审核意见追加进正文，状态回 `draft`（`note` 必填） |

## 6. 数据结构

```ts
type RecorderView = { kind: 'builtin'; label: '记录员' };   // v4：不再是 {sessionId,label}

type RoomSummary = {
  id: string; title: string; status: 'open' | 'closed';
  createdAt: number; updatedAt: number; closedAt: number | null;
  category: string;                    // 分组键（绝对路径）
  dir: string;                         // 会议文件目录（绝对路径）
  archived: boolean; archivedAt: number | null;
  prompt: string | null;               // 房间级记录员提示词覆盖
  memberCount: number; liveCount: number; messageCount: number; seq: number;
  goalCount: number; doneGoalCount: number; resultCount: number;
  activeGoalId: string | null; activeGoalText: string | null;
  recorder: RecorderView;              // v4：恒内置
  push: 'off' | 'notice' | 'full'; reasoning: 'inherit' | 'low' | 'medium' | 'high';
  reopenRequest: { reason?: string; at: number; label?: string } | null;
};

type SessionItem = {                  // GET /sessions
  sessionId: string; title: string; label: string;   // label 是 title 的 v3 兼容别名
  cwd: string | null; live: boolean; persisted: boolean;
  updatedAt: number | null;           // 快照 updatedAt，缺省回 createdAt
};

type GoalResult = {
  title: string; file: string; status: 'draft' | 'approved' | 'superseded';
  by?: string; at: number; approvedBy: string | null; publishedAt: number | null;
  note: string | null; body: string; excerpt: string;
  evidence?: { seqFrom: number; seqTo: number; count: number };  // 内置记录员生成时才有
  model?: { provider: string; model: string };
};
```

- `members[]`：`{ sessionId, label, joinedAt, role?, reasoning, live }`（`role:'recorder'` 已被剥离；记录员从不出现）。
- `messages[]`：`{ seq, at, kind, text, author: { kind, id, label }, targets?, files? }`。
- `files[]`：`{ name, bytes, at }`（`/state` 与 `/files` 同形）。

## 7. `GET /sessions`（邀请列表数据源）

- 路由 `index.js:1884-1900`：`GET /sessions` 与 `/candidates` 同一分支；恒 `host.sessions(true)`（**强制不缓存**）；
  `?includeSubagents=1|true|yes` 关闭子会话过滤（仅内部调试）。响应：
  `{ sessions, candidates: 在线项, members: 默认房间成员, total, filtered, includeSubagents }`。
- 数据装配 `sessions()`（`:1404-1477`）：优先 `ctx.get('sessionQuery')` 的 `listSessions()` + `readTitleSnapshots(ids)`；
  标题兼容字符串与 rc.1 快照对象 `{title, messageSeqs, source, eventSeq, updatedAt}`；无 `sessionQuery` 时回退 `agents.list()`
  （此时 title 只有 `会话 <id 前 8 位>`、无 `cwd`）；**退化列表不写缓存**（`:1471-1473`），正常结果走 30 秒 TTL（`SESSION_TITLE_TTL`，`:25`）。
- 投影 + 过滤 `sessionListView(all, includeSubagents)`（`:1483-1506`）：
  - 过滤（`isSubagentSession`，`:43-51`）：`header.origin === 'subagent'`、`parentSession` 非空、`delegationDepth > 0`、`isSeeded === true` 四条，命中即剔除；
  - 排序：`live` 优先 → `updatedAt ?? createdAt` 倒序；
  - 每项只投影 `{ sessionId, title, cwd, live, persisted, updatedAt, label }`（不再外露 `subagent` 字段）；
  - 返回 `total` = 过滤前条数、`filtered` = `total - sessions.length`。

## 8. 客户端契约

### 8.1 槽位与导航

- `sidebar.panellist`：**只注册 1 条** `{ id: 'dsh-meeting-room', order: 100, label: '会议室', glyph: RoomIcon }`（`client.js:17-24`、`:593-601`）。
  渲染逻辑在 `applyRoomRows()`（`:628-650`）：按 `id` 增删，签名 `${order}|${label}` 未变则跳过（不再每轮重注册）。
- `main`：`desiredMain()`（`:664-676`）注册 `dsh-meeting-room`（组件 `MainPane`，`:654-663`）
  + 每个「有结果」房间的 `dsh-meeting-room:result:<roomId>`（组件 `ResultTab`，`:1555`）；`applyRoomPanels()`（`:677-689`）做增量注册。
- 面板内导航 `goInternal(id)`（`:504-511`）：只改 `meeting.activePanelId`（`:245-260` 一带的内存 state）并 `emit()` + `syncSlots()`；
  **只有** `hostActivePanelId() !== PANEL_ID` 时调一次 `layout.selectPanel(PANEL_ID)`（`:496-511`）。
  `openRoom(roomId)`（`:512-516`）切内部房间视图；`openResult(roomId, goalId)`（`:517-521`）仍用 `selectPanel('dsh-meeting-room:result:<roomId>')` 打开结果页。
- **保留 id 不是房间**：`MainPane` 的 `roomId` 计算显式排除 `NEW_ID`（`:654-663`），`roomIdOf()` 里 `const internal = id === NEW_ID || id === SETTINGS_ID;`（`:1069-1078`）；
  因此切到「新建会议室」/「设置」屏时，`viewOf('new')` 不会造出幽灵房间视图、内容区不会漂成 `RoomPanel('new')`。
- `followActive()`（`:705-728`）只跟进 `dsh-meeting-room:result:` 前缀（点结果页签时同步房间与 `rightGoal`）；其余情况一律保留面板内部模式。
- `backToConversation()` = `layout.selectPanel(null)`（`:495`）。

### 8.2 主题 token 与聊天页

- 颜色常量表 `client.js:36-52` 全部走官方 token，**没有** `#fff` / `var(--surface-primary,…)` / `color:'inherit'`（`grep` 命中 0）。
  用到的：`--dsw-alias-border-l1/-l2`、`--dsw-alias-bg-layer-1/-2`、`--dsw-alias-bg-overlay`、`--dsw-alias-label-primary/-secondary/-tertiary/-primary-inverted`、
  `--dsw-alias-brand-primary`、`--dsw-alias-state-success/-warn/-error/-idle-primary`、`--dsw-alias-interactive-bg-hover`、`--dsw-specific-sidebar-fill`。
- 消息行 `S.msg` 无 `border`（`:89`）；`mine = author.kind === 'user'` → `S.msgUser`（`alignItems:'flex-end'`）+ `S.bubbleUser`（底色 `LAYER2`、圆角 10、`maxWidth:'78%'`）；
  其它 → `S.msgOther` + `S.bubbleOther`；系统行 → `S.bubbleSystem`（灰、斜体）（`:90-94`、`:1235-1258`）。
- 名字颜色 `nameColor(key)`：稳定哈希（`hash*31 + charCode`）取 `NAME_COLORS = [ACCENT, OK, WARN, DANGER, IDLE, MUTED]`（`:144-155`）；同一 label/sessionId 恒定同色。
- 「策划会议」抽屉 `PlannerDrawer`（`:1261-1277`）内含目标 / 与会者 / 记录员 / 投递与思考程度 / 会议控制；
  `DrawerRecorder`（`:1411-1458`）不再有「选一个会话当记录员」，只显示 `记录员（内置 AI）` + 提示词编辑（房间级 / 全局默认两张按钮）；
  设置面板（`:1017`、`:1052-1053`）只提交 `category` / `prompt`（注释明确 `recorder` 恒 400）。
- 邀请列表（`:1401-1403`）：离线标「离线」，已在房间显示「已在房间」且不给重复加入按钮。

## 9. 工具（Host → 与会者 AI，12 个）

`room_list`、`room_archive`、`room_join`、`room_leave`、`room_say`、`room_read`、`room_files`、`room_open`、
`room_goal_report`、`room_result_write`、`room_request_reopen`、`room_finalize`（`index.js:2552-2871`，注册于 `:2873`）。
工具数 **12 不变**；v4 唯一语义变化：**`room_result_write` 对 AI 与会者一律禁用**，只回中文提示（`index.js:2783-2807`）。
仍然**没有** `room_recorder` 工具 —— 与会者 AI 无法自行指派记录员（v4 起也没人能指派）。

## 10. 配置项（cordis config，`index.js:53-60`）

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `~/.dsh/meeting-room` | 状态根（只放 `rooms.json` / `settings.json`） |
| `category` | `~/dsh/会议` | 新房间默认分类目录 |
| `roomId` | `main` | 默认会议室 id（v1 兼容路径用） |
| `maxReadMessages` | `40` | `room_read` 默认条数；**同时是内置记录员取证的条数上限** |
| `maxReadChars` | `40000` | `room_read` 默认字符数；**同时是记录员取证的字符上限** |
| `autoCloseGoals` | `false` | 预留，当前未启用 |

加载日志（`index.js:2890`）：
`[dsh-meeting-room] v4 已加载：状态根=<root>，会议文件目录=<category>，默认会议室=<roomId>（记录员=内置 AI；/sessions 只列顶层会话）`

## 11. 钩子契约（v4.1 事故固化：waterfall 钩子必须返回 `next()` 的结果）

本插件往 agent 上注册两个 **waterfall 钩子**（`agent/pre-step`、`agent/request`），注册点在
`index.js` 的 `EffortControl.ensure()`（修后 `:1629-1679`，两条注册语句在 `:1671-1672`）。
waterfall 的语义是：钩子拿到 `next`，**必须把 `next()` 的结果原样返回**；不调用 `next()` 时，钩子自己的返回值就会被当成最终结果。

| 项 | 契约 |
|---|---|
| `agent/pre-step` | `(payload, next) => …`，每条分支都必须 `return next()`；缺 `next` 时返回**合法决策对象** `{ kind:'enter', messages }`（`:1642`、`:1651-1652`），**绝不返回 `undefined`** |
| `agent/request` | `async (payload, next) => { const resolved = await next(); … }`，返回 `resolved` 或 `{ ...resolved, reasoningEffort }`（v4 起写法本就正确，`:1654-1669`） |
| 违反后果 | `dsh-agent-loop` 的 `preStep()`（`dsh-agent-loop/lib/index.js:903-926`）把 waterfall 结果赋给 `decision`，紧接着在 **`:921`** 读 `decision.kind` → 抛 `TypeError: Cannot read properties of undefined (reading 'kind')`；`turn/end` 带 `reason.kind='error'`、`code:"UNKNOWN"`，**走不到 `step/start`** ⇒ 用户看到与会者每一轮立刻「处理失败 / 本轮运行失败」 |
| 触发条件 | 只有「该房间级或该成员级**思考程度 ≠ `inherit`**」时才会挂钩子（`effective()` `:1598-1603`；`relayWithEffort()` 在 `:1342-1348` 调 `this.effort.prepare()`）。所以房间 `reasoning:"high"` 会让**整房成员**中招；房间 `inherit` + 某成员 `reasoningByMember[...]="low"` 只让**那一个成员**中招 |
| 修复锚点 | `EffortControl.onPreStep`（修后 `:1636-1653`，其中 `:1636-1639` 是固化该契约的注释）：`:1640` 声明 `next` 形参、`:1642` 缺 `messages` 时兜底、`:1651-1652` 缺 `next` 时返回 `{kind:'enter',messages}`，否则 `return next()` |
| 生命周期 | 钩子实例经 `rec.disposers` 挂在插件 scope 的 `agentCtx.on(...)` 上；**旧（坏）钩子只在插件 scope 被 dispose 或 DSH 重启后消失** —— 改盘上文件、甚至让插件重新加载（`cordis.yml` mtime 变化），都不保证运行进程内存里的旧钩子实例消失 |
| 回归护栏 | `selftest/run.mjs`「思考程度真正生效」段新增 4 条断言：① 钩子声明了 `next` 形参；② 用忠实复刻的 waterfall 链调用**真实注册的钩子**后 `decision.kind` 可读（旧版此条必崩）；③ 下游 `{kind:'reject'}` 被原样透传；④ 缺 `next` 时仍返回合法决策。全量自测 `321 → 325 项：通过 325，失败 0` |

> 写新钩子时的自检：函数签名里有没有 `next`？每条 `return` 路径是不是都经过 `next()`（或缺 `next` 时给了合法决策）？
> 返回 `undefined` 的钩子不是「什么都不做」，而是**把整轮 agent 运行打断**。

## 12. 变更记录

- v4.1（2026-09-29，包版本 `0.4.1`，热修）：
  修复 `agent/pre-step` 钩子返回 `undefined` 导致与会者每轮「本轮运行失败（`Cannot read properties of undefined (reading 'kind')`）」——
  `EffortControl.onPreStep` 改为把 `next()` 的结果原样返回（缺 `next` 时兜底返回合法决策），并加 4 条回归断言（契约见 §11）。
  **修复需重启 DSH（或完整重载插件 scope）才生效；重启前进程内存里可能残留旧钩子。**
- v4.0.0（2026-09-29，包版本 `0.4.0`）：
  ① 左侧只留一个「会议室」入口，分类 / 房间 / 新建 / 设置全在面板内部；
  ② 面板内导航 `goInternal()`，点房间右侧直接出内容；
  ③ 客户端颜色全量改用官方主题 token（修掉浅色主题下的白底白字）；
  ④ 记录员改为**每个房间自带的内置 AI**：`POST /rooms/:id/recorder` 与 `PATCH /settings {recorder}` 恒 `400`，
     目标达成 / 散会时由内置记录员自动生成草稿（`503` 失败路径不落半成品）；
  ⑤ `GET /sessions` 默认只列顶层会话并返回 `{total, filtered}`；
  ⑥ 聊天页去方框、我的消息靠右、与会者名字分色。
  另：`room_result_write` 对 AI 与会者禁用；已发布结果再写草稿 / 再 approve → `409`。
- v3 → v4 回退禁止：分类折叠、归档、`purge` 护栏、12 个工具、路径护栏（大小写 / 真实路径 / 文件身份）、
  v1 兼容端点、结果审核流程，全部不许回退。
- 历史契约：`docs/v3-API.md`（v3 权威口径）、`docs/v2-API.md`（v1/v2 遗留语义）。

## 13. 核对说明与未核实项

逐条核对过的锚点（`index.js`）：`:14`、`:16-17`、`:18-24`、`:25-31`、`:33-40`、`:43-51`、`:53-60`、`:428`、`:529-531`、`:533-544`、
`:558-587`、`:589-606`、`:684-692`、`:698-719`、`:722-747`、`:750-784`、`:790-831`、`:840-897`、`:899-934`、`:1342-1348`、`:1404-1477`、`:1483-1506`、
`:1598-1603`、`:1629-1679`、`:1636-1653`、`:1671-1672`（以上 v4.1 钩子契约，均在 v4.1 快照上重核）、
`:1890-1906`、`:1928-1936`、`:1953-2064`、`:2069-2072`、`:2157-2186`、`:2187-2208`、`:2209-2320`、`:2321-2414`、`:2415-2421`、`:2422-2431`、
`:2505-2514`、`:2558-2877`、`:2789-2813`、`:2896`（**v4.1 之前核的行号已整体 +6**，因为 `:1636-1653` 处新增 6 行）。

核对过的宿主侧锚点（`@deepseek-ai/dsh-agent-loop`，本地副本 `C:\Users\uyiop\dsh\.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`，
72219 B / 1967 行 / SHA1 `699AD14A22F16236F6E3B3675927B16CCBEB57C3` / `0.1.7-rc.2`）：`:903-926`（`preStep()` 里的 waterfall 调用）、`:921`（`decision.kind`）。

核对过的锚点（`client/client.js`）：`:17-24`、`:36-52`、`:89-99`、`:144-155`、`:488-521`、`:593-601`、`:605-650`、`:654-689`、
`:705-728`、`:1017`、`:1052-1053`、`:1069-1078`、`:1235-1258`、`:1261-1277`、`:1401-1403`、`:1411-1458`、`:1546-1555`。

**未核实（不要当事实引用）**：

1. **真机观感**：浅色/深色主题下的实际配色、点击动效、气泡左右对齐的肉眼效果 —— agent 看不到屏幕，需重启 DSH 后由用户目视。
2. **真机槽位占用**：`sidebar.panellist` 只剩 1 条、`main` 只有 1 面板 + N 个结果键，是按代码（`client.js:593-601`、`:664-676`）读出来的；
   没有在本机 GUI 上用 `cordis_inspect_query` 复核实时 Slot 树。
3. **模型侧端到端**：内置记录员真实调用默认模型产出的正文质量、`evidence` 是否覆盖全部相关结论 —— 自测用假 `llm` 桩；
   真模型只在「用户重启 DSH 后实际点『标记达成』」时才会跑到。
4. **自测项数**：v4.1 快照上实测两次 `合计 325 项：通过 325，失败 0`（exit 0，`selftest/run.mjs` 167690 B / SHA1 `3D8CFA441786031E5B2741889921D3A6EBBC64D5`）；
   换机器 / 改代码后以重跑出来的最后一行为准（见 README §11）。
5. **`delivered` 真实到达效果**：依赖宿主 `agents`，自测用 stub，本契约只描述语义。
6. **宿主 `dsh-agent-loop` 行号来源**：`:903-926` / `:921` 取自本机副本 `C:\Users\uyiop\dsh\.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`（`0.1.7-rc.2`），
   与 `docs\v4-方案.md` §6.8 的现场定位一致；**运行进程 asar 包内的同一文件未逐行比对**（本机 `_npx` 下另有两份不同版本的副本，行号不同）。
7. **v4.1 修复的真机效果未端到端**：自测用忠实复刻的 waterfall 链验证钩子契约；「重启后受害会话的后续轮次恢复正常」需用户重启 DSH 后目视。
