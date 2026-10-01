# dsh-meeting-room v7 契约（包版本 `0.7.0`）

> 本文件是 **v7 的唯一权威口径**。v6 / v6.1 的口径见 `docs/v6-API.md`（`0.6.0` / `0.6.1`），v5 及更早见 `docs/v5-API.md`、`docs/v4-API.md`、
> `docs/v3-API.md`、`docs/v2-API.md`。写接口 / 改行为前，先改**本文件**，再改 `client/client.js`、`index.js`、`selftest/run.mjs`、`README.zh.md`。
>
> **v7 只改了客户端**：全部改动都在 `client/client.js`（唤醒按钮删除、发送恒带 `mode:'notice'`、踢人不再问理由）。宿主 `index.js` 与 v6.1 **逐字节相同**，
> 所以 v7 没有新增/删除任何端点，只是客户端调用的 body 形态变了。
>
> **行号口径**：本文所有行号都是 `read` / `Get-Content`（含全部行）口径的**实测**行号，对应下面这份冻结快照。行号会随改动漂移，**以内容为准，不以行号为准**。

## 0. 冻结快照（本文件所有锚点的基准）

| 文件 | 字节 | 行数（`Get-Content`） | SHA1（`Get-FileHash -Algorithm SHA1`） |
| --- | --- | --- | --- |
| `index.js` | 137578 | 2952 | `DA8C43BA76B8AB85E6B2246FA2C01FE43DA158B6`（**v7 未改动宿主**，与 v6.1 逐字节相同） |
| `client/client.js` | 98817 | 1814 | `1E7042398BA88D27FD69AA4651197F0147F81CE5`（**v7 唯一改动文件**；v6.1 基线是 99186 B / 1823 行 / `717089C9D63404B47E14DB77EBA1FD85E4F4ABEF`） |
| `selftest/run.mjs` | 229487 | 4120 | `043C1039AD88DDE8BDD05212CF1A52554263AA94`（v7 定稿 **388/388/0**；v6.1 基线是 225949 B / 4070 行 / `7B44578B2AD4CDE0AFE1A62BF8B4E88DBDAC3C52`） |
| `package.json` | 3012 | 55 | `ABA7D3C3D3CDC9D25E6FAD6A226E413FFE61D401`（`version` = `0.7.0`；v6.1 基线是 2690 B / `347B136D25E876271813E9BD9B932C6D76AD0729` / `0.6.1`） |

契约来源（宿主官方）仍按 `docs/v5-API.md` §0 的副本口径取：`api-catalog.js` 必须用 asar 直读的**权威副本**
（605995 B / 8159 行 / `616BE74C2F025BAF1FD991DB2C05F9F936076E78`），`.recon-tmp` 下的是截断副本，不得据它写行号。

---

## 1. 需求 → 落地映射（用户原文，不得扩大范围）

用户在 v7 这轮提了两条（原文见 `docs/v7-方案.md` 或本表引用）：

| # | 用户需求（原文） | v7 实现 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 「取消“唤醒与会者功能”，我不想每次都要唤醒一次才能让他们发言。」 | **删除「唤醒与会者」按钮**（整块 UI 移除）；改为**每次发送都固定提醒**：`sendPost` 的 body 恒带 `mode:'notice'`，宿主对每条消息投一行「有 N 条新消息」提示（**不含用户正文**） | 客户端 `client/client.js:1207-1217`（body `:1208`）、旧按钮位置 `:1501-1504` 已被邀请列表内容取代、注释 `:30-31` / `:1205-1206`、composer 提示 `:1326` |
| 2 | 「取消提出与会者时弹出的“踢人理由”（以后不准擅自添加我没有说的功能）。」 | 点 ✕ **直接踢**：不发 `reason`、不弹任何面板、无二次确认；`view.kickReason` 状态与面板整体删除 | 客户端 `client/client.js:1489-1493`（`onClick` `:1492`，删除说明写在 `:1491`）；宿主 `/kick` 路由**未改** `index.js:2186-2211` |

**v7 明确不改**：宿主 `index.js` 全部（`/post` 的 mode 白名单与降级、`deliver()` 的 notice 正文规则、`/kick` 仍接受 `reason?`、按需激活、目录护栏、
内置记录员、12 个 `room_*` 工具、`inject` 数组）；客户端的 `askText` / `Dialog` 面板本身与其余 **4 处**调用；`to` / `files` / `pushAll` 语义；
`mode:'archive'`（只写记录、零投递）仍由宿主支持，只是 v7 界面不再产生它。

---

## 2. 与 v6.1 的差异总览

| 项目 | v6.1 | v7 |
| --- | --- | --- |
| 用户消息怎么叫醒与会者 | 先 `mode:'archive'` 写记录，再点「唤醒与会者」显式发一条 `mode:'notice'` | **发送即提醒**：每条消息的 body 恒为 `mode:'notice'`，不需要额外动作 |
| 「唤醒与会者」按钮 | 抽屉「与会者」段里有 | **删除**（`:1501-1504` 只剩「邀请会话 AI / 刷新邀请列表」） |
| composer 提示文案 | 「…需要他们回应时点「唤醒与会者」。思考程度：…」 | 「…与会者会收到一行『有新消息』提醒（不含你的正文）。思考程度：…」 |
| 抽屉「你和与会者 AI 之间」说明 | 第二条提到点「唤醒与会者」 | 第二条改成「每次发送后，与会者会收到一行『会议室有新消息』提醒…由他们自己来读」 |
| 踢人 | 点 ✕ 弹插件自带面板收理由（可留空） | 点 ✕ **直接踢**（`{ sessionId, notify: true }`，无 `reason`、无面板、无二次确认） |
| 客户端 `askText` 调用数 | 5 处（含踢人理由） | **4 处**（驳回原因 ×2 / 再议原因 / 散会标题） |
| 宿主代码 | v6.1 | **未动**（逐字节相同） |
| 自测项数 | 385 项：通过 385，失败 0 | **388 项：通过 388，失败 0**（+4 条 v7 断言，删 1 条已不存在的「踢人取消」用例，净 +3） |

---

## 3. 客户端行为契约

### 3.1 发送（`sendPost`，`client/client.js:1207-1217`）

```js
const sendPost = async (text, files) => {
  const body = { text, mode: 'notice' };                        // :1208  恒带 notice
  const targets = Object.keys(view.targets).filter((key) => view.targets[key]);
  if (targets.length) body.to = targets;                        // :1210  勾了人才带 to
  if (files && files.length) body.files = files;                // :1211  有附件才带
  await postJson(`/rooms/${q(roomId)}/post`, body);             // :1212
  view.draft = ''; view.targets = {};                           // :1213-1214
  await refreshAll(roomId);                                     // :1215
  setTimeout(toBottom, 0);                                      // :1216
};
```

- **每条消息都提醒**：`mode` 不再是缺省 `archive`，而是显式 `'notice'`。宿主 `deliver()` 在 `mode !== 'full'` 时投的是自造的一行提示
  （`index.js:654-655`），**不含用户 `text`** ⇒ v6 的「用户正文永不外发」结构不变。
- **不点名 = 全体成员**：不勾选任何人时不带 `to`，宿主 `index.js:651` 的缺省 targets 就是全体成员。
- **没有静默发送的界面路径**：v7 界面不再产生 `mode:'archive'`；要静默只能由脚本 / 工具显式调用宿主 `POST …/post { mode:'archive' }`。

### 3.2 踢人（`client/client.js:1489-1493`）

```js
h('button', {
  type: 'button', style: S.kick, title: '踢出会议室',
  // v7②：踢人不再问理由（用户明令禁止擅自加功能）⇒ 点了直接踢，不弹任何面板
  onClick: () => act(() => postJson(`/rooms/${q(roomId)}/kick`, { sessionId: member.sessionId, notify: true }), '已踢出'),
}, '✕')
```

- body 只有 `{ sessionId, notify: true }`：**不发 `reason`**、不等用户确认、不弹 `Dialog`。
- 宿主仍然接受 `reason?`（`index.js:2191-2194`）：有理由时系统消息写成「`X` 已被移出会议室（理由）」，并在 `notify:true` 的通知里带理由；
  v7 客户端不传 ⇒ 实际形态是「`X` 已被移出会议室」。
- 回包仍是 `{ removed, notified, members }`（`index.js:2210`）；`notify:true` 会先按需激活被移出者再投一行通知（`:2196-2209`，失败只 warn、`notified:false`）。

### 3.3 固定文案（composer 与抽屉）

- composer 提示（`client/client.js:1326`）：
  `你的消息只留在会议室记录里，不会进入与会者对话；与会者会收到一行『有新消息』提醒（不含你的正文）。思考程度：<档位>（在「策划会议」里改）`
- 抽屉「你和与会者 AI 之间」（`DrawerDelivery`，`client/client.js:1583-1593`）三行固定文案 + 思考程度档位：
  - `:1583` 盒头 `你和与会者 AI 之间`
  - `:1584` `你发的消息只会写进会议室记录，不会出现在与会者的对话里。`
  - `:1585` `每次发送后，与会者会收到一行『会议室有新消息』提醒（不含你的正文），由他们自己来读。`
  - `:1586` 盒头 `思考程度（房间默认）`，`:1587-1593` 是 `REASONING_LEVELS` 按钮（改房间级 `reasoning`）
- v7 抽屉里**没有**投递档位按钮、没有唤醒按钮；「邀请会话 AI / 刷新邀请列表」仍在 `:1495`。

### 3.4 仍然保留的 4 处 `askText`

| 位置 | 用途 | 是否必填 |
| --- | --- | --- |
| `client/client.js:1301` | 《会议结果》驳回原因 | 必填（`required: true`） |
| `client/client.js:1443` | 目标再议原因 | 可选 |
| `client/client.js:1608` | 散会标题 | 可选（默认 `会议已散会`） |
| `client/client.js:1759` | 结果页驳回原因 | 必填（`required: true`） |

面板定义：`askText` `client/client.js:732`、`Dialog` `:776-815`。v7 只删掉「踢人理由」这一处，其余按钮与校验未动。

---

## 4. 与宿主的边界（v7 未动，仅引用）

| 位置 | 内容 |
| --- | --- |
| `index.js:2118-2152` | `POST /rooms/:id/post`：mode 归一化 `:2124-2129`（`full` → `notice`）、写记录 `:2137`、按 `mode` 投递 `:2141-2147`、回包 `:2152` |
| `index.js:647-676` | `deliver()`：缺省 targets = 全体成员 `:651`；`full` 判定 `:652`；notice 正文 `:654-655`（`有 N 条新消息…用 room_read 按需查看`）、加前缀 `:656-657`；按需激活 `:660` |
| `index.js:2186-2211` | `POST /rooms/:id/kick`：`reason?` 可选 `:2191`、系统消息 `:2194`、`notify:true` 先激活后通知 `:2196-2209`、回包 `:2210` |
| `index.js:2006-2011` | `PATCH /rooms/:id` 的 `push` 白名单（`off`/`notice`；`full` → 400 `:2008`） |

**结论**：v7 客户端发的两种 body（`{text, mode:'notice', to?, files?}`、`{sessionId, notify:true}`）在 v6.1 宿主上就是合法入参，
所以「客户端 v7 + 宿主 v6.1」是自洽组合；反过来「客户端 v6.1 + 宿主 v6.1」也照旧可用（唤醒按钮只是多一次手动操作）。

---

## 5. 兼容性

- **老客户端（v6.1）连 v6.1/v7 宿主**：显式 `mode:'notice'` 一直是合法值，唤醒按钮只是 UI 消失，接口层面没有废弃任何东西。
- **老脚本 / 老工具传 `mode:'full'`**：宿主仍降级成 `notice`（正文不外发），行为不变。
- **老脚本传 `kick { reason }`**：宿主仍生效（写进系统消息与通知）；只有 v7 客户端不再收集理由。
- **房间级 `push`**：v6 起与「发帖」解耦（缺省 `archive` 不跟随 `push`），v7 不变；v7 客户端恒 `notice`，与房间 `push` 取值也无关。
- **包版本**：v7 = `0.7.0`；能连 v7 客户端行为需要宿主 ≥ `0.6.0`（`mode` 白名单在 v6 才落地）。低版本宿主仍会被 v7 客户端调用，只是投递正文规则按旧版执行。

---

## 6. 端点（v7 无新增/删除）

| 方法 | 路径 | v7 客户端实际 body | 说明 |
| --- | --- | --- | --- |
| POST | `/dsh-room/rooms/:id/post` | `{ text, mode:'notice', to?, files? }` | 恒 `notice`（§3.1） |
| POST | `/dsh-room/rooms/:id/kick` | `{ sessionId, notify:true }` | 无 `reason`（§3.2） |
| POST | `/dsh-room/rooms/:id/leave`、`/join` | 未变 | 邀请列表仍用 |
| PATCH | `/dsh-room/rooms/:id` | `{ reasoning }` 等 | 抽屉档位仍用 |
| GET | `/dsh-room/rooms/:id/state`、`/files`、`/sessions` | — | 每 1.5 秒轮询 / 抽屉按需 |

v1 兼容前缀（不带房间段的写法）与完整端点总表见 `docs/v6-API.md` §6 / `docs/v5-API.md`。

---

## 7. 排查表（v7 相关）

| 现象 | 原因 / 处理 |
| --- | --- |
| 发了消息，与会者还是没反应 | 按顺序查：① 客户端改动要**重启 DSH**（或完整重载插件 scope）才进内存；② 请求体的 `mode` 是否真的是 `'notice'` 到达宿主（`archive` 只写记录、零投递；`full` 会降级成 `notice`）；③ 目标会话是否被按需激活 —— 看 `POST …/post` 回包 `failed[i].error`（例如宿主没有会话激活能力 / 会话无法激活）；④ 对方会话是否已被踢出房间 |
| 界面里找不到「唤醒与会者」 | v7①**有意删除**：现在每条消息都自动提醒，不再需要手动唤醒 |
| 点 ✕ 直接把人踢了，没问理由 | v7②**有意为之**（用户明令不许擅自加功能）。宿主仍接受 `reason?`，只是界面不再收集 |
| 每条消息都会通知与会者，觉得太吵 | 这是 v7 的设计取舍：要静默就由脚本调用宿主 `{ mode:'archive' }`（界面不提供） |
| 与会者收到的提醒里**看不到我的正文** | 正确行为（v6 起结构性保证）：`notice` 只投「有 N 条新消息」一行；正文在结构上无外发通道 |

---

## 8. 锚点表（实测）

| 锚点 | 行号 | 备注 |
| --- | --- | --- |
| client `sendPost` | `client/client.js:1207-1217` | body `mode:'notice'` `:1208` |
| client `submit` / composer | `:1219` / `:1326` | 提示文案在 `:1326` |
| client 踢人 ✕ | `:1489-1493` | `onClick` `:1492`；`:1491` 是 v7② 说明注释 |
| client 邀请按钮 | `:1495` | 旧「唤醒与会者」块已删，位置被邀请列表占用 |
| client `DrawerDelivery` | `:1583-1593` | 盒头 `:1583`、说明 `:1584-1585`、档位 `:1586-1593` |
| client `askText` / `Dialog` | `:732` / `:776-815` | 4 处调用 `:1301` / `:1443` / `:1608` / `:1759` |
| client 头部注释 | `:30-31`、`:1205-1206` | v7①② 口径 |
| host `/post` | `index.js:2118-2152` | mode 归一化 `:2124-2129` |
| host `deliver()` | `index.js:647-676` | notice 正文 `:654-655`、激活 `:660` |
| host `/kick` | `index.js:2186-2211` | `reason?` `:2191` |
| host `pickEffort` | `index.js:1650-1668` | v6 修；`inject` `:1870`；加载日志 `:2951` |

历史上「唤醒与会者」按钮的旧锚点是 v6.1 的 `client/client.js:1501-1504`，v7 起该位置不再是唤醒块。

---

## 9. 变更记录

| 包版本 | 契约 | 要点 |
| --- | --- | --- |
| `0.7.0` | **v7（本文件）** | 取消唤醒按钮，发送恒带 `mode:'notice'`；踢人不再问理由；自测 385 → 388 |
| `0.6.1` | v6 / v6.1（`docs/v6-API.md`） | `pathIdentity` 改 BigInt `stat`（大 inode 误拒修复） |
| `0.6.0` | v6（`docs/v6-API.md`） | 用户正文结构性不外发；`push` 只剩 `off`/`notice`；页头删两个 chip；`pickEffort` 修 `llm` |
| `0.5.0` | v5（`docs/v5-API.md`） | 按需激活、文件抽屉、单入口面板、真实会话名 |
| `0.4.x` | v4 / v4.1（`docs/v4-API.md`） | 面板重构、内置记录员、`agent/pre-step` 钩子契约 |

---

## 10. 未核实项（诚实清单）

1. **真机未重启到 v7**：`client/client.js` 的改动要重启 DSH（或完整重载插件 scope）才进内存；本文的客户端行为均由源码实测 + 自测断言确认，未在重启后的真机上目视。
2. **踢人「无二次确认」的手感**：这是用户明确要求的行为，但误触成本（尤其是触屏 / 窄窗口下 ✕ 与「思考程度」下拉相邻）未在真机上评估；宿主侧也没有「撤销」能力。
3. **v7 新增断言的性质**：`selftest/run.mjs` 对客户端的断言是源码 / `node:vm` 渲染层断言，**不等于**真机 UI 目视。
4. **项数口径**：385 → 388 的净 +3 = 新增 4 条 v7 断言、删 1 条已不存在的「踢人取消」用例；具体条数以 `selftest/run.mjs` 自报为准。
5. **「与会者收到提醒后是否回应」**：取决于模型自身判断与房间思考程度，契约层无法断言；`delivered` 只代表入队成功。
6. **保留的 4 处 `askText`**：沿用 v6 的实现，v7 未逐条真机点过。
7. **宿主锚点**：`index.js` 与 v6.1 逐字节相同，本文行号按 §0 快照实测；若宿主被改动，宿主锚点整体失效。

---

## 11. 自测与红线

- **自测**：我在 §0 的快照上实跑 `node selftest/run.mjs`，得到 `合计 388 项：通过 388，失败 0`、exit 0、0 条 `FAIL`（跑前跑后 `selftest/run.mjs` 的 SHA1 未变）。
- **红线**：
  - v7 不改宿主 `index.js`、不改 `package.json`、不改 `selftest/run.mjs`；
  - 不写真实会议数据（`C:\Users\uyiop\dsh\会议`、`~\.dsh\meeting-room` 只读引用）；
  - 不重启、不安装 DSH；行号一律按 §0 快照实测，禁止照抄二手数字；
  - 文档里不出现桌面临时目录那类旧路径字面量（安装引用只认 `link:C:/Users/uyiop/dsh/dsh-meeting-room`）。
