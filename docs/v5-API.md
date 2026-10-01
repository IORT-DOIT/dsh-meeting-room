# dsh-meeting-room v5 API 与契约（包版本 `0.5.0`）

> 本文件是 **v5** 的唯一权威口径，供实现方、回归与文档引用。v4 / v4.1 的口径见 `docs/v4-API.md`（历史口径，v5 未回退其中任何能力）。

## 0. 冻结快照（本文件所有锚点都按这三份实测；行号是「Get-Content 全行」口径，括号内为非空行口径）

| 文件 | 字节 | 行数 | SHA1 |
| --- | --- | --- | --- |
| `index.js` | 136713 | 2943（非空 2779） | `4DA6E6F1529AB4F8B3ACC74B801ABE70D00C6A91` |
| `client/client.js` | 95331 | 1746（非空 1661） | `CDDFEBDB1DF652A75AEF461E0FC91D5067547369` |
| `package.json` | 2030 | 55 | `945A6AD56ED0E05C0C7333BF933FEFD19793AF04` |

`package.json`：`"version": "0.5.0"`（L3）；顶层 `description`（L5）与 bundle 段 `description`（L39）已是 v5 文案。

`client/client.js` 的 SHA1 是 **C11 热修后**的值（v5③：composer 底部提示行改按房间 `push` 取 `PUSH_LABEL` 人话标签 —— 修复前 `push=off` 会露出内部值 `默认投递：archive`）。该热修**只改 `client.js:1244` 一行，字节数与行数不变**（旧 SHA1 `DC9709650B3DB669583E2B518F0C4A95D3648372`，`node --check` = 0）。

宿主侧引用的源码副本（行号按下面这份**权威副本**核对 —— 它由 `.recon-tmp\asar.mjs` 从 asar 内**全量直读导出**）：

| 文件 | 字节 | 行数 | SHA1 | 说明 |
| --- | --- | --- | --- | --- |
| `C:\Users\uyiop\dsh\.recon-tmp\api-catalog.js`（= asar 内 `dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`） | 605995 | 8159 | `616BE74C2F025BAF1FD991DB2C05F9F936076E78` | 官方服务 / 类型目录（**本文件行号只按这份**） |
| `C:\Users\uyiop\dsh\.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js` | 124151 | – | `0D93B300E74E82B4DDE5DB17D224ED5823B532CC` | `sessionController` 服务实现（与 asar 直读**逐字节一致**） |
| `C:\Users\uyiop\dsh\.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js` | 72219 | 1967 | `699AD14A22F16236F6E3B3675927B16CCBEB57C3` | `agent/pre-step` waterfall 调用方（v4.1 事故） |

> **不要用这份陈旧副本**：`C:\Users\uyiop\dsh\.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js`（598769 B / 8073 行 / SHA1 `21F6189114EFFD7DCD6110500C4F278D800B23E9`）比真实文件**少 86 行**，`sessionController` 一带的锚点整体前移 —— 用它算出来的行号是错的。

`C:\Software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai` 不存在（asar 内不能按此路径直接读文件），宿主文件要按上表副本核对；`api-catalog.js` 已用 asar 直读仲裁（两份 SHA1 一致，行号以直读导出那份为准），`dsh-agent-loop` 那份**未与 asar 逐行比对**（见 §10）。

---

## 1. 用户四条需求 → 落地位置

| # | 需求（用户原话口径） | v5 实现 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 「与会者」必须先到它自己的会话里说一句话才会被激活，否则「唤醒与会者」几乎没用 | 投递 / 唤醒时宿主**按需激活**与会者会话：`MeetingHost.activate()` 先找 live agent，否则走官方 `sessionController.resolveAgent()`（拿不到再回落 `agents.resume()`）；`deliver()` 不再跳过非 live 成员 | `index.js` `Room.deliver()` :646-675、`MeetingHost.activate()` :1337-1367、`POST /rooms/:id/post` :2112-2144、`kick{notify}` :2187-2200 |
| 2 | 发出消息后会议界面要自动下拉到最底层 | 发送成功后滚到底；进入房间首次加载也滚一次；**轮询不强制滚**（用户自己往回翻时不会被拽走） | `client.js` `scrollRef`/`toBottom()` :1096-1106、发送后 :1129、轮询 :1090、消息容器 :1193 |
| 3 | 「默认投递方式」看不懂 | 三档按钮改成大白话（`只记录，不通知` / `提醒有新消息` / `提醒并附上全文`），并在盒头写明「别人（与会者 AI）怎么收到我的消息」+ 三行档位说明 | `client.js` `PUSH_LABEL` :32、`DrawerDelivery` :1500-1520 |
| 4 | 把「会议文件」收成最上面一个按钮（放在「会议室列表」左边） | 房间页头新增「会议文件」按钮，点开是抽屉（overlay + 右侧 sheet，条目链接到 `raw?name=`）；消息区原来的**内联文件盒已移除** | `client.js` 按钮 :1172-1173、`FilesDrawer` :1275-1294、挂载 :1246、`view.filesOpen` :297 |

### 1.1 明确不改的东西（v1–v4 已交付能力一条都不许丢）

- 目录模型与护栏：状态根 `~/.dsh/meeting-room`（只 `rooms.json` / `settings.json`）、会议文件目录 `<分类>/<房间 id>/`、`category`/`dir` 受保护位置 400、`purge=1` 的「目录名 = 房间 id 且不在受保护位置」才真删。
- 单入口面板（`sidebar.panellist` 只 1 条）、面板内导航 `goInternal()`、`main` = 面板键 + `result:<roomId>` 结果键。
- 内置记录员（恒 400 的指派端点、草稿 pipeline、`room_result_write` 对 AI 禁用、approve 后 409）、`GET /sessions` 只列顶层会话 + `{total, filtered}`。
- 主题 token（`--dsw-alias-*` / `--dsw-specific-*`）、聊天气泡、名字分色。
- 12 个 `room_*` 工具（数量不变）；v1 兼容端点 `/dsh-room/<旧端点>`。
- 不新增运行时依赖，不改宿主文件（除 `.recon-tmp` 探针）；v5 改动**需重启 DSH 才生效**。

---

## 2. 与 v4 / v4.1 的差异总览

| 面 | v4 / v4.1 | v5 |
| --- | --- | --- |
| 投递目标 | 缺省 = **在线**成员（`liveMembers()`），非 live 的直接 `continue` 跳过 | 缺省 = **全体成员**；循环里先 `activate()`，激活失败才进 `failed`（带激活错误原因） |
| `deliver()` 回包 | `{ delivered, failed }` | `{ delivered, failed, activated }`（`activated` = 本次真正被激活的会话数） |
| `POST /rooms/:id/post` 回包 | `{ message, delivered, failed, droppedFiles, mode }` | 增加 `activated` |
| `kick{notify:true}` | 只在对方 live 时投通知 | 先 `activate()` 再 `relay()`；激活 / 投递失败只 `warn`，回包 `notified:false` |
| 会议文件入口 | 消息区内联文件盒 + `room_files` / `GET …/files` | 页头「会议文件」按钮 + 抽屉；内联盒移除（HTTP 与工具通路不变） |
| 投递档位文案 | `off` / `notice` / `full` 裸值或短标签 | 人话标签 + 三行解释（值不变，仍 `off` / `notice` / `full`） |
| 滚动 | 无保证 | 发送后与首次加载各滚一次；轮询不滚 |
| 工具 / 端点 / 配置项 | — | **无新增、无删除**（`activate()` 是宿主内部方法，不是 HTTP 端点） |

---

## 3. 宿主按需激活契约

### 3.1 `MeetingHost.activate(sessionId)` —— `index.js:1337-1367`

```js
async activate(sessionId) {
  const live = this.agentOf(sessionId);
  if (live) return { ok: true, agent: live, activated: false };
  const controller = this.ctx.get?.('sessionController');
  if (controller && typeof controller.resolveAgent === 'function') { /* → resolveAgent */ }
  const agents = this.ctx.agents;
  if (agents && typeof agents.resume === 'function') { /* → agents.resume 回落 */ }
  return { ok: false, error: '宿主没有提供会话激活能力' };
}
```

语义（契约，任何调用方都可以依赖）：

1. **只在真要投递时才激活**：`activate()` 自己没有副作用式唤醒 —— 它只被 `deliver()` 与 `kick{notify:true}` 调用，不会因为轮询 / 渲染 / `/state` 而被触发。
2. **已经在线的会话零代价**：`agentOf()`（:1329-1335，即 `ctx.agents.get(sessionId)`，异常吞掉回 `undefined`）拿到 agent 就 `{ ok:true, agent, activated:false }`。
3. **三级路径**（按顺序，前者可用就不走后者）：
   1. `ctx.get('sessionController')` 且其 `resolveAgent` 是函数 → `await controller.resolveAgent(sessionId)`（:1349）；返回 `{ agent }` ⇒ `{ ok:true, agent, activated:true }`；返回 `{ error }` ⇒ `{ ok:false, error: error.message || '会话无法激活' }`。
   2. 否则回落 `ctx.agents.resume({ resumeSessionId: sessionId })`（:1359）；`handle.agent` 存在 ⇒ `{ ok:true, agent, activated:true }`；否则 `{ ok:false, error:'会话无法激活' }`。
   3. 两者都不可用 ⇒ `{ ok:false, error:'宿主没有提供会话激活能力' }`。
4. **绝不抛错**：两条路径都各自 `try/catch`，异常折成 `{ ok:false, error }`（`error.message` 或 `String(error)`）。所以投递主流程永远不会因为激活失败而 5xx。

返回值就三种形状（同一份契约）：

```ts
{ ok: true;  agent: Agent; activated: boolean }   // activated=true 表示这次真去激活了
{ ok: false; error: string }                      // 激活失败 / 宿主没有该能力
```

**为什么优先 `sessionController.resolveAgent`**：它与 GUI 打开会话是同一条通路 —— 内部 `composeAgent()` 会给 agent 装上 agent preset（`presets.mount`）与模型选择（`installSelection`），因此被激活者与「用户点开会话」时的能力完全一致（见 §3.5）。直接拼 `agents.resume({ resumeSessionId })` 只是兜底，不带这套组合。

### 3.2 `Room.deliver()` —— `index.js:642-675`

- 目标缺省从「在线成员」改成 **全体成员**：`targets?.length ? targets.map(...) : [...this.members.values()]`（:650）。
- 循环（:657-673）对每个成员：`await this.host.activate(member.sessionId)`（:659）→ 失败则 `failed.push({ sessionId, error: activation.error || '会话不在线' })` 并 `continue`（:660-663）；成功则 `if (activation.activated) activated += 1`（:664），再 `relayWithEffort()`（:666）；`outcome.ok` 才进 `delivered`，否则 `failed.push({ sessionId, error:'会话不在线' })`；异常 → `failed.push({ sessionId, error: message })` + `host.warn`。
- 返回 `{ delivered, failed, activated }`（:674）。`delivered` 的语义仍是"已送进对方会话队列"（不代表已读 / 已回复），**不因为 v5 而改变**。
- 投递正文格式未变：`full` 用全文（带 `【会议室 <标题>】<作者>：` 前缀），否则一行提示（`notice` 语义）—— :651-656。

### 3.3 `POST /rooms/:id/post` —— `index.js:2112-2144`

- 请求体不变：`{ text, label?, mode?, to?, files?, pushAll? }`；`mode` 缺省仍为 `pushAll===true ? 'full' : room.push === 'off' ? 'archive' : room.push`。
- `mode === 'archive'`（含房间 `push:'off'` 且未显式给 `mode` 的情况）**只归档、不激活任何人**：回包 `activated: 0`（:2131-2134）。
- 其他 `mode` 时按 `to`（逐成员）或缺省全体成员投递，`activated = outcome.activated ?? 0`（:2141）。
- 回包：`{ message, delivered, failed, activated, droppedFiles, mode }`（:2143）。新增字段是 `activated`；`failed` 里的每条现在可能是**激活失败**的原因（宿主能力缺失 / 会话无法激活），不再只是"会话不在线"。

### 3.4 `kick{notify:true}` —— `index.js:2177-2202`

- 移除成员、落系统行后，`body.notify === true` 时：先 `await host.activate(target.sessionId)`（:2189），失败只 `host.warn('通知被移出者失败：…')`（:2191）；成功再 `host.relay(target.sessionId, '【会议室 <标题>】你已被移出本次会议（<原因>）。')` 并把 `notified` 置 `true`（:2193-2195）；`relay` 抛错也只 `warn`（:2196-2198）。
- 回包仍是 `{ removed, notified, members }`（:2201）；`notify` 只影响是否尝试通知，**不影响移除结果**。

### 3.5 官方宿主契约依据（我按本机可读副本逐行核对）

| 锚点（文件:行） | 内容 |
| --- | --- |
| `api-catalog.js:1839` | `key: 'sessionController'`（服务键名） |
| `api-catalog.js:1844` | `signature: 'resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult>'`（描述为「Resolve or resume one ordinary Session for another Host API domain」） |
| `api-catalog.js:4430-4431` | `ApiSessionAgentError = RemoteError<'session/not-found' \| 'session/agent-busy' \| 'session/writer-held' \| 'gateway/internal'>` |
| `api-catalog.js:4434-4435` | `ApiSessionAgentResult = { readonly agent: Agent } \| { readonly error: ApiSessionAgentError }` |
| `api-catalog.js:3739 / :3741` | `name: 'agent/pre-step'` / 其 signature（v4.1 钩子契约所在的 waterfall 事件） |
| `dsh-api-session-controller/lib/index.js:358-371` | `async composeAgent(presetId)`：`installSelection(agent)`（:361/:367）+ `await presets.mount(agentCtx, resolvedId)`（:368） |
| `dsh-api-session-controller/lib/index.js:377-397` | `async resume(sessionId, supplied)`：有 `supplied` 走 `resumeObserved`（:378），否则先观察会话（:387） |
| `dsh-api-session-controller/lib/index.js:399-406` | `async resumeObserved(sessionId, observation)`：`const composition = await this.composeAgent(...)`（:402）→ `this.ctx.agents.resume({ … })`（:406） |

> **行号基准说明（副本选择问题，不是方案写错）**：`docs/v5-方案.md` §1 引的 `sessionController` `:1839` / `resolveAgent` `:1844` / `ApiSessionAgentResult` `:4434-4435` **与权威副本（asar 直读导出）完全一致**。我初稿误用了**同名的陈旧副本**（`…\dsh-tool-cordis\lib\types\api-catalog.js`，598769 B / 8073 行，比真实文件少 86 行），才算出 `:1789` / `:1794` / `:4380-4385`；现已按权威副本改正。**教训：同一文件可能有多份副本，引用宿主行号前先比 SHA1。**

---

## 4. 客户端契约（`client/client.js`）

### 4.1 投递档位文案与说明 —— :30-32、:1500-1520

```js
const PUSH_MODES = ['off', 'notice', 'full'];                                   // :30
const PUSH_LABEL = { off: '只记录，不通知', notice: '提醒有新消息', full: '提醒并附上全文' }; // :32
```

- 值（发往 `PATCH /rooms/:id { push }` 的仍然是 `off|notice|full`）不变，只有**展示文案**改成大白话；文案统一定义在 `PUSH_LABEL`，其它地方（composer 提示 :1244、抽屉按钮 :1513、说明行 :1519）都复用它，不再重复字面量。
- composer 提示行（:1244）**直接读房间 `push` 再查 `PUSH_LABEL`**：模板是 `` `默认投递：${PUSH_LABEL[(room && room.push) || 'off'] || PUSH_LABEL.off}；思考程度：…` `` ⇒ `push=off` 显示「默认投递：只记录，不通知」、`notice` 显示「提醒有新消息」、`full` 显示「提醒并附上全文」。**C11 热修前**这一行会直接打出内部值（`默认投递：archive`），是 v5③ 的漏网点，已修；实际投递语义仍由 `defaultFileMode()`（:481）决定，该函数与投递行为均未改动。
- `DrawerDelivery`（:1500-1520）盒头改成 **「别人（与会者 AI）怎么收到我的消息」**（:1506），三个按钮用 `PUSH_LABEL`（:1508-1513），下面三行解释（:1515-1519）：
  1. `只记录，不通知`：只写进会议记录，不叫醒任何 AI。
  2. `提醒有新消息`：只发一行『有 N 条新消息』，AI 自己去读。
  3. `提醒并附上全文`：把消息全文直接发给每个与会者 AI。
- 末尾仍保留一行：「自己发的消息仍按这里的方式投递给与会者 AI；点成员名可只发给指定成员。」（:1520）

### 4.2 房间页头「会议文件」按钮 + `FilesDrawer` —— :1172-1173、:1275-1294

- 按钮位置：**在「← 会议室列表」左边**（同一行页头），文案就是 `会议文件`；`onClick` 置 `view.filesOpen = true` 后 `emit()`（:1173）。
- **消息区不再有内联文件盒**（源码注释 :1172 明确写了这次搬迁）；清单 / 打开正文的 HTTP 与工具通路不变（`room_files`、`GET /rooms/:id/files`、`room_open`、`GET /rooms/:id/raw?name=`）。
- `FilesDrawer`（:1275-1294）结构：
  - 外层 `div` 里两层：遮罩 `S.overlay`（:1282，点击关闭）+ 右侧 sheet `S.sheet`（:1283）；`S.overlay` = `position:absolute; inset:0; rgba(0,0,0,0.28); zIndex:60`（:130），`S.sheet` = `position:absolute; top/right/bottom:0; width:min(430px,94%); background:LAYER; borderLeft:1px solid LINE`（:131）—— 与「策划会议」抽屉同一套 overlay/sheet 造型。
  - 头部（:1284-1288）：标题 `会议文件` + 数量 chip `${files.length} 个` + `关闭` 按钮。
  - 正文（:1289-1293）：每个文件一行，`<a>` 链接到 `` `${API}/rooms/${q(roomId)}/raw?name=${q(file.name)}` ``（`target:"_blank"`, `rel:"noreferrer"`，:1291）+ `byteSize(file.bytes)`；空态文案 **「还没有会议文件。」**（:1293）。
  - 挂载点：房间视图里 `view.filesOpen ? h(FilesDrawer, { roomId, view }) : null`（:1246）。
- 数据来源仍是房间视图里的 `view.files`（`GET /rooms/:id/files` 的 `{ files:[{ name, bytes, at }] }`），抽屉不额外发请求。

### 4.3 滚动语义 —— :1090、:1096-1106、:1129、:1193

- `const scrollRef = react.useRef(null)`（:1096）+ `toBottom()`（:1098-1104）：把 `scrollRef.current` 滚到 `scrollHeight`（拿不到元素就静默返回）。
- **首次加载**（进入房间 / 切房间时数据到位）滚一次：`setTimeout(toBottom, 0)`（:1105）。
- **发送成功后**滚一次：`sendPost` 里 `setTimeout(toBottom, 0)`（:1129，等 DOM 更新完再滚）。
- **轮询不滚**：1.5 秒的 `setInterval`（:1090）只拉数据刷新，不调用 `toBottom` —— 用户往上翻记录时不会被强制拽回底部。
- 消息容器是 `h('div', { ref: scrollRef, style: S.scroll }, …)`（:1193），`S.scroll` = `flex:1 1 auto; minHeight:0; overflow:auto`（:87）。

---

## 5. 端点速查（v5 相关）

| 方法 / 路径 | v5 变化 | 返回 |
| --- | --- | --- |
| `POST /dsh-room/rooms/:id/post` | 缺省目标 = 全体成员；投递前按需激活；回包多一个 `activated` | `{ message, delivered, failed, activated, droppedFiles, mode }` |
| `POST /dsh-room/rooms/:id/kick` | `notify:true` 时先激活再 `relay`，失败只 `warn` | `{ removed, notified, members }` |

v5 **没有**新增、删除或改名任何 HTTP 端点与 `room_*` 工具。`activate()` 只是宿主内部方法（不暴露为端点），`GET /rooms/:id/files`、`GET /rooms/:id/raw?name=` 继续供「会议文件」抽屉使用。

---

## 6. 客户端状态增量

| 状态 | 位置 | 语义 |
| --- | --- | --- |
| `view.filesOpen` | `client.js:297`（`newView()` 里初始 `false`） | 「会议文件」抽屉开 / 关；切房间 / 重建视图时回到 `false`（沿用 `newView()` 的既有重置语义） |

除 `filesOpen` 外，v5 未新增客户端持久化状态：投递档位仍读 `room.push`（回落到 `view.push`，:1503），思考程度仍读 `room.reasoning`（:1504）。

---

## 7. 配置项（cordis config）

**v5 未新增 / 未删除任何配置键**。`Config` 六键与 v4 相同；`settings.json` 仍只 `category` / `prompt`（记录员不再可配置，`recorder` 残留字段被忽略）。投递档位是**房间级**字段（`PATCH /rooms/:id { push }`），不是 cordis 配置。

---

## 8. 实测锚点表（v5 冻结快照）

| 主题 | 锚点 |
| --- | --- |
| `Room.deliver()` | `index.js:642-675`（缺省全体 :650；`activate` :659；`activated += 1` :664；`relayWithEffort` :666；返回 :674） |
| `MeetingHost.agentOf()` | `index.js:1329-1335` |
| `MeetingHost.activate()` | `index.js:1337-1367`（契约注释 :1337-1342；`resolveAgent` :1349；`agents.resume` :1359；兜底文案 :1366） |
| `POST /rooms/:id/post` | `index.js:2112-2144`（`activated` 声明 :2131；archive 不激活 :2132-2134；投递 :2135-2141；回包 :2143） |
| `kick` | `index.js:2177-2202`（`notify` 分支 :2187-2200；回包 :2201） |
| 客户端投递文案 | `client.js:30`（`PUSH_MODES`）、`client.js:32`（`PUSH_LABEL`）、`client.js:481`（`defaultFileMode()`：投递语义用）、`client.js:1244`（composer 提示行读 `room.push` + `PUSH_LABEL`） |
| `DrawerDelivery` | `client.js:1500-1520`（盒头 :1506；按钮 :1508-1513；三行说明 :1515-1519；尾注 :1520） |
| 页头按钮 | `client.js:1172-1173`（注释 :1172，按钮 :1173） |
| `FilesDrawer` | `client.js:1246`（挂载）、`client.js:1275-1294`（overlay :1282、sheet :1283、头部 :1284-1288、链接 :1291、空态 :1293） |
| overlay / sheet 样式 | `client.js:130-131` |
| 滚动 | `client.js:1090`（轮询不滚）、`client.js:1096-1106`（`scrollRef` / `toBottom` / 首次加载）、`client.js:1129`（发送后）、`client.js:1193`（容器）、`client.js:87`（`S.scroll`） |
| `view.filesOpen` | `client.js:297` |
| 宿主契约 | `api-catalog.js:1839 / :1844 / :4430-4431 / :4434-4435 / :3739-3741`（**权威副本**，见 §0）；`dsh-api-session-controller/lib/index.js:358-371 / :377-397 / :399-406` |

---

## 9. 变更记录

| 版本 | 包版本 | 变更 |
| --- | --- | --- |
| v5 | `0.5.0` | 投递 / 唤醒时按需激活与会者会话（`MeetingHost.activate()`，`resolveAgent` 优先 + `agents.resume` 回落、绝不抛错）；`deliver()` 缺省目标改为全体成员并返回 `activated`；`POST /rooms/:id/post` 回包新增 `activated`；`kick{notify}` 先激活再通知；房间页头新增「会议文件」按钮 + 抽屉，移除消息区内联文件盒；投递三档改大白话 + 三行说明（composer 提示行也复用人话标签，不再露出内部值 `archive`）；发送后 / 首次加载自动滚到底（轮询不滚）。**需重启 DSH 才生效** |
| v4.1 | `0.4.1` | `agent/pre-step` 钩子改为返回 `next()` 的结果（waterfall 契约），修复思考程度 ≠ `inherit` 的房间里与会者每轮「本轮运行失败」；见 `docs/v4-API.md` §11 |
| v4 | `0.4.0` | 单入口面板、面板内导航、官方主题 token、内置记录员（指派端点恒 400）、`GET /sessions` 只列顶层会话；见 `docs/v4-API.md` |
| v3 | `0.3.x` | 工作区式分类面板、聊天室化、真实会话名、记录员提示词、文件归位；见 `docs/v3-API.md` |

---

## 10. 未核实项（写进正文但本机无法自证的，一律列在这里）

1. **真机 GUI 观感**：页头按钮位置、抽屉动画、滚动体验都按源码读写；agent 看不到屏幕，需**重启 DSH 后由用户目视**。
2. **实时 Slot 树未用 Inspect 取证**：客户端槽位 / 抽屉结构是从 `client.js` 源码读出的，没有查运行时 Slot 树。
3. **按需激活的真实端到端效果**：自测用 stub `agents` / `sessionController`；真机上「发一条消息就把离线与会者叫起来」的效果需用户重启后实测（失败会在 `POST …/post` 回包的 `failed[i].error` 里带原因）。
4. **`sessionController` 在真实宿主中的可得性**：`ctx.get('sessionController')` 命中与否决定走哪条路径；本机运行进程内未取证，回落到 `agents.resume` 时**不带 agent preset / 模型选择组合**（§3.1 已写明）。
5. **宿主源码副本的选择**：`api-catalog.js` 必须用 asar 直读导出的权威副本（§0，605995 B / 8159 行 / SHA1 `616BE74C…`）；同名的陈旧副本（598769 B / 8073 行）会把该带锚点带偏约 50 行。`dsh-api-session-controller/lib/index.js` 已与 asar 逐字节一致；`dsh-agent-loop/lib/index.js`（72219 B）**未与 asar 逐行比对**，其 `:903-926` / `:921` 锚点来自 v4.1 轮次（见 `docs/v4-API.md` §13）。
6. **`docs/v5-方案.md` 的旧锚点偏差**：方案里的 `index.js` 侧落点（如 `deliver()` :646-669、`activate()` :1338-1368、`post` :2074-2104）与最终实测相差数行；本文件用实测值，方案只作定位线索。
7. **自测项数**：v5 定稿在 `selftest/run.mjs`（196820 B / 3589 行 / SHA1 `FF89FEC70700F7E1FE893B0F7951C127DC09D02A`）上实测两次 `合计 355 项：通过 355，失败 0`（exit 0；v4.1 基线 325/325/0，同文件旧值 167690 B / `3D8CFA44…`）。这是 Lead 与自测侧两方独立跑出的一致结果，但**不替代读者自己跑**；`355` 的构成（6 条改写 + 30 条新增）按任务分工写在收口记录里，本文件不逐条列举。
