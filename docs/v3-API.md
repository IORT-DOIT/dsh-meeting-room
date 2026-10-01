# dsh-meeting-room v3 API 契约

> v3 = 在 v2（多会议室 / 踢人 / 投递策略 / 会议目标 / 记录员与《会议结果》/ 后可重开）之上，
> 落实用户 2026-09-28 的五条需求：工作区式分类面板、聊天室式界面 + 「策划会议」抽屉、
> 邀请列表显示真实会话名、去掉记录员自动指派改为默认 AI + 可改提示词、文件全部离开桌面。
>
> 本文件是实现与客户端/自测的唯一契约。改动必须同步：`index.js`、`client/client.js`、
> `selftest/run.mjs`、`README.zh.md`、`docs/v2-API.md`。

## 1. 目录模型（需求 1 / 5）

| 概念 | 默认值 | 说明 |
|---|---|---|
| 状态根 `stateRoot` | `~/.dsh/meeting-room` | 只放登记与设置：`rooms.json`、`settings.json` |
| 默认分类 `defaultCategory` | `~/dsh/会议`（即 `C:\Users\uyiop\dsh\会议`） | 新会议室的默认「会议文件放置位置」的父目录 |
| 房间分类 `category` | = `defaultCategory` | 绝对路径。面板按它分组（一个分类 = 一个可折叠分组） |
| 房间目录 `dir` | `join(category, id)` | 该会议室全部会议文件的落地目录（`files/`、`results/`、`transcript.jsonl`、`room.json`、`goals.json`、`members.json`） |

- `room.dir` 是绝对路径，`category = dirname(dir)`；新建时可直接给 `dir`（= 房间自己的目录，优先于 `category`；目录名允许 ≠ 房间 id）。
- `dir` 会写进两处：`room.json`（房间自述）与 `rooms.json`（索引条目）。重启时的 dir 优先级是
  **构造时显式给的 dir（`POST {dir}` / 索引里的 `dir` / 目录扫描结果）→ `room.json` 里的 `dir` → 按 `category` 推导**，
  每一路都要过 `assertSafeTarget`，不安全的来源只 `warn` 并退回推导。
- **目录护栏**（`assertSafeTarget` / `isOwnRoomDir` / `isRoomDataDir`）：房间目录指向受保护位置
  （状态根 **及其父目录**（默认 `~/.dsh`）、用户主目录、进程工作目录、盘根，以及主目录/cwd/状态根的**上级**）→ `400`；
  **也不允许落在状态根内部**（状态根只放两个 json），
  **父目录**同样不能是盘根 / 主目录 / cwd / 状态根 / 状态根的父目录（避免直接在 `C:\`、用户主目录或 `~/.dsh` 下凭空建房间）。默认分类目录本身是合法父目录。
  另外：当状态根本身就位于「用户主目录下的隐藏配置目录」内部（默认 `~/.dsh/meeting-room`）时，**该配置主目录（`~/.dsh`）内部的任何位置**都不允许当会议室目录或分类目录
  （`POST /rooms`、`PATCH /rooms/:id`、`PATCH /settings {category}` 一律 `400`，且不 `mkdir`、不改内存、不登记）。
  这一条是定向的：**不**把「状态根父目录的内部」一刀切禁掉 —— 状态根可能被放在普通工作目录里（自测/探针夹具就是这种形状），一刀切会连正常用法一起挡掉。
- **路径比较一律折叠大小写 / 解析真实路径**（`foldPath` / `samePath` / `insidePath` / `sameOrInside` / `realPathDeep` / `realPathOf`）：
  Windows 文件系统大小写不敏感，而字符串比较是大小写敏感的，因此 `~/.DSH/meeting-room`、8.3 短名、junction/符号链接
  这类「等价路径」曾经可以绕过护栏（极端情况：`POST { id: 'meeting-room', dir: '…/.DSH/meeting-room' }` 成功登记后
  `DELETE ?purge=1` 会把整个状态根 `rm -rf`）。现在：
  ① 所有护栏比较都先 `resolve` + 折叠大小写（返回值仍是**原始大小写**路径，不受影响）；
  ② `assertSafeRealTarget` 会额外解析「最近存在的祖先」的真实路径（消除短名/软链/junction）并再校验一次，
     `POST /rooms`、`PATCH /rooms/:id`、`PATCH /settings {category}`、`room.json`/索引里的 `dir` 复原都走它；
  ③ `purge` 真正 `rm` 之前用 `realpathSync.native` 复校，复校不过就只删登记（`purged: false`）并 `warn`。
  `PATCH {category|dir}` 的顺序是：先判「目标/父级是否已是文件」（`目标不是目录` / `父级不是目录`），再判位置安全，两者都不碰内存。
  搬移（`PATCH {category|dir}`）用较宽的 `isRoomDataDir`：目录名 == 房间 id，**或**该目录 `room.json` 里的 `id` 就是本房间（改名过的房间也能搬干净）；
  `purge` 删除只用严格的 `isOwnRoomDir`（目录名必须 == 房间 id），避免 `rm -rf` 用户指定的共享目录 —— 不满足时 `DELETE ?purge=1` 回
  `{ deleted: true, purged: false, reason: '…' }`，只删登记、文件保留。
- **索引自愈**：`rooms.json` 只是索引。启动时除了状态根，还会扫 `settings.category` / `defaultCategory` / 各登记房间的 `category`
  下的 `<分类>/<房间目录>/room.json`，**以 `room.json` 里的 `id` 为房间标识**（目录名可以是别的，不会被当成第二个房间），
  把没登记的房间重新收养；索引里缺 `dir` 的老条目也会补齐。收养/补写发生在 `start()` 里并**立即 `await` 落盘**（不等 250ms 防抖）。
- 迁移：房间 meta 里没有 `dir` 时按上式算出目标目录；若目标不存在而旧目录 `stateRoot/<id>` 存在，
  则把旧目录整体搬到目标（`rename`，跨卷回退 `copyFile`+删）。迁移只做一次，完成后写回 `room.json`。
- 插件源码安装位置：`C:\Users\uyiop\dsh\dsh-meeting-room`（`link:` 安装到 profile）。

## 2. 设置 `settings.json`（需求 4）

```json
{
  "category": "C:\\Users\\uyiop\\dsh\\会议",
  "recorder": { "sessionId": "...", "label": "..." },
  "prompt": "【会议室 {{room}}】目标「{{goal}}」已达成，请你作为记录员写《会议结果》。…",
  "updatedAt": 1790000000000
}
```

- `recorder`：默认记录员 AI。**不再自动指派**（v2 的「空 sessionId → 从在线成员里挑一个」已删除）。
- `prompt`：记录员提示词模板，支持 `{{room}}`、`{{goal}}`、`{{goalId}}` 占位符，用户可在「策划会议 → 记录员」里改。
- 房间级覆盖：`room.prompt`（非空则优先于 settings.prompt）；`room.recorder`（非空则优先于 settings.recorder）。
- 新房间创建时若 `settings.recorder` 已设置，则自动写入该房间的 `recorder`。
- **继承时机（实现口径）**：房间加载（`Room.load()`）时若自身没有 `recorder`，会把 `settings.recorder` 写进该房间的内存态（随后随落盘生效）——
  即「默认记录员」对**既有房间**同样生效，不只是新建房间。想解除某个房间的默认记录员，用 `POST /rooms/:id/recorder` 指定别的会话，或让记录员 `leave` / 被 `kick`。

### 2.1 行为边界（实现已如此，别再按直觉猜）

| 场景 | 实际行为 |
|---|---|
| `GET /browse?path=` 指向不存在或文件 | 逐级向上回退到**最近存在的祖先目录**（最多 12 级），响应里的 `path`/`exists` 是回退后的结果 |
| `PATCH /rooms/:id {category\|dir}` 目标目录已存在 | 走 `moveDir`（rename 失败则递归合并复制），**同名文件以本房间的副本覆盖**目标里的旧文件 |
| `PATCH /settings {category}` | 只改默认分类并 `mkdir`，**不搬已有房间**（每个房间有自己的 `category`/`dir`） |
| `PATCH /settings {prompt}` 传空串 | 重置为内置默认提示词；不区分「从未自定义」与「恢复默认」（两者取值相同） |
| `room_archive` 的 `archived` | 归一化：`false` / `'false'` / `0` / `'0'` 视为取消归档，其余（含缺省）视为归档 |
| `GET /sessions` 缓存 | 端点**每次真查**（面板要立刻看到新建会话）；30 秒 TTL 只作用于宿主内部取名（`sessionLabel`），含空列表结果 |
| `POST /rooms {dir}` | `dir` = 会议室**自己的目录**（完整路径，优先于 `category`）；目录名允许 ≠ 房间 id；若该目录已有别的会议室的 `room.json` → 409 |
| `PATCH /rooms/:id {dir}` 改完 | `room.json` 与 `rooms.json` **立即**落盘（不等防抖）；旧目录若是本房间的数据目录（`isRoomDataDir`）就整体搬走，否则只切目录并在日志里 `warn` |
| `DELETE /rooms/:id?purge=1` 但目录名 ≠ 房间 id | `purged: false`，只删登记，磁盘文件保留（`reason` 说明原因） |
| `GET /rooms` 里的 `dir` 字段 | = 该房间当前实际落地目录；与 `category` 一起透出，客户端按 `category` 分组 |
| 无记录员时的 `room_result_write` | 直接拒绝（提示去「策划会议 → 记录员」指定），避免默认配置下任何 AI 都能写草稿 |
| 状态根在 `~/.dsh` 内（默认）时，把会议室/分类指到 `~/.dsh/<任意子目录>` | `400`（`会议室目录不能放在 DSH 配置目录内部（…）` / `分类目录不能放在 DSH 配置目录内部（…）`），不 `mkdir`、不改内存、不登记；`~/.dsh` 本身同样 `400` |
| 状态根在普通目录里（如 `<tmp>/root`，自测夹具） | **不受**上一条限制：`<tmp>/cat/会议/<id>` 这类「状态根父目录的内部」照常 200（护栏是定向的，只针对主目录下的隐藏配置目录） |
| 「状态根父目录」这条保护的适用条件 | **形状相关**：只有当状态根位于「用户主目录下的隐藏配置目录」内部时 `configHome()` 才非 `null`（真机默认 `~/.dsh/meeting-room` ⇒ `configHome() = ~/.dsh`）；否则该目录内部（如 `<tmp>/其他分类/MyMeetings`）是合法的。写探针时注意 `USERPROFILE`/`HOME` 的还原时机 —— 过早还原成真实主目录会让形状翻转、同一用例从 `400` 变成 `200`（独立验证轮 N10 曾因此误红）。无条件禁掉「状态根父目录的内部」会误伤自测/探针那类合法布局，故实现保持不变 |
| 用大小写翻转 / 8.3 短名 / junction 拼出「等价路径」（如 `~/.DSH/meeting-room`、`<junction→~/.dsh>/meeting-room`） | `400`（比较折叠大小写 + 解析真实路径）；`POST` 不 `mkdir`、不登记，`DELETE ?purge=1` 即使房间已存在也只删登记（`purged: false`） |
| 目标目录与房间 id 同名、恰好就是状态根本身（`POST { id: 'meeting-room', dir: '…' }`） | `400`（`会议室目录不能放在插件状态根里`）；不会出现「登记成功 → purge 掉状态根」 |

## 3. 端点总表

统一前缀 `/dsh-room`。v1 兼容是 **`/dsh-room/<旧端点>`**（`state|post|join|leave|kick|close|adjourn|reopen|goals|results|result|recorder|reasoning|upload|raw|files|finalize`）
映射到默认房间（`config.roomId`，默认 `main`），**没有** `/dsh-meeting-room` 这个前缀。所有请求要求回环来源
（`Host`/`Origin` 校验、`sec-fetch-site: cross-site` 拒绝）。JSON 响应；出错返回 `{ error }` + 4xx/5xx。

### 3.1 总览与设置

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/rooms` | – | `{ rooms: RoomSummary[] }`（**含已归档**，按 `category` 再按 `updatedAt` 排序） |
| POST | `/rooms` | `{ id?, title?, goal?, category?, dir?, recorder?, recorderLabel? }` | `{ room: RoomSummary }` |
| GET | `/settings` | – | `{ settings: Settings, defaultCategory, defaultPrompt }` |
| PATCH | `/settings` | `{ category?, recorder?, prompt? }` | `{ settings: Settings }` |
| GET | `/sessions` | – | `{ sessions: SessionItem[] }`（**真实标题**，见 §5） |
| GET | `/browse` | query `path?` | `{ path, parent, dirs: [{ name, path }] }`（挑分类目录用；默认从 `defaultCategory` 起） |
| GET | `/rooms/:id/state` | query `since?` | `{ room, root, seq, members, messages, files, goals, results, push, reasoning, resolution, settings? }` |

### 3.2 房间

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| PATCH | `/rooms/:id` | `{ title?, category?, dir?, archived?, push?, reasoning?, prompt?, reopenRequest? }` | 改标题/换分类目录/归档(`archived:true|false`)/投递/思考程度/记录员提示词 |
| DELETE | `/rooms/:id` | query `purge=1` | 删除登记；`purge=1` **仅当房间目录名 = 房间 id 且不在受保护位置**时才真删文件，否则回 `{ deleted:true, purged:false, reason }` 只删登记 |
| POST | `/rooms/:id/close` | `{ title?, body? }` | 散会（v2 语义） |
| POST | `/rooms/:id/adjourn` | `{ recorder? }` | 散会并要求记录员整理（记录员不在线 → 409） |
| POST | `/rooms/:id/reopen` | `{ by?, reason?, sessionId?, label? }` | `by:'user'`（默认）直接重开；`by:'member'` 只写 `reopenRequest`（**没有** `reopen-request` 端点） |

### 3.3 成员 / 消息 / 文件

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/rooms/:id/join` | `{ sessionId, label? }` | 加入 |
| POST | `/rooms/:id/leave` | `{ sessionId }` | 退出（记录员退出会清空记录员） |
| POST | `/rooms/:id/kick` | `{ sessionId, reason?, notify? }` | 踢人（需求 ①） |
| POST | `/rooms/:id/post` | `{ text, label?, mode?, to?, files?, pushAll? }` | 发言；`mode ∈ archive/notice/full` |
| POST | `/rooms/:id/reasoning` | `{ level, sessionId? }` | 房间级或成员级思考程度；成员级 `inherit` = 删覆盖 |
| POST | `/rooms/:id/upload` | `{ name, base64 }` | 上传（≤8MiB） |
| GET | `/rooms/:id/raw` | query `name` | 下载房内文件 |
| GET | `/rooms/:id/files` | – | `{ files: [{ name, bytes, at }] }`（`at` = mtime 毫秒；`transcript.md` 是房间目录里的文件，请用 `/raw?name=transcript.md` 取） |
| POST | `/rooms/:id/finalize` | `{ title, body, force? }` | v1 兼容的散会决议（写 `决议.md` + `resolution-state.json`；已交付且未 `force` → 409） |

### 3.4 目标 / 记录员 / 结果

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET/POST | `/rooms/:id/goals` | `{ text }` | 列目标 / 新建目标 |
| PATCH | `/rooms/:id/goals/:gid` | `{ text?, status? }` | 改名 / 标记状态（`open`/`active`/`done`；`status:'active'` 同时切换当前目标） |
| POST | `/rooms/:id/goals/:gid/complete` | `{ note? }` | 完成目标并请记录员写草稿 → `{ goal, recorder, asked, reason, failed, already? }` |
| POST | `/rooms/:id/goals/:gid/reopen` | `{ reason? }` | 再议 |
| GET/POST | `/rooms/:id/recorder` | `{ sessionId, label? }` | **v3：sessionId 必填**；空 → `400 {error:'请先指定记录员 AI（v3 不再自动指派）'}` |
| GET | `/rooms/:id/results` | – | 结果列表 |
| GET | `/rooms/:id/result` | query `goalId` | 单个结果的 markdown |
| POST | `/rooms/:id/results/:gid/draft` | `{ title, body, by? }` | 记录员写草稿（非本房记录员 403） |
| POST | `/rooms/:id/results/:gid/approve` | `{ by?, note? }` | 发布（已发布 → 409）；逐成员分节投递 |
| POST | `/rooms/:id/results/:gid/reject` | `{ note, by? }` | 驳回回草稿（note 必填） |

## 4. 数据结构

```ts
type RoomSummary = {
  id: string; title: string; status: 'open' | 'closed';
  createdAt: number; updatedAt: number; closedAt: number | null;
  category: string;          // v3：分组键（绝对路径）
  dir: string;               // v3：会议文件目录（绝对路径）
  archived: boolean;         // v3
  archivedAt: number | null; // v3
  memberCount: number; liveCount: number; messageCount: number; seq: number;
  goalCount: number; doneGoalCount: number; resultCount: number;
  activeGoalId: string | null; activeGoalText: string | null;
  recorder: { sessionId: string; label: string } | null;
  prompt: string | null;     // v3：房间级记录员提示词覆盖
  push: 'off' | 'notice' | 'full'; reasoning: 'inherit' | 'low' | 'medium' | 'high';
  reopenRequest: { reason?: string; at: number; label?: string } | null;
};

type SessionItem = {
  sessionId: string; label: string;   // label = 真实会话标题（工作区里显示的那个）
  live: boolean; persisted: boolean;
  cwd: string | null;                 // 会话工作目录（用于显示分组提示）
};
```

- `members[]`：`{ sessionId, label, joinedAt, role?, reasoning, live }`。
- `messages[]`：`{ seq, at, kind, text, author: { kind, id, label }, targets?, files? }`。
- `goals[]` / `results[]`：同 v2（`result` 含 `title/file/status/at/body/excerpt/approvedBy/publishedAt/note/goalId/goalText`）。
- `files[]`：`{ name, bytes, at }`（`at` 就是 mtime 毫秒；`GET /rooms/:id/state` 与 `GET /rooms/:id/files` 同形）。

## 5. 真实会话名（需求 3）

`GET /sessions` 的 `label` 依次取：

1. `ctx.sessionQuery.readTitleSnapshots(ids)` —— **注意返回结构是 settled 结果数组**：
   `[{ status:'fulfilled', value:{ session:{id,...}, title? } } | { status:'rejected', reason }]`，
   标题在 `value.title`、会话在 `value.session.id`。（v2 误读成 `s.id`/`s.title`，所以恒回落。）
   **0.2.0-rc.1 起 `value.title` 不再是字符串，而是快照对象**
   `SessionTitleSnapshot = { title: string; messageSeqs; source; eventSeq; updatedAt }`
   （宿主类型：`SessionTitleObservation { session: SessionHeader; title?: SessionTitleSnapshot }`）。
   因此实现同时兼容两种情况：字符串直接 `trim()`，对象取 `.title`：
   `const rawTitle = value.title ?? value.session?.title ?? item.title;`
   `const title = typeof rawTitle === 'string' ? rawTitle.trim() : String(rawTitle?.title ?? '').trim();`
   —— 旧代码 `typeof value.title === 'string'` 在 rc.1 上永远为假，会导致真名全丢、面板恒显示「会话 xxxxxxxx」。
2. `header.title`（`listSessions()` 记录的 `header.title`，rc.1 的 `SessionHeader` 里其实**没有**这个字段，故通常为空）。
3. 兜底 `会话 <id 前 8 位>`。

标题缓存分两层（实现口径）：

- **宿主内部取名**（`sessionLabel()`，用于 `POST /rooms/:id/recorder` 给非成员填 label 等）：走 30 秒 TTL 缓存，含空列表结果，避免每次取名都扫一遍标题。
- **`GET /sessions` 端点**：**每次都真查**（`host.sessions(true)`）——面板点开「邀请会话窗口」时要能立刻看到刚建的会话，不能被 30 秒缓存挡住。`listSessions` 自身在宿主里有 3 秒缓存，所以也不算重活。
- `readTitleSnapshots` 抛错时只丢标题、不影响列表，并 `warn()` 一行。
- **退化结果（`sessionQuery` 不可用 / `listSessions` 抛错）不写进缓存**：否则 30 秒内即使服务恢复，会话名与记录员 label 也会一直回落成短 id（真实症状：记录员标签显示 `会话 session-`）。

## 6. 客户端改造要求（需求 1 / 2 / 3）

面板（`sidebar.panellist`）：

- 结构对齐官方「工作区」：标题行 + 右上角图标（新建会议室 `＋`）；下面是**按 `category` 分组的树**，
  组标题 = 目录显示名（取 basename，末段为 `会议` 时显示「会议」）+ 房间数 + 折叠箭头，组内是房间行。
- 房间行：状态点（进行中/已结束/归档）、标题、右侧时间（相对时间）；行尾 `⋯` 菜单 =
  打开 / 重命名 / 换分类目录 / 在文件夹中打开 / 归档·取消归档 / 删除。
- 归档房间收进底部可折叠的「已归档」组。
- 「已结束」「归档」视觉弱化；多人/未读不要求。

会议室主体（`main`，聊天室式）：

- 顶部只留：房间标题 + 状态 + 人数 + （可选）记录员名；**右上角一个「策划会议」按钮**。
- 中间是消息流（保持 v2 渲染），底部 composer 与 v2 一致（投递方式收进抽屉里的「默认投递方式」）。
- 「策划会议」抽屉/弹层里放：会议目标（新建/改名/激活/标记达成/再议）、与会者（邀请、踢人、逐人思考程度）、
  **记录员 AI（选择会话 + 可编辑提示词 textarea + 保存）**、投递与思考程度默认值、会议控制（散会 / 重开 / 归档 / 删除）。
- 邀请列表（`GET /sessions`）必须显示真实标题；离线会话标注「离线」，保留加入按钮。
- 《会议结果》右侧页签与审核流程保持 v2。

## 7. 工具（Host → 与会者 AI）

12 个 `room_*` 工具：v2 的 11 个保持不变，只有行为调整 + 新增 1 个。

- `room_list`：输出追加 `目录 <dir>`、`已归档` 字段；仍列出全部房间（含已归档）。
- `room_archive(roomId, archived)`：**v3 新增**，归档 / 取消归档（等价 `PATCH /rooms/:id {archived}`）。
- **没有 `room_recorder` 工具**（v2 也没有）：记录员只能由**用户**通过 `POST /rooms/:id/recorder`
  或 `PATCH /settings {recorder}` 指定，与会者 AI 无法自行指派，也不再自动挑人。

## 8. 变更记录

- v3.0.0（2026-09-28）：分类目录 + 归档 + 删除；`/settings`；真实会话名修复；
  记录员不再自动指派（默认 AI + 可改提示词）；插件源码与产物迁出桌面。
- v3.0.1（2026-09-29）：兼容 DSH **0.2.0-rc.1** —— 标题快照 `value.title` 变成对象（见 §5）、
  退化列表不再污染 30 秒缓存、目录护栏新增文件身份（`dev:ino`）层。包版本 `0.3.0` → `0.3.1`。
- 实现期修复（Lead 冒烟发现）：`MeetingHost.sessionsCache` 之前只在 `Room` 里初始化，
  非 force 调用 `host.sessions()` 会抛 `TypeError`（被 `sessionLabel` 吞掉 → 默认记录员标签
  回落成短 id）。已在 `MeetingHost` 构造里补 `this.sessionsCache = { at: 0, list: [] }`。
- 契约校正（README 作者核对实现时发现，本文件按**实现实际行为**改正，未改代码）：
  `reopen-request` 端点不存在（改用 `POST /reopen {by:'member'}`）；v1 兼容是 `/dsh-room/<旧端点>`
  而非 `/dsh-meeting-room` 前缀；`GET /transcript`→`GET /files`、`POST /resolution`→`POST /finalize`；
  `PATCH /goals/:gid` 只认 `text`/`status`（`active` 语义由 `status:'active'` 承担）；
  `files[]` 的 mtime 字段名是 `at`（不是 `mtimeMs`）。
- 安全加固（Lead，冒烟 42/42）：新增 `assertSafeTarget()` / `isOwnRoomDir()`，
  `PATCH /rooms/:id {category|dir}` 与 `POST /rooms {category|dir}` 会拒绝受保护位置（400），
  `DELETE ?purge=1` 对「目录名 ≠ 房间 id」的房间只删登记并回 `purged:false`。
- 安全加固 2（等价路径，`v3-fcase.mjs` 35/35 + verifier M14–M22）：护栏比较一律折叠大小写（`foldPath`/`samePath`/`insidePath`/`sameOrInside`），
  再按真实路径（`realPathOf` 用 `realpathSync.native`、`realPathDeep` 向上找最近存在祖先）与**文件身份**（`stat` 的 `dev:ino`，`pathIdentity`/`isSameLocationAsAncestor`）
  复校，覆盖大小写翻转 / 8.3 短名 / 软链 / junction / `\\?\` 前缀 / subst 映射盘的别名绕过；`DELETE ?purge=1` 在 `rm` 前再复校一次，
  不通过则只删登记并 `warn()`。护栏返回的仍是**原始大小写路径**（不做规范化写回）。
- DSH 0.2.0-rc.1 重核验（Lead，Inspect 取证 + `v3-rc1-contract.mjs` 23/23）：宿主面 `sessionQuery` / `llm.resolveModelInfo` /
  `agents` / `webServer.register` / `tools.register` / `ctx.effect` 与两个 waterfall 钩子（`agent/pre-step`、`agent/request`）
  在 rc.1 仍成立；修掉 rc.1 暴露的**标题快照对象**缺陷（见 §5）与**退化列表污染 30 秒缓存**缺陷。
