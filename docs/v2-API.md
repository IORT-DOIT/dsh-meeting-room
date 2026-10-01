# dsh-meeting-room v2 —— Host HTTP / Tool 契约（冻结稿）

> 这份文档是 v2 的唯一接口约定：Host 半区（`index.js`）与浏览器半区（`client/client.js`）都按它写。
> 改接口必须同时改这份文档 + `selftest/run.mjs` + `README.zh.md`。

## 0. 总则

- 基址 `const API = '/dsh-room'`，Host 只注册**一条 prefix 路由** `{kind:'prefix', path:'/dsh-room'}`，内部自己解析子路径（`@deepseek-ai/dsh-host-webserver` 的 `WebRouteKind = 'exact' | 'prefix'`）。
- 所有房间相关端点写成 `/dsh-room/rooms/<roomId>/...`。
- **向后兼容**：v1 的无房间段路径（`/dsh-room/state`、`/post`、`/join` …）一律等价于「默认房间」（`config.roomId`，默认 `main`）。老 client / 老 selftest / 手工 curl 不能被打断。
- 请求校验顺序：**先校验方法与参数，再看状态门闩**（参数错 → 400，状态冲突 → 409）。
- 写盘顺序：先落 `transcript.jsonl`（唯一事实来源），再更新内存与镜像 `.md`。
- 响应都是 JSON（`/raw` 除外）；错误体形如 `{"error":"……"}`。

## 1. 磁盘布局

```
<root>/rooms.json                      # 房间注册表 [{id,title,createdAt,updatedAt,status,closedAt,order}]
<root>/<roomId>/room.json              # {id,title,createdAt,updatedAt,status:'open'|'closed',closedAt,
                                       #  push:'off'|'notice'|'full', reasoning:'inherit'|'low'|'medium'|'high',
                                       #  reasoningByMember:{[sessionId]:level}, recorder:{sessionId,label}|null,
                                       #  activeGoalId:string|null, reopenRequest:{by,label,at,reason}|null}
<root>/<roomId>/goals.json             # [{id,text,status:'open'|'active'|'done',createdAt,updatedAt,doneAt,
                                       #   result:{title,file,status:'draft'|'approved'|'superseded',at,approvedBy,publishedAt,note}|null,
                                       #   history:[{at,by,action,note}]}]
<root>/<roomId>/results/<goalId>.md    # 记录员产出的《会议结果》正文（草稿→发布同一文件，draft 时带 `_草稿_` 头）
<root>/<roomId>/transcript.jsonl       # 消息真源
<root>/<roomId>/transcript.md          # 人读镜像
<root>/<roomId>/members.json           # [{sessionId,label,joinedAt,role?}]（role:'recorder' 可选）
<root>/<roomId>/files/                 # 交接文件只读副本
<root>/<roomId>/决议.md                 # v1 遗留单一决议（保留可读，不再新增）
<root>/<roomId>/resolution-state.json  # v1 遗留门闩
```

- `rooms.json` 不存在时自动发现：`<root>/` 下任何含 `transcript.jsonl` 或 `members.json` 的子目录都收养为房间（`status:'open'`），并写下 `rooms.json`。
- 新房间目录名 = `id`（安全字符），标题另存 `title`。

## 2. 房间

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-room/rooms` | `{rooms:[RoomSummary], defaultRoomId}` |
| POST | `/dsh-room/rooms` | body `{title?, goal?, id?}` → `{room:RoomSummary}`；`goal` 非空则同时创建第一条会议目标 |
| PATCH | `/dsh-room/rooms/:id` | body 任意子集 `{title, goal, push, reasoning}` → `{room}`；`goal` 是「改当前（active）目标文案」的快捷方式 |
| POST | `/dsh-room/rooms/:id/close` | 结束会议（`status:'closed'`，记录保留）→ `{room, results:[ResultView], delivered}` |
| POST | `/dsh-room/rooms/:id/reopen` | body `{by:'user'|'member', sessionId?, label?, reason?}`；user → 直接重开（`status:'open'`，清 `reopenRequest`）；member → 只写 `reopenRequest`，返回 `{requested:true, room}` |
| GET | `/dsh-room/rooms/:id/state?since=N` | 见 §3 |

`RoomSummary = {id,title,status,createdAt,updatedAt,closedAt,memberCount,liveCount,messageCount,seq,
goalCount,doneGoalCount,activeGoalId,recorder,push,reasoning,reopenRequest}`

## 3. `GET /dsh-room/rooms/:id/state?since=N`

```jsonc
{
  "room": { …RoomSummary… },
  "root": "C:\\Users\\uyiop\\.dsh\\meeting-room\\<id>",
  "seq": 12,                       // = max(messages[].seq)，按已进内存的消息现算
  "members": [{ "sessionId": "…", "label": "…", "joinedAt": 0, "live": true, "role": "recorder"|undefined }],
  "messages": [ …seq>N 的消息… ],
  "files": [{ "name": "…", "bytes": 0, "at": 0 }],
  "goals": [ …GoalView… ],
  "results": [ …ResultView… ],
  "resolution": null               // v1 兼容：默认房间的 决议.md 摘要（可空）
}
```

`GoalView = {id,text,status,createdAt,updatedAt,doneAt,result:ResultView|null}`
`ResultView = {goalId,goalText,title,file,status:'draft'|'approved'|'superseded',at,approvedBy,publishedAt,note,excerpt}`

## 4. 成员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dsh-room/rooms/:id/join` | `{sessionId, label?}`；已在册 → `already:true` 只更新显示名（不刷系统行）；离线会话也能加入 |
| POST | `/dsh-room/rooms/:id/leave` | `{sessionId}`；不在册 → `{removed:false}` 且不写行 |
| POST | `/dsh-room/rooms/:id/kick` | `{sessionId, reason?, notify?}` → `{members, removed, notified}`；**只踢房间登记，不动宿主会话**；写系统行 `X 已被移出会议室（原因）`；`notify:true` 时给被踢者投一条一行通知 |
| GET | `/dsh-room/sessions` | 全局：`{sessions:[{sessionId,label,live,persisted}], candidates, members}`（`members` 为默认房间成员，v1 兼容） |

## 5. 消息

`POST /dsh-room/rooms/:id/post`

| 字段 | 说明 |
| --- | --- |
| `text` | 必填，非空 |
| `label` | 人类显示名（默认 `我`） |
| `files` | 文件名或绝对路径；只有真实存在的房间副本才登记，其余进 `droppedFiles` |
| `to` | 显式接收者 sessionId 列表 |
| `pushAll` | `true` 时投给全体成员（v1 兼容） |
| `mode` | `'archive'`（只归档）/ `'notice'`（只投一行提示）/ `'full'`（投全文，v1 行为）；缺省取房间 `push` |

返回 `{message, delivered:[sessionId], failed:[{sessionId,error}], droppedFiles, mode}`。

**投递策略（用户 m01422 第 4 条）**：房间默认 `push:'off'`，人在会议室里发的指令**只归档、不进与会者上下文**。面板上的「唤醒与会者」按钮用 `mode:'notice'` 投一行：
```
【会议室 <标题>】有 <n> 条新消息（最新 #<seq>）。用 room_read 按需查看，然后简短回应；不要凭印象回答。
```
`mode:'full'` 才把正文投进去（点名/明确要求时才用）。

## 6. 会议目标

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dsh-room/rooms/:id/goals` | `{text}` → 新目标（`status:'open'`），若房间无 active 目标则设为 active |
| PATCH | `/dsh-room/rooms/:id/goals/:goalId` | `{text?}` / `{status:'active'}`（切换当前目标） |
| POST | `/dsh-room/rooms/:id/goals/:goalId/complete` | `{by?, note?}`；标记 `done`、写系统行、**触发记录员写草稿**（见 §7） |
| POST | `/dsh-room/rooms/:id/goals/:goalId/reopen` | `{reason?, by?}`；「再议」：状态回 `active`，旧结果标 `superseded`，写系统行 |

## 7. 记录员与《会议结果》

- 每个房间有一个**记录员角色** `recorder:{sessionId,label}`。房间里那句「记录员」不是 Lead，也不是「第一个入会的人」。
- 目标 `complete` 后 Host 给记录员发起一条任务消息（走后端 relay，`mode` 由房间 `push` 决定是否只发提示）：

```
【会议室 <标题>】目标「<目标文案>」已达成，请你作为记录员写《会议结果》。
1) 先用 room_read 读完整记录（since=0 读全量；不许凭印象）。
2) 只记录与会者与用户真实说过的结论/分工/待办/未决问题；**不得无中生有**，没提到的写「讨论中未结论」。
3) 按与会者分别成节：`## <成员显示名>`（没有专属结论的人写「本次目标与你无直接分工」）。
4) 用 room_result_write(roomId, goalId, title, body) 写草稿，等审核通过才发布。
```

- 记录员用工具 `room_result_write`（HTTP 等价：`POST .../results/:goalId/draft`）落草稿：`result.status='draft'`，同时把 `results/<goalId>.md` 写出来，审核期间就能看文件。
- 人在面板上审核（或 HTTP）：`approve` → `status:'approved'`、`publishedAt` 落盘、系统行、**按成员分节分别投递**给与会者；`reject` → 回 `draft` 并把 `note` 追加到草稿文件末尾，请记录员重写。
- 「分节投递」的精确口径：正文里 `## <成员显示名>` 那一节发给该成员；标题含「全体/通用/所有人/共同」的小节发给每个人；某成员抽不到专属小节时**回落整篇正文**（宁可多发，不可漏发）。标题匹配先按完整显示名，再按显示名第一段（空格/·/－ 前）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-room/rooms/:id/results` | `{results:[ResultView], recorder}` |
| GET | `/dsh-room/rooms/:id/result?goalId=…` | 纯文本 `text/markdown`（侧边栏结果页用） |
| POST | `/dsh-room/rooms/:id/results/:goalId/draft` | `{title, body, by?}` → `{result}`；`by` 既不是本房间记录员的 sessionId 也不是它的显示名时 403（挡「别人代写」）；缺 `title`/`body` → 400 |
| POST | `/dsh-room/rooms/:id/results/:goalId/approve` | `{by?, note?}` → `{result, delivered, failed}`（已发布再 approve → 409） |
| POST | `/dsh-room/rooms/:id/results/:goalId/reject` | `{by?, note}` → `{result}`（note 必填） |
| POST | `/dsh-room/rooms/:id/recorder` | `{sessionId?, label?, exclude?}`：传 sessionId 就指派它；**不传/为空 = Host 从当前在线成员里自动指派一个**（可用 `exclude` 排除某会话）→ `{recorder, members}`。**取消记录员只能靠该会话 `leave` 或被 `kick`**（那时 `setRecorder(null)`）。 |

## 8. 思考程度（用户 m01422 第 3 条）

- 房间级：`reasoning:'inherit'|'low'|'medium'|'high'`；成员级覆盖 `reasoningByMember[sessionId]`。成员设成 `'inherit'` = 删掉这条覆盖，**回落到房间级**（不是「谁都不管」）。
- 生效方式：`agent/pre-step` 认出「本次投递的那条消息」（按 `source.rpcId`）→ 该轮第一个 `agent/request`（`{prepend:true}`，故在官方 model-selection 之后覆盖，必定生效）里把 `reasoningEffort` 换成 `resolveModelInfo(provider,model).reasoning.efforts` 上的等级（精确匹配优先；否则 low=首、medium=中、high=末）。模型没声明等级 → 不覆盖 + 只 warn 一次。**只影响那一轮的第一个请求**，不碰会话持久选择、不写全局默认模型。
- 契约保证：房间状态里能读写这两个字段，面板上有房间级 + 每人一个下拉；钩子不可用时投递文本里附带「简短回应」的明确指令。
- `PATCH /dsh-room/rooms/:id` body 可带 `{reasoning}`；`POST /dsh-room/rooms/:id/reasoning` `{level, sessionId?}` → `{room}`。

## 9. 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/dsh-room/rooms/:id/upload` | `{name, base64}` → `{name, bytes, renamed}`（8 MiB 上限，重名加后缀） |
| GET | `/dsh-room/rooms/:id/raw?name=…` | 只读副本；非 ASCII 名走 ASCII 兜底 + RFC 5987 `filename*` |
| GET | `/dsh-room/rooms/:id/files` | `{files:[{name,bytes,at}]}` |

## 10. Agent 工具（Host 注册，名字保持不变 + 新增）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `room_list` | — | 列出全部房间 + 我在哪些房间里 |
| `room_join` | `{roomId?, label?}` | 幂等；`roomId` 缺省 = 默认房间 |
| `room_leave` | `{roomId?}` | 未入会不写行 |
| `room_say` | `{roomId?, text, to?, files?}` | 默认只归档不推送 |
| `room_read` | `{roomId?, since?, limit?}` | 按需读记录 |
| `room_files` | `{roomId?}` | 列出房间文件 |
| `room_open` | `{roomId?, name}` | 读房间文件正文 |
| `room_goal_report` | `{roomId?, goalId?, verdict, summary}` | 与会者报目标进展，`verdict` 枚举逐字为 `达成` / `有分歧`；只写进房间记录，**不直接改目标状态**（改状态要在面板/HTTP 上做） |
| `room_result_write` | `{roomId?, goalId, title, body}` | **记录员专用**：写草稿 |
| `room_request_reopen` | `{roomId?, reason}` | 与会者请求重开已结束的会议 / 再议 |
| `room_finalize` | `{title, body, force?}` | v1 遗留：写默认房间的 `决议.md`（保留兼容，文档标注遗留） |

## 11. 客户端槽位（浏览器半区冻结）

| 槽位 | 形态 | 用途 |
| --- | --- | --- |
| `sidebar.panellist` | `{name, id, order, label}`（`kind:'list'`，`order` 排序） | 一条「会议室」总入口（`order:100`）+ 每个房间一行（`order:101+`）；折叠 = 注销/重注册房间行（`ctx.slots.register` 返回 disposer） |
| `main` | `{name:'main', key:'dsh-meeting-room:<roomId>'}`（`kind:'keyed'`） | 每个房间的整页面板；`ctx.layout.selectPanel(key)` 打开，`ctx.layout.selectPanel(null)` 回会话 |
| `sidebar.right.pane.tab` | `{name, id, order, label}` | 《会议结果》.md 结果页（「一样参考普通对话」） |

- 房间列表刷新：每 1.5 s 轮询 `GET /dsh-room/rooms`（轻量），面板打开时轮询该房间 `state`。
- 面板内轮询与 v1 相同：`GET /dsh-room/rooms/:id/state?since=<seq>`，按 seq 去重合并。

## 12. 验收口径（selftest 必须覆盖）

1. 多房间：建 3 个房间，各自 transcript/members 独立；`rooms.json` 落盘；重启后能收养。
2. 兼容：无房间段的 v1 路径仍工作。
3. 踢人：踢掉后成员表少一人、系统行一条、被踢者可重新 join。
4. 投递策略：`push:'off'` 时 `/post` 不投递（`delivered:[]`）；`mode:'notice'` 只投一行且不含正文；`mode:'full'` 含正文。
5. 目标：建/改/切换/完成/再议，`goals.json` 与系统行一致。
6. 记录员：`complete` 只是标记 `done` + 给记录员发任务（**不产生结果**，`resultCount` 不变）；**记录员落笔**才有 `draft`（`resultCount` +1）；`approve` 后 `approved` + 分节投递；`reject` 回 `draft` 并带 note；无 `recorder` 时 `complete` 不静默假成功。
7. 结束/重开：`close` 后记录保留、`reopen` 由用户直接生效、由成员只产生 `reopenRequest`。
8. 参数校验：所有端点的方法/必填字段错误 → 400；状态冲突 → 409。
9. 文件：非 ASCII 名下载 200；`room_result_write` 越权（非记录员）拒绝。

## 13. 变更记录（v2 定稿后修复轮）

一轮「自带自测 + 独立探针」双路验证暴露的实现缺陷，已全部修复；以下为**行为契约的最终口径**（与本节不一致的旧描述以本节为准）。

| # | 级别 | 缺陷 | 最终口径 |
| --- | --- | --- | --- |
| B-1 | P0 | `apply` 里写裸 `webServer` / `tools` 标识符 ⇒ `ReferenceError`，0 路由 / 0 工具 | 一律 `ctx.webServer.register(route)` / `ctx.tools.register(def)`；自测第一条断言「apply 不抛错」必须守住 |
| B-2 | P1 | `append` 在 `await` 前算 `seq` ⇒ 同房间并发发言 seq 重复（20 并发只有 44 个唯一 seq）、`state.seq` 回退 | **seq 的分配必须在 `Room.writeChain` 串行链内部**；链本身永不 reject（错误只回给调用方） |
| B-3 | P2 | `approve` 分节投递用 `title.includes(label)` 且命中即覆盖 ⇒ 显示名互为子串时（「实现方」/「另一实现方」）投错小节 | `sectionScore(title, label)`：精确 100 > 前缀+分隔符 70 > 后缀+分隔符 60 > 包含 20，取最高分；仍取不到则回落整篇正文 |
| B-4 | P2 | v2 重写丢掉 `sec-fetch-site` 检查 | `isTrustedRequest`：`sec-fetch-site: cross-site` → 拒绝（与 v1 一致）；回环 Host/Origin、`null`/`file://`/`app://` 仍放行 |
| B-5 | P3 | 上传 `name:''` / `'.'` / `'..'` 被 `safeName` 静默压成 `file` / `_` | 一律 **400**（v1 口径）；正常重名仍自动改名并回 `renamed:true`（传了非法原始名也算 `renamed:true`） |

附带两处行为明确化：

- **工具错误返回字符串**：`room_*` 工具内部抛错不再把堆栈丢给模型，统一转成一句中文（404 追加「可以先调用 `room_list` 看现有会议室」）；HTTP 端点仍返回状态码。
- **`/post` 的 `files` 允许房间内已有文件名**：绝对路径或相对 cwd 的路径优先；只有当两者都不存在、且给的是纯文件名、且 `files/` 里确有同名副本时，才沿用房间副本（面板「上传后自动挂到消息」走这条路），不再落进 `droppedFiles`。

## 14. 变更记录（《会议结果》落到侧边栏 + 客户端挂载点口径）

| # | 项 | 最终口径 |
| --- | --- | --- |
| C-1 | `RoomSummary` 新增 `resultCount` | `resultCount: goals.filter((g) => g.result).length`（与 `goalCount` / `doneGoalCount` 并列），侧边栏据此决定该房间要不要多挂一行《会议结果》 |
| C-2 | 《会议结果》挂载点 | 由 `sidebar.right.pane.tab` 改为 **`main` 的 keyed 整页**：`key = 'dsh-meeting-room:result:<roomId>'`，与房间页 `key = 'dsh-meeting-room:<roomId>'` 并列 |
| C-3 | 侧边栏行 | 有结果的房间多一行 `sidebar.panellist`：`id = 'dsh-meeting-room:result:<roomId>'`（与该 main 的 key 同串，点行即切到结果页）、`order = RESULT_ROW_ORDER(201) + index`、图标一页纸（`ResultRowIcon`） |
| C-4 | 为什么不用右侧栏页签 | `sidebar.right.pane.tab` 是**右侧栏页签类型系统**的 keyed 座位：必须先用 `ctx.sidebarRightTabs.register(...)` 注册类型、再由宿主打开页签才会渲染；插件直接 `slots.register({name:'sidebar.right.pane.tab', id})` 不会显示（全 asar 也不存在 `ctx.slots.selectSlot`）。故结果页统一走已验证可用的 `main` keyed 整页 |
| C-5 | 点侧边栏行后仍能定位房间 | 宿主切面板时不会回调插件，`client/client.js` 订阅 `ctx.layout.panelInfo` 的 `activePanelId`，按 `dsh-meeting-room:result:<roomId>` / `dsh-meeting-room:<roomId>` 前缀反解回 `activeRoom` |
| C-6 | `.md` 文件本身 | 仍只走 `GET /dsh-room/rooms/:id/result?goalId=` 与 `results/` 目录下的文件（草稿阶段就已落盘）；客户端也不再调用已不存在的 `slots.selectSlot` |
| C-7 | 工具 404 提示（P4） | `fail()` 把状态码写在 `error.statusCode`（index.js:1024-1026），工具包装层原先读 `error.status` ⇒ 404 提示「（可以先调用 room_list 看现有会议室）」是死分支。现读 `Number(error?.statusCode ?? error?.status ?? 0)` |
| C-8 | `complete` 与结果的因果（口径） | `complete` **只**标记 `done` + 给记录员发任务（`asked`/`reason`），**不产生结果**；`resultCount = goals.filter((g) => g.result).length` 只有在**记录员落笔草稿**后才 +1 |

自测口径：`node selftest/run.mjs` → **合计 165 项：通过 165，失败 0**（含 C-1…C-7 的断言）。
