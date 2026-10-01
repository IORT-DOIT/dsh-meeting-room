# dsh-meeting-room v6 契约（文档口径：v6.1 定稿，包版本 `0.6.1`；v6 基线是 `0.6.0`）

> 本文件是 **v6 / v6.1 的唯一权威口径**。v5 及更早的口径见 `docs/v5-API.md`（v5 / `0.5.0`）、`docs/v4-API.md`（v4 / v4.1）、
> `docs/v3-API.md` / `docs/v2-API.md`（历史）。写接口 / 改行为前，先改**本文件**，再改 `index.js`、`client/client.js`、`selftest/run.mjs`、`README.zh.md`。
>
> **行号口径**：本文所有行号都是 `read` / `Get-Content`（含全部行）口径的**实测**行号，对应下面这份冻结快照。谁给行号都必须先复核；
> 行号会随改动漂移，**以内容为准，不以行号为准**。

## 0. 冻结快照（本文件所有锚点的基准）

| 文件 | 字节 | 行数（`Get-Content`） | SHA1（`Get-FileHash -Algorithm SHA1`） |
| --- | --- | --- | --- |
| `index.js` | 137578 | 2952 | `DA8C43BA76B8AB85E6B2246FA2C01FE43DA158B6`（**v6.1 定稿**；v6 基线是 137234 B / 2949 行 / `C42BCE4E7E4DC1E68DDB1DAFF2281A92B02776AE`） |
| `client/client.js` | 99186 | 1823 | `717089C9D63404B47E14DB77EBA1FD85E4F4ABEF`（v6.1 **未动**） |
| `package.json` | 2690 | 55 | `347B136D25E876271813E9BD9B932C6D76AD0729`（`version` = `0.6.1`；v6 基线是 2496 B / `B8A543B4C0F65B6C9CBFBDB0CB6B9FECAB1A96A9` / `0.6.0`） |
| `selftest/run.mjs` | 225949 | 4070 | `7B44578B2AD4CDE0AFE1A62BF8B4E88DBDAC3C52`（v6 定稿 385/385/0；v6.1 **未动**。v5 定稿是 196820 B / 3589 行 / `FF89FEC70700F7E1FE893B0F7951C127DC09D02A`） |

契约来源（宿主官方）仍按 `docs/v5-API.md` §0 的副本口径取：`api-catalog.js` 必须用 asar 直读的**权威副本**（605995 B / 8159 行 / `616BE74C2F025BAF1FD991DB2C05F9F936076E78`），
`.recon-tmp\dsh\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js`（598769 B / 8073 行 / `21F6189114EFFD7DCD6110500C4F278D800B23E9`）是**截断副本**，不得据它写行号。

---

## 1. 需求 → 落地映射（用户原文，不得扩大范围）

用户在 v6 这轮提了四条（原文见 `docs/v6-方案.md` §0）：

| # | 用户需求 | v6 实现 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 「别人（与会者 AI）怎么收到我的消息」：**我发的消息只出现在会议室里，不出现在与会者的对话中** | 用户正文**结构性**不外发：`/post` 只接受 `archive` / `notice`，`mode:'full'` 一律降级 `notice`（降级后投递内容只有一行提示、不含正文），缺省 `archive`；房间级 `push` 不再影响发帖，「投递默认值」三档 UI 整体移除；房间 `push` 只允许 `off` / `notice` | 宿主 `index.js:29-30` / `:423` / `:2006-2011` / `:2118-2152`；客户端 `DrawerDelivery` `client/client.js:1586-1603`、composer 提示 `:1327` |
| 2 | 「与会者又出 bug 了」（每轮「本轮运行失败」） | `pickEffort` 不再直接读受限代理属性，改 `ctx.get('llm')`；并按官方契约**加 `await`** 调 `resolveModelInfo()`（原来是同步取值 ⇒ 只拿到 Promise ⇒ 思考等级静默失效） | 宿主 `index.js:1650-1668`、调用点 `:1704` |
| 3 | 「踢出会议室」功能失效 | 原生输入对话框在桌面客户端运行时不可用（拿不到返回值 ⇒ 静默不动作）。插件自带输入面板（`Dialog` + `askText`），**5 处**原生输入调用全部替换；踢人链路本身（宿主 `/kick` 路由）不需要改 | 客户端 `client/client.js:733-815`（面板）、`:1302` / `:1444` / `:1492` / `:1617` / `:1768`（5 处调用） |
| 4 | 去掉聊天界面最上面的**在线人数**与**记录员（内置 AI）**两个 chip | 页头删掉这两个 chip（信息在「策划会议」里本来就有）；标题 / 状态 / 已归档 / 会议文件按钮 / 返回列表 / 策划会议全部保留 | 客户端 `client/client.js:1248-1258`（`:1252` 留了删除说明，`:1550-1553` 是「策划会议 → 记录员」段里**保留**的身份 chip） |

**v6 明确不改**：`deliver()` 本体（`:647-676`）与 `'full'` 语义（《会议结果》投递 `:2455-2462`、散会决议 `:2917-2924`、与会者互发 `room_say` `:2695` / `:2702` / `:2727-2736` 仍可用 `full`）；
v1–v5 的全部能力（目录护栏、按需激活、`activated` 回包、文件抽屉、滚动语义、内置记录员、12 个 `room_*` 工具）；`inject` 数组（`:1870` 仍是 `['tools','webServer','agents']`）；不新增依赖。

---

## 2. 与 v5 的差异总览

| 项目 | v5 | v6 |
| --- | --- | --- |
| 用户消息外发 | 房间 `push='full'` 时每条用户消息都把**正文**投进与会者会话 | 用户正文**永不外发**：`/post` 只收 `archive`/`notice`，`full` 降级 `notice`，缺省 `archive` |
| 房间 `push` 取值 | `off` / `notice` / `full` | 只剩 `off` / `notice`；老房间的 `full` 载入即归一化成 `off` |
| 发帖缺省 mode | `pushAll:true → full`；否则跟房间 `push`（`off → archive`） | 恒 `archive`（不跟随房间、不看 `pushAll`） |
| 「投递默认值」三档 UI | 三档按钮 + 三行档位说明 + composer 按档位取人话 | UI 移除；`DrawerDelivery` 改成固定两条说明；composer 固定文案 |
| 思考程度（`pickEffort`） | 直接读 `this.host.ctx?.llm`（受限代理抛 `cannot get property "llm" without inject`）+ 同步调 async 的 `resolveModelInfo` | `ctx.get?.('llm')` + `await resolveModelInfo()`；失败静默降级只 warn |
| 原生输入框 | 5 处 `window.prompt(...)` | 0 处；插件自带 `Dialog` / `askText`（Enter 提交、Escape 关闭、必填校验） |
| 页头 chip | `N/M 人` + 记录员 chip（含「未指定记录员」警告） | 两者移除；其余页头元素保留 |
| 端点 / 工具 / 配置项 | — | **无增删**（`/post` 接受 `mode` 的范围收窄、`PATCH /rooms {push}` 白名单收窄） |
| 生效方式 | — | **需重启 DSH（或完整重载插件 scope）** |

---

## 3. 宿主契约（`index.js`）

### 3.1 用户正文不外发（结构性关闭）

- `index.js:29-30`：
  ```js
  // v6：移除 'full' —— 用户正文永不外发；已存 push='full' 的房间由载入归一化钩子变成 'off'
  const PUSH_MODES = new Set(['off', 'notice']);
  ```
- 载入归一化（`:423`，原样保留）：`if (!PUSH_MODES.has(this.room.push)) this.room.push = 'off';` ⇒ 老房间里的 `push:'full'` 一旦被载入就变 `'off'`（与用户选的「默认谁都别被打扰」一致）。
- `PATCH /rooms/:id { push }`（`:2006-2011`）：只接受 `off` / `notice`，否则 400，文案 `push 只能是 off/notice`（`:2008` 用 `[...PUSH_MODES].join('/')` 拼）。
- `POST /rooms/:id/post`（`:2118-2152`）的 mode 归一化：
  ```js
  let mode = String(body.mode ?? '');
  // v6：用户消息永不外发 —— 'full' 一律降级为 'notice'（老客户端兜底）；
  // 缺省 'archive'（只写进会议室记录），不再跟随房间 push，也不再认 body.pushAll→full
  if (mode === 'full') mode = 'notice';
  if (!['archive', 'notice'].includes(mode)) mode = '';
  if (!mode) mode = 'archive';
  ```
  - `:2137` 先 `room.append({ kind:'chat', text, ... })`（**消息一定进会议室记录**）；
  - `:2141` 只有 `mode !== 'archive'` 才投递；`:2142-2146` 目标：`body.to` 非空用它，否则 `pushAll === true` 展开成全成员，否则空数组（`deliver()` 对空数组的缺省 = 全体成员，`:651`）；`:2147` 调 `room.deliver(...)`；
  - `:2152` 回包不变：`{ message, delivered, failed, activated, droppedFiles, mode }`。`archive` 时 `delivered` / `failed` 为空、`activated` 为 0，回包里 `mode` 是**归一化后**的值（老客户端传 `full` 会看到 `notice`）。
- `deliver()` 本体**没有改**：`:652` `const full = text !== undefined && mode === 'full'`、`:653-657` 文案拼装、`:660` 先 `host.activate()`、`:675` 返回 `{ delivered, failed, activated }`。
  `full`（含正文）现在只由**非用户路径**使用：《会议结果》投递 `:2455-2462`、散会决议 `:2917-2924`、与会者 `room_say`（工具 `:2695` / enum `:2702` 仍含 `full`，`:2727-2736` 按 `args.mode` 投递）。

### 3.2 `pickEffort`：受限代理访问 + async 契约

`index.js:1650-1668`（`EffortControl` 内）：

| 锚点 | 内容 |
| --- | --- |
| `:1650` | `async pickEffort(provider, model, level) {` |
| `:1651-1652` | 注释：插件 ctx 是 Cordis 受限代理，直接读 `.llm` 会抛 `cannot get property "llm" without inject`（`inject` 不含 `llm`），必须用 `get()`（与 `:758` 同法） |
| `:1653-1654` | `const llm = this.host.ctx.get?.('llm');` / `if (!llm?.resolveModelInfo) return null;` |
| `:1656-1660` | `try { info = await llm.resolveModelInfo(provider, model); } catch { return null; }`（官方契约里 `resolveModelInfo` 是 **async**） |
| `:1661-1667` | `efforts` 取值与档位映射逻辑**逐字保留**（`ids.includes(level)` / `high→末位` / `low→首位` / 其余→中间） |
| `:1695-1710` | `onRequest` 钩子：`:1696 await next()`、`:1704 const effort = await this.pickEffort(...)`、`:1706` 取不到时只发一次 warn（`warnOnce`）后原样返回 |
| `:1870` | `export const inject = ['tools', 'webServer', 'agents'];`（**未动**，保持惰性获取） |

修好前：与会者会话每轮直接抛 `cannot get property "llm" without inject`，UI 显示「本轮运行失败」；即使访问修好而漏掉 `await`，也只会拿到 Promise ⇒ `efforts` 取不到 ⇒ 返回 `null` ⇒ 思考程度**静默失效**。
两者必须一起改。历史错 `Cannot read properties of undefined (reading 'kind')` 是 v4.1 已修的另一桩（现 `onPreStep` `:1681-1694` 正确 `return next()`），保留为对照。

### 3.3 `pathIdentity`：文件身份必须用 BigInt（v6.1 修复）

`index.js:1819-1827`：

```js
/** 文件身份（卷 + 文件索引）：同一位置的别名路径（映射盘、subst、软链、短名、大小写）会得到同一个身份 */
async function pathIdentity(target) {
  // bigint: true ⇒ st.ino/st.dev 是 BigInt，交给模板串精确转十进制。
  // 否则大 inode（本机 ≈1e16 > 2^53）会被 Number 舍入，两个相差 1 的 ino 可能变成同一个 double，
  // 使 isSameLocationAsAncestor 误判「就是受保护位置」而拒绝合法目录（v6.1 修复）。
  const st = await stat(target, { bigint: true }).catch(() => null);
  if (!st || st.ino === 0n) return null;
  return `${st.dev}:${st.ino}`;
}
```

- **v6 的旧实现**是 `const st = await stat(target).catch(() => null); if (!st || !st.ino) return null;` ⇒ `st.ino` 是 Number。本机 NTFS 的 ino 量级 ≈6.2e15–2.8e16，多数大于 `2^53 = 9007199254740992`，**相邻 ino 会被舍入成同一个 double**。
- **后果只在否决方向**：`isSameLocationAsAncestor`（`:1833-1844`）把「目标就是受保护位置」判成真 ⇒ 返回 `400 会议室目录不能放在受保护位置`，把合法目录也拒了。3 个调用点 `:925`（`category` 护栏）、`:1039`、`:1114` 全是 deny 方向 ⇒ **只误拒、不会误删、不丢数据**。
- **verifier 实测**（`_verify\v6-ino.mjs`，12/12、观察 38）：背靠背创建 2000 对真目录（相邻差 1 的 1631 对），v6 身份式误判 **9/2000 = 0.45%**（第 1 次）与 **8/2000 = 0.40%**（第 2 次）；同一批改用 BigInt 身份式后 **0**（S6.5b）。失败当次那对 ino（`10696049115848951` / `…852`）被 verifier 一手复算坐实是同一机制。
- **仍是 fail-open（P3，未闭环）**：`st.ino === 0n`（或 `stat` 失败）时返回 `null`，身份层静默失效 ⇒ 该层护栏**漏放行**；方向与上相反、危害更低，见 §10。
- **独立复验（task-31）**：verifier 另起一支探针 `_verify\v6.1-ino.mjs`（39/39）复验本修复 —— 真 FS 背靠背 2500 对，**v6.1 臂误判 0/2500，v6 臂 4/2500 = 0.16%**；确定性扫描每格 5000，Number 臂在 `[2^53,2^54)` Δ1 为 **0.500**、`[2^54,2^55)` Δ1 为 **0.750**，v6.1 臂**全格 0.000**；失败当次那对（`10696049115848951` / `…952`）在 v6 口径下同串、v6.1 可区分。护栏否决方向未放松：`v6.1-guard` **74/74**（房间目录 11 例、分类目录 7 例仍 400；5 个同型用例 v6 / v6.1 状态码逐个一致），另有 `v6.1-diff` 20/20、`v6.1-regress` 50/50、`v6-client` 34/34。把现行 `index.js` 反向变异后**逐字节复现 v6 冻结的 137234 B / `C42BCE4E…`** ⇒ 相对 v6 只此一处实质变化（+344 B）。新分级 **P0=0 / P1=0（原 P1 关闭）/ P2=0**，P3 三条保留。报告：`_verify\v6-report.md` 终版 **38293 B / 305 行（非空行口径，全行 399）/ SHA1 `CA457B93822622434D8960FB8A3D1E5D0130B229`**（§10 即本次复验轮）。**边界**：真机 19387 未重启到 v6.1；本批真 FS 带位漂移 ⇒ 4 对样本与 v6 期 9/2000 不可直接比分布。

---

## 4. 客户端契约（`client/client.js`）

### 4.1 「投递默认值」三档被移除

- `PUSH_MODES` / `PUSH_LABEL` **已删除**（`grep -n "PUSH_MODES\|PUSH_LABEL" client/client.js` = 0）；`.recon-tmp` 之外的旧文档若还提三档，那是 v5 口径。
- `DrawerDelivery`（`:1586-1603`）现在是固定说明 + 思考程度：
  - `:1592` 盒头「你和与会者 AI 之间」；
  - `:1593` 「你发的消息只会写进会议室记录，不会出现在与会者的对话里。」
  - `:1594` 「要他们回应时，点消息区上方的「唤醒与会者」：只会发一行『会议室有新消息』，不含你的正文。」
  - `:1595-1602` 「思考程度（房间默认）」四档按钮（`REASONING_LEVELS`）不变。
- composer 底部提示（`:1327`）改固定文案：`你的消息只留在会议室记录里，不会进入与会者对话；需要他们回应时点「唤醒与会者」。思考程度：<档位>（在「策划会议」里改）`。
- 「唤醒与会者」按钮**保留**（`:1503`）：它显式 `POST /rooms/:id/post { text:'（提醒）请在会议室里查看新消息。', mode:'notice' }` —— 投递内容由插件生成、只有一行，不含用户正文。

### 4.2 5 处原生输入框 → 插件自带面板

新增（`:733-815`）：

| 锚点 | 内容 |
| --- | --- |
| `:302` | `view` 状态新增 `dialog: null`（`{ title, hint, value, placeholder, required, confirmLabel, error, onOk }`） |
| `:733-746` | `askText(view, opts, notify)`：写 `view.dialog` 后 `emit()` |
| `:748-752` | `dismissDialog(view)`：清空并重渲染 |
| `:754-774` | `confirmDialog(view)`：`required` 且 trim 后为空 ⇒ 就地置 `error='必填'` 并 **不**调用 `onOk`；否则先清空再回调，回调抛错 / reject 只 `warn` |
| `:776-815` | `Dialog(props)`：`S.dialogWrap`（`:134`）+ `S.overlay`（点击关闭）+ `S.dialogCard`（`:135`）；`input`（`:801-810`，`autoFocus` + `useEffect` 兜底聚焦）、`Enter` 提交 / `Escape` 关闭、`:811` 错误行、`:812-815` 「取消」/「确认」 |
| `:1330` / `:1798` | 房间面板与结果页各挂一次 `view.dialog ? h(Dialog, { view }) : null` |

5 处替换（业务回调与 POST body **逐字保留**，只把取值来源从 `window.prompt` 换成 `askText` 的 `onOk`）：

| # | 锚点 | 标题 / 是否必填 | 原业务动作 |
| --- | --- | --- | --- |
| 1 | `:1302` | 驳回原因（必填） | `POST /rooms/:id/results/:gid/reject { note, by:'我' }` |
| 2 | `:1444` | 再议原因（可选） | `POST /rooms/:id/goals/:gid/reopen { reason }` |
| 3 | `:1492` | 踢出「<成员>」的理由（可选，默认值取 `view.kickReason`） | `POST /rooms/:id/kick { sessionId, reason, notify:true }` |
| 4 | `:1617` | 散会标题（可选，默认「会议已散会」） | `POST /rooms/:id/close { title, body:'（由主持人散会）' }` |
| 5 | `:1768` | 驳回原因（必填） | `review('reject', { note, by:'我' })` |

收敛判据：`grep -n "window\.\(prompt\|confirm\|alert\)" client/client.js` = **0**；`node --check client/client.js` = 0。踢人链路（确认 ⇒ `/kick` ⇒ toast「已踢出」⇒ 刷新后成员消失）不变；
宿主 `/kick` 路由本身完备（激活 / 通知失败只 warn，回 `notified:false`），**没有改宿主**。

### 4.3 页头两个 chip 移除

`client/client.js:1248-1258` 现在是：`:1249` 房间标题 → `:1250` 状态 chip（已结束 / 进行中）→ `:1251` 已归档 chip → `:1252` **v6④ 的删除说明注释** → `:1253` spacer → `:1255` 「会议文件」按钮 → `:1257` 「← 会议室列表」→ `:1258` 「策划会议」。

- 删掉的是「`N/M 人`」在线人数 chip 与记录员 chip（含「未指定记录员」警告）。`grep -n "liveCount" client/client.js` = 0。
- 记录员身份仍能在「策划会议 → 记录员」段看到（`:1550-1553` 的 `记录员（内置 AI）` chip 是**保留**的，与页头无关）。
- `S.chipWarn` 仍被结果状态等使用（`:1293` / `:1748`），因此样式常量未清理（只删了页头上的用量）。

---

## 5. 升级与兼容

| 场景 | v6 行为 | 说明 |
| --- | --- | --- |
| 老房间 `push:'full'` | 载入后变 `off` | `:423` 归一化钩子；`PATCH { push:'full' }` 会 400 |
| 老客户端发 `mode:'full'` | 降级 `notice` | 投递内容**只有一行提示**，不含正文；回包 `mode` 是 `notice` |
| 老客户端发 `pushAll:true` | 不再升 `full` | 缺省就是 `archive`；`pushAll` 仅在 `mode==='notice'` 时用于展开目标（`:2142-2146`） |
| 老客户端依赖三档 UI | 找不到档位按钮 | 客户端代码已换；**必须重启 DSH** 才加载新 `client.js` |
| 与会者 AI 之间 / 结果投递 | 仍可用 `full`（含正文） | `deliver()` 未改；`room_say` 工具 enum 仍含 `full` |
| 思考程度（房间级 / 成员级） | 修复后真正生效 | 之前是「抛错」或「静默失效」，修复需**重启 DSH** |
| 真实数据 | **不动** | 不写真实会议目录 / 状态根；不新增依赖；不改 profile 里的 junction |

---

## 6. 端点与请求（只列 v6 有语义变化的部分）

| 方法 | 路径 | 请求 | v6 语义 |
| --- | --- | --- | --- |
| POST | `/rooms/:id/post` | `{ text*, label?, mode?, to?, files?, pushAll? }` | `mode ∈ archive/notice`；`full` ⇒ `notice`；缺省 `archive`。回包 `{ message, delivered, failed, activated, droppedFiles, mode }` |
| PATCH | `/rooms/:id` | `{ push? }` | 只接受 `off` / `notice`（其余 400） |
| POST | `/rooms/:id/kick` | `{ sessionId?, reason?, notify? }` | **路由未改**（v5 语义：`notify:true` 先激活再通知，失败只 warn → `notified:false`）；v6 改的是客户端如何拿到 `reason` |

其余端点、12 个 `room_*` 工具、cordis 配置项**无增删**。

---

## 7. 排查表

| 现象 | 原因 / 处理 |
| --- | --- |
| 与会者会话里**还能看到**我发的消息正文 | 跑的还是 v5 或更早的客户端 / 宿主。确认包版本 ≥ `0.6.0`，然后**重启 DSH**（`link:` 安装改盘上文件也不会换掉运行中的代码） |
| 与会者每轮「本轮运行失败」，错误写 `cannot get property "llm" without inject` | 这是 v6② 修掉的老代码（直接读受限代理属性）。确认版本 ≥ `0.6.0` 并重启；若仍有，把错误原文连同版本报回来 |
| 设了思考程度但没效果（也不报错） | 老代码里 `resolveModelInfo()` 是 async，同步取值只会拿到 Promise ⇒ 静默失效。v6 已加 `await`；重启后仍无效果就看会话里有没有那条 `模型 … 未声明可用的思考等级` 的 warn |
| 「踢出会议室」点了没反应 | 老代码用原生输入对话框（桌面客户端运行时不可用 ⇒ 静默不动作）。v6 换成插件自带面板；重启后点 ✕ 应弹面板，确认后才发 `/kick` |
| 页头找不到「在线人数」/「记录员（内置 AI）」 | v6④ 有意删除；信息在「策划会议」里（与会者段 / 记录员段） |
| 「策划会议」里找不到「投递默认值」三档 | v6① 有意删除：用户消息永不外发，没有「投递方式」可选；要叫醒与会者就点「唤醒与会者」 |
| `PATCH /rooms/:id { push:'full' }` 返回 400 | v6 起 `push` 只能是 `off` / `notice`（`index.js:2008`） |
| 老房间的 `push` 自己变成了 `off` | `push:'full'` 在载入时被归一化（`index.js:423`），符合「默认谁都别被打扰」 |
| 想确认某条消息到底有没有外发 | 看 `POST /post` 回包：`mode` 是归一化后的值；`archive` 时 `delivered` 为空，`notice` 时投递内容是一行提示、不含正文 |

---

## 8. 锚点表（按 §0 冻结快照实测）

| 主题 | 宿主 `index.js` | 客户端 `client/client.js` |
| --- | --- | --- |
| v6① 白名单 / 归一化 | `:29-30`、`:423`、`:2006-2011` | — |
| v6① 发帖语义 | `:2118-2152`（`:2124-2129` mode 归一化、`:2137` append、`:2141-2147` 投递、`:2152` 回包） | `:1327` composer 提示、`:1503` 唤醒按钮、`:1586-1603` DrawerDelivery |
| `deliver()`（未改） | `:647-676`（`:652` full 判定、`:660` activate、`:675` 回包） | — |
| `full` 的合法用途 | `:2455-2462`（结果）、`:2695` / `:2702`（room_say 工具与 enum）、`:2727-2736`（与会者互发）、`:2917-2924`（决议） | — |
| v6② `pickEffort` | `:1650-1668`（`:1653` get('llm')、`:1657` await）、`:1704` 调用、`:1706` warn、`:1870` inject | — |
| **v6.1 `pathIdentity`（BigInt 身份，P1 修复）** | `pathIdentity` `:1820-1827`、`isSameLocationAsAncestor` `:1833-1844`、调用点 `:925` / `:1039` / `:1114`、`realpathSync.native` 复校 `:1792` | — |
| v6③ 自带面板 | — | `:134-136` 样式、`:302` `view.dialog`、`:733-815` `askText`/`Dialog`、`:1330` / `:1798` 挂载 |
| v6③ 5 处调用 | — | `:1302`、`:1444`、`:1492`、`:1617`、`:1768` |
| v6④ 页头 | — | `:1248-1258`（`:1252` 删除说明） |
| 记录员身份（保留） | — | `:1550-1553`（策划会议内） |
| 加载日志 | `:2951`（文案仍是 `v4 已加载`，v5 / v6 / v6.1 都没改） | — |

---

## 9. 变更记录

| 版本 | 包版本 | 变更 |
| --- | --- | --- |
| **v6.1** | `0.6.1` | **P1 热修**：`pathIdentity` 改 `stat(target, { bigint: true })` + `st.ino === 0n`，消除大 inode（>2^53）被 Number 舍入、相邻 ino 判成同一位置导致的误拒（只误拒、不丢数据）；`index.js:1819-1827`，3 个调用点与其余语义未动。已由独立复验轮确认 **P1 关闭**（报告 `_verify\v6-report.md` 38293 B / 305 行（非空行口径，全行 399）/ `CA457B93822622434D8960FB8A3D1E5D0130B229`；P0=0 / P1=0 / P2=0）。**需重启 DSH 才生效** |
| v6 | `0.6.0` | 用户消息正文**永不外发**（`/post` 只收 `archive`/`notice`、`'full'` 降级 `notice`、缺省 `archive`、房间 `push` 只剩 `off`/`notice`、三档 UI 移除）；`pickEffort` 改 `ctx.get('llm')` + `await resolveModelInfo()`（修与会者每轮运行失败与思考程度静默失效）；5 处原生输入框换成插件自带 `Dialog`/`askText`（踢人恢复可用）；页头删掉在线人数与记录员 chip。**需重启 DSH 才生效** |
| v5 | `0.5.0` | 投递 / 唤醒时按需激活与会者（`MeetingHost.activate()`）、`deliver()` 返回 `activated`、`kick{notify}` 先激活、页头「会议文件」抽屉、发送后滚到底；见 `docs/v5-API.md` |
| v4.1 | `0.4.1` | `agent/pre-step` 钩子返回 `next()` 的结果（waterfall 契约）；见 `docs/v4-API.md` §11 |
| v4 | `0.4.0` | 单入口面板、面板内导航、官方主题 token、内置记录员、`/sessions` 只列顶层会话；见 `docs/v4-API.md` |
| v3 | `0.3.x` | 工作区式分类面板、聊天室化、真实会话名、记录员提示词、文件归位；见 `docs/v3-API.md` |

---

## 10. 未核实项（写进正文但本机无法自证的，一律列在这里）

1. **真机 GUI 观感**：删 chip 后的页头留白、对话框居中与遮罩、必填提示位置都按源码读写；agent 看不到屏幕，需**重启 DSH 后由用户目视**。
2. **原生输入对话框不可用这一事实**：来自用户实测（点 ✕ 无反应）与「桌面端运行时默认不实现该 API」的产品判断；本机没有在运行进程里直接取证 `window.prompt` 的可用性。
3. **`resolveModelInfo` 的真实返回形状**：按官方契约（asar 直读 `api-catalog.js`）它是 async 且返回含 `reasoning.efforts` 的对象；本机自测用的是 stub `llm`，真模型/provider 的档位清单未端到端验证。
4. **踢人后的成员消失、`notified` 真值**：`/kick` 路由与客户端链路都按源码核实；真实投递效果依赖宿主 `agents`，需重启后实测。
5. **v6.1 的量化与复验边界**：**P1 已复验关闭**（task-31：P0=0 / P1=0 / P2=0；真 FS 2500 对 v6.1 臂 0/2500、确定性扫描全格 0.000）。但 0.45% / 0.40% / 0.16% 都是本机 NTFS + **各自批次**的采样值（复验那批带 inode 位漂移、只有 4 对真碰撞样本），与 v6 期 9/2000 **不是同一批、不可直接比分布**；换环境要重跑 `_verify\v6.1-ino.mjs` 重新量化。另：**真机未重启到 v6.1**（运行进程仍可能是 v6 代码），「装进运行进程后不再误拒」尚未真机验证。
6. **实时 Slot 树未用 Inspect 取证**：页头元素改动的实际渲染顺序是从 `client.js` 源码读出的，没有查运行时 Slot 树。
7. **宿主副本一致性**：本文引用的 `index.js` 锚点全部来自 §0 冻结快照（一手 `read` / `grep`）；没有与 profile junction 指向的运行副本逐字节比对。

---

## 11. 红线（改 v6 相关代码时）

1. 不新增任何依赖；不改 `inject` 数组；不改 profile 里的 junction / 软链；不重启 DSH（由用户决定）。
2. 用户正文外发通道必须**结构性**关闭：`/post` 只接受 `archive`/`notice`，`full` 一律降级；不得用「客户端不传」这种约定替代宿主侧白名单。
3. `client/client.js` 里 `window.prompt` / `window.confirm` / `window.alert` 必须保持 **0**；所有输入走 `askText` + `Dialog`。
4. 不得写真实 `C:\Users\uyiop\dsh\会议` 与 `C:\Users\uyiop\.dsh\meeting-room`（只读指纹；跑测试前清 `%TEMP%\mr-*`）。
5. 行号以**实测**为准；`api-catalog.js` 契约只从 asar 直读副本取（§0）。
6. 不得回退 v1–v5 的任何已交付能力：目录护栏、按需激活、`activated` 回包、文件抽屉、滚动语义、内置记录员、12 个工具与全部端点（v6 只收窄 `/post` 的 `mode` 与 `PATCH { push }` 的取值）。
