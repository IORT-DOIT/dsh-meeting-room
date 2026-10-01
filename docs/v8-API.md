# dsh-meeting-room v8 对接契约（包版本 `0.8.0`）

> ⚠️ **v11 已取消本文档里的「接力上限」**：`autoContinueHops` 现在只是开关（非 0 = 开且**无跳数天花板**），回包不再有分母、也不再写「自动接力已达上限」系统行，`autoCapNoticed` 已删除。**现行口径见 `docs/v11-方案.md` 与 `README.zh.md` §4.4 / §8 / §13.9**；本文档其余部分（v8 当时的字段、行号、冻结快照）作为**历史契约**保留，不要再按本文档描述上限行为。

> ⚠️ **v12 / v13 又改了本文档里的三处行为**（**现行口径见 `docs/v12-方案.md` / `docs/v13-方案.md` 与 `README.zh.md` §0.10 / §0.11 / §4.4 / §4.5**）：
> ① **散会后不再广播**（v13）：`room_say` 照旧写进记录但回「已写进会议记录 #N，但会议已经散会…不再自动接力」，**不再投递**；人类 `POST /rooms/:id/post` 回包多一个 `relaySkipped:true` 且 `delivered` 为空（正文仍进记录）。**重开会议后恢复**。
> ② **换会议目录的语义**（v13）：`PATCH /rooms/:id { dir }` 现在是「**把整个房间搬过去**」，面板的「新建子文件夹」拼 `<父目录>\<名字>\<房间id>`；**搬进自己的子目录**与**搬到分类目录本身**都直接 **400**（中文原因：房间文件会被无限复制 / 各房间的文件会混在一起）。
> ③ **唤醒消息多一句「文件写哪」**（v13）：只对**本来就用 `room_say`** 的投递追加「本次会议的文件请写在 `<房间目录>\附件` 里…不要写到桌面或其它地方」。
> 另：v12 起房间目录固定 `记录/` + `附件/`（旧 `files/` `results/` 自动搬家）、房间多一个 `saveMode` 字段、多一个工具 `room_task_done`（**共 13 个**）、客户端触发记录员的两个接口超时 **300 s**（宿主看门狗 240 s）；v13 客户端新增消息索引与跟随滚动（**纯客户端行为，不属 HTTP 契约**）。

> 这是 **v8（包版本 `0.8.0`）的唯一权威口径**。v7 及更早见 `docs/v7-API.md` / `docs/v6-API.md` / `docs/v5-API.md` / `docs/v4-API.md` / `docs/v3-API.md`。
> v8 只做两件事：**宿主 `index.js` 让会议室自己往下走**（`room_say` 缺省 = 写记录 + 自动接力；`deliver()` 顺带排除发言者本人），以及**客户端 `client.js` 两句文案**。**没有新增端点、没有新增工具、没有新增 UI 控件。**

## 0. 冻结快照

| 文件 | 字节 | 行（总行数） | SHA1 | 说明 |
| --- | --- | --- | --- | --- |
| `index.js` | **141492** | **3015** | `161E880F355E0989FBCB6730F0C5FBA8BAB29682` | v8 唯一改动的宿主文件（v7 基线 137578 / 2952 / `DA8C43BA76B8AB85E6B2246FA2C01FE43DA158B6`） |
| `client\client.js` | **99018** | **1814** | `6DA60F34E7693CB059BF216D66A357C958CB7838` | v8 只改了两处文案（v7 基线 98817 / 1814 / `1E7042398BA88D27FD69AA4651197F0147F81CE5`） |
| `selftest\run.mjs` | **243653** | **4359** | `7F3B064F179FEEFCF4E4D2620D3EA0C8B65E69CB` | v8 定稿（v7 基线 229487 / 4120 / `043C1039AD88DDE8BDD05212CF1A52554263AA94`）；收口方**连续两次**实跑 `合计 407 项：通过 407，失败 0`、exit 0 |
| `package.json` | **3465** | **55** | `3FA8072A0B2FF0DDE38E8AC02AFE4C5B28338483` | `version` = **`0.8.0`**（v7 基线 3012 / 55 / `ABA7D3C3D3CDC9D25E6FAD6A226E413FFE61D401` / `0.7.0`） |

**部署与生效**：本机 `C:\Users\uyiop\.dsh\profiles\desktop\node_modules\dsh-meeting-room` 是 Junction → `C:\Users\uyiop\dsh\dsh-meeting-room`；v8 开工前实测运行中的 node 只有 1 个进程（PID 19500，2026/9/29 1:37:59 启动，见 `docs\v8-方案.md` §6）⇒ **v7 与 v8 都还没生效，重启 DSH 后一起生效**（不是 v8 单独生效）。

## 1. 需求 → 落地映射

User said (m06172)：**「为什么会出现这种回合制会话的情况？请做出修改」**（附图里与会者自己解释成「我们这类会话是回合制：没有新消息就不产生动作，看起来像暂停，其实是在待命」）。

| 现象/根因 | v8 落地 |
| --- | --- |
| 与会者 AI 是**被动唤醒**的会话：只有「投递给它一条消息」才动作 | **不由 v8 解决**（宿主机制）；v8 的解法是**插件主动投递** |
| `room_say` 缺省 `archive` ⇒ 与会者发言不叫醒任何人 | `room_say` **缺省 = 写记录 + 自动接力**（投给除自己外的成员，见 §4） |
| 人类发言那一侧当时也没投递（真机跑 v6.1，客户端不带 `mode`） | v7 已修（客户端恒带 `mode:'notice'`）；**真机重启后一起生效** |
| `deliver()` 缺省目标是全体成员（含发言者本人，理论自环） | `deliver()` 排除 `senderSessionId` 本人（§3） |

**v8 明确不改**：不新增 UI 控件 / 按钮 / 开关（用户明令）；不改 v6/v7 已定语义（用户消息正文永不外发、踢人不问理由、没有「唤醒与会者」按钮）；不改端点与工具面；不把接力额度写进 `room.json`。

## 2. 与 v7 的差异总览

| 维度 | v7 | v8 |
| --- | --- | --- |
| 与会者缺省发言 | `archive`：只写记录，谁都不叫 | **写记录 + 自动接力**（`notice` ping 给除自己外的成员） |
| 沉默档 | 缺省即沉默 | 必须**显式** `mode:'archive'`（语义保留） |
| 接力上限 | 无此概念 | `autoContinueHops`（Config，默认 6，`0` = 关闭）；触顶写一条系统行；人类 `/post` 把额度归零 |
| 投递目标 | 缺省全体成员（含本人） | 排除 `senderSessionId` 本人 |
| 新增提示文案 | — | ping 文案（不含任何发言正文）+ `room_say` 返回值 + 客户端两句说明 |
| 端点 / 工具 | — | **无增删**（仍 12 个工具） |
| 配置项 | 6 个 | **+1**：`autoContinueHops` |
| 自测 | 388/388/0 | 407/407/0（243653 B / 4359 行 / `7F3B064F…`） |

## 3. 宿主契约：`deliver()`（`index.js:652-688`）

```js
async deliver({ text, kind, authorLabel, targets, mode, senderSessionId, latestSeq, count, noticeStyle })
```

| 步骤 | 行号 | 语义 |
| --- | --- | --- |
| 目标解析 | `:656-657` | `targets` 有值就按它取成员，否则取**全体成员**；随后 `.filter((member) => !(senderSessionId && member.sessionId === senderSessionId))` ⇒ **v8：发言者本人一律排除（自环防护）** |
| `full` 判定 | `:658` | `text !== undefined && mode === 'full'` |
| ping 文案 | `:660` | `【会议室 <房名>】<发言者> 有新发言（#<seq>）。用 room_read 看完整记录；有新意见或要回应就 room_say，没有新内容就不必发言。` —— **只由 `authorLabel` + 序号拼成，绝不引用任何发言正文** |
| 普通 notice 文案 | `:663` | `【会议室 <房名>】有 <count> 条新消息（最新 #<seq>）。用 room_read 按需查看，然后简短回应；不要凭印象回答。` |
| `noticeText` | `:664` | `kind==='adjourn'` 或 `authorLabel==='系统'` 时用 `body`；否则 `【会议室 <房名>】<作者>：<body>`（`full` 时 `<body>` = 正文） |
| 最终文案 | `:665-669` | `noticeStyle === 'ping' && mode === 'notice'` ⇒ **ping 文案**（原样送达，不套 「房名+作者」前缀）；否则 `full` ⇒ `【房名】作者：正文`；否则 `noticeText` |
| 逐成员投递 | `:670-687` | 每个成员先 `host.activate(sessionId)`（v5 语义：失败进 `failed` 不抛错），再 `host.relayWithEffort(..., { senderSessionId })`；回包 `{ delivered, failed, activated }` |

**已知既有缺陷（P3-a，v6/v7 就有，v8 未修）**：人类 `/post` 的 `notice` 走 `noticeText` 时会写成 `【房名】我：【房名】有 N 条新消息…`（房名出现两次）。它**不影响 v8 的 ping**（ping 文案单独构造，只出现一次房名）。

## 4. 宿主契约：`room_say` 三态（`index.js:2716-2807`）

工具描述 `:2718`：「缺省（不传 mode/to）＝写入会议记录 **并且自动接力**…只想记录、不打扰任何人就显式传 `mode='archive'`；要点名回应就传 `to`」；参数枚举 `:2724`（`archive` / `notice` / `full`）。

```js
const modeProvided = typeof args.mode === 'string' && args.mode.trim() !== '';        // :2750
const mode = ['archive','notice','full'].includes(args.mode) ? args.mode : '';       // :2751
const hasTo = Array.isArray(args.to) && args.to.length > 0;                          // :2752
const cap = Number(host.config?.autoContinueHops) > 0 ? Math.floor(Number(host.config.autoContinueHops)) : 0; // :2753
```

**决策矩阵**（先 `room.append(...)` 落记录 `:2741-2746`，再按下面分支投递）：

| `mode` | `to` | 行为 | 返回值（`:2799-2805`） |
| --- | --- | --- | --- |
| `notice` / `full` | 有 / 无 | 走 v6/v7 原语义：`room.deliver(...)`（`noticeStyle` 不传 ⇒ 普通 notice 文案；`full` 投正文） | `已通知 N 人。` |
| `archive` | 任意 | **只归档，不投递**（显式沉默档） | `已写入会议记录（未打扰任何人）。` |
| 白名单外非空（如 `'ARCHIVE'`、`'bogus'`） | 任意 | 按「显式传了 mode」处理 ⇒ **只归档、不接力**（防御性修法，`:2748-2751`） | `已写入会议记录（未打扰任何人）。` |
| 未传（`mode` 空） | 无 | **自动接力**：投给除自己外的全体成员 | `已写入会议记录，并自动接力提醒 N 人（第 R/C 跳）。` |
| 未传 | 有 | 走 `to` 定向投递（不接力） | `已通知 N 人。` |

**自动接力分支（`:2772-2797`）**：

```js
} else if (!modeProvided && !hasTo) {
  const others = [...room.members.values()].filter((m) => m.sessionId !== sessionId);
  if (room.room.status !== 'closed' && others.length && cap > 0) {
    if (room.autoHop < cap) {
      room.autoHop += 1;
      relayed = room.autoHop;
      const outcome = await room.deliver({ kind:'chat', authorLabel: label, targets: others.map((m) => m.sessionId),
        mode:'notice', latestSeq: message.seq, senderSessionId: sessionId ?? undefined, noticeStyle:'ping' });
      ...
    } else if (!room.autoCapNoticed) {
      room.autoCapNoticed = true;
      await room.appendSystem(`自动接力已达上限（${cap} 跳），等待你的指令。`);   // :2792
      capped = ` 自动接力已达上限（${cap} 跳），等待你的指令。`;
    } else {
      capped = ` 自动接力已达上限（${cap} 跳）。`;
    }
  }
}
```

- **只归档、不接力的四种情况**：`room.status === 'closed'`（已散会）、除自己外**没有别的成员**、`cap === 0`（关闭）、显式 `archive` / 白名单外 `mode`。
- **触顶**：每个用户消息周期**恰一条**系统行（`autoCapNoticed` 去重，`:2790-2792`）；之后同一周期内只回 `自动接力已达上限（6 跳）。`，不再写系统行。
- **额度归零**：人类 `POST /rooms/:id/post` 在落记录后立刻 `room.autoHop = 0; room.autoCapNoticed = false;`（`:2157-2159`）⇒ 每发一次言重新拿到 6 跳。
- **状态是纯内存态**：`autoHop` / `autoCapNoticed` 在房间对象构造时初始化为 `0` / `false`（`:340-342`），**不写 `room.json`**，重启归零；模块顶部还有一行注释说明（`:340`）。

## 5. Config：`autoContinueHops`

| 位置 | 内容 |
| --- | --- |
| zod schema | `index.js:61`：`autoContinueHops: z.number().default(6).description('一次人类发言之后允许自动接力几跳；0 = 关闭自动接力（只进配置，不加面板）')` |
| 独立护栏 | `index.js:1886-1891`：`const rawHops = config?.autoContinueHops; const autoContinueHops = typeof rawHops === 'number' && Number.isFinite(rawHops) && rawHops >= 0 ? Math.floor(rawHops) : 6;`（注释写明：`Number(null)===0` 会静默关闭，所以不能用 `Number` 强转） |
| 装配 | `:1892-1899` 进 `cfg`（`autoContinueHops` 与 `autoCloseGoals` 并列）；`:1901` `new MeetingHost(ctx, cfg)` |
| 面板 | **没有**：v8 不新增任何 UI 控件（用户明令），这个键只出现在 cordis 配置、加载日志与文档里 |

| 配置值 | 生效跳数 | 说明 |
| --- | --- | --- |
| 缺省（不写） | 6 | zod `.default(6)` |
| `6` / `3` / `1` | 6 / 3 / 1 | 直接生效 |
| `1.9` | 1 | `Math.floor`（zod 只校验 number，取整在 `apply()` 里做） |
| `0` | 0 | **关闭自动接力**（与会者缺省发言退回「只记录」；显式 `notice`/`full`/`to` 不受影响） |
| `-1` | 6 | `rawHops >= 0` 不成立 ⇒ 回落默认 |
| `null` / `''` / `false` / 字符串 | 6 | 类型护栏 ⇒ 回落默认（**不会**被误当成 0 而静默关闭） |
| `Infinity` / `NaN` | 6 | `Number.isFinite` 不成立 ⇒ 回落默认 |

## 6. 客户端契约（`client\client.js`）

| 项 | 行号 | 内容 |
| --- | --- | --- |
| `sendPost` | `:1207-1217` | body 恒 `{ text, mode:'notice' }`（`:1208`）+ 可选 `to`（`:1210`）、`files`（`:1211`）；**v8 未改动**（v7 语义） |
| composer 提示行 | `:1326` | `你的消息只留在会议室记录里，不会进入与会者对话；与会者会收到一行『有新消息』提醒（不含你的正文）。与会者之间的发言会自动接力（默认最多 6 跳）；没有新意见就自然停下。思考程度：…`（**v8 新增中间那句**） |
| 「策划会议」抽屉第二行 | `:1585` | `每次发送后，与会者会收到一行『会议室有新消息』提醒（不含你的正文），由他们自己来读。与会者之间的发言会自动接力（默认最多 6 跳）；没人有新意见就自然停下。`（**v8 新增后半句**；第一行 `:1584`、盒头 `:1583`） |
| 触顶系统行渲染 | `:1338-1341` | `author.kind === 'system' \|\| message.kind === 'system'` ⇒ 走 `S.bubbleSystem` 既有样式；**v8 没有新增样式或控件** |
| 界面控件 | — | 仍无「唤醒与会者」按钮、无投递档位、无自动接力开关（用户明令不许擅自加功能） |

## 7. HTTP 端点（**v8 无增删**）

| 方法 | 路径 | v8 相关点 |
| --- | --- | --- |
| POST | `/rooms/:id/post` | `mode` 归一化 `:2143-2148`：`'full'` ⇒ `'notice'`，非 `archive`/`notice` 的一律 ⇒ `archive`（老客户端兜底）；落记录后 **`autoHop = 0` / `autoCapNoticed = false`**（`:2157-2159`）；`mode !== 'archive'` 才 `deliver()`（`:2163-2173`，**不传** `senderSessionId`：人类不是成员）。回包 `{ message, delivered, failed, activated, droppedFiles, mode }` |
| POST | `/rooms/:id/kick` | v7 未改（`reason` 可选）；v8 未改 |
| — | 工具 | 仍 12 个 `room_*`；只有 `room_say` 的**缺省行为**变了（§4） |

## 8. 锚点表（全部按 v8 冻结文件实测）

**宿主 `index.js`（141492 B / 3015 行）**

| 锚点 | 行号 |
| --- | --- |
| `autoContinueHops` zod 定义 | `:61` |
| 房间内存态初始化（`autoHop` / `autoCapNoticed` + v8 注释） | `:340-342` |
| `deliver()` 定义（v8 注释） | `:647-651`（签名 `:652`） |
| `deliver()` 排除本人 | `:656-657` |
| ping 文案 / body / noticeText / finalText | `:660` / `:663` / `:664` / `:665-669` |
| `deliver()` 逐成员激活 + relay + 回包 | `:670-687` |
| `apply()` 的 `autoContinueHops` 护栏 | `:1886-1891`（装配 `:1892-1901`） |
| `/post` mode 归一化 | `:2143-2148` |
| `/post` 额度归零 | `:2157-2159` |
| `/post` 投递调用 | `:2163-2173` |
| `room_say` 工具定义 + 描述 | `:2716-2726`（描述 `:2718`、枚举 `:2724`） |
| `room_say` execute 落记录 | `:2741-2746` |
| `modeProvided` / `mode` / `hasTo` / `cap` | `:2750` / `:2751` / `:2752` / `:2753` |
| 显式 `notice`/`full` 分支 | `:2759-2771` |
| 自动接力分支（`autoHop` ++ / ping 投递） | `:2772-2789`（`:2775-2777` 自增、`:2778-2786` 投递） |
| 触顶系统行 + 去重 | `:2790-2796`（`appendSystem` `:2792`） |
| 返回值拼接 | `:2799-2805` |
| 加载日志（文案仍写 `v4 已加载`，v8 未改） | `:3014` |

**客户端 `client/client.js`（99018 B / 1814 行）**

| 锚点 | 行号 |
| --- | --- |
| `sendPost`（body 恒 `mode:'notice'`） | `:1207-1217`（body `:1208`） |
| composer 提示行（v8 文案） | `:1326` |
| 系统消息渲染 | `:1338-1341` |
| 抽屉第二行（v8 文案） | `:1585`（第一行 `:1584`） |
| 踢人 ✕ 直接踢（v7 语义） | `:1489-1493`（`onClick` `:1492`） |
| `askText` 定义 + 4 处调用 | `:732`；`:1301` / `:1443` / `:1608` / `:1759` |

## 9. 变更记录

| 包版本 | 契约要点 |
| --- | --- |
| **0.8.0（v8）** | `room_say` 缺省 = 写记录 + 自动接力（`noticeStyle:'ping'`，不含正文）；`deliver()` 排除 `senderSessionId`；Config `autoContinueHops`（默认 6、0 = 关闭、类型护栏回落 6）；触顶系统行（每周期一条）；人类 `/post` 归零额度；客户端两句文案；无端点 / 工具增删 |
| 0.7.0（v7） | 删除「唤醒与会者」按钮、`sendPost` 恒带 `mode:'notice'`、踢人不问理由；宿主未动 |
| 0.6.1 | `pathIdentity` 用 BigInt（修大 inode 舍入导致的概率性误拒） |
| 0.6.0（v6） | 用户正文结构性不外发（`/post` 只收 `archive`/`notice`）、`push` 收窄、`pickEffort` 修 `ctx.get('llm')` + `await`、插件自带输入面板、页头 chip 移除 |
| 0.5.0（v5） | 按需激活（`activate()` 三级）、回包 `activated`、会议文件抽屉、滚动语义 |
| 0.4.1 / 0.4.0 | `agent/pre-step` waterfall 钩子契约；单入口面板 + 聊天室化 + 内置记录员 + 顶层会话 |

## 10. 未核实项（诚实清单）

1. **真机未重启**：本机运行中的 DSH 进程还是 v6.1 的代码（v7 客户端改动也没生效）⇒ 「自动接力让房间自己往下走」**没有在真机上被看到过**；重启后 **v7 + v8 一起生效**。
2. **客户端那句「默认最多 6 跳」是硬编码文案**：`client.js:1326` / `:1585` 写死 6，改 `autoContinueHops`（改成 3、或设 0 关闭）**不会**更新界面文字。
3. **P3-a 未修**：人类 `/post` 的 `notice` 文案里房名出现两次（§3 末尾）；v6/v7 既有，v8 按「不扩大改动面」保留。
4. **`autoContinueHops` 归一化的边缘路径**：`:1886-1891` 的护栏写在 `apply()` 里；绕过 `apply()` 直接构造宿主（自测 / 夹具）拿不到它。zod 那条 `.default(6)` 与它是两层独立保护。
5. **自动换力的真实效果未端到端**：自测用 stub `agents` / `llm`，只能证明「缺省会投递、投给谁、投什么文案、上限如何截断」，**不能证明与会者真的会接话**（那取决于模型与它自己的判断）。
6. **`autoHop` 内存态的真实演化未观察**：多房间同时接力、长时间运行后的计数、以及重启归零的实际观感，都只在自测夹具里验过。
7. **客户端观感未取证**：两句文案在真机上的排版（composer 提示行会不会太长、抽屉里两行的折行）需要重启后目视。

## 11. 自测与红线

- **v8 定稿自测**：`selftest/run.mjs` `243653 B / 4359 行 / SHA1 7F3B064F179FEEFCF4E4D2620D3EA0C8B65E69CB`；实跑 `合计 407 项：通过 407，失败 0`、exit 0、0 条 FAIL（收口方**连续两次**实跑全绿，0 条 FAIL）。
- **v8 行为面断言**：`room_say` 缺省＝归档 + 除本人外全员 `notice`（ping 文案用哨兵串证明**不含**发言正文）、显式 `mode:'archive'` 不接力、白名单外非空 `mode` 只归档、上限截断后**恰一条**系统行、`autoContinueHops = 0` 关闭、`room.status === 'closed'` 不接力、人类 `/post` 把 `autoHop` 归零、`deliver()` 排除 `senderSessionId` 本人。
- **红线**：本文档只描述 v8 冻结快照；不改源码、不改 `package.json` / `selftest`；不写真实会议数据（`C:\Users\uyiop\dsh\会议` 与 `C:\Users\uyiop\.dsh\meeting-room` 只读）；不重启 DSH；文档里不出现桌面临时目录那类旧路径字面量（安装引用只认 `link:C:/Users/uyiop/dsh/dsh-meeting-room`）。
