#!/usr/bin/env node
/**
 * dsh-meeting-room v4 自测（独立测试脚本）
 *
 * 用法：node selftest/run.mjs
 * 退出码：全绿 0，有失败 1；末行固定格式 `合计 N 项：通过 N，失败 0`（README 引用）。
 *
 * 约束：本脚本只读实现（index.js / client/client.js），不修改任何实现文件；
 *       房间数据全部写在 os.tmpdir() 下的临时 root + 临时 category，不碰 profile、不碰 ~/.dsh。
 *       v3 起状态根只放 rooms.json / settings.json，会议文件落在 <category>/<roomId>/，
 *       所以每次 apply 都必须显式传 category（否则会退回真实默认目录 ~/dsh/会议）。
 *
 * 桩机制（沿用 v1）：
 *   register('./stub-loader.mjs') 把 @deepseek-ai/schemastery、@deepseek-ai/dsh-tools、
 *   @deepseek-ai/dsh-llm/message 换成桩 → 动态 import('../index.js') → 用假宿主 ctx 调
 *   apply(ctx, config) → 用 http.createServer 起真服务器，按插件注册的 prefix 路由喂请求
 *   （fetch 打真 HTTP，不 mock）。
 *
 * v4 关键点（测试据此写）：
 *   - 插件只注册一条 {kind:'prefix', path:'/dsh-room'}，内部自解析子路径；本夹具按前缀匹配，
 *     且不包一层 try/catch 改写响应（插件 handler 自己兜错，重复 writeHead 会假失败）。
 *   - 假宿主 ctx 必须有 effect / get / llm.resolveModelInfo / tools.register / webServer.register /
 *     agents.get|list / logger，否则 apply 会炸。
 *   - Agent 工具返回字符串（桩 defineTool 不跑 output.render），断言直接用返回值。
 *   - 工具 exec 上下文取会话 id 的口径：exec.agent.id（index.js workerOf）。
 *   - 记录员是**每个会议室自带的内置 AI**：room.recorder 恒为 {kind:'builtin',label:'记录员'}，
 *     POST /rooms/:id/recorder 与 PATCH|POST /settings {recorder} 一律 400（中文文案逐字断言），
 *     settings.json 不再持久化 recorder，settingsView().recorder 恒 null。
 *   - 目标 complete / 散会 → 宿主自己调 ctx.get('llm').stream 生成草稿（result.status='draft'、
 *     by='记录员'、evidence 是真实 transcript seq 区间），所以假 ctx 必须提供 llm.stream 并把
 *     每次入参记进 sink.llmCalls —— 「提示词占位符真的被替换」就断言送给模型的 userText。
 *     失败 / 无 llm / 空输出 → 503 且 result 保持空、不落草稿文件（llmMode 夹具切换）。
 *   - GET /sessions 默认过滤 subagent（origin/parentSession/delegationDepth/isSeeded 四个口径），
 *     出口带 {total,filtered}，排序 = live 优先 → updatedAt 倒序；?includeSubagents=1 全量。
 *   - 其余端点：GET|PATCH /settings、GET /browse、DELETE /rooms/:id[?purge=1]、
 *     PATCH /rooms/:id 的 category|dir|archived|prompt|saveMode、13 个 room_* 工具（含 room_archive、room_task_done）。
 */
import { register } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

register('./stub-loader.mjs', import.meta.url)
const plugin = await import('../index.js')
const { apply } = plugin

const HERE = path.dirname(fileURLToPath(import.meta.url))
// v6②：源码级断言用（注入清单 / 直读检查）；只读，不参与运行
const pluginSource = fs.readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
const pluginInject = plugin.inject
const WORK = path.join(os.tmpdir(), 'mr-selftest-v3-' + Date.now())
const ROOT = path.join(WORK, 'root')
const OUTSIDE = path.join(WORK, 'outside')
// v3：状态根（只放 rooms.json / settings.json）与会议文件分类目录分离。
const CAT = path.join(WORK, 'cat', '会议')
const CAT2 = path.join(WORK, 'cat2', '会议')
const CAT3 = path.join(WORK, 'cat3', '会议')
fs.mkdirSync(ROOT, { recursive: true })
fs.mkdirSync(OUTSIDE, { recursive: true })
fs.mkdirSync(CAT, { recursive: true })
fs.mkdirSync(CAT2, { recursive: true })

// ---------------------------------------------------------------- 断言小工具

let passed = 0
let failed = 0
const failures = []
const unhandled = []

process.on('unhandledRejection', (error) => {
  unhandled.push(String(error?.stack ?? error))
})

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('PASS  ' + name)
  } else {
    failed += 1
    failures.push({ name, detail })
    console.log('FAIL  ' + name)
    if (detail !== undefined && detail !== '') console.log('      ' + String(detail))
  }
}

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 64 - title.length)))
}

// v3：房间文件在 <category>/<roomId>/；状态根只有 rooms.json / settings.json。
const roomDir = (...seg) => path.join(CAT, ...seg)
const stateDir = (...seg) => path.join(ROOT, ...seg)
const dirOf = (category, ...seg) => path.join(category, ...seg)
const exists = (p) => fs.existsSync(p)
const readText = (p) => fs.readFileSync(p, 'utf8')
const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const json = (value) => {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text
}

// v4：内置记录员的两条固定中文拒绝文案（逐字断言，避免「只要 400 就算过」的松断言）
const V4_ASSIGN_REJECT = 'v4：记录员是每个会议室自带的内置 AI，不需要指派'
const V4_SETTINGS_REJECT = 'v4：记录员是每个会议室自带的内置 AI，不能再配置'
/** 内置记录员视图恒为这个值（不许有 sessionId / role 之类的旧字段残留） */
const isBuiltinRecorder = (r) => r?.kind === 'builtin' && r?.label === '记录员' && r.sessionId === undefined && r.role === undefined
/** 假 llm 固定产出的正文（断言草稿真的来自「模型」而不是别处） */
const LLM_REPLY = '## 记录员（内置 AI）\n\n-LLM-DRAFT-BODY-\n\n## 记录中未涉及\n-LLM-NOTHING-ELSE-\n'
const llmCallsOf = (host) => host.llmCalls ?? []
/**
 * v4 收口（task-15）：`room_result_write` 对 AI 与会者一律禁用 —— 不写盘，只回一段固定中文提示
 * （三句：结果由内置记录员自动生成 + 用 room_goal_report / room_say 表达意见 + 人类在面板手动填写）。
 * 断言刻意检查「没有出现『草稿已写入』」，防止把禁用误判成放行。
 */
const V4_TOOL_DISABLED_HINT =
  '《会议结果》由每个会议室的内置记录员在会议目标达成时自动生成，再由用户审核发布；AI 与会者不能写结果。'
const isToolDisabledHint = (text) => {
  const s = String(text)
  return s.includes(V4_TOOL_DISABLED_HINT) && s.includes('room_goal_report') && s.includes('room_say') && s.includes('面板') && !s.includes('草稿已写入')
}

/**
 * v6②：真机 Cordis 受限代理直读 `.llm` 的原话（逐字断言用；插件的 inject 不含 'llm'）。
 * 出处：v6 方案 §1 图二根因 —— `ctx.llm` 在受限代理上会抛这条错误。
 */
const RESTRICTED_LLM_ERROR = 'cannot get property "llm" without inject'

// ---------------------------------------------------------------- 假宿主夹具

/**
 * 假 agent：ctx.on 记录 (event, fn, opts) 以便测试直接调 handler；
 * followup 复刻真机语义 —— 消息进收件箱时 emit('agent/inbox/inserted', { agent, message })，
 * 然后才记进 sink.deliveries（真机：dsh-agent-loop/lib/index.js:206）。
 * v14①：补齐 session.header.cwd 与 agent 作用域的 tools（影子工具注册要用）——
 * 真机上与会者会话的 cwd 是工作区根，插件据此判断「顶层文件名」。
 */
function makeAgent(id, sink) {
  const listeners = new Map()
  /**
   * v15②：复刻真机 `agent.inbox`（dsh-agent-loop/lib/index.js:70-172 ReactLoopInbox）。
   * 真机契约：followup 进 next-turn、steer 进 next-step；claim 时 next-step 整批取走、
   * next-turn **只取 1 条**（这就是「3 条排队消息 = 多跑 3 个轮次」的来源）；
   * locate/replace/remove 按 message.id 在两张表里找。插件的「最多一条未领取提示」靠它工作。
   */
  const inbox = {
    nextTurn: [],
    nextStep: [],
    locate(messageId) {
      for (const target of ['nextStep', 'nextTurn']) {
        const index = this[target].findIndex((m) => m.id === messageId)
        if (index >= 0) return { target, index }
      }
      return undefined
    },
    replace(messageId, newMessage) {
      const at = this.locate(messageId)
      if (!at) return false
      this[at.target].splice(at.index, 1, newMessage)
      return true
    },
    remove(messageId) {
      const at = this.locate(messageId)
      if (!at) return false
      this[at.target].splice(at.index, 1)
      return true
    },
    /** 模拟一次 DSH 领取（next-step 全取 + next-turn 取 1） */
    claim() {
      const claimed = this.nextStep.splice(0, this.nextStep.length)
      if (this.nextTurn.length) claimed.push(this.nextTurn.shift())
      return claimed
    },
  }
  const agent = {
    id,
    inbox,
    session: { header: { id, cwd: sink.agentCwd } },
    ctx: {
      on(event, fn, opts) {
        sink.onCalls.push({ agentId: id, event, fn, opts })
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          const at = (listeners.get(event) ?? []).indexOf(fn)
          if (at >= 0) listeners.get(event).splice(at, 1)
        }
      },
      // v14①：agent 作用域的工具服务（与真机一样：register 落在这个 agent 的层里）
      tools: {
        get(name) {
          return sink.baseTools.get(name)
        },
        register(def) {
          sink.agentShadows.push({ agentId: id, def })
          return () => {}
        },
      },
    },
    followup(message) {
      // v15②：真机 followup = send(message,'next-turn',true)（进队列后才发 inserted 事件）
      inbox.nextTurn.push(message)
      for (const fn of listeners.get('agent/inbox/inserted') ?? []) {
        try {
          fn({ agent, message })
        } catch {
          /* 真机里监听器炸了不该影响投递 */
        }
      }
      sink.deliveries.push({ to: id, message })
      return Promise.resolve(message)
    },
    steer(message) {
      inbox.nextStep.push(message)
      return Promise.resolve(message)
    },
  }
  return agent
}

/**
 * 用假宿主 ctx 调一次 apply，返回 { routes, tools, deliveries, onCalls, warns, ... }。
 * options: { root, roomId, category, agents:[id], sessionQuery, llmThrows, modelEfforts,
 *            llmMode, agentDefaultModel, providers }
 * v3：category 必须显式给（缺省用临时 CAT），否则房间会落到真实 ~/dsh/会议。
 * v4：llmMode 切换内置记录员的模型通路 —— 'normal'（默认，text-delta + finish:stop）/
 *     'no-llm'（ctx.get('llm') → undefined）/ 'throw'（stream 直接抛）/ 'finish-error' /
 *     'aborted' / 'empty'（只有 finish:stop，没有正文）。每次 stream 的入参都进 sink.llmCalls。
 */
/** v12①：可控闸门 —— 用来把「慢但活着」和「彻底卡死」两种 LLM 流做进自测（不改插件代码）。
 *  open() 返回的闸门自带 wait(ms)：等放开，或最多等 ms 毫秒（超时继续 —— 「慢流」用例要的就是这个）。 */
const gate = {
  open() {
    let release = () => {}
    const promise = new Promise((resolve) => { release = resolve })
    return {
      promise,
      release,
      async wait(ms) {
        await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])
      },
    }
  },
}

function createHost(options = {}) {
  const sink = {
    routes: [],
    tools: [],
    deliveries: [],
    onCalls: [],
    disposers: [],
    warns: [],
    handlerErrors: [],
    llmCalls: [],
    applyError: null,
    // v5：按需激活会话（activate）的可观测计数器 —— 用来断言「优先走 sessionController、
    // 不再回落 agents.resume」以及「archive 不激活任何人」。
    resolveAgentCalls: [],
    resumeCalls: [],
    // v12①：看门狗用例用的闸门（慢流 / 卡死流）
    slowGate1: null,
    stallGate: null,
    // v17②：host 作用域 ctx.on 注册的监听（approval/request 就走这里）
    hostOnCalls: [],
    // v14①：会议文件暂存区 —— 假 agent 的 cwd、agent 作用域影子注册、基准工具收到的参数
    agentCwd: options.agentCwd ?? path.join(os.tmpdir(), 'mr-agent-cwd'),
    baseTools: new Map(),
    agentShadows: [],
    agentToolCalls: [],
  }
  /**
   * v14①：四个「吃 file_path」的基准工具（真机由 dsh-tool-fs 提供）。
   * 影子工具包住它们，所以基准工具记下的是**最终**收到的参数 —— 断言改写是否真的发生。
   * output.render 是 register 的硬要求（index.js 只替 agent 作用域注册，这里只做基准）。
   */
  for (const name of ['write', 'edit', 'read', 'read_image']) {
    sink.baseTools.set(name, {
      name,
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: true },
      output: { schema: { type: 'object' }, render: () => [] },
      execute(args, exec) {
        sink.agentToolCalls.push({ tool: name, args, agent: exec?.agent?.id ?? null })
        return { ok: true, tool: name }
      },
    })
  }
  const agents = new Map()
  // v15②：暴露给用例读 agent.inbox（断言「排队消息」深度与文案原地刷新）
  sink.agents = agents
  const addAgent = (id) => {
    const agent = makeAgent(id, sink)
    agents.set(id, agent)
    return agent
  }
  for (const id of options.agents ?? []) addAgent(id)

  // v5：activate() 的三级通路 = ① agentOf 命中 → ② sessionController.resolveAgent → ③ agents.resume。
  //   默认两条通路都**不**提供（夹具保持旧行为：离线成员激活失败，error='宿主没有提供会话激活能力'）。
  //   options.sessionController=true 提供 ②（resolveMode 可按 sessionId 切 'ok'|'error'|'throw'）；
  //   options.resume=true 提供 ③。两者都给时用于断言「优先 ②，不回落 ③」。
  const resolveModeOf = (sessionId) => options.resolveMode?.[sessionId] ?? options.resolveMode?.default ?? 'ok'
  const resolveErrorText = (fallback) => options.resolveError?.message ?? fallback
  const sessionController = {
    async resolveAgent(sessionId) {
      sink.resolveAgentCalls.push(sessionId)
      const mode = resolveModeOf(sessionId)
      if (mode === 'throw') throw new Error(resolveErrorText('resolveAgent 炸了'))
      if (mode === 'error') return { error: { message: resolveErrorText('会话无法激活') } }
      const agent = agents.get(sessionId) ?? addAgent(sessionId)
      return { agent }
    },
  }
  const resumeAgent = async (arg) => {
    sink.resumeCalls.push(arg)
    const mode = options.resumeMode ?? 'ok'
    if (mode === 'throw') throw new Error('resume 炸了')
    if (mode === 'error') return { error: { message: '无法恢复该会话' } }
    return { agent: agents.get(arg.resumeSessionId) ?? addAgent(arg.resumeSessionId) }
  }

  // llmMode / agentDefaultModel 在调用时读取，所以测试可以中途改（不用为每个失败模式重建宿主）
  // v6②：真机的 resolveModelInfo 是 **async**（返回 Promise）——假宿主持平和它一致，
  // 这样「忘了 await」的实现会在所有思考程度用例上立刻暴露。
  const llm = {
    async resolveModelInfo(provider, model) {
      if (options.llmThrows === true) throw new Error('llm 不可用')
      if (options.modelEfforts && model in options.modelEfforts) return { reasoning: { efforts: options.modelEfforts[model] } }
      if (model === 'no-effort') return { reasoning: { efforts: [] } }
      return { reasoning: { efforts: ['low', 'medium', 'high'] } }
    },
    listProviders: async () => options.providers ?? [{ id: 'prov-a' }, { id: 'prov-b' }],
    listModels: async (provider) => (provider === 'prov-a' ? [{ id: 'model-a' }] : []),
    async *stream(call) {
      sink.llmCalls.push(call)
      const llmMode = options.llmMode ?? 'normal'
      if (llmMode === 'throw') throw new Error('模型服务炸了')
      if (llmMode === 'finish-error') {
        yield { type: 'text-delta', text: '半截草稿' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 500' } } }
        return
      }
      if (llmMode === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      if (llmMode === 'empty') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // v12①：慢但活着（两段之间真等一小会）—— 每来一个 chunk 就该重置看门狗，不该被误杀
      if (llmMode === 'slow') {
        yield { type: 'text-delta', text: '第一段-' }
        await gate.open().wait(options.slowStepMs ?? 120)
        yield { type: 'text-delta', text: '第二段' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // v12①：卡死（正文之后再也不来 chunk）—— 看门狗必须放弃这轮并抛中文 503
      if (llmMode === 'stall') {
        yield { type: 'text-delta', text: '半截-' }
        host.stallGate = gate.open()
        await host.stallGate.wait(5000)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: LLM_REPLY }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const ctx = {
    effect(fn) {
      sink.disposers.push(fn())
      return () => {}
    },
    /**
     * v17②：host 作用域的 ctx.on（真机是 cordis 事件）。会议室插件用它接管
     * 'approval/request' —— 与会者的工具权限请求改由会议室面板批准。
     */
    on(event, fn, opts) {
      sink.hostOnCalls.push({ event, fn, opts })
      return () => {
        const at = sink.hostOnCalls.findIndex((c) => c.event === event && c.fn === fn)
        if (at >= 0) sink.hostOnCalls.splice(at, 1)
      }
    },
    get(name) {
      if (name === 'sessionQuery') return options.sessionQuery
      if (name === 'llm') return (options.llmMode ?? 'normal') === 'no-llm' ? undefined : llm
      if (name === 'agentDefaultModel') return options.agentDefaultModel
      if (name === 'sessionController') return options.sessionController ? sessionController : undefined
      return undefined
    },
    logger: {
      info() {},
      warn(text) {
        sink.warns.push(String(text))
      },
      error() {},
    },
    llm,
    tools: {
      register(def) {
        sink.tools.push(def)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        sink.routes.push(route)
        return () => {}
      },
    },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.keys()].map((id) => ({ id, title: id })),
      // v5：仅当显式打开时才给 resume，否则「宿主没有提供会话激活能力」这条旧断言就失真了。
      ...(options.resume ? { resume: resumeAgent } : {}),
    },
  }

  /**
   * v6② 根因回归护栏：真机上插件 ctx 是 Cordis 的**受限代理** —— 插件的 inject 不含 'llm'，
   * 直接读 `ctx.llm` 会抛「cannot get property "llm" without inject」（v5 的 pickEffort 就是这么炸的，
   * 见图二）。所以假 ctx 默认真复刻这个契约：属性读 `.llm` 抛错，只有 `ctx.get('llm')` 能拿到 llm。
   * 这样任何回退到 `ctx.llm` 直读的实现都会在**所有**用例上立刻炸出来，而不是只在某个分支上。
   * options.directLlm === true 时才退回旧的「随便读」形状（留给未来对比用）。
   */
  const restrictedCtx = options.directLlm === true ? ctx : new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'llm') throw new Error(RESTRICTED_LLM_ERROR)
      return Reflect.get(target, prop, receiver)
    },
  })

  try {
    apply(restrictedCtx, {
      root: options.root ?? ROOT,
      roomId: options.roomId ?? 'main',
      // v3：显式给分类目录，绝不落到真实 ~/dsh/会议
      category: options.category ?? CAT,
      // v8：自动接力上限（不传 ⇒ 实现自带兜底 6；0 ⇒ 关闭；负数/非数 ⇒ 实现回落 6）
      ...(options.autoContinueHops === undefined ? {} : { autoContinueHops: options.autoContinueHops }),
      // v12①：记录员看门狗时限（不传 ⇒ 240s；自测调到几百毫秒，免得真等 4 分钟）
      ...(options.recorderTimeoutMs === undefined ? {} : { recorderTimeoutMs: options.recorderTimeoutMs }),
    })
  } catch (error) {
    sink.applyError = error
  }

  return Object.assign(sink, {
    ctx: restrictedCtx,
    agents,
    addAgent,
    /** v4：运行中途切内置记录员的模型通路（normal / no-llm / throw / finish-error / aborted / empty） */
    setLlmMode(mode) {
      options.llmMode = mode
    },
    /** v6②：运行中途让 llm.resolveModelInfo 抛错（pickEffort 必须吞掉并返回 null） */
    setLlmThrows(value) {
      options.llmThrows = value === true
    },
    /** v6②：运行中途换「模型 → 思考档位」表（值可以不是数组，用来测畸形声明） */
    setModelEfforts(map) {
      options.modelEfforts = map
    },
    setAgentDefaultModel(value) {
      options.agentDefaultModel = value
    },
    /** v5：中途切 resolveAgent 的行为（'ok' | 'error' | 'throw'），用来断言失败通路不冒泡、不回落。 */
    setResolveMode(sessionId, mode, message) {
      options.resolveMode = { ...(options.resolveMode ?? {}), [sessionId]: mode }
      if (message !== undefined) options.resolveError = { message }
    },
    /** v5：切 agents.resume 通路的行为（'ok' | 'error' | 'throw'）。 */
    setResumeMode(mode) {
      options.resumeMode = mode
    },
  })
}

/** 起真服务器，按插件注册的 prefix 路由匹配（不再包 try/catch 改写响应）。 */
function serve(host) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = host.routes.find((r) =>
      r.kind === 'prefix' ? pathname === r.path || pathname.startsWith(r.path + '/') : pathname === r.path,
    )
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"no route"}')
      return
    }
    const record = (error) => {
      host.handlerErrors.push(String(error?.message ?? error))
      if (!res.writableEnded) {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      }
    }
    try {
      Promise.resolve(route.handler(req, res)).catch(record)
    } catch (error) {
      record(error)
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }))
  })
}

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()))

/**
 * v5：显式就绪门（task-24 的 flake 收敛）。
 * apply() 里是 `const readyPromise = host.start().catch((error) => host.warn('初始化失败：' + error?.message))`，
 * 一旦 start() reject，异常会被那条 warn 吞掉、ready 照常 resolve，之后所有路由都 404；
 * 旧脚本就会在后面某处 `.body.goals.find(...)` 上抛 `TypeError: Cannot read properties of undefined (reading 'find')`。
 * 所以起完服务器先显式轮询 GET /dsh-room/rooms，超时就把被吞掉的 warn 原文打印出来（不再靠重跑）。
 */
async function waitReady(host, base, label = '') {
  const deadline = Date.now() + 3000
  let last = null
  for (;;) {
    try {
      const res = await GET(base, '/dsh-room/rooms')
      last = res
      if (res.status === 200 && Array.isArray(res.body?.rooms)) return { ok: true, res, swallowed: [] }
    } catch (error) {
      last = { status: 0, body: String(error?.message ?? error) }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const swallowed = (host.warns ?? []).filter((text) => String(text).includes('初始化失败'))
  console.log(
    '      [ready] ' + (label || '宿主') + ' 3s 内未就绪：GET /rooms = ' + json(last?.body).slice(0, 200) +
      '；被吞掉的 warn = ' + (swallowed.length ? swallowed.join(' | ') : '（无）') +
      '；handlerErrors = ' + json(host.handlerErrors ?? []).slice(0, 200),
  )
  return { ok: false, res: last, swallowed }
}
/** serve + 显式就绪（字段与 serve 一致，另外多一个 ready）。 */
async function serveReady(host, label = '') {
  const started = await serve(host)
  const ready = await waitReady(host, started.base, label)
  return { ...started, ready }
}

async function call(base, method, url, body, headers) {
  const init = { method, headers: { ...(headers ?? {}) } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(base + url, init)
  const raw = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* 非 JSON（/raw、/result 是纯文本） */
  }
  return { status: res.status, body: parsed, raw, headers: res.headers }
}

const GET = (base, url, headers) => call(base, 'GET', url, undefined, headers)
const POST = (base, url, body, headers) => call(base, 'POST', url, body ?? {}, headers)
const PATCH = (base, url, body) => call(base, 'PATCH', url, body ?? {})
const DELETE = (base, url) => call(base, 'DELETE', url)

/** 裸 http.request：伪造 Origin / sec-fetch-site（fetch 不方便设这些头）。 */
function raw(base, urlPath, headers = {}) {
  const u = new URL(base + urlPath)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { host: u.host, ...headers },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const toolOf = (host, name) => host.tools.find((t) => t.name === name)

/** 调 Agent 工具：v2 工具返回字符串本身（桩 defineTool 不跑 output.render）。 */
async function useTool(host, name, args, sessionId) {
  const tool = toolOf(host, name)
  if (!tool) throw new Error('工具缺失：' + name)
  const exec = sessionId ? { agent: { id: sessionId } } : {}
  return tool.execute(args ?? {}, exec)
}

const deliveriesTo = (host, id) => host.deliveries.filter((d) => d.to === id)
const lastDelivery = (host, id) => deliveriesTo(host, id).at(-1)
const deliveryText = (d) => d?.message?.content?.[0]?.text ?? ''

/** 单条投递记录里的会话 id（deliver 返回的 delivered 是 sessionId 数组）。 */
const has = (list, value) => Array.isArray(list) && list.includes(value)

// ---------------------------------------------------------------- 起场

section('装配')

const host = createHost({
  root: ROOT,
  roomId: 'main',
  agents: ['sess-spec', 'sess-impl', 'sess-other'],
  modelEfforts: { weird: ['L1', 'L2', 'L3'] },
  // v4：内置记录员发草稿时先读默认模型；给上就能断言 result.model 采自这里
  agentDefaultModel: { currentSelection: () => ({ provider: 'sel-prov', model: 'sel-model' }) },
})
check('apply 不抛错', host.applyError === null, String(host.applyError?.stack ?? host.applyError ?? ''))
check(
  '只注册一条 prefix 路由 /dsh-room',
  host.routes.length === 1 && host.routes[0].kind === 'prefix' && host.routes[0].path === '/dsh-room',
  json(host.routes.map((r) => [r.kind, r.path])),
)
const TOOL_NAMES = [
  'room_list',
  'room_archive',
  'room_join',
  'room_leave',
  'room_say',
  'room_read',
  'room_files',
  'room_open',
  'room_goal_report',
  'room_result_write',
  'room_task_done',
  'room_request_reopen',
  'room_finalize',
]
check(
  '注册 13 个 Agent 工具且名字齐全（v3 room_archive、v12 room_task_done）',
  host.tools.length === 13 && TOOL_NAMES.every((n) => host.tools.some((t) => t.name === n)),
  '实际 ' + host.tools.length + ' 个：' + host.tools.map((t) => t.name).join(','),
)
check(
  'v3 没有 room_recorder 工具（记录员走 HTTP /recorder）',
  toolOf(host, 'room_recorder') === undefined,
  host.tools.map((t) => t.name).join(','),
)
check(
  'v4 收口：room_result_write 的 description 标明「对 AI 与会者禁用」，工具总数 v12 起是 13',
  host.tools.length === 13 && String(toolOf(host, 'room_result_write')?.description ?? '').includes('（v4：对 AI 与会者禁用）'),
  String(toolOf(host, 'room_result_write')?.description ?? '').slice(0, 200),
)
check(
  '路由与工具都在 ctx.effect 里注册（拿到 disposer）',
  host.disposers.length === 1 && typeof host.disposers[0] === 'function',
  'disposers=' + host.disposers.length,
)

const { server, base, ready: mainReady } = await serveReady(host, '主宿主')
check(
  '启动就绪：apply 后 GET /rooms 显式就绪（start() 失败不再被 readyPromise.catch 静默吞掉）',
  mainReady.ok === true,
  'last=' + json(mainReady.res?.body).slice(0, 200) + ' swallowed=' + json(mainReady.swallowed),
)

section('多房间：创建 / 列表 / 隔离')

const list0 = await GET(base, '/dsh-room/rooms')
check(
  'GET /rooms 返回默认房间 main + defaultRoomId',
  list0.status === 200 &&
    list0.body?.defaultRoomId === 'main' &&
    list0.body?.rooms?.some((r) => r.id === 'main'),
  json(list0.body).slice(0, 200),
)

const alphaCreate = await POST(base, '/dsh-room/rooms', {
  id: 'alpha',
  title: '音效评审',
  goal: '确认 SND-07 音效规格',
})
check(
  'RoomSummary 带 resultCount（侧边栏据此决定要不要挂《会议结果》行）',
  alphaCreate.status === 200 && alphaCreate.body?.room?.resultCount === 0,
  json(alphaCreate.body?.room).slice(0, 200),
)
check(
  'POST /rooms 建房间（带 goal）返回 RoomSummary（v4：recorder 恒为内置 {kind:builtin,label:记录员}）',
  alphaCreate.status === 200 &&
    alphaCreate.body?.room?.id === 'alpha' &&
    alphaCreate.body?.room?.title === '音效评审' &&
    alphaCreate.body?.room?.goalCount === 1 &&
    alphaCreate.body?.room?.status === 'open' &&
    alphaCreate.body?.room?.push === 'off' &&
    alphaCreate.body?.room?.reasoning === 'inherit' &&
    isBuiltinRecorder(alphaCreate.body?.room?.recorder),
  json(alphaCreate.body).slice(0, 300),
)
const betaCreate = await POST(base, '/dsh-room/rooms', { id: 'beta', title: '接口对齐', goal: '对齐 v2 接口契约' })
const gammaCreate = await POST(base, '/dsh-room/rooms', { id: 'gamma', title: '无记录员', goal: '无记录员也能完成任务' })
const deltaCreate = await POST(base, '/dsh-room/rooms', { id: 'delta', title: '离线记录员' })
const echoCreate = await POST(base, '/dsh-room/rooms', { id: 'echo', title: '继承思考程度' })
check(
  '连续建 4 个房间均成功',
  [betaCreate, gammaCreate, deltaCreate, echoCreate].every((r) => r.status === 200),
  [betaCreate.status, gammaCreate.status, deltaCreate.status, echoCreate.status].join(','),
)

const list1 = await GET(base, '/dsh-room/rooms')
const alphaSummary = list1.body?.rooms?.find((r) => r.id === 'alpha')
const SUMMARY_KEYS = [
  'id',
  'title',
  'status',
  'memberCount',
  'liveCount',
  'messageCount',
  'seq',
  'goalCount',
  'doneGoalCount',
  'activeGoalId',
  'recorder',
  'push',
  'reasoning',
  'reopenRequest',
]
check(
  'GET /rooms 列表项含 memberCount/liveCount/goalCount/doneGoalCount/push/reasoning/recorder',
  alphaSummary !== undefined && SUMMARY_KEYS.every((k) => k in alphaSummary),
  json(alphaSummary).slice(0, 300),
)
check(
  'rooms.json 落盘在状态根（v3：状态根只剩 rooms.json / settings.json）',
  exists(stateDir('rooms.json')) &&
    ['main', 'alpha', 'beta', 'gamma', 'delta', 'echo'].every((id) =>
      readJsonFile(stateDir('rooms.json')).some((r) => r.id === id),
    ) &&
    !exists(roomDir('rooms.json')),
  exists(stateDir('rooms.json')) ? json(readJsonFile(stateDir('rooms.json'))).slice(0, 300) : '文件不存在',
)
check(
  'RoomSummary 透出 v3 目录字段（category/dir/archived/archivedAt/prompt）',
  alphaSummary !== undefined &&
    alphaSummary.category === CAT &&
    alphaSummary.dir === dirOf(CAT, 'alpha') &&
    alphaSummary.archived === false &&
    alphaSummary.archivedAt === null &&
    alphaSummary.prompt === null,
  json(alphaSummary).slice(0, 300),
)
check(
  '房间文件落在 <category>/<roomId>/（状态根下没有同名房间目录）',
  exists(dirOf(CAT, 'alpha', 'room.json')) &&
    exists(dirOf(CAT, 'alpha', 'goals.json')) &&
    !exists(stateDir('alpha')) &&
    !exists(stateDir('beta')),
  'dirname=' + dirOf(CAT, 'alpha') + ' rootAlpha=' + exists(stateDir('alpha')),
)
check(
  'rooms.json 每项带 category/archivedAt（v3 状态根 schema）',
  readJsonFile(stateDir('rooms.json')).every((r) => typeof r.category === 'string' && 'archivedAt' in r),
  json(readJsonFile(stateDir('rooms.json'))).slice(0, 200),
)

// 成员登记
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-spec', label: '规格维护方' })
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-impl', label: '实现方' })
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-cold', label: '离线同学' })
await POST(base, '/dsh-room/rooms/beta/join', { sessionId: 'sess-impl', label: '实现方' })
await POST(base, '/dsh-room/rooms/beta/join', { sessionId: 'sess-other', label: '另一实现方' })
const alphaState0 = await GET(base, '/dsh-room/rooms/alpha/state?since=0')
check(
  'join 3 人后成员表 / 在线数正确（sess-cold 离线）',
  alphaState0.body?.members?.length === 3 &&
    alphaState0.body.members.filter((m) => m.live).length === 2 &&
    alphaState0.body.members.find((m) => m.sessionId === 'sess-spec')?.label === '规格维护方' &&
    alphaState0.body.members.find((m) => m.sessionId === 'sess-cold')?.live === false,
  json(alphaState0.body?.members),
)
const rejoin = await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-spec', label: '规格维护方' })
check('重复 join 返回 already:true', rejoin.status === 200 && rejoin.body?.already === true, json(rejoin.body).slice(0, 200))

// ---------------------------------------------------------------- v17② 会议室实时审批

section('v17②：与会者的权限请求在会议室里实时批准 / 拒绝')

const approvalListener = host.hostOnCalls.find((c) => c.event === 'approval/request')
check(
  'v17②：宿主在 host 作用域注册了 approval/request 监听（与会者权限请求改由会议室面板接管）',
  typeof approvalListener?.fn === 'function',
  `hostOn=${json(host.hostOnCalls.map((c) => c.event))}`,
)

// 自测里不裸 await 审批 Promise：万一实现漏了 settle，整轮会挂死（跑不完、也不报错）。
// 统一用 settleWithin 兜 3 秒，超时就拿到 '__timeout__' 让断言失败。
const settleWithin = async (promise, ms = 3000) => Promise.race([
  promise,
  new Promise((resolve) => { const timer = setTimeout(() => resolve('__timeout__'), ms); timer.unref?.(); }),
])

// ① 非与会者：一律 next()，不改原审批结果
let outsiderNext = false
const outsiderOutcome = await approvalListener.fn(
  { agent: { id: 'sess-stranger' }, toolName: 'write', callId: 'call-outsider' },
  async () => {
    outsiderNext = true
    return 'allowed-once'
  },
)
check(
  'v17②：非与会者的权限请求原样 next() 交回 DSH 原审批链（不拦、不改结果）',
  outsiderNext === true && outsiderOutcome === 'allowed-once',
  `next=${outsiderNext} outcome=${outsiderOutcome}`,
)

// ② 与会者：先挂起，房间面板看得到（GET /rooms/:id/approvals + RoomSummary 都能看到）
const approvalPending = approvalListener.fn(
  { agent: { id: 'sess-spec' }, toolName: 'write', callId: 'call-17a', reason: '要写报告' },
  async () => 'unavailable',
)
await new Promise((resolve) => setTimeout(resolve, 20))
const approvalList1 = await GET(base, '/dsh-room/rooms/alpha/approvals')
const approvalSummary = await GET(base, '/dsh-room/rooms/alpha/state')
check(
  'v17②：与会者的请求被挂起（谁、什么工具、什么理由都记下来了）',
  approvalList1.status === 200 &&
    approvalList1.body.approvals.length === 1 &&
    approvalList1.body.approvals[0].callId === 'call-17a' &&
    approvalList1.body.approvals[0].label === '规格维护方' &&
    approvalList1.body.approvals[0].toolName === 'write' &&
    approvalList1.body.approvals[0].reason === '要写报告' &&
    approvalList1.body.approvals[0].sessionId === 'sess-spec',
  json(approvalList1.body).slice(0, 240),
)
check(
  'v17②：待批请求也进 RoomSummary（面板轮询 state 就能弹横幅，不必再开一条轮询）',
  Array.isArray(approvalSummary.body?.room?.approvals) &&
    approvalSummary.body.room.approvals.some((a) => a.callId === 'call-17a'),
  json(approvalSummary.body?.room?.approvals ?? null).slice(0, 200),
)
const approvalAllow = await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17a', decision: 'allow' })
const approvalOutcome1 = await settleWithin(approvalPending)
check(
  'v17②：面板点「允许」→ 请求方立刻拿到 allowed-once，待批表清空（一次性授权）',
  approvalOutcome1 === 'allowed-once' &&
    approvalAllow.status === 200 &&
    approvalAllow.body.decision === 'allow' &&
    approvalAllow.body.toolName === 'write' &&
    (await GET(base, '/dsh-room/rooms/alpha/approvals')).body.approvals.length === 0,
  `outcome=${approvalOutcome1} body=${json(approvalAllow.body).slice(0, 200)}`,
)
check(
  'v17②：已处理过的请求再点一次 → 409（不能重复授权，也不再挂在表里）',
  (await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17a', decision: 'deny' })).status === 409,
  json((await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17a', decision: 'deny' })).body).slice(0, 160),
)

// ③ 拒绝
const approvalPending2 = approvalListener.fn(
  { agent: { id: 'sess-spec' }, toolName: 'edit', callId: 'call-17b' },
  async () => 'unavailable',
)
await new Promise((resolve) => setTimeout(resolve, 20))
const approvalDeny = await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17b', decision: 'deny' })
const approvalOutcome2 = await settleWithin(approvalPending2)
check(
  'v17②：面板点「拒绝」→ 请求方拿到 rejected',
  approvalOutcome2 === 'rejected' && approvalDeny.status === 200 && approvalDeny.body.decision === 'deny',
  `outcome=${approvalOutcome2} body=${json(approvalDeny.body).slice(0, 160)}`,
)

// ④ 请求方自己取消（signal abort）→ cancelled，且不留待批项
const approvalAbort = new AbortController()
const approvalCancelled = approvalListener.fn(
  { agent: { id: 'sess-spec' }, toolName: 'write', callId: 'call-17c', signal: approvalAbort.signal },
  async () => 'unavailable',
)
approvalAbort.abort()
const approvalOutcome3 = await settleWithin(approvalCancelled)
check(
  'v17②：请求方自己取消（signal abort）→ cancelled，待批表不留残项',
  approvalOutcome3 === 'cancelled' &&
    (await GET(base, '/dsh-room/rooms/alpha/approvals')).body.approvals.length === 0,
  `outcome=${approvalOutcome3}`,
)

// ⑤ 别的会议室不能代批 + 非法 decision
const approvalPending3 = approvalListener.fn(
  { agent: { id: 'sess-spec' }, toolName: 'write', callId: 'call-17d' },
  async () => 'unavailable',
)
await new Promise((resolve) => setTimeout(resolve, 20))
const approvalForeign = await POST(base, '/dsh-room/rooms/beta/approvals', { callId: 'call-17d', decision: 'allow' })
const approvalBadDecision = await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17d', decision: 'maybe' })
check(
  'v17②：别的会议室不能代批（404）、decision 只认 allow/deny（400），请求仍挂在原地',
  approvalForeign.status === 404 &&
    approvalBadDecision.status === 400 &&
    (await GET(base, '/dsh-room/rooms/alpha/approvals')).body.approvals.length === 1,
  `foreign=${approvalForeign.status} bad=${approvalBadDecision.status}`,
)
await POST(base, '/dsh-room/rooms/alpha/approvals', { callId: 'call-17d', decision: 'deny' })
const approvalOutcome4 = await settleWithin(approvalPending3)
check(
  'v17②：收尾清理后没有遗留待批（后续用例不受影响）',
  approvalOutcome4 === 'rejected' && (await GET(base, '/dsh-room/rooms/alpha/approvals')).body.approvals.length === 0,
  `outcome=${approvalOutcome4}`,
)

// -------------------------------------- v18：审批监听必须抢在「浏览器审批桥」前面（真机 bug）

section('v18：审批监听注册顺序（真机 bug：请求只弹在会话页，会议室横幅不出现）')

check(
  'v18：ctx.on(approval/request) 必须带 { global: true, prepend: true } —— 浏览器桥先注册且阻塞等用户，普通注册的监听器永远轮不到',
  approvalListener?.opts?.prepend === true && approvalListener?.opts?.global === true,
  `opts=${json(approvalListener?.opts ?? null)}`,
)

// 只读诊断环 + 诊断端点：真机上 GET /dsh-room/staging 一眼看出「监听到底有没有被叫到、
// 注册时到底用了什么 options、是不是本房间成员」。
// 注意：这里的 `host` 是夹具假宿主（createHost），插件内部的 MeetingHost 只能经 HTTP 端点观察。
const stagingDiagnostics = await GET(base, '/dsh-room/staging')
const approvalSeen = stagingDiagnostics.body?.approvals?.seen ?? []
check(
  'v18：诊断环记下最近听到的审批请求（matched=true 是本房间成员，false 是别人的会话）',
  approvalSeen.some((e) => e.matched === true && e.sessionId === 'sess-spec') &&
    approvalSeen.some((e) => e.matched === false && e.sessionId === 'sess-stranger') &&
    approvalSeen.every((e) => typeof e.at === 'string' && typeof e.toolName === 'string'),
  json(approvalSeen.slice(-4)),
)
check(
  'v18：GET /dsh-room/staging 透出 approvals{ready,options,pending,seen} —— 重载 DSH 后一次核验监听是否生效',
  stagingDiagnostics.status === 200 &&
    stagingDiagnostics.body?.approvals?.ready === true &&
    stagingDiagnostics.body?.approvals?.options?.prepend === true &&
    stagingDiagnostics.body?.approvals?.options?.global === true &&
    Array.isArray(stagingDiagnostics.body?.approvals?.seen),
  json(stagingDiagnostics.body?.approvals ?? null).slice(0, 240),
)

// id 前缀漂移：房间成员写 `session-xxx`、请求方 agent.id 是裸 `xxx`（反之亦然）也要认得出。
// 用一间一次性房间做，避免给 alpha 等后续用例敏感的房间留成员 / 消息副作用。
const PREF_ROOM = 'pref18'
await POST(base, '/dsh-room/rooms', { id: PREF_ROOM, title: '前缀漂移', category: CAT })
await POST(base, `/dsh-room/rooms/${PREF_ROOM}/join`, { sessionId: 'session-pref18', label: '前缀成员' })
const prefixPending = approvalListener.fn(
  { agent: { id: 'pref18' }, toolName: 'write', callId: 'call-18a' },
  async () => 'unavailable',
)
await new Promise((resolve) => setTimeout(resolve, 20))
const prefixListed = await GET(base, `/dsh-room/rooms/${PREF_ROOM}/approvals`)
check(
  'v18：`session-` 前缀写法不一致也认得出（成员 session-pref18 / 请求方 pref18），照样挂到面板上',
  prefixListed.body?.approvals?.some((a) => a.callId === 'call-18a' && a.label === '前缀成员'),
  json(prefixListed.body?.approvals ?? null).slice(0, 200),
)
await POST(base, `/dsh-room/rooms/${PREF_ROOM}/approvals`, { callId: 'call-18a', decision: 'deny' })
const prefixOutcome = await settleWithin(prefixPending)
const prefixLeft = await POST(base, `/dsh-room/rooms/${PREF_ROOM}/leave`, { sessionId: 'session-pref18' })
check(
  'v18：前缀漂移命中后能正常拒绝关掉，且不留残项（收尾把夹具成员移出）',
  prefixOutcome === 'rejected' &&
    (await GET(base, `/dsh-room/rooms/${PREF_ROOM}/approvals`)).body.approvals.length === 0 &&
    prefixLeft.status === 200,
  `outcome=${prefixOutcome} leave=${prefixLeft.status}`,
)

// 隔离：A 的消息/目标/文件不出现在 B
const alphaPost = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'ALPHA-ONLY-MESSAGE' })
check('隔离：A 房间发言成功且只归档（默认 push off）', alphaPost.status === 200 && alphaPost.body?.mode === 'archive', json(alphaPost.body).slice(0, 200))
await POST(base, '/dsh-room/rooms/alpha/upload', { name: 'alpha-report.md', base64: b64('# alpha only\n') })
const alphaState1 = await GET(base, '/dsh-room/rooms/alpha/state?since=0')
const betaState1 = await GET(base, '/dsh-room/rooms/beta/state?since=0')
check(
  '隔离：B 的 state 里没有 A 的消息',
  !json(betaState1.body?.messages ?? []).includes('ALPHA-ONLY-MESSAGE'),
  json(betaState1.body?.messages ?? []).slice(0, 200),
)
check(
  '隔离：B 的 state 里没有 A 的目标/文件',
  !json(betaState1.body?.goals ?? []).includes('SND-07') &&
    (betaState1.body?.files ?? []).length === 0 &&
    (alphaState1.body?.files ?? []).some((f) => f.name === 'alpha-report.md'),
  'betaGoals=' + json(betaState1.body?.goals ?? []) + ' betaFiles=' + json(betaState1.body?.files ?? []),
)
check(
  '隔离：各房间 transcript.jsonl / 目录独立',
  exists(roomDir('alpha', 'transcript.jsonl')) &&
    exists(roomDir('beta', 'transcript.jsonl')) &&
    readText(roomDir('alpha', 'transcript.jsonl')).includes('ALPHA-ONLY-MESSAGE') &&
    !readText(roomDir('beta', 'transcript.jsonl')).includes('ALPHA-ONLY-MESSAGE'),
)

// ---------------------------------------------------------------- v3 目录模型

section('v3 目录模型：显式 category / dir / 旧布局搬家')

const catCreate = await POST(base, '/dsh-room/rooms', { id: 'catroom', title: '分类建房', category: CAT2 })
check(
  'POST /rooms 显式 category → dir = <category>/<id>',
  catCreate.status === 200 && catCreate.body?.room?.dir === dirOf(CAT2, 'catroom') && catCreate.body?.room?.category === CAT2,
  json(catCreate.body?.room).slice(0, 200),
)
check(
  '显式 category 的房间文件真落在该目录（不在默认分类）',
  exists(dirOf(CAT2, 'catroom', 'room.json')) && !exists(dirOf(CAT, 'catroom')),
)

const dirCreate = await POST(base, '/dsh-room/rooms', { id: 'dirroom', title: '按目录建房', dir: path.join(CAT3, 'dirroom') })
check(
  'POST /rooms 显式 dir → category = dirname(dir)、dir = dir',
  dirCreate.status === 200 &&
    dirCreate.body?.room?.dir === path.join(CAT3, 'dirroom') &&
    dirCreate.body?.room?.category === CAT3,
  json(dirCreate.body?.room).slice(0, 200),
)
check('按 dir 建房的文件落在该目录', exists(path.join(CAT3, 'dirroom', 'room.json')))

// 排序：同分类内按 updatedAt 倒序（分类之间按路径排）
await POST(base, '/dsh-room/rooms', { id: 'sorta', title: '排序 A', category: CAT2 })
await POST(base, '/dsh-room/rooms', { id: 'sortb', title: '排序 B', category: CAT2 })
await POST(base, '/dsh-room/rooms/sorta/post', { text: '让 sorta 成为最近更新' })
const sortedRooms = (await GET(base, '/dsh-room/rooms')).body.rooms
const cat2Group = sortedRooms.filter((r) => r.category === CAT2)
const catGroup = sortedRooms.filter((r) => r.category === CAT)
check(
  'GET /rooms 同分类内按 updatedAt 倒序（最近更新的排前面）',
  cat2Group.length === 3 && cat2Group[0].id === 'sorta' && cat2Group[0].updatedAt >= cat2Group[1].updatedAt,
  json(cat2Group.map((r) => [r.id, r.updatedAt])),
)
const sortedCats = sortedRooms.map((r) => String(r.category))
let catOrderOk = true
const seen = new Set()
let prev = null
for (const c of sortedCats) {
  if (c !== prev) {
    if (seen.has(c)) catOrderOk = false
    if (prev !== null && prev.localeCompare(c) > 0) catOrderOk = false
    seen.add(c)
    prev = c
  }
}
check(
  'GET /rooms 跨分类按 category 路径排序（同分类连续、相邻分类单调不减）',
  catOrderOk && catGroup.length >= 6 && cat2Group.length === 3,
  json(sortedRooms.map((r) => [r.id, r.category])).slice(0, 300),
)

// 旧布局搬家（端到端：预置 <stateRoot>/<roomId>/ + rooms.json 登记）
const LEGACY_ROOT = path.join(WORK, 'legacy-root')
const LEGACY_CAT = path.join(WORK, 'legacy-cat', '会议')
fs.mkdirSync(path.join(LEGACY_ROOT, 'legacy', 'files'), { recursive: true })
fs.writeFileSync(
  path.join(LEGACY_ROOT, 'legacy', 'room.json'),
  JSON.stringify({ id: 'legacy', title: '旧布局房间', createdAt: 1, status: 'open', push: 'off' }),
)
fs.writeFileSync(
  path.join(LEGACY_ROOT, 'legacy', 'transcript.jsonl'),
  JSON.stringify({ seq: 1, at: 1, kind: 'system', text: 'LEGACY-ROOM-MESSAGE', author: { kind: 'system', id: 'system', label: '系统' } }) + '\n',
)
fs.writeFileSync(path.join(LEGACY_ROOT, 'legacy', 'files', 'old.txt'), 'legacy file')
fs.writeFileSync(
  path.join(LEGACY_ROOT, 'rooms.json'),
  JSON.stringify([{ id: 'legacy', title: '旧布局房间', createdAt: 1, updatedAt: 1, status: 'open' }]),
)
const legacyHost = createHost({ root: LEGACY_ROOT, category: LEGACY_CAT, roomId: 'main' })
const legacyServe = await serve(legacyHost)
await GET(legacyServe.base, '/dsh-room/rooms')
const legacyRooms = await GET(legacyServe.base, '/dsh-room/rooms')
const legacySummary = legacyRooms.body?.rooms?.find((r) => r.id === 'legacy')
check(
  '旧布局：启动后登记表里的房间 dir 指向分类目录',
  legacySummary?.dir === dirOf(LEGACY_CAT, 'legacy') && legacySummary?.category === LEGACY_CAT,
  json(legacySummary).slice(0, 200),
)
check(
  '旧布局：旧目录整体搬到 <category>/<roomId>/（含 transcript.jsonl 与 files/）',
  exists(dirOf(LEGACY_CAT, 'legacy', 'room.json')) &&
    exists(dirOf(LEGACY_CAT, 'legacy', 'transcript.jsonl')) &&
    exists(dirOf(LEGACY_CAT, 'legacy', '附件', 'old.txt')),
)
check(
  '旧布局：旧目录已清空（状态根下不再有该房间目录）',
  !exists(path.join(LEGACY_ROOT, 'legacy', 'room.json')) && !exists(path.join(LEGACY_ROOT, 'legacy', 'transcript.jsonl')),
)
const legacyMovedState = await GET(legacyServe.base, '/dsh-room/rooms/legacy/state?since=0')
check(
  '旧布局：历史记录随目录搬过来（内容不丢）',
  json(legacyMovedState.body?.messages ?? []).includes('LEGACY-ROOM-MESSAGE') && legacyMovedState.body?.room?.dir === dirOf(LEGACY_CAT, 'legacy'),
  json(legacyMovedState.body?.messages ?? []).slice(0, 160),
)
check('旧布局：搬家后旧目录本身已不在', !exists(path.join(LEGACY_ROOT, 'legacy')))

// 搬家只做一次：换个宿主重启（同一 root + category），已经搬过的房间不会回退
const legacyHost2 = createHost({ root: LEGACY_ROOT, category: LEGACY_CAT, roomId: 'main' })
const legacyServe2 = await serve(legacyHost2)
const legacyRooms2 = await GET(legacyServe2.base, '/dsh-room/rooms')
const legacySummary2 = legacyRooms2.body?.rooms?.find((r) => r.id === 'legacy')
check(
  '旧布局：重启后仍用新目录（不重复搬家、不重建旧目录）',
  legacySummary2?.dir === dirOf(LEGACY_CAT, 'legacy') &&
    exists(dirOf(LEGACY_CAT, 'legacy', 'room.json')) &&
    !exists(path.join(LEGACY_ROOT, 'legacy')),
  json(legacySummary2).slice(0, 200),
)
await closeServer(legacyServe.server)
await closeServer(legacyServe2.server)

// ---------------------------------------------------------------- v1 兼容

section('v1 兼容：无房间段路径 → 默认房间 main')

await POST(base, '/dsh-room/join', { sessionId: 'sess-spec', label: '规格维护方' })
const legacyPost = await POST(base, '/dsh-room/post', { text: 'v1 兼容发言', label: '规格维护方' })
check(
  'v1 /post 落到默认房间 main（默认 off ⇒ 只归档）',
  legacyPost.status === 200 && legacyPost.body?.mode === 'archive' && legacyPost.body?.message?.seq > 0,
  json(legacyPost.body).slice(0, 200),
)

const legacyState = await GET(base, '/dsh-room/state?since=0')
const mainState = await GET(base, '/dsh-room/rooms/main/state?since=0')
check(
  'v1 /state 与 /rooms/main/state 等价',
  legacyState.status === 200 &&
    legacyState.body?.room?.id === 'main' &&
    legacyState.body.seq === mainState.body?.seq &&
    legacyState.body.messages.length === mainState.body?.messages?.length,
  'legacy.seq=' + legacyState.body?.seq + ' rooms.seq=' + mainState.body?.seq,
)

const alphaUnchanged = await GET(base, '/dsh-room/rooms/alpha/state?since=0')
check(
  'v1 兼容路径没污染 alpha（房间隔离）',
  alphaUnchanged.body?.seq === alphaState1.body.seq && !json(alphaUnchanged.body?.messages).includes('v1 兼容发言'),
)

const V1_GETS = ['state', 'goals', 'results', 'recorder', 'reasoning', 'files', 'candidates', 'sessions']
const badCompat = []
for (const p of V1_GETS) {
  const r = await GET(base, '/dsh-room/' + p)
  if (r.status === 404 && r.body?.error === '未知路径') badCompat.push(p)
}
check('v1 无房间段 GET 路径全部仍可用（不再「未知路径」）', badCompat.length === 0, badCompat.join(','))

const v1Goal = await POST(base, '/dsh-room/goals', { text: 'main 的 v1 目标' })
const v1Kick = await POST(base, '/dsh-room/kick', { sessionId: 'no-such-session' })
const v1ReasoningBad = await POST(base, '/dsh-room/reasoning', { level: 'extreme' })
const v1Reopen = await POST(base, '/dsh-room/reopen', { by: 'user' })
check(
  'v1 无房间段 POST 路径可用（goals/kick/reasoning/reopen）',
  v1Goal.status === 200 && v1Kick.status === 200 && v1Kick.body?.removed === false && v1ReasoningBad.status === 400 && v1Reopen.status === 200,
  [v1Goal.status, v1Kick.status, v1ReasoningBad.status, v1Reopen.status].join(','),
)

const unknownPath = await GET(base, '/dsh-room/nope/nope')
check('未知路径 → 404 且带 error 文案', unknownPath.status === 404 && typeof unknownPath.body?.error === 'string', json(unknownPath.body))

// ---------------------------------------------------------------- 会话清单

section('会话清单：agents 回退 / sessionQuery 标题')

const sessionsFallback = await GET(base, '/dsh-room/sessions')
check(
  'GET /sessions 无 sessionQuery 时回退到在线 agents',
  sessionsFallback.status === 200 &&
    sessionsFallback.body?.sessions?.length === 3 &&
    sessionsFallback.body.sessions.every((s) => typeof s.sessionId === 'string' && s.live === true),
  json(sessionsFallback.body).slice(0, 300),
)
check(
  'GET /sessions 同时给出 v1 兼容的 candidates/members',
  Array.isArray(sessionsFallback.body?.candidates) && Array.isArray(sessionsFallback.body?.members),
)

const titleHost = createHost({
  root: path.join(WORK, 'title-root'),
  category: path.join(WORK, 'title-cat', '会议'),
  roomId: 'main',
  agents: ['sess-a'],
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'sess-a', title: '头里的标题' } },
      { header: { id: 'sess-b' } },
      { header: { id: 'sess-c', title: '头里的标题 C' } },
      { header: { id: 'sess-d' } },
    ],
    // v3 真源：readTitleSnapshots 返回 settled 结果数组（不是 v2 误读的 [{id,title}]）
    readTitleSnapshots: async (ids) =>
      ids.map((id) => {
        if (id === 'sess-a') return { status: 'fulfilled', value: { session: { id }, title: '快照标题 A' } };
        if (id === 'sess-b') return { status: 'fulfilled', value: { session: { id }, title: '快照标题 B' } };
        return { status: 'rejected', reason: new Error('还没生成标题') };
      }),
  },
})
const titleServed = await serve(titleHost)
await GET(titleServed.base, '/dsh-room/rooms')
const titled = await GET(titleServed.base, '/dsh-room/sessions')
const titledMap = new Map((titled.body?.sessions ?? []).map((s) => [s.sessionId, s]))
check(
  'v3 settled 快照：item.value.title 优先于 header.title',
  titledMap.get('sess-a')?.label === '快照标题 A' && titledMap.get('sess-b')?.label === '快照标题 B',
  json(titled.body?.sessions),
)
check(
  'settled 快照 status:rejected → 回落 header.title',
  titledMap.get('sess-c')?.label === '头里的标题 C',
  json(titledMap.get('sess-c')),
)
check(
  'settled 快照 rejected 且无 header.title → 回落「会话 <id 前 8 位>」',
  titledMap.get('sess-d')?.label === '会话 sess-d',
  json(titledMap.get('sess-d')),
)

const brokenHost = createHost({
  root: path.join(WORK, 'broken-root'),
  category: path.join(WORK, 'broken-cat', '会议'),
  roomId: 'main',
  agents: ['sess-x'],
  sessionQuery: {
    listSessions: async () => {
      throw new Error('boom')
    },
  },
})
const brokenServed = await serve(brokenHost)
await GET(brokenServed.base, '/dsh-room/rooms')
const brokenList = await GET(brokenServed.base, '/dsh-room/sessions')
check(
  'sessionQuery 抛错 → 降级为在线 agents 且 logger.warn 留痕',
  brokenList.status === 200 &&
    brokenList.body?.sessions?.length === 1 &&
    brokenList.body.sessions[0].sessionId === 'sess-x' &&
    brokenHost.warns.some((w) => w.includes('sessionQuery')),
  json(brokenList.body?.sessions) + ' warns=' + json(brokenHost.warns),
)
await closeServer(brokenServed.server)
await closeServer(titleServed.server)

// ---------------------------------------------------------------- v3 设置 / 会话真名 / 目录浏览

section('v3 设置：GET/PATCH settings / 内置记录员（v4 改写）/ 提示词覆盖')

const CFG_ROOT = path.join(WORK, 'cfg-root')
const CFG_CAT = path.join(WORK, 'cfg-cat', '会议')
let listSessionsCalls = 0
let titleSnapshotCalls = 0
// bbb 的标题快照带 updatedAt（用于 /sessions 的 updatedAt 倒序断言），aaa/ccc 走 header 回退
const CFG_TITLES = { 'aaa-1111': '电脑分析', 'bbb-2222': { title: '写接口文档', updatedAt: 200 } }
const cfgHost = createHost({
  root: CFG_ROOT,
  category: CFG_CAT,
  roomId: 'main',
  agents: ['aaa-1111', 'bbb-2222', 'ccc-3333'],
  // v4：内置记录员出草稿前先读默认模型；给上就能断言 result.model 的来源
  agentDefaultModel: { currentSelection: () => ({ provider: 'sel-prov', model: 'sel-model' }) },
  sessionQuery: {
    listSessions: async () => {
      listSessionsCalls += 1
      return [
        { header: { id: 'aaa-1111', cwd: 'C:\\proj\\one', createdAt: 100 }, live: true, persisted: true },
        { header: { id: 'bbb-2222', cwd: 'C:\\proj\\two' }, live: false, persisted: true },
        { header: { id: 'ccc-3333', title: '头里的标题 C', createdAt: 50 }, live: false, persisted: true },
        // v4：/sessions 默认只列顶层会话 —— 四个「子会话」判定口径各来一条，都必须被过滤掉
        { header: { id: 'sub-origin', title: '子代理 A', origin: 'subagent' }, live: true, persisted: true },
        { header: { id: 'sub-parent', title: '子代理 B', parentSession: 'aaa-1111' }, live: false, persisted: true },
        { header: { id: 'sub-depth', title: '子代理 C', delegationDepth: 2 }, live: false, persisted: true },
        { header: { id: 'sub-seeded', title: '子代理 D', isSeeded: true }, live: false, persisted: true },
      ]
    },
    readTitleSnapshots: async (ids) => {
      titleSnapshotCalls += 1
      return ids.map((id) => {
        const hit = CFG_TITLES[id]
        if (!hit) return { status: 'rejected', reason: new Error('还没生成标题') }
        return { status: 'fulfilled', value: { session: { id }, title: hit } }
      })
    },
  },
})
const cfgServed = await serve(cfgHost)
const cfg = cfgServed.base
await GET(cfg, '/dsh-room/settings')

const settings0 = await GET(cfg, '/dsh-room/settings')
check(
  'GET /settings 返回 settings + 顶层 defaultCategory/defaultPrompt（v4：recorder 恒 null）',
  settings0.status === 200 &&
    settings0.body?.settings?.category === CFG_CAT &&
    settings0.body?.settings?.defaultCategory === CFG_CAT &&
    settings0.body?.defaultCategory === CFG_CAT &&
    settings0.body?.settings?.recorder === null &&
    settings0.body?.defaultPrompt === settings0.body?.settings?.defaultPrompt &&
    String(settings0.body?.defaultPrompt).includes('不得编造') &&
    String(settings0.body?.defaultPrompt).includes('{{room}}') &&
    settings0.body?.settings?.prompt === settings0.body?.settings?.defaultPrompt,
  json(settings0.body?.settings).slice(0, 300),
)

// v4：记录员是每个房间自带的内置 AI —— 旧的「配置默认记录员」两条写法都必须被逐字拒绝
const setRec = await PATCH(cfg, '/dsh-room/settings', { recorder: { sessionId: 'bbb-2222' } })
check(
  'PATCH /settings {recorder:{sessionId}} → 400 且是 v4 固定文案（不再按会话取 label）',
  setRec.status === 400 && setRec.body?.error === V4_SETTINGS_REJECT,
  JSON.stringify(setRec.body),
)
const clearRec = await PATCH(cfg, '/dsh-room/settings', { recorder: null })
check(
  'PATCH /settings {recorder:null} → 也 400（v4 不存在「清除默认记录员」这条路径）',
  clearRec.status === 400 && clearRec.body?.error === V4_SETTINGS_REJECT,
  JSON.stringify(clearRec.body),
)
check(
  '两条 recorder 写入都没落盘：状态根 settings.json 里没有 recorder 键',
  !exists(path.join(CFG_ROOT, 'settings.json')) || !('recorder' in readJsonFile(path.join(CFG_ROOT, 'settings.json'))),
  exists(path.join(CFG_ROOT, 'settings.json')) ? readText(path.join(CFG_ROOT, 'settings.json')).slice(0, 200) : '(还没有 settings.json)',
)

const setPrompt = await PATCH(cfg, '/dsh-room/settings', { prompt: '【{{room}}】目标「{{goal}}」（{{goalId}}）请写结果' })
check('PATCH /settings 保存自定义提示词（占位符原样保留）', setPrompt.status === 200 && String(setPrompt.body?.settings?.prompt).includes('{{room}}'), json(setPrompt.body?.settings?.prompt))
check('自定义提示词 != 内置默认（确实覆盖了）', setPrompt.body?.settings?.prompt !== settings0.body?.settings?.defaultPrompt)

const settingsFile = path.join(CFG_ROOT, 'settings.json')
check(
  'settings.json 落盘在状态根（category/prompt/updatedAt；v4 不含 recorder）',
  exists(settingsFile) &&
    readJsonFile(settingsFile).category === CFG_CAT &&
    readJsonFile(settingsFile).prompt === '【{{room}}】目标「{{goal}}」（{{goalId}}）请写结果' &&
    Number.isFinite(readJsonFile(settingsFile).updatedAt) &&
    !('recorder' in readJsonFile(settingsFile)),
  readText(settingsFile).slice(0, 240),
)

const inheritRoom = await POST(cfg, '/dsh-room/rooms', { id: 'inherit', title: '继承记录员', goal: '把接口写完' })
check('POST /rooms 未给 category → 用 settings.category', inheritRoom.body?.room?.category === CFG_CAT, inheritRoom.body?.room?.category)
const inheritView = await GET(cfg, '/dsh-room/rooms/inherit')
const inheritListed = await GET(cfg, '/dsh-room/rooms')
check(
  '新房间即带内置记录员（v4：不再从 settings.recorder 继承会话；REST 三处口径一致）',
  isBuiltinRecorder(inheritRoom.body?.room?.recorder) &&
    isBuiltinRecorder(inheritView.body?.room?.recorder) &&
    isBuiltinRecorder(inheritListed.body?.rooms?.find((r) => r.id === 'inherit')?.recorder),
  json(inheritRoom.body?.room?.recorder),
)
check('新房间文件落在 <category>/<roomId>/（状态根下没有同名目录）', exists(path.join(CFG_CAT, 'inherit', 'goals.json')) && !exists(path.join(CFG_ROOT, 'inherit')))

// 提示词替换 e2e（v4 通路）：目标标记达成 → 宿主直接调 llm.stream 生成草稿，
// 送给模型的 userText 第一段就是替换后的提示词 —— 唯一能证明「替换真的发生」的载体。
const gid1 = inheritRoom.body.room.activeGoalId
const llmBefore1 = llmCallsOf(cfgHost).length
const done1 = await POST(cfg, `/dsh-room/rooms/inherit/goals/${gid1}/complete`, { by: 'user' })
check(
  '目标标记达成 → 内置记录员调 llm 出草稿（asked:true / status:draft / by:记录员 / 正文来自 llm）',
  done1.status === 200 &&
    done1.body?.asked === true &&
    done1.body?.result?.status === 'draft' &&
    done1.body?.result?.by === '记录员' &&
    done1.body?.result?.body === LLM_REPLY.trim() &&
    isBuiltinRecorder(done1.body?.recorder) &&
    llmCallsOf(cfgHost).length === llmBefore1 + 1,
  `asked=${done1.body?.asked} result=${json(done1.body?.result?.status)} n=${llmCallsOf(cfgHost).length}`,
)
const call1 = llmCallsOf(cfgHost).at(-1)
const text1 = call1?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  'settings.prompt 的 {{room}}/{{goal}}/{{goalId}} 全部替换为真实值（断言送给假 llm 的 userText 前缀）',
  text1.startsWith(`【继承记录员】目标「把接口写完」（${gid1}）请写结果`),
  text1.slice(0, 160),
)
check(
  'userText 结构完整（会议记录证据段 + 与会者名单）且模型参数正确（provider/model/temperature/system）',
  text1.includes('【会议记录（唯一证据，seq ') &&
    text1.includes('【与会者名单】') &&
    call1?.provider === 'sel-prov' &&
    call1?.model === 'sel-model' &&
    call1?.temperature === 0.2 &&
    String(call1?.system).includes('记录员'),
  json({ provider: call1?.provider, model: call1?.model, temperature: call1?.temperature }),
)
check(
  '草稿 evidence 是真实 transcript seq 区间（seqFrom<=seqTo、count>=1）、model 采自 agentDefaultModel',
  Number.isFinite(done1.body?.result?.evidence?.seqFrom) &&
    Number.isFinite(done1.body?.result?.evidence?.seqTo) &&
    done1.body.result.evidence.seqFrom <= done1.body.result.evidence.seqTo &&
    done1.body.result.evidence.count >= 1 &&
    done1.body?.result?.model?.provider === 'sel-prov' &&
    done1.body?.result?.model?.model === 'sel-model',
  json(done1.body?.result?.evidence),
)
const inheritState = await GET(cfg, '/dsh-room/rooms/inherit/state?since=0')
const inheritSeqs = (inheritState.body?.messages ?? []).map((m) => m.seq)
check(
  '草稿 evidence 落在真实 transcript seq 区间内（seqFrom>=最小 seq、seqTo<=最大 seq、count<=条数）',
  done1.body.result.evidence.seqFrom >= Math.min(...inheritSeqs) &&
    done1.body.result.evidence.seqTo <= Math.max(...inheritSeqs) &&
    done1.body.result.evidence.count <= inheritSeqs.length &&
    done1.body.result.evidence.count >= 1,
  json({ evidence: done1.body.result.evidence, min: Math.min(...inheritSeqs), max: Math.max(...inheritSeqs), n: inheritSeqs.length }),
)
const draftSystemLine = '内置记录员提交了《把接口写完 · 会议结果》草稿（目标：把接口写完），等待审核'
check(
  '草稿提交系统行：内置记录员提交了《…》草稿（目标：…），等待审核',
  inheritState.body.messages.some((m) => m.kind === 'system' && String(m.text).includes(draftSystemLine)),
  json((inheritState.body.messages ?? []).filter((m) => m.kind === 'system').map((m) => m.text).slice(-3)),
)
check(
  '草稿落盘：results/<gid>.md 写的就是 llm 正文，goals.json 里状态 draft',
  exists(path.join(CFG_CAT, 'inherit', '记录', '结果', `${gid1}.md`)) &&
    readText(path.join(CFG_CAT, 'inherit', '记录', '结果', `${gid1}.md`)).includes('-LLM-DRAFT-BODY-') &&
    readJsonFile(path.join(CFG_CAT, 'inherit', 'goals.json')).find((g) => g.id === gid1)?.result?.status === 'draft',
  readText(path.join(CFG_CAT, 'inherit', '记录', '结果', `${gid1}.md`)).slice(0, 120),
)

const g3 = await POST(cfg, '/dsh-room/rooms/inherit/goals', { text: '第二个目标：补文档' })
const gid3 = g3.body?.goal?.id
const patchedPrompt = await PATCH(cfg, '/dsh-room/rooms/inherit', { prompt: '房间级模板：{{room}} / {{goal}}' })
check(
  'PATCH /rooms/:id prompt 保存房间级提示词（summary.prompt + patch 都回读）',
  patchedPrompt.status === 200 && patchedPrompt.body?.room?.prompt === '房间级模板：{{room}} / {{goal}}' && patchedPrompt.body?.patch?.prompt === patchedPrompt.body.room.prompt,
  json(patchedPrompt.body?.patch),
)
const llmBefore3 = llmCallsOf(cfgHost).length
const done3 = await POST(cfg, `/dsh-room/rooms/inherit/goals/${gid3}/complete`, { by: 'user' })
const text3 = llmCallsOf(cfgHost).at(-1)?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  '房间级 prompt 覆盖 settings.prompt（userText 用房间级模板替换后的文本开头）',
  done3.body?.asked === true &&
    llmCallsOf(cfgHost).length === llmBefore3 + 1 &&
    text3.startsWith('房间级模板：继承记录员 / 第二个目标：补文档'),
  text3.slice(0, 160),
)

const clearedPrompt = await PATCH(cfg, '/dsh-room/rooms/inherit', { prompt: '' })
check('PATCH prompt:"" → 房间级清空（回落 settings.prompt）', clearedPrompt.status === 200 && clearedPrompt.body?.room?.prompt === null, json(clearedPrompt.body?.patch))
const g4 = await POST(cfg, '/dsh-room/rooms/inherit/goals', { text: '第三个目标' })
const gid4 = g4.body?.goal?.id
const llmBefore4 = llmCallsOf(cfgHost).length
await POST(cfg, `/dsh-room/rooms/inherit/goals/${gid4}/complete`, { by: 'user' })
const text4 = llmCallsOf(cfgHost).at(-1)?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  '清空房间级 prompt 后重新用 settings.prompt（userText 回到 settings 模板）',
  llmCallsOf(cfgHost).length === llmBefore4 + 1 && text4.startsWith(`【继承记录员】目标「第三个目标」（${gid4}）请写结果`),
  text4.slice(0, 160),
)
const llmBeforeIdem = llmCallsOf(cfgHost).length
const again4 = await POST(cfg, `/dsh-room/rooms/inherit/goals/${gid4}/complete`, { by: 'user' })
check(
  '已出草稿的目标再 complete → already:true / asked:false，且不再调 llm（幂等）',
  again4.status === 200 &&
    again4.body?.already === true &&
    again4.body?.asked === false &&
    String(again4.body?.reason).includes('已有草稿') &&
    llmCallsOf(cfgHost).length === llmBeforeIdem,
  `already=${again4.body?.already} asked=${again4.body?.asked} reason=${again4.body?.reason}`,
)

// 记录员端点：v4 恒 400（路由保留只为给旧客户端一句中文说明）
const recEmpty = await POST(cfg, '/dsh-room/rooms/inherit/recorder', {})
check(
  'POST /rooms/:id/recorder 空 body → 400 且是 v4 固定文案（不再自动指派）',
  recEmpty.status === 400 && recEmpty.body?.error === V4_ASSIGN_REJECT,
  JSON.stringify(recEmpty.body),
)
const recExplicit = await POST(cfg, '/dsh-room/rooms/inherit/recorder', { sessionId: 'ccc-3333' })
check(
  '显式 sessionId 也 400（v4 记录员是内置 AI，label 不再取会话名）',
  recExplicit.status === 400 && recExplicit.body?.error === V4_ASSIGN_REJECT,
  JSON.stringify(recExplicit.body),
)
const joinRec = await POST(cfg, '/dsh-room/rooms/inherit/join', { sessionId: 'ccc-3333', label: '头里的标题 C' })
const recState = await GET(cfg, '/dsh-room/rooms/inherit/state?since=0')
check(
  '被拒绝的指派没有副作用：成员表没有 role=recorder、transcript 里没有「记录员：」系统行',
  !(recState.body?.messages ?? []).some((m) => String(m.text).includes('记录员：')) &&
    !(joinRec.body?.members ?? []).some((m) => m.role === 'recorder') &&
    (joinRec.body?.members ?? []).some((m) => m.sessionId === 'ccc-3333'),
  json(joinRec.body?.members),
)

// 会话清单：v4 恒 force 取数（不再有「PATCH {recorder} 顺便取名」这条走缓存的路径），
// 所以连续两次都必须真的重新查询 sessionQuery —— 用调用计数证明缓存没拦住。
const sess1 = await GET(cfg, '/dsh-room/sessions')
check(
  'GET /sessions 第一次查询：listSessions / readTitleSnapshots 各 1 次',
  listSessionsCalls === 1 && titleSnapshotCalls === 1,
  `listSessions=${listSessionsCalls} titleSnapshots=${titleSnapshotCalls}`,
)
const sessTruth = await GET(cfg, '/dsh-room/sessions')
check(
  'GET /sessions 第二次仍重新查询（v4 恒 force，30 秒缓存不拦 /sessions）',
  listSessionsCalls === 2 && titleSnapshotCalls === 2,
  `listSessions=${listSessionsCalls} titleSnapshots=${titleSnapshotCalls}`,
)
const sessMap = new Map((sessTruth.body?.sessions ?? []).map((s) => [s.sessionId, s]))
check(
  'GET /sessions 透出真实标题 / live / cwd / updatedAt（v4：title 与 label 同值）',
  sessMap.get('aaa-1111')?.label === '电脑分析' &&
    sessMap.get('aaa-1111')?.title === '电脑分析' &&
    sessMap.get('aaa-1111')?.live === true &&
    sessMap.get('aaa-1111')?.cwd === 'C:\\proj\\one' &&
    'updatedAt' in (sessMap.get('aaa-1111') ?? {}) &&
    sessMap.get('bbb-2222')?.label === '写接口文档' &&
    sessMap.get('bbb-2222')?.title === '写接口文档' &&
    sessMap.get('bbb-2222')?.live === false,
  json(sessTruth.body?.sessions),
)
check('settled 快照 rejected → 回落 header.title（同一宿主内）', sessMap.get('ccc-3333')?.label === '头里的标题 C', json(sessMap.get('ccc-3333')))
check(
  'candidates 只含在线会话（子会话即使 live 也被过滤）；members 取默认房间',
  Array.isArray(sessTruth.body?.candidates) && sessTruth.body.candidates.length === 1 && sessTruth.body.candidates[0].sessionId === 'aaa-1111' && Array.isArray(sessTruth.body?.members),
  json(sessTruth.body?.candidates),
)
check(
  'GET /sessions 默认过滤四种口径的子会话（origin / parentSession / delegationDepth / isSeeded）+ total/filtered 正确',
  sessTruth.body?.total === 7 &&
    sessTruth.body?.filtered === 4 &&
    (sessTruth.body?.sessions ?? []).length === 3 &&
    !(sessTruth.body?.sessions ?? []).some((s) => String(s.sessionId).startsWith('sub-')),
  json({ total: sessTruth.body?.total, filtered: sessTruth.body?.filtered, ids: (sessTruth.body?.sessions ?? []).map((s) => s.sessionId) }),
)
check(
  'GET /sessions 排序：live 优先 → updatedAt 倒序（aaa 在线第一，bbb 快照 updatedAt=200 压过 ccc 的 createdAt=50）',
  json((sessTruth.body?.sessions ?? []).map((s) => s.sessionId)) === json(['aaa-1111', 'bbb-2222', 'ccc-3333']),
  json((sessTruth.body?.sessions ?? []).map((s) => [s.sessionId, s.live, s.updatedAt])),
)
const sessAll = await GET(cfg, '/dsh-room/sessions?includeSubagents=1')
check(
  'GET /sessions?includeSubagents=1 → 全量 7 条 / filtered 0，子会话也在（label===title、带 updatedAt 字段）',
  sessAll.body?.total === 7 &&
    sessAll.body?.filtered === 0 &&
    sessAll.body?.includeSubagents === true &&
    (sessAll.body?.sessions ?? []).some((s) => s.sessionId === 'sub-origin') &&
    (sessAll.body?.sessions ?? []).every((s) => s.label === s.title && 'updatedAt' in s),
  json((sessAll.body?.sessions ?? []).map((s) => s.sessionId)),
)

// 目录浏览
fs.mkdirSync(path.join(CFG_CAT, 'a1'), { recursive: true })
fs.mkdirSync(path.join(CFG_CAT, 'a2'), { recursive: true })
fs.mkdirSync(path.join(CFG_CAT, '.secret'), { recursive: true })
const br = await GET(cfg, '/dsh-room/browse?path=' + encodeURIComponent(CFG_CAT))
check(
  'GET /browse 列非隐藏子目录并按名排序',
  // inherit 是新建房间，main 是默认会议室（start() 会为 defaultRoomId 建目录）
  br.status === 200 && br.body?.path === CFG_CAT && br.body?.parent === path.dirname(CFG_CAT) && json(br.body?.dirs?.map((d) => d.name)) === json(['a1', 'a2', 'inherit', 'main']),
  json(br.body).slice(0, 260),
)
check('GET /browse 缺省从 settings.category 起', (await GET(cfg, '/dsh-room/browse')).body?.path === CFG_CAT)
check(
  'GET /browse path 指向文件 → 退到其父目录',
  (await GET(cfg, '/dsh-room/browse?path=' + encodeURIComponent(path.join(CFG_CAT, 'inherit', 'goals.json')))).body?.path === path.join(CFG_CAT, 'inherit'),
)
const brMissing = await GET(cfg, '/dsh-room/browse?path=' + encodeURIComponent(path.join(CFG_CAT, 'nope')))
check(
  'GET /browse 路径不存在 → 退到最近存在的祖先目录，exists:true',
  brMissing.body?.path === CFG_CAT && brMissing.body?.exists === true && json(brMissing.body?.dirs?.map((d) => d.name)) === json(['a1', 'a2', 'inherit', 'main']),
  json(brMissing.body).slice(0, 200),
)
const brPost = await POST(cfg, '/dsh-room/browse', {})
check('POST /browse → 405', brPost.status === 405, json(brPost.body))

// 设置校验
const badRec = await PATCH(cfg, '/dsh-room/settings', { recorder: { sessionId: '' } })
check('PATCH /settings recorder.sessionId 空 → 400（v4 固定文案，不是「不能为空」）', badRec.status === 400 && badRec.body?.error === V4_SETTINGS_REJECT, JSON.stringify(badRec.body))
const badRec2 = await PATCH(cfg, '/dsh-room/settings', { recorder: 'aaa-1111' })
check('PATCH /settings recorder 传字符串 → 也 400（任何形状的 recorder 配置都拒绝）', badRec2.status === 400 && badRec2.body?.error === V4_SETTINGS_REJECT, JSON.stringify(badRec2.body))
const badCat = await PATCH(cfg, '/dsh-room/settings', { category: 'relative/会议' })
check('PATCH /settings category 非绝对路径 → 400', badCat.status === 400 && String(badCat.body?.error).includes('绝对路径'), JSON.stringify(badCat.body))
const catOk = await PATCH(cfg, '/dsh-room/settings', { category: CAT3 })
check('PATCH /settings category 绝对路径 → settings.category 更新', catOk.status === 200 && catOk.body?.settings?.category === CAT3, json(catOk.body?.settings?.category))
await closeServer(cfgServed.server)

// ---------------------------------------------------------------- v3 换分类 / 归档 / 删除

section('v3 房间：换分类搬文件 / 归档 / 删除（purge）')

const zeta = await POST(base, '/dsh-room/rooms', { id: 'zeta', title: '搬家房', goal: '验证搬家' })
check('v3 新房间建在默认分类 CAT', zeta.body?.room?.dir === dirOf(CAT, 'zeta'), json(zeta.body?.room).slice(0, 200))
await POST(base, '/dsh-room/rooms/zeta/post', { text: 'ZETA-MESSAGE' })

const movedCat = await PATCH(base, '/dsh-room/rooms/zeta', { category: CAT2 })
check(
  'PATCH category → dir/category 更新且返回 patch',
  movedCat.status === 200 && movedCat.body?.room?.dir === dirOf(CAT2, 'zeta') && movedCat.body?.room?.category === CAT2 && movedCat.body?.patch?.category === CAT2,
  json(movedCat.body?.patch),
)
check(
  'PATCH category → 房间文件（room.json/transcript/files）跟着搬，旧目录清空',
  exists(dirOf(CAT2, 'zeta', 'room.json')) && exists(dirOf(CAT2, 'zeta', 'transcript.jsonl')) && exists(dirOf(CAT2, 'zeta', '附件')) && !exists(dirOf(CAT, 'zeta')),
)
check(
  '搬家后历史消息不丢（state 里仍有 ZETA-MESSAGE）',
  (await GET(base, '/dsh-room/rooms/zeta/state?since=0')).body.messages.some((m) => String(m.text).includes('ZETA-MESSAGE')),
)

const movedDir = await PATCH(base, '/dsh-room/rooms/zeta', { dir: dirOf(CAT3, 'zeta') })
check(
  'PATCH dir → 落到指定目录（category = dirname）',
  movedDir.status === 200 && movedDir.body?.room?.dir === dirOf(CAT3, 'zeta') && movedDir.body?.room?.category === CAT3,
  json(movedDir.body?.room).slice(0, 200),
)
check('PATCH dir → 文件在新目录，旧目录清空', exists(dirOf(CAT3, 'zeta', 'room.json')) && !exists(dirOf(CAT2, 'zeta')))

const badCat2 = await PATCH(base, '/dsh-room/rooms/zeta', { category: 'relative/会议' })
check('PATCH category 相对路径 → 400', badCat2.status === 400 && String(badCat2.body?.error).includes('绝对路径'), JSON.stringify(badCat2.body))
const emptyCat = await PATCH(base, '/dsh-room/rooms/zeta', { category: '' })
check('PATCH category 空 → 400', emptyCat.status === 400 && String(emptyCat.body?.error).includes('不能为空'), JSON.stringify(emptyCat.body))

const archTrue = await PATCH(base, '/dsh-room/rooms/zeta', { archived: true })
check(
  'PATCH archived:true → archived/archivedAt，房间仍在列表中',
  archTrue.status === 200 && archTrue.body?.room?.archived === true && Number.isFinite(archTrue.body.room.archivedAt) && (await GET(base, '/dsh-room/rooms')).body.rooms.some((r) => r.id === 'zeta'),
  json(archTrue.body?.patch),
)
check(
  '归档写系统行（记录保留）',
  (await GET(base, '/dsh-room/rooms/zeta/state?since=0')).body.messages.some((m) => String(m.text).includes('已归档')),
)
const archFalse = await PATCH(base, '/dsh-room/rooms/zeta', { archived: false })
check('PATCH archived:false → 取消归档', archFalse.status === 200 && archFalse.body?.room?.archived === false && archFalse.body?.room?.archivedAt === null, json(archFalse.body?.patch))

const delSoft = await DELETE(base, '/dsh-room/rooms/zeta')
check(
  'DELETE /rooms/:id → 只除名，不删文件',
  delSoft.status === 200 && delSoft.body?.deleted === true && delSoft.body?.purged === false && delSoft.body?.dir === dirOf(CAT3, 'zeta') && exists(dirOf(CAT3, 'zeta', 'room.json')),
  json(delSoft.body),
)
check('DELETE 后不再出现在 GET /rooms', !(await GET(base, '/dsh-room/rooms')).body.rooms.some((r) => r.id === 'zeta'))
check('DELETE 后 state → 404「会议室不存在」', (await GET(base, '/dsh-room/rooms/zeta/state')).status === 404)
const delGone = await DELETE(base, '/dsh-room/rooms/zeta')
check('DELETE 已删除的房间 → 404（会议室不存在）', delGone.status === 404, JSON.stringify(delGone.body))

const eta = await POST(base, '/dsh-room/rooms', { id: 'eta', title: '连文件删' })
const etaDir = eta.body?.room?.dir
const delPurge = await DELETE(base, '/dsh-room/rooms/eta?purge=1')
check(
  'DELETE ?purge=1 → 连文件删（purged:true 且目录消失）',
  delPurge.status === 200 && delPurge.body?.purged === true && delPurge.body?.dir === etaDir && !exists(etaDir),
  json(delPurge.body),
)

// ---------------------------------------------------------------- v3 加固回归（对应 Lead 修的 F1/F4/F5/F7 + O3 + 索引自愈）

section('v3 加固回归：目录护栏 / dir 占用 / 改名归位 / 索引自愈 / O3 结果写入门禁（v4 收口：AI 工具禁用）')

const HARD_ROOT = path.join(WORK, 'hard-root')
const HARD_CAT = path.join(WORK, 'hard-cat', '会议')
const HARD_CAT2 = path.join(WORK, 'hard-cat2', '会议')
const HARD_RENAMED = path.join(WORK, 'hard-renamed')
const hardHost = createHost({ root: HARD_ROOT, category: HARD_CAT, roomId: 'main', agents: ['hard-a', 'hard-b'] })
const { server: hardServer, base: hardBase } = await serve(hardHost)
const disposeHost = (host) => {
  for (const d of host.disposers ?? []) {
    try {
      d?.()
    } catch {
      /* ignore */
    }
  }
}

// F1：目录护栏（受保护位置一律 400，且不许先建目录再报错）
const homeAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-h1', category: os.homedir() })
check(
  'F1 POST {category:用户主目录} → 400（父目录不能是主目录，且没建目录）',
  homeAttempt.status === 400 && /受保护/.test(homeAttempt.body?.error ?? '') && !exists(path.join(os.homedir(), 'hard-h1')),
  json({ status: homeAttempt.status, error: homeAttempt.body?.error }),
)
const rootAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-d1', dir: path.parse(process.cwd()).root })
check(
  'F1 POST {dir:盘根} → 400（会议室目录不能是盘根）',
  rootAttempt.status === 400 && /盘根/.test(rootAttempt.body?.error ?? ''),
  json({ status: rootAttempt.status, error: rootAttempt.body?.error }),
)
const stateAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-d2', dir: path.join(HARD_ROOT, 'sub') })
check(
  'F1 POST {dir:状态根内部} → 400（状态根只放两个 json）',
  stateAttempt.status === 400 && /状态根/.test(stateAttempt.body?.error ?? '') && !exists(path.join(HARD_ROOT, 'sub')),
  json({ status: stateAttempt.status, error: stateAttempt.body?.error }),
)
const catAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-d3', dir: HARD_CAT })
check(
  'F1 POST {dir:分类目录本身} → 400（房间文件会混在一起）',
  catAttempt.status === 400 && /分类目录本身/.test(catAttempt.body?.error ?? ''),
  json({ status: catAttempt.status, error: catAttempt.body?.error }),
)
const cwdAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-d4', dir: path.join(process.cwd(), 'hard-sub') })
check(
  'F1 POST {dir:cwd 的子目录} → 400（父目录不能是工作目录）',
  cwdAttempt.status === 400 && /受保护/.test(cwdAttempt.body?.error ?? '') && !exists(path.join(process.cwd(), 'hard-sub')),
  json({ status: cwdAttempt.status, error: cwdAttempt.body?.error }),
)

// F5：PATCH {dir:<已存在文件>} 必须先校验后改内存
await POST(hardBase, '/dsh-room/rooms', { id: 'hard-file' })
const hardBefore = await GET(hardBase, '/dsh-room/rooms/hard-file/state?since=0')
const hardPlainFile = path.join(WORK, 'hard-plain.txt')
fs.writeFileSync(hardPlainFile, 'x')
const fileAttempt = await PATCH(hardBase, '/dsh-room/rooms/hard-file', { dir: hardPlainFile })
const hardAfter = await GET(hardBase, '/dsh-room/rooms/hard-file/state?since=0')
check(
  'F5 PATCH {dir:已存在文件} → 400 且内存 root/dir 不变（先校验后改内存）',
  fileAttempt.status === 400 &&
    /目标不是目录/.test(fileAttempt.body?.error ?? '') &&
    hardAfter.body?.root === hardBefore.body?.root &&
    hardAfter.body?.room?.dir === hardBefore.body?.room?.dir,
  json({ status: fileAttempt.status, error: fileAttempt.body?.error, before: hardBefore.body?.room?.dir, after: hardAfter.body?.room?.dir }),
)

// F7：GET /settings 顶层字段（前端不拆 settings 也能拿到）
const hardSettings = await GET(hardBase, '/dsh-room/settings')
check(
  'F7 GET /settings 顶层同时给出 defaultCategory 与 defaultPrompt',
  hardSettings.status === 200 &&
    hardSettings.body?.defaultCategory === HARD_CAT &&
    typeof hardSettings.body?.defaultPrompt === 'string' &&
    hardSettings.body.defaultPrompt.length > 0 &&
    typeof hardSettings.body?.settings?.defaultPrompt === 'string',
  json({ keys: Object.keys(hardSettings.body ?? {}), defaultCategory: hardSettings.body?.defaultCategory }),
)

// F4（占用判定）：目标目录已有别的房间 room.json → 409，不覆写别人的 room.json
const occupiedDir = dirOf(HARD_CAT, 'hard-occupied')
fs.mkdirSync(occupiedDir, { recursive: true })
fs.writeFileSync(
  path.join(occupiedDir, 'room.json'),
  JSON.stringify({ id: 'somebody-else', title: '别人的房间', status: 'open', category: HARD_CAT, dir: occupiedDir }, null, 2),
)
const occupiedAttempt = await POST(hardBase, '/dsh-room/rooms', { id: 'hard-occupied', category: HARD_CAT })
check(
  'F4 POST /rooms 目标目录已有别的房间 room.json → 409（不覆写）',
  occupiedAttempt.status === 409 &&
    /已经是会议室/.test(occupiedAttempt.body?.error ?? '') &&
    JSON.parse(readText(path.join(occupiedDir, 'room.json'))).id === 'somebody-else',
  json({ status: occupiedAttempt.status, error: occupiedAttempt.body?.error }),
)

// O3（v4 收口，task-15）：记录员是每个会议室自带的内置 AI，不占 sessionId；
// `room_result_write` 对 AI 与会者**一律禁用**（不写盘，只回中文提示）——《会议结果》只能由
// 内置记录员在目标达成时自动生成，或由人类走 HTTP /rooms/:id/results/:gid/draft 手动填写。
await POST(hardBase, '/dsh-room/rooms', { id: 'hard-norec', goal: '目标：验证记录员门禁（v4 工具已禁用）' })
const norecGid = (await GET(hardBase, '/dsh-room/rooms/hard-norec/goals')).body?.goals?.[0]?.id
const norecResultPath = dirOf(HARD_CAT, 'hard-norec', '记录', '结果', `${norecGid}.md`)
const norecGoalsPath = dirOf(HARD_CAT, 'hard-norec', 'goals.json')
const norecAssign = await POST(hardBase, '/dsh-room/rooms/hard-norec/recorder', { sessionId: 'hard-b' })
check(
  'O3 v4：POST /rooms/:id/recorder 显式 sessionId → 400 逐字（记录员不可指派）',
  norecAssign.status === 400 && norecAssign.body?.error === V4_ASSIGN_REJECT,
  JSON.stringify(norecAssign.body),
)
// 人类手动通路的草稿（HTTP 通路保留），用来验证工具路径既不会改写它、也不会新建
const humanDraft = await POST(hardBase, `/dsh-room/rooms/hard-norec/results/${norecGid}/draft`, {
  title: '人工草稿',
  body: 'HUMAN-DRAFT-BODY',
  by: '手动',
})
const humanDraftBefore = json(readJsonFile(norecGoalsPath).find((g) => g.id === norecGid)?.result ?? null)
const manualDraft = await useTool(hardHost, 'room_result_write', { roomId: 'hard-norec', goalId: norecGid, title: 'T', body: 'TOOL-BODY' }, 'hard-a')
check(
  'O3 v4：工具路径被禁用（返回禁用提示、不落盘、不改已有草稿）',
  humanDraft.status === 200 &&
    isToolDisabledHint(manualDraft) &&
    json(readJsonFile(norecGoalsPath).find((g) => g.id === norecGid)?.result ?? null) === humanDraftBefore &&
    readText(norecResultPath).includes('HUMAN-DRAFT-BODY') &&
    !readText(norecResultPath).includes('TOOL-BODY'),
  String(manualDraft),
)
const emptyDraft = await useTool(hardHost, 'room_result_write', { roomId: 'hard-norec', goalId: norecGid, title: ' ', body: 'B' }, 'hard-a')
check(
  'O3 v4：工具路径同样直接禁用（提示不区分参数是否为空）',
  isToolDisabledHint(emptyDraft) && json(readJsonFile(norecGoalsPath).find((g) => g.id === norecGid)?.result ?? null) === humanDraftBefore,
  String(emptyDraft),
)

// F2 的前半：PATCH {dir:<改名过的目录>}（目录名 ≠ 房间 id）→ room.json 里登记 dir
const renamedTarget = path.join(HARD_RENAMED, 'my-renamed-dir')
const renamed = await PATCH(hardBase, '/dsh-room/rooms/hard-file', { dir: renamedTarget })
const renamedJson = exists(path.join(renamedTarget, 'room.json')) ? readJsonFile(path.join(renamedTarget, 'room.json')) : null
check(
  'F2 PATCH {dir:改名过的目录} → room.dir/patch.dir 更新且 room.json 登记 dir（不靠 category 推导）',
  renamed.status === 200 && renamed.body?.room?.dir === renamedTarget && renamed.body?.patch?.dir === renamedTarget && renamedJson?.dir === renamedTarget,
  json({ status: renamed.status, roomDir: renamed.body?.room?.dir, savedDir: renamedJson?.dir }),
)
check(
  'F2 改名搬家后旧目录已清空（原有文件跟着走，不是复制）',
  !exists(dirOf(HARD_CAT, 'hard-file', 'room.json')) && exists(path.join(renamedTarget, 'transcript.jsonl')),
  json({ oldGone: !exists(dirOf(HARD_CAT, 'hard-file', 'room.json')), moved: exists(path.join(renamedTarget, 'transcript.jsonl')) }),
)

// DELETE ?purge=1：目录名 ≠ 房间 id 时只删登记（避免把共享目录整锅端）
const purgeRenamed = await DELETE(hardBase, '/dsh-room/rooms/hard-file?purge=1')
check(
  'DELETE ?purge=1 目录名 ≠ 房间 id → purged:false 只删登记且不删目录（带 reason）',
  purgeRenamed.status === 200 &&
    purgeRenamed.body?.deleted === true &&
    purgeRenamed.body?.purged === false &&
    typeof purgeRenamed.body?.reason === 'string' &&
    purgeRenamed.body.reason.length > 0 &&
    exists(path.join(renamedTarget, 'room.json')) &&
    !(await GET(hardBase, '/dsh-room/rooms')).body.rooms.some((r) => r.id === 'hard-file'),
  json(purgeRenamed.body),
)

// browse：多级不存在时逐级回退到最近存在的祖先（最多 12 级）
const deepBrowse = await GET(hardBase, `/dsh-room/browse?path=${encodeURIComponent(path.join(HARD_CAT, 'nope', 'deep', 'deeper'))}`)
check(
  'browse 多级不存在 → 回退到最近存在的祖先目录（12 级容错）',
  deepBrowse.status === 200 && deepBrowse.body?.path === HARD_CAT && deepBrowse.body?.exists === true,
  json({ path: deepBrowse.body?.path, exists: deepBrowse.body?.exists }),
)

// PATCH /settings {category} 只改默认分类，不搬已有房间（每个房间有自己的 category/dir）
const norecDirBefore = dirOf(HARD_CAT, 'hard-norec')
const catPatch = await PATCH(hardBase, '/dsh-room/settings', { category: HARD_CAT2 })
const norecState = await GET(hardBase, '/dsh-room/rooms/hard-norec/state?since=0')
check(
  'PATCH /settings {category} → 只改默认分类并 mkdir，不搬已有房间',
  catPatch.status === 200 && catPatch.body?.settings?.category === HARD_CAT2 && norecState.body?.room?.dir === norecDirBefore && exists(HARD_CAT2),
  json({ settingsCategory: catPatch.body?.settings?.category, roomDir: norecState.body?.room?.dir }),
)

// 索引自愈：rooms.json 丢了，但目录里有 room.json → 重启收养并写回索引
const HEAL_ROOT = path.join(WORK, 'heal-root')
const HEAL_CAT = path.join(WORK, 'heal-cat', '会议')
const healHost1 = createHost({ root: HEAL_ROOT, category: HEAL_CAT, roomId: 'main', agents: [] })
const { server: healServer1, base: healBase1 } = await serve(healHost1)
await POST(healBase1, '/dsh-room/rooms', { id: 'seeded' })
const manualDir = dirOf(HEAL_CAT, 'manual')
fs.mkdirSync(manualDir, { recursive: true })
fs.writeFileSync(
  path.join(manualDir, 'room.json'),
  JSON.stringify({ id: 'manual', title: '手抄房间', status: 'open', category: HEAL_CAT, dir: manualDir }, null, 2),
)
fs.writeFileSync(path.join(manualDir, 'transcript.jsonl'), '')
await new Promise((resolve) => setTimeout(resolve, 400)) // 等 250ms 防抖把 rooms.json 写稳，再删
await closeServer(healServer1)
disposeHost(healHost1)
fs.rmSync(path.join(HEAL_ROOT, 'rooms.json'), { force: true })
const healHost2 = createHost({ root: HEAL_ROOT, category: HEAL_CAT, roomId: 'main', agents: [] })
const { server: healServer2, base: healBase2 } = await serve(healHost2)
const healed = await GET(healBase2, '/dsh-room/rooms')
check(
  '索引自愈：rooms.json 删掉后，目录里带 room.json 的房间重启被重新收养',
  healed.body?.rooms?.some((r) => r.id === 'manual' && r.dir === manualDir),
  json(healed.body?.rooms?.map((r) => [r.id, r.dir])),
)
const HEAL_INDEX = path.join(HEAL_ROOT, 'rooms.json')
const readIndexMaybe = () => {
  try {
    return exists(HEAL_INDEX) ? readJsonFile(HEAL_INDEX) : null
  } catch {
    return null
  }
}
await new Promise((resolve) => setTimeout(resolve, 400)) // 等 flush 防抖写盘
const healedIndex = readIndexMaybe()
check(
  '索引自愈：rooms.json 被写回（含收养的 manual，不只是内存）',
  Array.isArray(healedIndex) && healedIndex.some((r) => r.id === 'manual'),
  json(healedIndex ? healedIndex.map((r) => r.id) : `文件不存在：${HEAL_INDEX}`),
)
await closeServer(healServer2)
disposeHost(healHost2)
await closeServer(hardServer)
disposeHost(hardHost)

// ---------------------------------------------------------------- v3 加固回归：显式 dir 语义 / 同目录 409 / 重启后 dir 不漂

section('v3 加固回归：显式 dir 语义 / 同目录 409 / 重启后 dir 不漂')

const FIX_ROOT = path.join(WORK, 'fix-root')
const FIX_CAT = path.join(WORK, 'fix-cat', '会议')
const FIX_WORLD = path.join(WORK, 'fix-world')
const fixHost = createHost({ root: FIX_ROOT, category: FIX_CAT, roomId: 'main', agents: [] })
const { server: fixServer, base: fixBase } = await serve(fixHost)

const explicitDir = path.join(FIX_WORLD, 'MyMeetings')
const explicit = await POST(fixBase, '/dsh-room/rooms', { id: 'named', dir: explicitDir })
const explicitSaved = exists(path.join(explicitDir, 'room.json')) ? readJsonFile(path.join(explicitDir, 'room.json')) : null
check(
  'F4 POST {id:named, dir:<world>/MyMeetings} → 房间就落在该目录（目录名 ≠ 房间 id，dir 写进 room.json）',
  explicit.status === 200 &&
    explicit.body?.room?.dir === explicitDir &&
    explicitSaved?.id === 'named' &&
    explicitSaved?.dir === explicitDir &&
    exists(path.join(explicitDir, 'transcript.jsonl')),
  json({ status: explicit.status, dir: explicit.body?.room?.dir, saved: explicitSaved?.dir }),
)
check(
  'F4 显式 dir 的房间不会在分类目录下另建同名幽灵目录',
  !exists(dirOf(FIX_CAT, 'named')),
  json({ ghost: dirOf(FIX_CAT, 'named'), exists: exists(dirOf(FIX_CAT, 'named')) }),
)

const sameDir = await POST(fixBase, '/dsh-room/rooms', { id: 'other', dir: explicitDir })
check(
  'F4 同一目录再建第二个房间 → 409（该目录已是会议室「named」的目录）',
  sameDir.status === 409 && /已经是会议室/.test(sameDir.body?.error ?? '') && !exists(dirOf(FIX_CAT, 'other')),
  json({ status: sameDir.status, error: sameDir.body?.error }),
)

// 重启一次：房间数不翻倍、dir 不漂回 <category>/<id>、索引里带 dir
await closeServer(fixServer)
disposeHost(fixHost)
const FIX_INDEX = path.join(FIX_ROOT, 'rooms.json')
const fixIndex1 = exists(FIX_INDEX) ? readJsonFile(FIX_INDEX) : []
const fixHost2 = createHost({ root: FIX_ROOT, category: FIX_CAT, roomId: 'main', agents: [] })
const { server: fixServer2, base: fixBase2 } = await serve(fixHost2)
const afterRestart = await GET(fixBase2, '/dsh-room/rooms')
check(
  'F2 重启后显式 dir 不漂（room.dir 仍是 <world>/MyMeetings），且不产生重复房间/幽灵目录',
  fixIndex1.some((r) => r.id === 'named' && r.dir === explicitDir) &&
    afterRestart.body?.rooms?.filter((r) => r.id === 'named').length === 1 &&
    afterRestart.body.rooms.find((r) => r.id === 'named')?.dir === explicitDir &&
    !exists(dirOf(FIX_CAT, 'named')),
  json({ index: fixIndex1.map((r) => [r.id, r.dir]), rooms: afterRestart.body?.rooms?.map((r) => [r.id, r.dir]) }),
)

// 改成另一个「目录名 ≠ 房间 id」的目录后再重启：旧目录整体搬走，仍只有 1 个 named
const renamedX = path.join(FIX_WORLD, 'renamed-x')
const renameX = await PATCH(fixBase2, '/dsh-room/rooms/named', { dir: renamedX })
await closeServer(fixServer2)
disposeHost(fixHost2)
const fixHost3 = createHost({ root: FIX_ROOT, category: FIX_CAT, roomId: 'main', agents: [] })
const { server: fixServer3, base: fixBase3 } = await serve(fixHost3)
const afterRename = await GET(fixBase3, '/dsh-room/rooms')
check(
  'F2 改名目录后重启：只有 1 个 named（不按目录名收养成新房间），dir 不漂，旧目录已整体搬空',
  renameX.status === 200 &&
    readJsonFile(path.join(renamedX, 'room.json')).dir === renamedX &&
    afterRename.body?.rooms?.filter((r) => r.id === 'named').length === 1 &&
    afterRename.body.rooms.find((r) => r.id === 'named')?.dir === renamedX &&
    !afterRename.body.rooms.some((r) => r.id === 'renamed-x') &&
    !exists(explicitDir) &&
    exists(path.join(renamedX, 'transcript.jsonl')),
  json({ rooms: afterRename.body?.rooms?.map((r) => [r.id, r.dir]), oldGone: !exists(explicitDir) }),
)
await closeServer(fixServer3)
disposeHost(fixHost3)

// ---------------------------------------------------------------- 成员

section('成员：leave / kick / 重 join')

const seqBeforeLeave = (await GET(base, '/dsh-room/rooms/alpha/state?since=0')).body.seq
const leaveGhost = await POST(base, '/dsh-room/rooms/alpha/leave', { sessionId: 'ghost' })
const seqAfterLeave = (await GET(base, '/dsh-room/rooms/alpha/state?since=0')).body.seq
check(
  'leave 不在册 → removed:false 且不写系统行（seq 不变）',
  leaveGhost.status === 200 && leaveGhost.body?.removed === false && seqAfterLeave === seqBeforeLeave,
  json(leaveGhost.body).slice(0, 200),
)

const membersBeforeKick = (await GET(base, '/dsh-room/rooms/alpha/state?since=0')).body.members.length
const kick1 = await POST(base, '/dsh-room/rooms/alpha/kick', { sessionId: 'sess-impl', reason: '离线太久' })
const afterKick = (await GET(base, '/dsh-room/rooms/alpha/state?since=0')).body
check(
  'kick 移出登记表并写「已被移出会议室（原因）」系统行',
  kick1.status === 200 &&
    kick1.body?.removed === true &&
    !afterKick.members.some((m) => m.sessionId === 'sess-impl') &&
    afterKick.members.length === membersBeforeKick - 1 &&
    afterKick.messages.at(-1).text === '实现方 已被移出会议室（离线太久）',
  json(afterKick.members) + ' / ' + String(afterKick.messages.at(-1)?.text),
)

const kickGhost = await POST(base, '/dsh-room/rooms/alpha/kick', { sessionId: 'ghost' })
check('kick 不在册 → removed:false（不报错）', kickGhost.status === 200 && kickGhost.body?.removed === false, json(kickGhost.body))

const rejoinKicked = await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-impl', label: '实现方' })
check(
  '被踢的人可以重新 join',
  rejoinKicked.status === 200 && rejoinKicked.body?.already === false && rejoinKicked.body.members.some((m) => m.sessionId === 'sess-impl'),
  json(rejoinKicked.body).slice(0, 200),
)

const deliveriesBeforeNotify = host.deliveries.length
const kickNotify = await POST(base, '/dsh-room/rooms/alpha/kick', { sessionId: 'sess-impl', reason: '再移出一次', notify: true })
check(
  'kick notify:true 且对方在线 → 额外投一条通知',
  kickNotify.body?.notified === true && host.deliveries.length === deliveriesBeforeNotify + 1 && deliveryText(host.deliveries.at(-1)).includes('已被移出本次会议'),
  deliveryText(host.deliveries.at(-1)),
)
const warnsBeforeKickOffline = host.warns.length
const kickNotifyOffline = await POST(base, '/dsh-room/rooms/alpha/kick', { sessionId: 'sess-cold', notify: true })
check(
  'v5：kick notify:true 但宿主没有激活能力 → notified:false + 一条 warn + 投递记录不增（先激活再通知）',
  kickNotifyOffline.body?.removed === true &&
    kickNotifyOffline.body?.notified === false &&
    host.warns.length === warnsBeforeKickOffline + 1 &&
    String(host.warns.at(-1)).includes('宿主没有提供会话激活能力'),
  json(kickNotifyOffline.body).slice(0, 200) + ' / warn=' + String(host.warns.at(-1)),
)
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-impl', label: '实现方' })
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-cold', label: '离线同学' })

// ---------------------------------------------------------------- 投递策略

section('投递策略（v6）：缺省 archive / notice 一行提示 / full 降级 / pushAll 失效 / 房间 push 只管通知')

// v6①：/post 只认 archive|notice，缺省 archive；房间 push 设置不再影响「发帖子」这件事。
const deliveriesBeforeArchive = host.deliveries.length
const archiveAgain = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'ARCHIVE-BODY' })
const archiveSeq = archiveAgain.body?.message?.seq ?? 0
const archiveState = await GET(base, '/dsh-room/rooms/alpha/state?since=' + Math.max(0, archiveSeq - 1))
const archiveRecord = (archiveState.body?.messages ?? []).find((m) => m.seq === archiveSeq)
check(
  'v6①：/post 缺省 mode ⇒ archive，正文只进会议室记录、零投递（delivered:[]）、不激活任何人',
  archiveAgain.status === 200 &&
    archiveAgain.body?.mode === 'archive' &&
    archiveSeq > 0 &&
    archiveRecord?.text === 'ARCHIVE-BODY' &&
    Array.isArray(archiveAgain.body.delivered) &&
    archiveAgain.body.delivered.length === 0 &&
    archiveAgain.body.activated === 0 &&
    host.deliveries.length === deliveriesBeforeArchive,
  json(archiveAgain.body).slice(0, 200) + ' / 记录=' + json(archiveRecord?.text),
)

const noticePost = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'NOTICE-BODY-MUST-NOT-LEAK', to: ['sess-spec'], mode: 'notice' })
const noticeText = deliveryText(lastDelivery(host, 'sess-spec'))
check(
  'v6①：显式 notice + to → 只投一行提示（含「条新消息」+ room_read，不含正文）',
  noticePost.body?.mode === 'notice' &&
    has(noticePost.body.delivered, 'sess-spec') &&
    noticeText.includes('条新消息') &&
    noticeText.includes('room_read') &&
    !noticeText.includes('NOTICE-BODY-MUST-NOT-LEAK') &&
    noticeText.split('\n').length === 1,
  noticeText,
)

// v7①：客户端现在「每次发送都自动带 mode:'notice'」（v7 把唤醒按钮换成了自动提醒）——用唯一哨兵串
// 再钉一次 v6 的核心性质：正文永不进投递事件，但仍然写进会议室记录。
const V7_SENTINEL = '秘密正文-V7'
const deliveriesBeforeV7Sentinel = host.deliveries.length
const v7Notice = await POST(base, '/dsh-room/rooms/alpha/post', { text: `${V7_SENTINEL}：只在会议室里说的话`, to: ['sess-spec'], mode: 'notice' })
const v7Seq = v7Notice.body?.message?.seq ?? 0
const v7State = await GET(base, '/dsh-room/rooms/alpha/state?since=' + Math.max(0, v7Seq - 1))
const v7Record = (v7State.body?.messages ?? []).find((m) => m.seq === v7Seq)
const v7Sent = host.deliveries.slice(deliveriesBeforeV7Sentinel)
check(
  'v7①：mode:notice 的正文永不外发（哨兵串 秘密正文-V7 在投递事件里 0 命中），但仍然写进会议室记录',
  v7Notice.status === 200 &&
    v7Notice.body?.mode === 'notice' &&
    String(v7Record?.text ?? '').includes(V7_SENTINEL) &&
    v7Sent.length >= 1 &&
    v7Sent.every((d) => !deliveryText(d).includes(V7_SENTINEL)) &&
    v7Sent.every((d) => !json(d.message).includes(V7_SENTINEL)),
  '记录含哨兵=' + String(v7Record?.text ?? '').includes(V7_SENTINEL) + ' 投递条数=' + v7Sent.length + ' 投递含哨兵=' + v7Sent.some((d) => deliveryText(d).includes(V7_SENTINEL)),
)

// v6①：显式 notice 缺省 to 时 deliver() 仍按「空 targets = 全体成员」扇出（自动提醒路径就走这条），
// 但正文永远不进投递事件。
const deliveriesBeforeNoticeAll = host.deliveries.length
const noticeAll = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'NOTICE-ALL-BODY', mode: 'notice' })
check(
  'v6①：notice 缺省 to ⇒ 目标 = 全体成员（在线投到、离线进 failed 带原因、activated 0），正文不外发',
  noticeAll.status === 200 &&
    noticeAll.body?.mode === 'notice' &&
    noticeAll.body.delivered.slice().sort().join(',') === 'sess-impl,sess-spec' &&
    noticeAll.body?.failed?.length === 1 &&
    noticeAll.body.failed[0].sessionId === 'sess-cold' &&
    noticeAll.body.failed[0].error === '宿主没有提供会话激活能力' &&
    noticeAll.body?.activated === 0 &&
    host.deliveries.slice(deliveriesBeforeNoticeAll).every((d) => !deliveryText(d).includes('NOTICE-ALL-BODY')),
  json(noticeAll.body).slice(0, 240),
)

const deliveriesBeforeFull = host.deliveries.length
const fullPost = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'FULL-BODY-OK', to: ['sess-spec'], mode: 'full' })
const fullPostText = deliveryText(lastDelivery(host, 'sess-spec'))
check(
  'v6①：显式 mode:full ⇒ 回包降级为 notice、只投一行提示（投递事件与正文都不含用户正文）',
  fullPost.status === 200 &&
    fullPost.body?.mode === 'notice' &&
    has(fullPost.body.delivered, 'sess-spec') &&
    fullPostText.includes('条新消息') &&
    !fullPostText.includes('FULL-BODY-OK') &&
    host.deliveries.slice(deliveriesBeforeFull).every((d) => !json(d.message).includes('FULL-BODY-OK')),
  'mode=' + fullPost.body?.mode + ' text=' + fullPostText,
)

const fullNoTo = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'FULL-NO-TO', mode: 'full' })
check(
  'v6①：full 降级 notice + 缺省 to ⇒ 全体成员（在线投到、离线进 failed 带原因、activated 0），正文不外发',
  fullNoTo.status === 200 &&
    fullNoTo.body?.mode === 'notice' &&
    Array.isArray(fullNoTo.body?.delivered) &&
    fullNoTo.body.delivered.slice().sort().join(',') === 'sess-impl,sess-spec' &&
    fullNoTo.body?.failed?.length === 1 &&
    fullNoTo.body.failed[0].sessionId === 'sess-cold' &&
    fullNoTo.body.failed[0].error === '宿主没有提供会话激活能力' &&
    fullNoTo.body?.activated === 0 &&
    !fullNoTo.body.delivered.some((id) => deliveryText(lastDelivery(host, id)).includes('FULL-NO-TO')),
  json(fullNoTo.body).slice(0, 240),
)

const deliveriesBeforePushAllBare = host.deliveries.length
const pushAllBare = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'PUSH-ALL-BARE', pushAll: true })
check(
  'v6①：pushAll:true 不再把缺省发言升级成投递（mode 仍 archive、零投递、不激活）',
  pushAllBare.status === 200 &&
    pushAllBare.body?.mode === 'archive' &&
    pushAllBare.body.delivered.length === 0 &&
    pushAllBare.body.activated === 0 &&
    host.deliveries.length === deliveriesBeforePushAllBare,
  json(pushAllBare.body).slice(0, 200),
)

const pushAllNotice = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'PUSH-ALL-NOTICE', pushAll: true, mode: 'notice' })
check(
  'v6①：pushAll 只在显式 notice 下扇出（v1 兼容），目标 = 全体成员、正文不外发',
  pushAllNotice.body?.mode === 'notice' &&
    pushAllNotice.body.delivered.slice().sort().join(',') === 'sess-impl,sess-spec' &&
    pushAllNotice.body?.failed?.length === 1 &&
    pushAllNotice.body.failed[0].sessionId === 'sess-cold' &&
    pushAllNotice.body?.activated === 0,
  json(pushAllNotice.body).slice(0, 240),
)

const toOffline = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'TO-OFFLINE', to: ['sess-cold'], mode: 'notice' })
check(
  'v6①：to 只给离线成员 → delivered 为空，但 failed 必含该成员 + 原因（不再静默跳过）',
  toOffline.status === 200 &&
    Array.isArray(toOffline.body?.delivered) &&
    toOffline.body.delivered.length === 0 &&
    toOffline.body?.failed?.length === 1 &&
    toOffline.body.failed[0].sessionId === 'sess-cold' &&
    toOffline.body.failed[0].error === '宿主没有提供会话激活能力' &&
    toOffline.body?.activated === 0,
  json(toOffline.body).slice(0, 240),
)

const droppedPost = await POST(base, '/dsh-room/rooms/alpha/post', { text: '带不存在的文件', files: [path.join(WORK, 'nowhere.txt')] })
check(
  'post files 里不存在的文件 → 进 droppedFiles，正文照常归档',
  droppedPost.status === 200 && droppedPost.body?.droppedFiles?.length === 1 && droppedPost.body?.message?.seq > 0,
  json(droppedPost.body).slice(0, 200),
)

const patchNotice = await PATCH(base, '/dsh-room/rooms/alpha', { push: 'notice' })
const deliveriesBeforeDefaultNotice = host.deliveries.length
const defaultNotice = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'ROOM-PUSH-NOTICE' })
check(
  'v6①：PATCH push:notice 仍写得进，但缺省发言不再跟随它（mode 仍 archive、零投递、不激活）',
  patchNotice.status === 200 &&
    patchNotice.body?.room?.push === 'notice' &&
    defaultNotice.body?.mode === 'archive' &&
    defaultNotice.body.delivered.length === 0 &&
    defaultNotice.body.activated === 0 &&
    host.deliveries.length === deliveriesBeforeDefaultNotice,
  json(defaultNotice.body).slice(0, 200),
)
const patchFull = await PATCH(base, '/dsh-room/rooms/alpha', { push: 'full' })
const deliveriesBeforeDefaultFull = host.deliveries.length
const defaultFull = await POST(base, '/dsh-room/rooms/alpha/post', { text: 'ROOM-PUSH-FULL-BODY' })
check(
  "v6①：PATCH push:full ⇒ 400，文案只列 off/notice（'full' 已下线），房间设置未变、发言仍 archive 且正文不外发",
  patchFull.status === 400 &&
    String(patchFull.body?.error ?? '').includes('off/notice') &&
    !String(patchFull.body?.error ?? '').includes('full') &&
    defaultFull.body?.mode === 'archive' &&
    defaultFull.body.delivered.length === 0 &&
    host.deliveries.length === deliveriesBeforeDefaultFull,
  json(patchFull.body) + ' / next=' + json(defaultFull.body).slice(0, 120),
)
const patchBadPush = await PATCH(base, '/dsh-room/rooms/alpha', { push: 'bogus' })
check(
  'v6①：PATCH push 非法值 → 400，文案与合法值清单同源（off/notice）',
  patchBadPush.status === 400 && String(patchBadPush.body?.error ?? '').includes('off/notice'),
  json(patchBadPush.body),
)
const patchBadTitle = await PATCH(base, '/dsh-room/rooms/alpha', { title: '   ' })
check('PATCH title 空 → 400', patchBadTitle.status === 400, json(patchBadTitle.body))
const patchBackOff = await PATCH(base, '/dsh-room/rooms/alpha', { push: 'off' })
check('PATCH push 复原为 off', patchBackOff.body?.room?.push === 'off', json(patchBackOff.body?.patch))

// v6①：room.json 里遗留的 push:'full' 载入即归一成 'off'（列表视图 + state 视图两处都不再露出 full）
const PUSH_ROOT = path.join(WORK, 'v6-push-root')
const PUSH_CAT = path.join(WORK, 'v6-push-cat', '会议')
fs.mkdirSync(path.join(PUSH_CAT, 'pfull'), { recursive: true })
fs.writeFileSync(
  path.join(PUSH_CAT, 'pfull', 'room.json'),
  JSON.stringify({ id: 'pfull', title: '遗留 full 房间', createdAt: 1, status: 'open', push: 'full' }),
)
const pushHost = createHost({ root: PUSH_ROOT, category: PUSH_CAT, roomId: 'main' })
const pushServed = await serve(pushHost)
const pushReady = await waitReady(pushHost, pushServed.base, 'v6 push 归一宿主')
const pfullState = await GET(pushServed.base, '/dsh-room/rooms/pfull/state?since=0')
const pfullSummary = (await GET(pushServed.base, '/dsh-room/rooms')).body?.rooms?.find((r) => r.id === 'pfull')
check(
  "v6①：room.json 遗留 push:'full' 载入归一为 'off'（列表与 state 两处视图都不含 full）",
  pushReady.ok === true &&
    pfullState.status === 200 &&
    pfullState.body?.room?.push === 'off' &&
    pfullState.body?.push === 'off' &&
    pfullSummary?.push === 'off',
  json({ ready: pushReady.ok, list: pfullSummary?.push, state: pfullState.body?.room?.push, error: pfullState.body?.error }),
)
await closeServer(pushServed.server)

// ---------------------------------------------------------------- v5 按需激活

section('v5 按需激活：sessionController 优先 / agents.resume 回落 / activated 语义 / archive 不激活')

const ACT_ROOT = path.join(WORK, 'act-root')
const ACT_CAT = path.join(WORK, 'act-cat', '会议')
const RES_ROOT = path.join(WORK, 'res-root')
const RES_CAT = path.join(WORK, 'res-cat', '会议')
fs.mkdirSync(ACT_CAT, { recursive: true })
fs.mkdirSync(RES_CAT, { recursive: true })

// 同时给 sessionController 与 agents.resume：用来断言「优先 ②，不回落 ③」。
const actHost = createHost({
  root: ACT_ROOT,
  category: ACT_CAT,
  roomId: 'main',
  agents: ['act-live'],
  sessionController: true,
  resume: true,
})
const actServed = await serveReady(actHost, 'v5 激活宿主')
const actBase = actServed.base
await POST(actBase, '/dsh-room/rooms', { id: 'act', title: '激活房', goal: '验证按需激活' })
check(
  'v5 激活宿主就绪（GET /rooms 有 rooms / 房间 act 建好）',
  actServed.ready.ok === true && (await GET(actBase, '/dsh-room/rooms/act')).status === 200,
  'ready=' + actServed.ready.ok,
)
await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-live', label: '在线者' })
await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-cold', label: '离线者' })
const actMembers0 = (await GET(actBase, '/dsh-room/rooms/act/state?since=0')).body.members
check(
  'v5：成员在线态来自 host.isLive（有 agent 的在线、没 agent 的离线）',
  actMembers0.find((m) => m.sessionId === 'act-live')?.live === true && actMembers0.find((m) => m.sessionId === 'act-cold')?.live === false,
  json(actMembers0.map((m) => [m.sessionId, m.live])),
)

const actToCold = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-COLD-BODY', to: ['act-cold'], mode: 'notice' })
const actToColdText = deliveryText(lastDelivery(actHost, 'act-cold'))
check(
  'v6①：to=[离线成员] → 先激活再投递一行提示（delivered 含它、activated=1、failed 空、正文不外发），且优先走 sessionController.resolveAgent（未回落 agents.resume）',
  actToCold.status === 200 &&
    has(actToCold.body?.delivered, 'act-cold') &&
    actToCold.body?.activated === 1 &&
    (actToCold.body?.failed ?? []).length === 0 &&
    actHost.resolveAgentCalls.join(',') === 'act-cold' &&
    actHost.resumeCalls.length === 0 &&
    actToColdText.includes('条新消息') &&
    !actToColdText.includes('ACT-COLD-BODY'),
  json(actToCold.body) + ' resolve=' + json(actHost.resolveAgentCalls) + ' resume=' + actHost.resumeCalls.length + ' text=' + actToColdText,
)
const actMembers1 = (await GET(actBase, '/dsh-room/rooms/act/state?since=0')).body.members
check(
  'v5：激活成功后 members[].live 翻转为在线（与回包 activated 数一致）',
  actMembers1.find((m) => m.sessionId === 'act-cold')?.live === true && actToCold.body?.activated === 1,
  json(actMembers1.map((m) => [m.sessionId, m.live])),
)

const actAgain = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-COLD-AGAIN', to: ['act-cold'], mode: 'notice' })
check(
  'v5：已经 live 的成员再投 → activated=0（幂等：只数本次真激活）',
  has(actAgain.body?.delivered, 'act-cold') && actAgain.body?.activated === 0 && (actAgain.body?.failed ?? []).length === 0,
  json(actAgain.body),
)

await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-cold2', label: '离线者2' })
const actDefaultTo = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-DEFAULT-TO', mode: 'notice' })
check(
  'v6①：显式 notice 缺省 to → 目标 = 全体成员（除已 live 的外再激活 1 人，delivered = 三名、failed 空）',
  (actDefaultTo.body?.delivered ?? []).slice().sort().join(',') === 'act-cold,act-cold2,act-live' &&
    actDefaultTo.body?.activated === 1 &&
    (actDefaultTo.body?.failed ?? []).length === 0,
  json(actDefaultTo.body),
)

// ② resolveAgent 返回 { error } → 不回落 ③，failed 带 error.message。
actHost.setResolveMode('act-bad', 'error', '会话已归档，无法激活')
await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-bad', label: '坏会话' })
const resumeBeforeBad = actHost.resumeCalls.length
const actBad = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-BAD', to: ['act-bad'], mode: 'notice' })
check(
  'v5：resolveAgent 返回 { error } → { ok:false, error:error.message } 且不再回落 agents.resume',
  actBad.status === 200 &&
    (actBad.body?.delivered ?? []).length === 0 &&
    actBad.body?.failed?.length === 1 &&
    actBad.body.failed[0].error === '会话已归档，无法激活' &&
    actBad.body?.activated === 0 &&
    actHost.resumeCalls.length === resumeBeforeBad,
  json(actBad.body) + ' resume=' + (actHost.resumeCalls.length - resumeBeforeBad),
)

// ② resolveAgent 抛异常 → activate 绝不冒泡（HTTP 仍 200，失败进 failed）。
actHost.setResolveMode('act-boom', 'throw', 'resolveAgent 炸了')
await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-boom', label: '炸会话' })
const handlerErrorsBefore = actHost.handlerErrors.length
const actBoom = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-BOOM', to: ['act-boom'], mode: 'notice' })
check(
  'v5：resolveAgent 抛异常 → activate 不冒泡（HTTP 200、failed 带 message、无 handlerError）',
  actBoom.status === 200 &&
    actBoom.body?.failed?.[0]?.error === 'resolveAgent 炸了' &&
    actBoom.body?.activated === 0 &&
    actHost.handlerErrors.length === handlerErrorsBefore,
  actBoom.status + ' ' + json(actBoom.body).slice(0, 200) + ' handlerErrors=' + (actHost.handlerErrors.length - handlerErrorsBefore),
)

// archive 不激活任何人。
const resolvesBeforeArchive = actHost.resolveAgentCalls.length
const actArchive = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-ARCHIVE', mode: 'archive' })
check(
  'v5：mode=archive → 零投递且不激活（resolveAgent 调用次数不变、activated=0）',
  actArchive.body?.mode === 'archive' &&
    (actArchive.body?.delivered ?? []).length === 0 &&
    actArchive.body?.activated === 0 &&
    actHost.resolveAgentCalls.length === resolvesBeforeArchive,
  json(actArchive.body) + ' resolve=' + (actHost.resolveAgentCalls.length - resolvesBeforeArchive),
)

// v6①：连 mode 都不传（缺省 archive）时，宿主即便有激活能力也不该被叫起来。
const resolvesBeforeNoMode = actHost.resolveAgentCalls.length
const actNoMode = await POST(actBase, '/dsh-room/rooms/act/post', { text: 'ACT-NO-MODE', to: ['act-live'] })
check(
  'v6①：不传 mode（缺省 archive）⇒ 零投递且不激活（带 to 也一样，宿主有 sessionController 也不被叫）',
  actNoMode.body?.mode === 'archive' &&
    (actNoMode.body?.delivered ?? []).length === 0 &&
    actNoMode.body?.activated === 0 &&
    actHost.resolveAgentCalls.length === resolvesBeforeNoMode,
  json(actNoMode.body) + ' resolve=' + (actHost.resolveAgentCalls.length - resolvesBeforeNoMode),
)

// 有激活能力时 kick notify:true → 离线成员也能被通知到。
const deliveriesBeforeActKick = actHost.deliveries.length
await POST(actBase, '/dsh-room/rooms/act/join', { sessionId: 'act-kick', label: '待踢离线者' })
const actKick = await POST(actBase, '/dsh-room/rooms/act/kick', { sessionId: 'act-kick', reason: '清理', notify: true })
check(
  'v5：有激活能力时 kick notify:true → 离线成员 notified:true 且投递记录 +1（先激活再 relay）',
  actKick.body?.notified === true &&
    actHost.deliveries.length === deliveriesBeforeActKick + 1 &&
    deliveryText(lastDelivery(actHost, 'act-kick')).includes('已被移出本次会议'),
  json(actKick.body) + ' ' + deliveryText(lastDelivery(actHost, 'act-kick')),
)

// ③ 没有 sessionController → 回落 agents.resume。
const resHost = createHost({ root: RES_ROOT, category: RES_CAT, roomId: 'main', agents: [], resume: true })
const resServed = await serveReady(resHost, 'v5 resume 宿主')
const resBase = resServed.base
await POST(resBase, '/dsh-room/rooms', { id: 'res', title: '回落房', goal: '验证 resume 回落' })
await POST(resBase, '/dsh-room/rooms/res/join', { sessionId: 'res-offline', label: '离线者' })
const resPost = await POST(resBase, '/dsh-room/rooms/res/post', { text: 'RES-BODY', to: ['res-offline'], mode: 'notice' })
check(
  'v5：无 sessionController → 回落 agents.resume（handle.agent ⇒ ok、activated=1；参数是 {resumeSessionId}）',
  has(resPost.body?.delivered, 'res-offline') &&
    resPost.body?.activated === 1 &&
    resHost.resumeCalls.length === 1 &&
    resHost.resumeCalls[0]?.resumeSessionId === 'res-offline' &&
    resHost.resolveAgentCalls.length === 0,
  json(resPost.body) + ' resume=' + json(resHost.resumeCalls),
)
const resMembers = (await GET(resBase, '/dsh-room/rooms/res/state?since=0')).body.members
check(
  'v5：resume 激活成功后 members[].live 也翻转为在线',
  resMembers.find((m) => m.sessionId === 'res-offline')?.live === true,
  json(resMembers.map((m) => [m.sessionId, m.live])),
)
resHost.setResumeMode('error')
await POST(resBase, '/dsh-room/rooms/res/join', { sessionId: 'res-bad', label: '恢复失败者' })
const resBad = await POST(resBase, '/dsh-room/rooms/res/post', { text: 'RES-BAD', to: ['res-bad'], mode: 'notice' })
check(
  'v5：agents.resume 返回 { error } → failed 带「会话无法激活」，不抛错',
  resBad.status === 200 && resBad.body?.failed?.[0]?.error === '会话无法激活' && resBad.body?.activated === 0,
  json(resBad.body),
)
resHost.setResumeMode('throw')
const resThrew = await POST(resBase, '/dsh-room/rooms/res/post', { text: 'RES-THROW', to: ['res-bad'], mode: 'notice' })
check(
  'v5：agents.resume 抛异常 → activate 不冒泡（HTTP 200，failed 带 message）',
  resThrew.status === 200 && resThrew.body?.failed?.[0]?.error === 'resume 炸了' && resHost.handlerErrors.length === 0,
  resThrew.status + ' ' + json(resThrew.body).slice(0, 200),
)
await closeServer(actServed.server)
await closeServer(resServed.server)

// ---------------------------------------------------------------- 目标

section('会议目标：建 / 改 / 切 / 达成触发内置记录员草稿 / 再议')

// v4：记录员是内置 AI —— 旧的「指定记录员」写法必须 400（v3 是 200）
const betaRecorder = await POST(base, '/dsh-room/rooms/beta/recorder', { sessionId: 'sess-impl', label: '实现方' })
check(
  'POST /recorder 指定记录员 → 400 逐字 v4 文案（v3 的 200 指派路径已取消）',
  betaRecorder.status === 400 && betaRecorder.body?.error === V4_ASSIGN_REJECT,
  JSON.stringify(betaRecorder.body),
)

const betaGoals0 = await GET(base, '/dsh-room/rooms/beta/goals')
const betaGoal1 = betaGoals0.body?.goals?.[0]
check(
  'GET goals 返回 goals + activeGoalId（建房间带的 goal 是 active）',
  betaGoals0.status === 200 && betaGoal1?.status === 'active' && betaGoals0.body.activeGoalId === betaGoal1.id,
  json(betaGoals0.body).slice(0, 300),
)

const goalAdd = await POST(base, '/dsh-room/rooms/beta/goals', { text: '第二个目标：补文档' })
const goal2 = goalAdd.body?.goal
const goalsAfterAdd = await GET(base, '/dsh-room/rooms/beta/goals')
check(
  'POST goals 追加目标（已有 active ⇒ 新目标 open，active 不变）',
  goalAdd.status === 200 && goal2?.status === 'open' && goalAdd.body.goals.length === 2 && goalsAfterAdd.body?.activeGoalId === betaGoal1.id,
  json(goalAdd.body).slice(0, 300) + ' / activeGoalId=' + goalsAfterAdd.body?.activeGoalId,
)
check('POST goals 空 text → 400', (await POST(base, '/dsh-room/rooms/beta/goals', { text: '   ' })).status === 400)
check('未知目标 → 404「会议目标不存在」', (await PATCH(base, '/dsh-room/rooms/beta/goals/nope', { text: 'x' })).status === 404)

const goalSwitch = await PATCH(base, '/dsh-room/rooms/beta/goals/' + goal2.id, { status: 'active' })
check(
  'PATCH goals/:gid status:active → 切换 activeGoalId',
  goalSwitch.status === 200 && goalSwitch.body?.goal?.status === 'active' && goalSwitch.body.goals.find((g) => g.id === goal2.id)?.status === 'active',
  json(goalSwitch.body).slice(0, 200),
)
const goalRename = await PATCH(base, '/dsh-room/rooms/beta/goals/' + goal2.id, { text: '第二个目标：补 v2 文档' })
check('PATCH goals/:gid 改文案', goalRename.body?.goal?.text === '第二个目标：补 v2 文档', json(goalRename.body?.goal))
check('PATCH goals/:gid 非法 status → 400', (await PATCH(base, '/dsh-room/rooms/beta/goals/' + goal2.id, { status: 'bogus' })).status === 400)

const llmBeforeBeta = llmCallsOf(host).length
const completed = await POST(base, '/dsh-room/rooms/beta/goals/' + goal2.id + '/complete', { note: '记得写未决问题' })
check(
  'complete → 目标 done + 系统行 + 内置记录员出草稿（asked:true / draft / 只调一次 llm）',
  completed.status === 200 &&
    completed.body?.goal?.status === 'done' &&
    typeof completed.body.goal.doneAt === 'number' &&
    completed.body.asked === true &&
    completed.body?.result?.status === 'draft' &&
    completed.body?.result?.by === '记录员' &&
    isBuiltinRecorder(completed.body?.recorder) &&
    llmCallsOf(host).length === llmBeforeBeta + 1 &&
    (await GET(base, '/dsh-room/rooms/beta/state?since=0')).body.messages.some((m) => m.kind === 'system' && m.text.includes('已达成')),
  json(completed.body).slice(0, 300),
)
check(
  'complete 后 goals.json 与接口一致（status done）',
  readJsonFile(roomDir('beta', 'goals.json')).find((g) => g.id === goal2.id)?.status === 'done',
)
const betaCall = llmCallsOf(host).at(-1)
const taskText = betaCall?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  '给内置记录员的写作任务：默认提示词（占位符已替换）+ 会议记录证据段 + 与会者名单 + 补充要求',
  taskText.startsWith('【会议室 接口对齐】目标「第二个目标：补 v2 文档」已达成') &&
    taskText.includes('不得编造') &&
    taskText.includes('【会议记录（唯一证据，seq ') &&
    taskText.includes('【与会者名单】') &&
    taskText.includes('补充要求：记得写未决问题'),
  taskText.slice(0, 260),
)
check(
  'complete 的草稿也落盘：results/<gid>.md 带「记录员：记录员（内置 AI）」抬头',
  exists(roomDir('beta', '记录', '结果', `${goal2.id}.md`)) &&
    readText(roomDir('beta', '记录', '结果', `${goal2.id}.md`)).includes('记录员：记录员（内置 AI）') &&
    readText(roomDir('beta', '记录', '结果', `${goal2.id}.md`)).includes('-LLM-DRAFT-BODY-'),
  readText(roomDir('beta', '记录', '结果', `${goal2.id}.md`)).slice(0, 160),
)
const llmBeforeBetaAgain = llmCallsOf(host).length
const betaAgain = await POST(base, '/dsh-room/rooms/beta/goals/' + goal2.id + '/complete', {})
check(
  'complete 已 done 再调 → already:true + asked:false + 不重复调 llm（幂等）',
  betaAgain.body?.already === true && betaAgain.body?.asked === false && String(betaAgain.body?.reason).includes('已有草稿') && llmCallsOf(host).length === llmBeforeBetaAgain,
  `already=${betaAgain.body?.already} asked=${betaAgain.body?.asked} reason=${betaAgain.body?.reason}`,
)

const gammaGoals = await GET(base, '/dsh-room/rooms/gamma/goals')
const gammaGoal = gammaGoals.body?.goals?.[0]
const gammaDone = await POST(base, '/dsh-room/rooms/gamma/goals/' + gammaGoal.id + '/complete', {})
check(
  'v4：没有「记录员在线」这个前提也能出草稿（asked:true + status:draft）',
  gammaDone.status === 200 && gammaDone.body?.asked === true && gammaDone.body?.result?.status === 'draft' && isBuiltinRecorder(gammaDone.body?.recorder),
  json(gammaDone.body).slice(0, 240),
)
check(
  '无在线成员时 POST /rooms/:id/recorder 空 body → 400 逐字 v4 文案（v3「自动指派」路径已取消）',
  (await POST(base, '/dsh-room/rooms/gamma/recorder', {})).status === 400,
)

// v4 新增：内置记录员的模型通路失败必须「503 + result 仍空 + 不落草稿文件」，绝不写半成品。
const LLM_ROOT = path.join(WORK, 'llm-root')
const LLM_CAT = path.join(WORK, 'llm-cat', '会议')
const llmHost = createHost({
  root: LLM_ROOT,
  category: LLM_CAT,
  roomId: 'main',
  agents: ['lm-a'],
  llmMode: 'normal',
  agentDefaultModel: { currentSelection: () => ({ provider: 'sel-prov', model: 'sel-model' }) },
})
const llmServed = await serveReady(llmHost, 'llm 宿主')
const llmBase = llmServed.base
const lmCreate = await POST(llmBase, '/dsh-room/rooms', { id: 'lm', title: '模型失败房', goal: '失败目标 0' })
// task-24 flake：老脚本在这里不检查就往下走，一旦 start() 被吞、房间没注册，
// 下面 `(await GET(...)).body.goals.find(...)` 就会抛 TypeError（首跑偶发）。这里显式就绪 + 显式断言。
const lmReadyGoals = await GET(llmBase, '/dsh-room/rooms/lm/goals')
check(
  'flake 收敛：llm 宿主显式就绪（房间已注册、GET /rooms/lm/goals 返回 goals 数组），不靠重跑',
  llmServed.ready.ok === true && lmCreate.status === 200 && lmReadyGoals.status === 200 && Array.isArray(lmReadyGoals.body?.goals),
  'ready=' + llmServed.ready.ok + ' create=' + lmCreate.status + ' goals=' + json(lmReadyGoals.body).slice(0, 160),
)
const LLM_FAIL_MODES = [
  ['no-llm', 'ctx.get(\'llm\') 是 undefined'],
  ['throw', 'stream 抛错'],
  ['finish-error', 'finish reason.kind=error'],
  ['aborted', 'finish reason.kind=aborted'],
  ['empty', '只有 finish、没有正文'],
]
const failGids = []
for (const [mode, desc] of LLM_FAIL_MODES) {
  llmHost.setLlmMode(mode)
  const gFail = await POST(llmBase, '/dsh-room/rooms/lm/goals', { text: `失败目标 ${mode}` })
  const gidFail = gFail.body?.goal?.id
  failGids.push(gidFail)
  const callsBefore = llmCallsOf(llmHost).length
  const failedRes = await POST(llmBase, `/dsh-room/rooms/lm/goals/${gidFail}/complete`, {})
  const goalAfter = (await GET(llmBase, '/dsh-room/rooms/lm/goals')).body?.goals?.find((g) => g.id === gidFail)
  check(
    `内置记录员失败通路（${mode}：${desc}）→ 503 + result 仍空 + 不落草稿文件`,
    failedRes.status === 503 &&
      String(failedRes.body?.error).includes('内置记录员暂时无法调用模型') &&
      failedRes.body?.result === undefined &&
      !goalAfter?.result &&
      (mode === 'no-llm' ? llmCallsOf(llmHost).length === callsBefore : llmCallsOf(llmHost).length === callsBefore + 1) &&
      !exists(dirOf(LLM_CAT, 'lm', '记录', '结果', `${gidFail}.md`)),
    `${failedRes.status} ${String(failedRes.body?.error).slice(0, 90)} result=${json(goalAfter?.result)}`,
  )
}
const goalsAfterFails = (await GET(llmBase, '/dsh-room/rooms/lm/goals')).body?.goals ?? []
const doneFailGoals = goalsAfterFails.filter((g) => failGids.includes(g.id))
check(
  '失败后 goal.status 仍是 done（失败不把目标打回）且 transcript 有「已达成」系统行',
  doneFailGoals.length === LLM_FAIL_MODES.length &&
    doneFailGoals.every((g) => g.status === 'done') &&
    failGids.length === LLM_FAIL_MODES.length &&
    ((await GET(llmBase, '/dsh-room/rooms/lm/state?since=0')).body?.messages ?? []).some((m) => String(m.text).includes('已达成')),
  'done=' + doneFailGoals.length + '/' + failGids.length,
)
// 没有 agentDefaultModel → 回落到 llm.listProviders()[0] + llm.listModels()[0]
llmHost.setAgentDefaultModel(undefined)
llmHost.setLlmMode('normal')
const gFallback = await POST(llmBase, '/dsh-room/rooms/lm/goals', { text: '回落模型目标' })
const fallbackRes = await POST(llmBase, `/dsh-room/rooms/lm/goals/${gFallback.body?.goal?.id}/complete`, {})
check(
  '没有默认模型时回落 provider/model 列表第一项（prov-a / model-a）',
  fallbackRes.status === 200 && fallbackRes.body?.result?.model?.provider === 'prov-a' && fallbackRes.body?.result?.model?.model === 'model-a',
  json(fallbackRes.body?.result?.model),
)
llmHost.setAgentDefaultModel({ currentSelection: () => ({ provider: 'sel-prov', model: 'sel-model' }) })
await closeServer(llmServed.server)

// ---------------------------------------------------------------- 会议结果

section('《会议结果》：v4 收口（HTTP 手动通路保留 / 工具对 AI 禁用 / 已发布不可覆盖）/ 驳回 / 发布分节投递 / 磁盘')

const RESULT_BODY = '## 实现方\nIMPL-SECTION-ONLY\n\n## 另一实现方\nOTHER-SECTION-ONLY\n\n## 全体\nALL-HANDS-NOTE\n'
const draftByOther = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: 'x', body: 'y', by: 'sess-other' })
check(
  'v4 收口：HTTP 手动通路保留（人类/面板可写，by 原样保留）→ 200 且 status=draft',
  draftByOther.status === 200 && draftByOther.body?.result?.by === 'sess-other' && draftByOther.body?.result?.status === 'draft',
  json(draftByOther.body?.result).slice(0, 160),
)
check(
  'draft title 空 → 400',
  (await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: ' ', body: 'y', by: 'sess-impl' })).status === 400,
)
check(
  'draft body 空 → 400',
  (await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: 't', body: '  ', by: 'sess-impl' })).status === 400,
)
const draftOk = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: 'v2 接口对齐结果', body: RESULT_BODY, by: 'sess-impl' })
check(
  'v4 收口：HTTP 手动写草稿 → status draft + 标题按请求覆盖（未发布可反复覆盖）',
  draftOk.status === 200 && draftOk.body?.result?.status === 'draft' && draftOk.body.result.title === 'v2 接口对齐结果',
  json(draftOk.body?.result).slice(0, 200),
)
// v4 收口（task-15 新增 F/G）：HTTP 通路的系统行按 by 区分 —— 只有 by==='记录员' 沿用记录员口径
const draftByHand = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: '手动草稿标题', body: 'MANUAL-BODY', by: '手动' })
// 目标文案在会议目标段被 PATCH 过（GoalView 快照 goal2 可能落后），系统行以宿主当前文案为准
const goal2ServerText = (await GET(base, '/dsh-room/rooms/beta/goals')).body.goals.find((g) => g.id === goal2.id)?.text ?? goal2.text
check(
  'v4：HTTP 手动写草稿（by=手动）→ 200 + draft + 系统行按「人类提交」口径逐字',
  draftByHand.status === 200 &&
    draftByHand.body?.result?.status === 'draft' &&
    draftByHand.body?.result?.by === '手动' &&
    (await GET(base, '/dsh-room/rooms/beta/state?since=0')).body.messages.some(
      (m) => m.kind === 'system' && m.text === `《手动草稿标题》草稿已提交（手动），等待审核（目标：${goal2ServerText}）`,
    ),
  json(draftByHand.body?.result).slice(0, 160),
)
const draftByRecorderName = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: '记录员草稿标题', body: 'RECORDER-BODY', by: '记录员' })
check(
  'v4：HTTP 写草稿（by=记录员）→ 系统行仍是「记录员提交了《…》草稿（目标：…），等待审核」逐字',
  draftByRecorderName.status === 200 &&
    (await GET(base, '/dsh-room/rooms/beta/state?since=0')).body.messages.some(
      (m) => m.kind === 'system' && m.text === `记录员提交了《记录员草稿标题》草稿（目标：${goal2ServerText}），等待审核`,
    ),
  json(draftByRecorderName.body?.result).slice(0, 160),
)
// 复原后面流程要用的草稿（证明未发布时 HTTP 通路可反复覆盖；宿主会对正文做 trim）
const draftRestored = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: 'v2 接口对齐结果', body: RESULT_BODY, by: 'sess-impl' })
check(
  'v4 收口：未发布时 HTTP 通路可反复覆盖草稿（复原回分节正文）',
  draftRestored.status === 200 && draftRestored.body?.result?.body === RESULT_BODY.trim(),
  json(draftRestored.body?.result).slice(0, 160),
)
const resultList = await GET(base, '/dsh-room/rooms/beta/results')
check(
  'GET results 列出草稿 + 内置记录员视图（v4 不再回会话记录员）',
  resultList.status === 200 &&
    resultList.body?.results?.length === 1 &&
    resultList.body.results[0].status === 'draft' &&
    isBuiltinRecorder(resultList.body.recorder),
  json(resultList.body).slice(0, 300),
)
const resultText = await GET(base, '/dsh-room/rooms/beta/result?goalId=' + goal2.id)
check(
  'GET result 返回正文（text/markdown）',
  resultText.status === 200 && resultText.raw.includes('IMPL-SECTION-ONLY') && String(resultText.headers.get('content-type')).includes('markdown'),
  String(resultText.headers.get('content-type')),
)

const rejectNoNote = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/reject', { by: 'user' })
check('reject 缺 note → 400', rejectNoNote.status === 400 && String(rejectNoNote.body?.error ?? '').includes('note'), json(rejectNoNote.body))
const rejected = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/reject', { by: 'user', note: '结论太笼统' })
check(
  'reject → 回到 draft 且正文追加审核意见',
  rejected.status === 200 &&
    rejected.body?.result?.status === 'draft' &&
    rejected.body.result.body.includes('审核意见') &&
    rejected.body.result.body.includes('结论太笼统') &&
    String(rejected.body.result.note ?? '').includes('结论太笼统'),
  json(rejected.body?.result).slice(0, 250),
)

const approved = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/approve', { by: 'user' })
const implText = deliveryText(lastDelivery(host, 'sess-impl'))
const otherText = deliveryText(lastDelivery(host, 'sess-other'))
check(
  'approve → approved + approvedBy + publishedAt',
  approved.status === 200 &&
    approved.body?.result?.status === 'approved' &&
    approved.body.result.approvedBy === 'user' &&
    typeof approved.body.result.publishedAt === 'number',
  json(approved.body?.result).slice(0, 250),
)
check(
  'approve → 把全文分发给成员（delivered 含两位在线成员）',
  has(approved.body?.delivered, 'sess-impl') && has(approved.body?.delivered, 'sess-other'),
  json(approved.body?.delivered),
)
check(
  '发布按 `## <成员显示名>` 分节投递（无包含关系的显示名收到自己那节）',
  otherText.includes('OTHER-SECTION-ONLY') && !otherText.includes('IMPL-SECTION-ONLY'),
  'other=' + otherText.slice(0, 160),
)
check(
  '显示名互为子串（实现方 / 另一实现方）时投错小节',
  implText.includes('IMPL-SECTION-ONLY') && !implText.includes('OTHER-SECTION-ONLY'),
  'impl=' + implText.slice(0, 200),
)
check('「全体」小节所有人都收到', implText.includes('ALL-HANDS-NOTE') && otherText.includes('ALL-HANDS-NOTE'))
const resultFile = roomDir('beta', '记录', '结果', goal2.id + '.md')
check(
  '发布后盘上有 results/<gid>.md 且含正文',
  exists(resultFile) && readText(resultFile).includes('IMPL-SECTION-ONLY') && readText(resultFile).includes('已发布'),
  exists(resultFile) ? readText(resultFile).slice(0, 200) : '文件不存在',
)
check('重复 approve → 409「已经发布过」', (await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/approve', { by: 'user' })).status === 409)
check('没有草稿的目标 approve → 409「还没有」', (await POST(base, '/dsh-room/rooms/beta/results/' + betaGoal1.id + '/approve', {})).status === 409)

// v4 收口（task-15 新增 H）：已发布的结果不允许被草稿覆盖
const stateBeforeH = await GET(base, '/dsh-room/rooms/beta/state?since=0')
const resultsBeforeH = json((await GET(base, '/dsh-room/rooms/beta/results')).body?.results ?? null)
const overwriteApproved = await POST(base, '/dsh-room/rooms/beta/results/' + goal2.id + '/draft', { title: '试图覆盖', body: 'NOPE-OVERWRITE', by: '手动' })
const stateAfterH = await GET(base, '/dsh-room/rooms/beta/state?since=0')
const resultsAfterH = json((await GET(base, '/dsh-room/rooms/beta/results')).body?.results ?? null)
check(
  'v4：approve 之后再写草稿 → 409 逐字 + 结果逐字未变 + transcript 无新增系统行',
  overwriteApproved.status === 409 &&
    overwriteApproved.body?.error === '这个《会议结果》已经发布过了，不能再用草稿覆盖' &&
    resultsAfterH === resultsBeforeH &&
    stateAfterH.body.seq === stateBeforeH.body.seq &&
    !stateAfterH.body.messages.some((m) => String(m.text).includes('试图覆盖')),
  json({ status: overwriteApproved.status, error: overwriteApproved.body?.error, seq: [stateBeforeH.body.seq, stateAfterH.body.seq] }),
)

const goalReopened = await POST(base, '/dsh-room/rooms/beta/goals/' + goal2.id + '/reopen', { reason: '还有补充', by: 'user' })
check(
  '目标再议：status 回 active、旧 result 变 superseded',
  goalReopened.status === 200 && goalReopened.body?.goal?.status === 'active' && goalReopened.body.goal.result?.status === 'superseded',
  json(goalReopened.body?.goal).slice(0, 250),
)

const gammaDraft = await POST(base, '/dsh-room/rooms/gamma/results/' + gammaGoal.id + '/draft', { title: '无记录员草稿', body: 'BODY' })
check('v4：无记录员也保留人类手动写草稿的 HTTP 通路（不因越权被挡；AI 工具通路已禁用）', gammaDraft.status === 200, json(gammaDraft.body).slice(0, 150))

// ---------------------------------------------------------------- 散会 / 重开

section('散会与重开：v4 不查记录员（无在线概念）/ 有 active 目标就出草稿 / member 请求 vs user 重开')

const deltaRecorder = await POST(base, '/dsh-room/rooms/delta/recorder', { sessionId: 'sess-cold', label: '离线记录员' })
check(
  'v4：给 delta 指派记录员 → 400 逐字（没有「在线/离线记录员」这回事了）',
  deltaRecorder.status === 400 && deltaRecorder.body?.error === V4_ASSIGN_REJECT,
  JSON.stringify(deltaRecorder.body),
)
const deltaAdjourn = await POST(base, '/dsh-room/rooms/delta/adjourn', {})
check(
  'v4：/adjourn 不再因「记录员不在线」409 → 200 + closed + closedAt；delta 无 active 目标 ⇒ asked:false + 原因',
  deltaAdjourn.status === 200 &&
    deltaAdjourn.body?.room?.status === 'closed' &&
    deltaAdjourn.body.room.closedAt > 0 &&
    deltaAdjourn.body.asked === false &&
    String(deltaAdjourn.body?.reason ?? '').includes('没有进行中的会议目标'),
  json(deltaAdjourn.body).slice(0, 240),
)
const deltaClose = await POST(base, '/dsh-room/rooms/delta/close', {})
check(
  'v4：/close 也不查记录员（没有在线概念）→ 200 且房间保持 closed',
  deltaClose.status === 200 && deltaClose.body?.room?.status === 'closed' && deltaClose.body.room.closedAt > 0,
  json(deltaClose.body?.room).slice(0, 200),
)
check('已 closed 再 close → already:true', (await POST(base, '/dsh-room/rooms/delta/close', {})).body?.already === true)
check(
  '散会写系统行「宣布散会，请记录员整理会议结果」（内置记录员的 label）',
  (await GET(base, '/dsh-room/rooms/delta/state?since=0')).body.messages.some((m) => m.kind === 'system' && String(m.text).includes('宣布散会，请记录员整理会议结果')),
)
const memberReopen = await POST(base, '/dsh-room/rooms/delta/reopen', { by: 'member', sessionId: 'sess-cold', reason: '还有补充' })
check(
  '成员请求重开 → requested:true 且房间仍 closed（只产生 reopenRequest）',
  memberReopen.status === 200 &&
    memberReopen.body?.requested === true &&
    memberReopen.body.room.status === 'closed' &&
    memberReopen.body.room.reopenRequest !== null,
  json(memberReopen.body).slice(0, 250),
)
const userReopen = await POST(base, '/dsh-room/rooms/delta/reopen', { by: 'user' })
check(
  '用户重开 → status open / closedAt 清空 / 请求清空',
  userReopen.body?.reopened === true && userReopen.body.room.status === 'open' && userReopen.body.room.closedAt === null && userReopen.body.room.reopenRequest === null,
  json(userReopen.body?.room).slice(0, 200),
)

const llmBeforeAdjourn = llmCallsOf(host).length
const betaAdjourn = await POST(base, '/dsh-room/rooms/beta/adjourn', {})
const adjournCall = llmCallsOf(host).at(-1)
check(
  'v4：有进行中目标时散会 → 宿主直接调 llm 出草稿（asked:true + stream 调用 +1 + 新草稿）',
  betaAdjourn.status === 200 &&
    betaAdjourn.body?.asked === true &&
    llmCallsOf(host).length === llmBeforeAdjourn + 1 &&
    betaAdjourn.body?.results?.some((r) => r.status === 'draft') &&
    String(adjournCall?.messages?.[0]?.content?.[0]?.text ?? '').includes('【会议室 接口对齐】'),
  json({ asked: betaAdjourn.body?.asked, reason: betaAdjourn.body?.reason, results: betaAdjourn.body?.results?.length }),
)
check('散会后 beta status closed', betaAdjourn.body?.room?.status === 'closed')
check('beta 重开回 open', (await POST(base, '/dsh-room/rooms/beta/reopen', { by: 'user' })).body?.room?.status === 'open')

// ---------------------------------------------------------------- v17① 批准重开必须真的把讨论推起来

section('v17①：批准重开 = 立刻给全体投递「已重开 + 继续讨论」')

const REOPEN_PUSH_MARK = '会议已重开，请立即接着讨论'
const reopenPushTextOf = (id) => deliveryText(deliveriesTo(host, id).filter((d) => deliveryText(d).includes(REOPEN_PUSH_MARK)).at(-1))
const betaPushes = ['sess-impl', 'sess-other'].map((id) => deliveriesTo(host, id).filter((d) => deliveryText(d).includes(REOPEN_PUSH_MARK)).length)
const betaPushText = reopenPushTextOf('sess-other')
check(
  'v17①：用户批准重开刚散会的 beta → 立刻给每位与会者投递全文（含当前目标与反馈口径）',
  betaPushes.every((n) => n === 1) && betaPushText.includes('当前会议目标') && betaPushText.includes('room_goal_report'),
  `pushes=${json(betaPushes)} text=${betaPushText.replace(/\n/g, ' | ').slice(0, 180)}`,
)

// 成员申请 → 用户批准：批准这一步就要把申请理由一起投出去
await POST(base, '/dsh-room/rooms', { id: 'reopen17', title: '重开投递', category: CAT })
await POST(base, '/dsh-room/rooms/reopen17/join', { sessionId: 'sess-spec', label: '规格维护方' })
await POST(base, '/dsh-room/rooms/reopen17/close', {})
const ask17 = await POST(base, '/dsh-room/rooms/reopen17/reopen', { by: 'member', sessionId: 'sess-spec', reason: '还有补充' })
const before17 = deliveriesTo(host, 'sess-spec').length
const approve17 = await POST(base, '/dsh-room/rooms/reopen17/reopen', { by: 'user' })
const pushes17 = deliveriesTo(host, 'sess-spec').slice(before17)
check(
  'v17①：成员申请重开、用户批准 → 批准这一步立刻推起来，并把申请理由一并投给全体',
  ask17.body?.requested === true &&
    approve17.status === 200 &&
    approve17.body?.room?.status === 'open' &&
    approve17.body.room.reopenRequest === null &&
    pushes17.length === 1 &&
    deliveryText(pushes17[0]).includes('重开原因（规格维护方）：还有补充'),
  `pushes=${pushes17.length} text=${deliveryText(pushes17[0]).replace(/\n/g, ' | ').slice(0, 180)}`,
)

// ---------------------------------------------------------------- 思考程度

section('思考程度：房间级 / 成员级 / effective')

const r0 = await GET(base, '/dsh-room/rooms/alpha/reasoning')
check(
  'GET reasoning 默认 inherit / options 四档',
  r0.body?.reasoning === 'inherit' && json(r0.body?.options) === '["inherit","low","medium","high"]' && r0.body.memberLevel === null,
  json(r0.body),
)
check('POST reasoning 非法值 → 400', (await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'extreme' })).status === 400)
const rSet = await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'low' })
check('POST reasoning 房间级 low', rSet.status === 200 && rSet.body?.reasoning === 'low', json(rSet.body))
const rMember = await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'high', sessionId: 'sess-spec' })
check('POST reasoning 成员级覆盖 → effective high', rMember.status === 200 && rMember.body?.effectiveFor === 'sess-spec' && rMember.body.effective === 'high', json(rMember.body))
const rGet = await GET(base, '/dsh-room/rooms/alpha/reasoning?sessionId=sess-spec')
check(
  'GET reasoning?sessionId → 房间级 + 成员级 + effective',
  rGet.body?.reasoning === 'low' && rGet.body.memberLevel === 'high' && rGet.body.effective === 'high',
  json(rGet.body),
)
const rPatchMember = await PATCH(base, '/dsh-room/rooms/alpha', { reasoning: 'medium', sessionId: 'sess-impl' })
check(
  'PATCH /rooms/:id {reasoning,sessionId} 也能设成员级',
  rPatchMember.status === 200 && rPatchMember.body?.patch?.reasoningByMember?.['sess-impl'] === 'medium',
  json(rPatchMember.body?.patch),
)

// ---------------------------------------------------------------- 思考程度钩子

section('思考程度真正生效：agent/pre-step + agent/request 钩子')

const onCalls = (agentId, event) => host.onCalls.filter((c) => c.agentId === agentId && c.event === event)
// v6①：/post 只认 archive|notice；这里投一行提示（v6 起用户正文永不外发）把钩子挂到目标 agent 上
const deliverTo = (to, text) => POST(base, '/dsh-room/rooms/alpha/post', { text, to: [to], mode: 'notice' })
const rpcOfLast = () => host.deliveries.at(-1).message.source.rpcId

await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'low' })
await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'inherit', sessionId: 'sess-spec' })
const dHook1 = await deliverTo('sess-spec', 'HOOK-1')
const rpc1 = rpcOfLast()
const pre1 = onCalls('sess-spec', 'agent/pre-step')
const req1 = onCalls('sess-spec', 'agent/request')
check(
  '投递时在目标 agent 上注册两枚钩子（request 带 {prepend:true}）',
  dHook1.body?.delivered?.includes('sess-spec') && pre1.length === 1 && req1.length === 1 && req1[0].opts?.prepend === true,
  json(req1.map((c) => c.opts)),
)
pre1[0].fn({ turn: 7, messages: [{ source: { rpcId: rpc1 } }] })
// 回归护栏（v4.1）：agent/pre-step 是 waterfall 钩子，必须把 next() 的结果原样返回。
// 旧版写成普通函数、不调用 next() ⇒ waterfall 解析出 undefined ⇒ dsh-agent-loop 的
// `if (decision.kind === 'reject')`（dsh-agent-loop/lib/index.js:921）抛
// 「Cannot read properties of undefined (reading 'kind')」，与会者每一轮都「本轮运行失败」。
const runWaterfall = (handlers, payload, fallback) => {
  const at = (i) => (i >= handlers.length ? fallback() : handlers[i](payload, () => at(i + 1)))
  return at(0)
}
check(
  'agent/pre-step 钩子声明了 next 形参（waterfall 契约）',
  typeof pre1[0].fn === 'function' && pre1[0].fn.length >= 2,
  'arity=' + pre1[0].fn.length,
)
const decisionLoop = await runWaterfall(
  [pre1[0].fn],
  { turn: 7, messages: [{ source: { rpcId: rpc1 } }] },
  async () => ({ kind: 'enter', messages: [{ id: 'ctx' }] }),
)
let kindRead = null
try {
  kindRead = decisionLoop.kind
} catch (error) {
  kindRead = 'ERR:' + (error?.message ?? error)
}
check(
  '模拟 agent-loop preStep：pre-step 决策非 undefined、decision.kind 可读',
  kindRead === 'enter',
  'decision=' + json(decisionLoop) + ' kind=' + kindRead,
)
const decisionReject = await runWaterfall([pre1[0].fn], { turn: 7, messages: [] }, async () => ({ kind: 'reject' }))
check('agent/pre-step 钩子透传下游 reject 决策（不吞掉、不替换）', decisionReject?.kind === 'reject', json(decisionReject))
const decisionNoNext = await pre1[0].fn({ turn: 7, messages: [{ id: 'm1' }] })
check(
  'agent/pre-step 钩子在缺 next 时也返回合法决策（绝不返回 undefined）',
  decisionNoNext?.kind === 'enter' && Array.isArray(decisionNoNext?.messages),
  json(decisionNoNext),
)
const out1 = await req1[0].fn({ turn: 7 }, async () => ({ provider: 'p', model: 'm' }))
check('房间级 low → 本轮第一个请求被加上 reasoningEffort:low', out1?.reasoningEffort === 'low', json(out1))
const out2 = await req1[0].fn({ turn: 7 }, async () => ({ provider: 'p', model: 'm' }))
check('同一 turn 的第二个请求不再被覆盖', out2?.reasoningEffort === undefined, json(out2))

await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'high', sessionId: 'sess-spec' })
await deliverTo('sess-spec', 'HOOK-2')
const rpc2 = rpcOfLast()
const pre2 = onCalls('sess-spec', 'agent/pre-step')
const req2 = onCalls('sess-spec', 'agent/request')
check('同一 agent 只注册一次钩子（WeakMap 缓存）', req2.length === 1, 'request 钩子数=' + req2.length)
pre2[0].fn({ turn: 8, messages: [{ source: { rpcId: rpc2 } }] })
const out3 = await req2[0].fn({ turn: 8 }, async () => ({ provider: 'p', model: 'm' }))
check('成员级 high 覆盖房间 low → reasoningEffort:high', out3?.reasoningEffort === 'high', json(out3))

await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'medium', sessionId: 'sess-spec' })
await deliverTo('sess-spec', 'HOOK-3')
const rpc3 = rpcOfLast()
pre2[0].fn({ turn: 11, messages: [{ source: { rpcId: rpc3 } }] })
const out4 = await req2[0].fn({ turn: 11 }, async () => ({ provider: 'p', model: 'weird' }))
check('模型未声明该等级 → 按模型声明档位映射（medium → 中间档 L2）', out4?.reasoningEffort === 'L2', json(out4))

await deliverTo('sess-spec', 'HOOK-4')
const rpc4 = rpcOfLast()
pre2[0].fn({ turn: 12, messages: [{ source: { rpcId: rpc4 } }] })
const out5 = await req2[0].fn({ turn: 12 }, async () => ({ provider: 'p', model: 'no-effort' }))
check(
  '模型没有任何思考等级 → 不改 config 且 warn 留痕',
  out5?.reasoningEffort === undefined && host.warns.some((w) => w.includes('思考等级')),
  json(out5) + ' warns=' + json(host.warns.slice(-2)),
)

await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'inherit' })
await POST(base, '/dsh-room/rooms/alpha/reasoning', { level: 'inherit', sessionId: 'sess-spec' })
host.addAgent('sess-fresh')
await POST(base, '/dsh-room/rooms/alpha/join', { sessionId: 'sess-fresh', label: '新同学' })
const dFresh = await deliverTo('sess-fresh', 'HOOK-INHERIT')
check(
  'inherit → 不注册钩子、不改 config（投递照常）',
  onCalls('sess-fresh', 'agent/request').length === 0 && has(dFresh.body?.delivered, 'sess-fresh'),
  json(dFresh.body).slice(0, 200),
)

// ---------------------------------------------------------------- v14①：会议文件暂存区

section('v14① 会议文件暂存区：与会者顶层文件 → 房间「附件/」（桌面零残留）')

// 与会者会话的 cwd 是桌面，而 workspace-write 沙箱只许写「会话 cwd + temp」——
// 让 AI 直接写 <房间>/附件 会被沙箱拒（v13 的提示词因此注定失败）。所以插件把「顶层文件名」
// 改写到 os.tmpdir() 暂存区，每轮结束（agent/turn-stopping）再同步进房间「附件/」。
const stageDirOf = (roomId) => path.join(os.tmpdir(), 'dsh-meeting-room', roomId)
const stageAttach = (...seg) => dirOf(CAT, 'stage1', '附件', ...seg)
fs.rmSync(stageDirOf('stage1'), { recursive: true, force: true })
fs.rmSync(dirOf(CAT, 'stage1'), { recursive: true, force: true })
const stageCreate = await POST(base, '/dsh-room/rooms', { id: 'stage1', title: '暂存区', goal: '会议文件不堆桌面', category: CAT })
host.addAgent('sess-stage')
const stageJoin = await POST(base, '/dsh-room/rooms/stage1/join', { sessionId: 'sess-stage', label: '写手' })
check('v14①：暂存区用例房间就绪', stageCreate.status === 200 && stageJoin.status === 200, json(stageCreate.body).slice(0, 160))

const stageCalls = (event) => host.onCalls.filter((c) => c.agentId === 'sess-stage' && c.event === event)
const stageShadows = () => host.agentShadows.filter((s) => s.agentId === 'sess-stage')
const shadowDefOf = (name) => stageShadows().find((s) => s.def.name === name)?.def
const runShadow = async (name, args) => {
  const def = shadowDefOf(name)
  if (!def) throw new Error('影子工具缺失：' + name)
  await def.execute({ ...args }, { agent: host.agents.get('sess-stage') })
  return host.agentToolCalls.at(-1)
}
const stageSay = (text) => POST(base, '/dsh-room/rooms/stage1/post', { text, to: ['sess-stage'], mode: 'notice' })
const stagedReport = path.join(stageDirOf('stage1'), '报告.md')

const dStage1 = await stageSay('STAGE-1')
check(
  'v14①：投递时只在与会者作用域注册 4 个影子工具（根 ctx 干净）',
  has(dStage1.body?.delivered, 'sess-stage') &&
    stageShadows().length === 4 &&
    ['write', 'edit', 'read', 'read_image'].every((n) => shadowDefOf(n)) &&
    !toolOf(host, 'write') &&
    !toolOf(host, 'read') &&
    !toolOf(host, 'read_image'),
  '影子=' + json(stageShadows().map((s) => s.def.name)) + ' 根工具=' + json(host.tools.map((t) => t.name)),
)
check(
  'v14①：挂 agent/inbox/inserted + agent/turn-stopping（各一枚；不占 EffortControl 的 pre-step）',
  stageCalls('agent/inbox/inserted').length === 1 &&
    stageCalls('agent/turn-stopping').length === 1 &&
    stageCalls('agent/pre-step').length === 0,
  'inbox=' + stageCalls('agent/inbox/inserted').length + ' stop=' + stageCalls('agent/turn-stopping').length + ' pre=' + stageCalls('agent/pre-step').length,
)

// 消息进收件箱 = agent.followup 那一刻（假 agent 已复刻真机语义）⇒ 这一刻起「本轮是会议轮」
const wTop = await runShadow('write', { file_path: '报告.md' })
check('v14①：write 顶层相对名 → 改写进暂存区（桌面上的同名旧文件不会被覆盖）', wTop.args.file_path === stagedReport, json(wTop.args))
check('v14①：write .\\报告.md → 同样进暂存区', (await runShadow('write', { file_path: '.\\报告.md' })).args.file_path === stagedReport)
const subRel = path.join('sub', 'x.md')
check('v14①：write 带目录的相对路径原样放行（不打断与会者改项目文件）', (await runShadow('write', { file_path: subRel })).args.file_path === subRel)
const upRel = path.join('..', 'x.md')
check('v14①：write ../x.md 原样放行', (await runShadow('write', { file_path: upRel })).args.file_path === upRel)
const cwdAbs = path.join(host.agentCwd, '报告.md')
check('v14①：write 会话 cwd 根下的绝对路径 → 也收进暂存区', (await runShadow('write', { file_path: cwdAbs })).args.file_path === stagedReport)
const elseAbs = path.join(os.tmpdir(), '别处', '报告.md')
check('v14①：write 别处的绝对路径原样放行', (await runShadow('write', { file_path: elseAbs })).args.file_path === elseAbs)
check('v14①：read 暂存区还没有该文件 → 不劫持（照读桌面上的真文件）', (await runShadow('read', { file_path: '报告.md' })).args.file_path === '报告.md')

// 别人的消息（人类正文）进箱 ⇒ 立刻解除会议作用域：非会议轮绝不动与会者路径
stageCalls('agent/inbox/inserted').at(-1).fn({ message: { id: 'human-turn-1' } })
check(
  'v14①：非会议消息进箱 → 解除会议作用域（后续工具调用不再改写）',
  (await runShadow('write', { file_path: '报告.md' })).args.file_path === '报告.md',
)

// 暂存区里真出现文件后，read/edit 跟着同一条工作副本走
await stageSay('STAGE-2')
fs.mkdirSync(stageDirOf('stage1'), { recursive: true })
fs.writeFileSync(stagedReport, 'STAGED-REPORT\n')
const rHit = await runShadow('read', { file_path: '报告.md' })
const eHit = await runShadow('edit', { file_path: '报告.md', old_string: 'A', new_string: 'B' })
check(
  'v14①：read/edit 命中暂存区 → 改写（读写同一份工作副本）',
  rHit.args.file_path === stagedReport && eHit.args.file_path === stagedReport,
  json(rHit.args) + json(eHit.args),
)

// 轮末同步：暂存区 → 房间「附件/」
const stopStage = stageCalls('agent/turn-stopping').at(-1)
await stopStage.fn({ turn: 41 })
check(
  'v14①：本轮结束 → 文件同步进房间「附件/」（内容一致）',
  fs.existsSync(stageAttach('报告.md')) && fs.readFileSync(stageAttach('报告.md'), 'utf8') === 'STAGED-REPORT\n',
  '存在=' + fs.existsSync(stageAttach('报告.md')),
)
const stageState = await GET(base, '/dsh-room/rooms/stage1/state?since=0')
check(
  'v14①：同步后立刻出现在面板文件列表里（refreshFiles）',
  (stageState.body?.files ?? []).some((f) => f.name === '报告.md'),
  json((stageState.body?.files ?? []).map((f) => f.name)),
)
let stopAgain = 'ok'
try {
  await stopStage.fn({ turn: 42 })
} catch (error) {
  stopAgain = 'ERR:' + (error?.message ?? error)
}
check('v14①：没有活跃会议轮时 turn-stopping 安全空转', stopAgain === 'ok', stopAgain)

// room_say 的 files 只给文件名时也认暂存区（不再多复制出「附录-1.md」）
fs.writeFileSync(path.join(stageDirOf('stage1'), '附录.md'), 'STAGED-APPENDIX\n')
const sayStage = await useTool(host, 'room_say', { roomId: 'stage1', text: '交一份附录', files: ['附录.md'] }, 'sess-stage')
check(
  'v14①：room_say files 给相对名 → 同步暂存区那份，不产生「附录-1.md」',
  fs.existsSync(stageAttach('附录.md')) && !fs.existsSync(stageAttach('附录-1.md')),
  'say=' + String(sayStage).slice(0, 100) + ' files=' + json(fs.readdirSync(stageAttach())),
)

await stageSay('STAGE-3')
check(
  'v14①：同一与会者再次投递不重复注册钩子/影子',
  stageCalls('agent/inbox/inserted').length === 1 && stageShadows().length === 4,
  'inbox=' + stageCalls('agent/inbox/inserted').length + ' 影子=' + stageShadows().length,
)

// 散会 → 暂存区清场（工作副本不留），产物仍在「附件/」
const stageClose = await POST(base, '/dsh-room/rooms/stage1/close', { title: '散会' })
check(
  'v14①：散会 → 暂存区清场、产物仍在房间「附件/」',
  stageClose.status === 200 && !fs.existsSync(stageDirOf('stage1')) && fs.existsSync(stageAttach('报告.md')),
  json(stageClose.body).slice(0, 160),
)

// ---------------------------------------------------------------- v6②：pickEffort 根因护栏

section("v6②：pickEffort 根因（受限代理 + async resolveModelInfo + warnOnce 去重）")

// 图二根因（v6 方案 §1）：真机上插件 ctx 是 Cordis 受限代理，而插件的 inject 不含 'llm'，
// 所以 `ctx.llm` / `ctx?.llm` 直读会抛「cannot get property "llm" without inject」；
// 并且宿主 API resolveModelInfo 是 **async** —— 旧实现既不 inject 又没 await，思考程度于是静默失效。
// 下面把「直读必炸」「必须 await」「任何畸形声明都不许把与会者轮次带崩」全部钉死。
let directLlmThrows = null
try {
  void host.ctx.llm
} catch (error) {
  directLlmThrows = String(error?.message ?? error)
}
check(
  'v6②：假宿主复刻真机受限代理 —— 直读 ctx.llm 抛「cannot get property "llm" without inject」',
  directLlmThrows === RESTRICTED_LLM_ERROR,
  String(directLlmThrows),
)
check(
  "v6②：插件 inject 不含 'llm'（唯一合法通路是 ctx.get('llm')）",
  Array.isArray(pluginInject) &&
    !pluginInject.includes('llm') &&
    pluginInject.includes('tools') &&
    pluginInject.includes('webServer') &&
    pluginInject.includes('agents'),
  json(pluginInject),
)
const directLlmReads = pluginSource.match(/ctx\??\.llm\b/g) ?? []
check(
  'v6②：插件源码 0 处 ctx.llm / ctx?.llm 直读（只有注释里的报错原文提到 llm）',
  directLlmReads.length === 0,
  '命中=' + json(directLlmReads),
)

const llmObject = host.ctx.get('llm')
const defaultResolveModelInfo = llmObject.resolveModelInfo
// 一轮「唤醒 → pre-step → request」：返回 request 钩子的返回值
const hookTurn = async (turn, level, sessionId, provider, model) => {
  await POST(base, '/dsh-room/rooms/alpha/reasoning', { level, sessionId })
  await deliverTo(sessionId, 'HOOK-T' + turn)
  const rpc = rpcOfLast()
  onCalls(sessionId, 'agent/pre-step').at(-1).fn({ turn, messages: [{ source: { rpcId: rpc } }] })
  return onCalls(sessionId, 'agent/request').at(-1).fn({ turn }, async () => ({ provider, model }))
}

// ① 正向：async + 对象形档位 [{ id }] —— 必须 await 出来、按 id 映射
llmObject.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'first' }, { id: 'middle' }, { id: 'last' }] } })
const outAsyncHigh = await hookTurn(31, 'high', 'sess-spec', 'p-async', 'm-async')
check(
  "v6②：resolveModelInfo 是 async → 必须 await；high → 最后一档（reasoningEffort:'last'）",
  outAsyncHigh?.reasoningEffort === 'last',
  json(outAsyncHigh),
)
const outAsyncMedium = await hookTurn(32, 'medium', 'sess-spec', 'p-async', 'm-async')
check('v6②：对象形档位 + 未声明的 medium → 中间档 ids[1]', outAsyncMedium?.reasoningEffort === 'middle', json(outAsyncMedium))
const outAsyncLow = await hookTurn(33, 'low', 'sess-spec', 'p-async', 'm-async')
check('v6②：对象形档位 + low → 第一档 ids[0]', outAsyncLow?.reasoningEffort === 'first', json(outAsyncLow))
llmObject.resolveModelInfo = async () => ({ reasoning: { efforts: ['low', 'mid', 'high'] } })
const outAsyncExact = await hookTurn(34, 'low', 'sess-spec', 'p-async', 'm-async')
check('v6②：字符串形档位且声明里就有该等级 → 原样返回（不写死档位名）', outAsyncExact?.reasoningEffort === 'low', json(outAsyncExact))

// ② 畸形声明：非数组 / 空数组 / 全是无名项 —— 不抛、不写 config、warnOnce 只喊一次
llmObject.resolveModelInfo = async () => ({ reasoning: { efforts: 'low' } })
const malformedBefore = host.warns.filter((w) => w.includes('bogus-efforts')).length
const outMalformed1 = await hookTurn(35, 'high', 'sess-spec', 'p-bogus', 'bogus-efforts')
const outMalformed2 = await hookTurn(36, 'high', 'sess-spec', 'p-bogus', 'bogus-efforts')
const malformedWarns = host.warns.filter((w) => w.includes('bogus-efforts'))
check(
  'v6②：efforts 非数组（字符串 "low"）→ 两轮都不抛、都不写 reasoningEffort、只 warn 一次（warnOnce 去重）',
  outMalformed1?.reasoningEffort === undefined &&
    outMalformed1?.provider === 'p-bogus' &&
    outMalformed2?.reasoningEffort === undefined &&
    malformedWarns.length === malformedBefore + 1 &&
    malformedWarns.at(-1).includes('未声明可用的思考等级') &&
    malformedWarns.at(-1).includes('「high」'),
  json({ out1: outMalformed1, out2: outMalformed2, warns: malformedWarns }),
)
llmObject.resolveModelInfo = async () => ({ reasoning: { efforts: [] } })
const outEmpty = await hookTurn(37, 'high', 'sess-spec', 'p-bogus', 'empty-efforts')
check('v6②：efforts 是空数组 → 不抛、不写 reasoningEffort（并各自记一次 warn）', outEmpty?.reasoningEffort === undefined, json(outEmpty))
llmObject.resolveModelInfo = async () => ({ reasoning: { efforts: [null, {}, ''] } })
const outNameless = await hookTurn(38, 'high', 'sess-spec', 'p-bogus', 'nameless-efforts')
check('v6②：efforts 里全是无名项 → 过滤后为空，不抛不写', outNameless?.reasoningEffort === undefined, json(outNameless))

// ③ resolveModelInfo 直接抛错 → pickEffort 必须吞掉（与会者这一轮照常跑，不能带崩）
llmObject.resolveModelInfo = async () => {
  throw new Error('模型服务不可用')
}
const outThrows = await hookTurn(39, 'high', 'sess-spec', 'p-throw', 'throw-model')
check('v6②：resolveModelInfo 抛错 → 钩子不抛、透传 config 且不写 reasoningEffort', outThrows?.provider === 'p-throw' && outThrows?.reasoningEffort === undefined, json(outThrows))

// ④ 宿主根本没有 llm 服务（ctx.get('llm') → undefined）→ 同样不能炸
host.setLlmMode('no-llm')
const outNoLlm = await hookTurn(40, 'high', 'sess-spec', 'p-none', 'none-model')
host.setLlmMode('normal')
llmObject.resolveModelInfo = defaultResolveModelInfo
check('v6②：ctx.get(\'llm\') 是 undefined → 钩子不抛、不写 reasoningEffort', outNoLlm?.provider === 'p-none' && outNoLlm?.reasoningEffort === undefined, json(outNoLlm))

// ---------------------------------------------------------------- 安全 / 健壮性

section('安全头：Origin / Host / sec-fetch-site')

const badOrigin = await raw(base, '/dsh-room/rooms', { origin: 'http://evil.example' })
check('非 loopback Origin → 403', badOrigin.status === 403, badOrigin.status + ' ' + badOrigin.text.slice(0, 120))
const nullOrigin = await raw(base, '/dsh-room/rooms', { origin: 'null' })
check('Origin: null → 放行', nullOrigin.status === 200, String(nullOrigin.status))
const nullOrigin2 = await raw(base, '/dsh-room/rooms', { origin: 'file://' })
check('Origin: file:// → 放行', nullOrigin2.status === 200, String(nullOrigin2.status))
const loopOrigin = await raw(base, '/dsh-room/rooms', { origin: 'http://127.0.0.1:1234' })
check('loopback Origin → 放行', loopOrigin.status === 200, String(loopOrigin.status))
const evilHost = await raw(base, '/dsh-room/rooms', { host: 'evil.example' })
check('非 loopback Host 头 → 403', evilHost.status === 403, evilHost.status + ' ' + evilHost.text.slice(0, 120))
const crossSite = await raw(base, '/dsh-room/rooms', { 'sec-fetch-site': 'cross-site' })
check('sec-fetch-site: cross-site → 403', crossSite.status === 403, crossSite.status + ' ' + crossSite.text.slice(0, 120))

section('上传 / 下载：穿越 / 重名 / 上限 / 并发 / 中文名')

const outsideSecret = path.join(OUTSIDE, 'secret.txt')
fs.writeFileSync(outsideSecret, 'OUTSIDE-SECRET\n')
const workBefore = fs.readdirSync(WORK).sort().join(',')
const outsideBefore = fs.readdirSync(OUTSIDE).sort().join(',')

const escapeUpload = await POST(base, '/dsh-room/rooms/alpha/upload', { name: '../../escape.txt', base64: b64('ESCAPED') })
check(
  '上传名带 ../../ 被压平到 files/ 内（房间外无写入）',
  escapeUpload.status === 200 &&
    exists(roomDir('alpha', '附件', 'escape.txt')) &&
    !exists(path.join(ROOT, 'escape.txt')) &&
    !exists(path.join(WORK, 'escape.txt')) &&
    !exists(path.join(ROOT, 'alpha', 'escape.txt')),
  json(escapeUpload.body),
)
const dotdotUpload = await POST(base, '/dsh-room/rooms/alpha/upload', { name: '..', base64: b64('x') })
const emptyNameUpload = await POST(base, '/dsh-room/rooms/alpha/upload', { name: '', base64: b64('x') })
check(
  '上传 name 为 .. / 空名 → 按 v1 口径 400',
  dotdotUpload.status === 400 && emptyNameUpload.status === 400,
  '.. → ' + dotdotUpload.status + ' ' + json(dotdotUpload.body) + ' / 空名 → ' + emptyNameUpload.status + ' ' + json(emptyNameUpload.body),
)

const dup1 = await POST(base, '/dsh-room/rooms/alpha/upload', { name: 'dup.txt', base64: b64('FIRST') })
const dup2 = await POST(base, '/dsh-room/rooms/alpha/upload', { name: 'dup.txt', base64: b64('SECOND') })
check(
  '重名上传自动改名且不覆盖',
  dup1.body?.name === 'dup.txt' &&
    dup2.body?.name === 'dup-1.txt' &&
    dup2.body?.renamed === true &&
    readText(roomDir('alpha', '附件', 'dup.txt')) === 'FIRST' &&
    readText(roomDir('alpha', '附件', 'dup-1.txt')) === 'SECOND',
  json([dup1.body, dup2.body]),
)

const tooBig = await POST(base, '/dsh-room/rooms/alpha/upload', {
  name: 'huge.bin',
  base64: Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64'),
})
check('超过 8MiB → 413', tooBig.status === 413, tooBig.status + ' ' + json(tooBig.body))

const raceUploads = await Promise.all(
  Array.from({ length: 8 }, (_, i) => POST(base, '/dsh-room/rooms/alpha/upload', { name: 'race.bin', base64: b64('RACE-' + i) })),
)
const raceNames = raceUploads.map((r) => r.body?.name).filter(Boolean)
const raceOnDisk = fs.readdirSync(roomDir('alpha', '附件')).filter((n) => n.startsWith('race'))
check(
  '8 个并发同名上传全部落盘且互不覆盖',
  raceUploads.every((r) => r.status === 200) && new Set(raceNames).size === 8 && raceOnDisk.length === 8,
  json(raceNames) + ' / disk=' + json(raceOnDisk),
)

const linesBefore = readText(roomDir('alpha', 'transcript.jsonl')).split('\n').filter(Boolean).length
const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => POST(base, '/dsh-room/rooms/alpha/post', { text: 'BURST-' + i })))
const alphaBurst = await GET(base, '/dsh-room/rooms/alpha/state?since=0')
const burstSeqs = alphaBurst.body.messages.map((m) => m.seq)
const linesAfter = readText(roomDir('alpha', 'transcript.jsonl')).split('\n').filter(Boolean).length
const ss = new Set()
const dupSeqs = []
for (const s of burstSeqs) (ss.has(s) ? dupSeqs.push(s) : ss.add(s))
check(
  '20 条并发发言序号无重复、jsonl 行数与 state 一致',
  burst.every((r) => r.status === 200) &&
    new Set(burstSeqs).size === burstSeqs.length &&
    linesAfter === linesBefore + 20 &&
    alphaBurst.body.messages.length === linesAfter &&
    alphaBurst.body.seq === Math.max(...burstSeqs),
  'lines=' + linesBefore + '→' + linesAfter + ' msgs=' + alphaBurst.body.messages.length + ' seq=' + alphaBurst.body.seq + ' 唯一序号=' + new Set(burstSeqs).size + '/' + burstSeqs.length + ' 重复序号=' + [...new Set(dupSeqs)].slice(0, 8).join(','),
)

const mirrorLines = readText(roomDir('alpha', 'transcript.md')).split('\n').filter((l) => l.startsWith('- #')).length
check(
  'transcript.md 镜像与 jsonl 逐条对齐（每条记录一行）',
  mirrorLines === linesAfter,
  '镜像行数=' + mirrorLines + ' jsonl=' + linesAfter,
)

const cnUpload = await POST(base, '/dsh-room/rooms/alpha/upload', { name: '中文 报告.md', base64: b64('中文内容 OK') })
const cnRaw = await GET(base, '/dsh-room/rooms/alpha/raw?name=' + encodeURIComponent('中文 报告.md'))
const cnDisposition = String(cnRaw.headers.get('content-disposition') ?? '')
check(
  '中文名文件下载 200（content-disposition 含 ASCII 兜底与 filename*=UTF-8）',
  cnUpload.status === 200 && cnRaw.status === 200 && cnRaw.raw.includes('中文内容 OK') && cnDisposition.includes("filename*=UTF-8''") && /filename="[\x20-\x7e]*"/.test(cnDisposition),
  cnRaw.status + ' ' + cnDisposition,
)

const rawTraverse = await GET(base, '/dsh-room/rooms/alpha/raw?name=' + encodeURIComponent('../../index.js'))
check('raw 路径穿越被挡（不是 200，且没有实现源码）', rawTraverse.status !== 200 && !rawTraverse.raw.includes('export const inject'), rawTraverse.status)
const rawTranscript = await GET(base, '/dsh-room/rooms/alpha/raw?name=transcript.jsonl')
check('raw 读不到房间内部文件（files/ 之外）', rawTranscript.status === 400 || rawTranscript.status === 404, rawTranscript.status)
const rawNoName = await GET(base, '/dsh-room/rooms/alpha/raw')
check('raw 缺 name → 400', rawNoName.status === 400, json(rawNoName.body))

check('插件没有往房间 root 之外写文件（WORK/OUTSIDE 目录清单不变）', fs.readdirSync(WORK).sort().join(',') === workBefore && fs.readdirSync(OUTSIDE).sort().join(',') === outsideBefore)

// ---------------------------------------------------------------- 只读交接

section('只读交接：room_say(files) 只复制、room_open 读不到房间外')

const sayFilesBefore = host.deliveries.length
const sayFiles = await useTool(host, 'room_say', { roomId: 'alpha', text: '带外部文件交接', files: [outsideSecret] }, 'sess-impl')
check(
  'room_say files 把副本写进房间 files/（原件不动）',
  String(sayFiles).includes('#') &&
    exists(roomDir('alpha', '附件', 'secret.txt')) &&
    fs.existsSync(outsideSecret) &&
    readText(outsideSecret) === 'OUTSIDE-SECRET\n',
  String(sayFiles).slice(0, 160),
)
// v8 A 项：这条 room_say 不传 mode/to ⇒ 现在是「缺省自动接力」路径，必须真的投递一行 ping，
// 且通知里不含发言正文、也不通知发言者本人（原有文件断言上一条保留不动）。
const sayFilesRelay = host.deliveries.slice(sayFilesBefore)
check(
  'v8：既有缺省路径（sayFiles 不传 mode/to）确实走了自动接力 —— 除发言者外收到 ping 文案、正文不外发、本人不在收件人里',
  sayFilesRelay.length >= 1 &&
    sayFilesRelay.every((d) => deliveryText(d).includes('有新发言')) &&
    sayFilesRelay.every((d) => !deliveryText(d).includes('带外部文件交接')) &&
    !sayFilesRelay.some((d) => d.to === 'sess-impl') &&
    String(sayFiles).includes('自动接力提醒'),
  json(sayFilesRelay.map((d) => [d.to, deliveryText(d).slice(0, 60)])) + ' / ' + String(sayFiles).slice(0, 120),
)
const outsideOnly = path.join(OUTSIDE, 'outside-only.txt')
fs.writeFileSync(outsideOnly, 'OUTSIDE-ONLY-SECRET\n')
const openOutside = await useTool(host, 'room_open', { roomId: 'alpha', name: '../../outside/outside-only.txt' }, 'sess-impl')
check('room_open 读不到房间目录以外的文件', !String(openOutside).includes('OUTSIDE-ONLY-SECRET'), String(openOutside).slice(0, 160))
const rawOutside = await GET(base, '/dsh-room/rooms/alpha/raw?name=' + encodeURIComponent('../../outside/outside-only.txt'))
check('raw 也读不到房间目录以外的文件', rawOutside.status !== 200 && !rawOutside.raw.includes('OUTSIDE-ONLY-SECRET'), rawOutside.status + ' ' + rawOutside.raw.slice(0, 80))
const openMissing = await useTool(host, 'room_open', { roomId: 'alpha', name: 'nowhere.txt' }, 'sess-impl')
check('room_open 不存在 → 「文件不存在：」', String(openMissing).includes('文件不存在'), String(openMissing).slice(0, 160))

// ---------------------------------------------------------------- Agent 工具

section('13 个 Agent 工具：返回字符串 + 行为')

check(
  '所有工具的 output.schema 都是 string（返回字符串契约）',
  host.tools.every((t) => t.output?.schema?.type === 'string'),
  json(host.tools.map((t) => [t.name, t.output?.schema?.type])),
)

const listText = await useTool(host, 'room_list', {}, 'sess-spec')
check('room_list 列出全部会议室与摘要', typeof listText === 'string' && listText.includes('会议室') && listText.includes('alpha') && listText.includes('beta'), String(listText).slice(0, 200))
check(
  'room_list 每行带「目录 <分类目录>」（v3 目录模型可见）',
  String(listText).includes('目录 ') && String(listText).includes(CAT),
  String(listText).slice(0, 240),
)

// v3 新增工具 room_archive：缺省归档、archived:false 取消归档，且 room_list 会标出「已归档」
const archiveTool = await useTool(host, 'room_archive', { roomId: 'gamma' }, 'sess-spec')
check(
  'room_archive 缺省 → 归档（含「已归档」与目录）',
  String(archiveTool).includes('已归档') && String(archiveTool).includes('目录') && (await GET(base, '/dsh-room/rooms')).body.rooms.find((r) => r.id === 'gamma')?.archived === true,
  String(archiveTool).slice(0, 200),
)
const listArchived = await useTool(host, 'room_list', {}, 'sess-spec')
check('room_list 标出已归档房间', String(listArchived).includes('已归档'), String(listArchived).slice(0, 240))
const unarchiveTool = await useTool(host, 'room_archive', { roomId: 'gamma', archived: false }, 'sess-spec')
check(
  'room_archive archived:false → 取消归档',
  String(unarchiveTool).includes('已取消归档') && (await GET(base, '/dsh-room/rooms')).body.rooms.find((r) => r.id === 'gamma')?.archived === false,
  String(unarchiveTool).slice(0, 200),
)

const joinNoSession = await useTool(host, 'room_join', {}, undefined)
check('room_join 无会话 id → 明确失败文案', String(joinNoSession).includes('无法确定你的会话 id'), String(joinNoSession))
const joinEcho = await useTool(host, 'room_join', { roomId: 'echo', label: '实现方' }, 'sess-impl')
check('room_join 成功 → 已加入 + 当前目标', String(joinEcho).includes('已加入会议室'), String(joinEcho).slice(0, 160))
const joinEchoAgain = await useTool(host, 'room_join', { roomId: 'echo' }, 'sess-impl')
check('room_join 重复 → 已经在会议室里', String(joinEchoAgain).includes('已经在会议室'), String(joinEchoAgain).slice(0, 160))
const leaveEcho = await useTool(host, 'room_leave', { roomId: 'echo' }, 'sess-impl')
check('room_leave 成功', String(leaveEcho).includes('已退出会议室'), String(leaveEcho).slice(0, 160))
const leaveEchoAgain = await useTool(host, 'room_leave', { roomId: 'echo' }, 'sess-impl')
check('room_leave 不在册 → 无需退出', String(leaveEchoAgain).includes('无需退出'), String(leaveEchoAgain).slice(0, 160))
const noSessionLeave = await useTool(host, 'room_leave', {}, undefined)
check('room_leave 无会话 id → 明确失败文案', String(noSessionLeave).includes('无法确定你的会话 id'), String(noSessionLeave))

const sayEmpty = await useTool(host, 'room_say', { roomId: 'alpha', text: '  ' }, 'sess-impl')
check('room_say 空文本 → 拒绝', String(sayEmpty).includes('发言内容不能为空'), String(sayEmpty))
const sayArchive = await useTool(host, 'room_say', { roomId: 'alpha', text: 'TOOL-ARCHIVE', mode: 'archive' }, 'sess-impl')
check('room_say mode:archive → 只归档不打扰', /^#\d+/.test(String(sayArchive)) && String(sayArchive).includes('未打扰任何人'), String(sayArchive).slice(0, 160))
const deliveriesBeforeToolSay = host.deliveries.length
const sayFull = await useTool(host, 'room_say', { roomId: 'alpha', text: 'TOOL-FULL-BODY', to: ['sess-spec'], mode: 'full' }, 'sess-impl')
check(
  'room_say mode:full → 投递给 to 里的在线成员（带房间前缀）',
  /^#\d+/.test(String(sayFull)) &&
    String(sayFull).includes('已通知') &&
    host.deliveries.length === deliveriesBeforeToolSay + 1 &&
    deliveryText(host.deliveries.at(-1)).includes('TOOL-FULL-BODY'),
  String(sayFull).slice(0, 160),
)
const sayMissingFile = await useTool(host, 'room_say', { roomId: 'alpha', text: 'TOOL-MISSING', files: [path.join(WORK, 'nope.txt')] }, 'sess-impl')
check('room_say 不存在的文件 → 未登记文件提示', String(sayMissingFile).includes('未登记文件'), String(sayMissingFile).slice(0, 160))

// ---------------------------------------------------------------- v8：room_say 缺省自动接力

section('v8：room_say 缺省自动接力（无跳数上限 / 排除本人 / 关闭 / 归零 / 正文不外发 / 不污染 room.json）')

const V8_SENTINEL = '秘密正文-V8'
/**
 * v8 专用宿主：房间 r 的三名成员全是真 agent（在线），cap 由参数决定；每个宿主独立 root/category，
 * 自动接力状态（room.autoHop）互不串味。
 */
async function makeV8Host(label, cap) {
  const root = path.join(WORK, `v8-${label}-root`)
  // 分类目录必须是状态根之外的兄弟目录（插件拒绝把会议室目录放进状态根）
  const category = path.join(WORK, `v8-${label}-cat`, '会议')
  const members = ['v8-a', 'v8-b', 'v8-c']
  const h = createHost({
    root,
    category,
    roomId: 'main',
    agents: members,
    ...(cap === undefined ? {} : { autoContinueHops: cap }),
  })
  const served = await serveReady(h, `v8 ${label}`)
  const base = served.base
  const roomRes = await POST(base, '/dsh-room/rooms', { id: 'r', title: `v8-${label}`, goal: '验证自动接力' })
  const joinRes = []
  for (const id of members) joinRes.push(await POST(base, '/dsh-room/rooms/r/join', { sessionId: id, label: id }))
  return { host: h, base, served, members, root, category, roomRes, joinRes }
}
const v8SayBy = (state, sessionId, args) => useTool(state.host, 'room_say', { roomId: 'r', ...args }, sessionId)
const v8State = async (state, roomId = 'r') => (await GET(state.base, `/dsh-room/rooms/${roomId}/state?since=0`)).body
const v8CapRows = (state) => (state.messages ?? []).filter((m) => m.kind === 'system' && String(m.text ?? '').includes('自动接力已达上限'))
/**
 * v15②：模拟「成员收到 ping 后跑完一轮、把队列领走」。
 * 真机 DSH 每个轮次只领 1 条 next-turn；v8 的跳数断言按「每跳 2 条新投递」计数，
 * 所以每跳之间要先让收件人把上一跳的提示领走（去重语义另有 v15② 专属用例单测）。
 */
const v8ClaimAll = (state) => {
  for (const [, agent] of state.host.agents) agent.inbox.claim()
}

const v8 = await makeV8Host('default')
const v8Members0 = (await v8State(v8)).members ?? []
check(
  'v8 宿主就绪（房间 r 的 3 名成员全部在线）',
  v8.served.ready.ok === true && v8Members0.length === 3 && v8Members0.every((m) => m.live === true),
  'members=' + json(v8Members0.map((m) => [m.sessionId, m.live])) + ' / create=' + v8.roomRes.status + ' ' + json(v8.roomRes.body).slice(0, 160) + ' / join=' + json(v8.joinRes.map((r) => r.status)),
)

// A + B1 + B7：缺省 room_say = 归档 + 自动接力（除本人外全体、notice ping 文案、正文不外发但确实进记录）
const v8Before1 = v8.host.deliveries.length
const v8Say1 = String(await v8SayBy(v8, 'v8-a', { text: `${V8_SENTINEL}：先说说我的看法` }))
const v8Relay1 = v8.host.deliveries.slice(v8Before1)
const v8Seq1 = Number((v8Say1.match(/^#(\d+)/) ?? [])[1] ?? 0)
check(
  'v8：缺省 room_say（不传 mode/to）⇒ 归档 + 自动接力，回包逐字「已写入会议记录，并自动接力提醒 2 人（第 1 跳）。」、收件人恰为除本人外成员',
  v8Seq1 > 0 &&
    v8Say1.includes(`#${v8Seq1} 已写入会议记录，并自动接力提醒 2 人（第 1 跳）。`) &&
    v8Relay1.map((d) => d.to).sort().join(',') === 'v8-b,v8-c' &&
    !v8Relay1.some((d) => d.to === 'v8-a'),
  v8Say1 + ' / to=' + json(v8Relay1.map((d) => d.to)),
)
const v8Read1 = String(await useTool(v8.host, 'room_read', { roomId: 'r', since: 0, limit: 50 }, 'v8-b'))
const v8PingLine = `【会议室 v8-default】v8-a 有新发言（#${v8Seq1}）。用 room_read 看完整记录；有新意见或要回应就 room_say，没有新内容就不必发言。`
check(
  'v8：接力用的是 ping 文案（逐字含最新 seq 与 room_read/room_say 指引），正文哨兵在投递里 0 命中、在记录里能读到',
  v8Relay1.length === 2 &&
    v8Relay1.every((d) => String(deliveryText(d)).startsWith(`${v8PingLine}\n`)) &&
    // v16⑥ 改文案：ping 之后追加的仍是「文件写在工作区顶层 → 插件轮末收进附件」，逐字钉住，
    // 防止有人再往唤醒文案里塞别的东西
    v8Relay1.every((d) => String(deliveryText(d)).includes('不要写到工作区以外的地方')) &&
    v8Relay1.every((d) => !deliveryText(d).includes(V8_SENTINEL)) &&
    v8Read1.includes(V8_SENTINEL),
  json(v8Relay1.map((d) => deliveryText(d).slice(0, 90))) + ' / 记录含哨兵=' + v8Read1.includes(V8_SENTINEL),
)

// B2 + A：显式 mode:'archive' 仍只归档（零投递），且不消耗自动接力额度
const v8Before2 = v8.host.deliveries.length
const v8Archive = String(await v8SayBy(v8, 'v8-b', { text: 'V8-ARCHIVE-ONLY', mode: 'archive' }))
check(
  "v8：显式 mode:'archive' ⇒ 只归档、零投递（保留 v6 语义），且不消耗接力额度",
  /^#\d+/.test(v8Archive) && v8Archive.includes('已写入会议记录（未打扰任何人）。') &&
    v8.host.deliveries.length === v8Before2,
  v8Archive,
)
// v15②：v8-b 收到第 1 跳的提示并跑完一轮（把队列领走）后再发下一条
v8ClaimAll(v8)
const v8Say1b = String(await v8SayBy(v8, 'v8-b', { text: 'V8-SECOND-HOP' }))
check(
  'v8：显式 archive 没有偷偷 +1 跳（紧接着的缺省发言仍是第 2 跳）',
  v8Say1b.includes('并自动接力提醒 2 人（第 2 跳）') && v8.host.deliveries.length === v8Before2 + 2,
  v8Say1b,
)

// v8 修复项②：只要**显式**传了非空 mode（哪怕不在白名单里，如大写 ARCHIVE），就绝不走缺省接力
const v8BeforeUpper = v8.host.deliveries.length
const v8Upper = String(await v8SayBy(v8, 'v8-c', { text: 'V8-UPPER-ARCHIVE', mode: 'ARCHIVE' }))
check(
  'v8：显式传白名单外 mode（大写 ARCHIVE）⇒ 不当作「没传 mode」，零投递、不接力',
  /^#\d+/.test(v8Upper) && v8Upper.includes('已写入会议记录（未打扰任何人）。') &&
    v8.host.deliveries.length === v8BeforeUpper,
  v8Upper,
)

// B8：deliver() 排除发言者本人（to:[自己] ⇒ 一个都不投；正文仍进记录）
const v8SelfBefore = deliveriesTo(v8.host, 'v8-a').length
const v8Self = String(await v8SayBy(v8, 'v8-a', { text: 'V8-TO-SELF', to: ['v8-a'], mode: 'notice' }))
const v8ReadSelf = String(await useTool(v8.host, 'room_read', { roomId: 'r', since: 0, limit: 50 }, 'v8-a'))
check(
  'v8：deliver() 排除发言者本人 —— room_say to:[自己] ⇒ delivered 为空、不投给自己、正文仍进记录',
  /^#\d+/.test(v8Self) && v8Self.includes('已写入会议记录（未打扰任何人）。') &&
    deliveriesTo(v8.host, 'v8-a').length === v8SelfBefore &&
    v8ReadSelf.includes('V8-TO-SELF'),
  v8Self + ' / 投给自己=' + deliveriesTo(v8.host, 'v8-a').length,
)

// B3：无跳数上限（给 cap=2 也不再截断）—— 连续多跳都照投，且绝不追加任何上限系统行
const v8cap = await makeV8Host('cap2', 2)
const capSay1 = String(await v8SayBy(v8cap, 'v8-a', { text: 'CAP-1' }))
// v15②：同上 —— 第 1 跳的两位收件人先各自跑完一轮，再发第 2 跳
v8ClaimAll(v8cap)
const capSay2 = String(await v8SayBy(v8cap, 'v8-b', { text: 'CAP-2' }))
const capAll2 = v8cap.host.deliveries.length
check(
  'v8：不再有跳数上限 —— autoContinueHops=2 时第 1、2 跳照常接力（第 1、2 跳各投 2 人）',
  capSay1.includes('已写入会议记录，并自动接力提醒 2 人（第 1 跳）。') &&
    capSay2.includes('已写入会议记录，并自动接力提醒 2 人（第 2 跳）。') &&
    capAll2 === 4,
  capSay1 + ' || ' + capSay2 + ' / deliveries=' + capAll2,
)
// v15②：第 2 跳的收件人也各自跑完一轮，再发第 3 跳（越过旧上限那一条）
v8ClaimAll(v8cap)
const capSay3 = String(await v8SayBy(v8cap, 'v8-c', { text: 'CAP-3' }))
check(
  'v8：越过旧上限（第 3 跳）仍继续接力，不再出现「自动接力已达上限」回包',
  capSay3.includes('已写入会议记录，并自动接力提醒 2 人（第 3 跳）。') &&
    !capSay3.includes('自动接力已达上限') &&
    v8cap.host.deliveries.length === capAll2 + 2,
  capSay3 + ' / deliveries=' + v8cap.host.deliveries.length,
)
const capSay4 = String(await v8SayBy(v8cap, 'v8-a', { text: 'CAP-4' }))
const capRows4 = v8CapRows(await v8State(v8cap))
check(
  'v8：连续第 4 跳照常接力，且全程没有追加任何「已达上限」系统行',
  capSay4.includes('（第 4 跳）') && !capSay4.includes('自动接力已达上限') && capRows4.length === 0,
  capSay4 + ' / 上限系统行数=' + capRows4.length,
)

// B6：人类 POST /post 之后计数归零；此后仍可继续无限接力
const capHuman = await POST(v8cap.base, '/dsh-room/rooms/r/post', { text: 'CAP-HUMAN' })
const capSay5 = String(await v8SayBy(v8cap, 'v8-a', { text: 'CAP-5' }))
check(
  'v8：人类 POST /post ⇒ 自动接力计数归零（随后一次缺省 room_say 又是第 1 跳）',
  capHuman.status === 200 && capHuman.body?.mode === 'archive' &&
    capSay5.includes('已写入会议记录，并自动接力提醒 2 人（第 1 跳）。'),
  'post=' + json(capHuman.body) + ' / say=' + capSay5,
)
const capSay6 = String(await v8SayBy(v8cap, 'v8-b', { text: 'CAP-6' }))
const capSay7 = String(await v8SayBy(v8cap, 'v8-c', { text: 'CAP-7' }))
const capRows7 = v8CapRows(await v8State(v8cap))
check(
  'v8：新周期内同样无上限 —— 第 2、3 跳照常接力，上限系统行数仍为 0',
  capSay6.includes('（第 2 跳）') && capSay7.includes('（第 3 跳）') && capRows7.length === 0,
  capSay7 + ' / 上限系统行数=' + capRows7.length,
)

// B4：autoContinueHops=0 ⇒ 缺省 room_say 也不接力（关闭生效）
const v8off = await makeV8Host('off', 0)
const offBefore = v8off.host.deliveries.length
const offSay = String(await v8SayBy(v8off, 'v8-a', { text: 'OFF-BODY' }))
check(
  'v8：autoContinueHops=0 ⇒ 缺省 room_say 只归档、零投递（关闭生效）',
  /^#\d+/.test(offSay) && offSay.includes('已写入会议记录（未打扰任何人）。') &&
    v8off.host.deliveries.length === offBefore,
  offSay,
)

// v8 修复项① + 无上限：非法值回落为「开」；连投 8 跳全部照常接力、无任何上限系统行
const v8neg = await makeV8Host('neg', -5)
const negSay1 = String(await v8SayBy(v8neg, 'v8-a', { text: 'NEG-1' }))
check(
  'v8：非法值（-5）回落为「开」—— 缺省发言照常接力，回包不再带分母（第 1 跳）',
  negSay1.includes('已写入会议记录，并自动接力提醒 2 人（第 1 跳）。'),
  negSay1,
)
const negHops = [negSay1]
for (let hop = 2; hop <= 7; hop += 1) {
  negHops.push(String(await v8SayBy(v8neg, 'v8-a', { text: `NEG-${hop}` })))
}
const negSay8 = String(await v8SayBy(v8neg, 'v8-a', { text: 'NEG-8' }))
const negRows = v8CapRows(await v8State(v8neg))
check(
  'v8：无跳数上限 —— 连投 8 跳全部照常接力（第 1..8 跳），且全程零上限系统行',
  negHops.every((text, index) => text.includes(`（第 ${index + 1} 跳）`)) &&
    negSay8.includes('（第 8 跳）') &&
    negRows.length === 0,
  negSay8 + ' / 上限系统行=' + json(negRows.map((m) => m.text)),
)
const v8null = await makeV8Host('nullcap', null)
const v8str = await makeV8Host('strcap', 'abc')
const nullSay = String(await v8SayBy(v8null, 'v8-a', { text: 'NULL-CAP' }))
const strSay = String(await v8SayBy(v8str, 'v8-a', { text: 'STR-CAP' }))
check(
  'v8：显式 null / 非数字（"abc"）都不得静默关闭自动接力 —— 两者都按「开」处理（第 1 跳）',
  nullSay.includes('（第 1 跳）') && strSay.includes('（第 1 跳）'),
  'null=' + nullSay + ' || abc=' + strSay,
)

// B5：房间 status=closed ⇒ 缺省 room_say 只记下正文、不再接力
await POST(v8.base, '/dsh-room/rooms', { id: 'rc', title: 'v8-closed', goal: '散会后不接力' })
for (const id of v8.members) await POST(v8.base, '/dsh-room/rooms/rc/join', { sessionId: id, label: id })
const rcClose = await POST(v8.base, '/dsh-room/rooms/rc/close', { title: '散会', body: '（测试散会）' })
const rcBefore = v8.host.deliveries.length
const rcSay = String(await useTool(v8.host, 'room_say', { roomId: 'rc', text: 'CLOSED-BODY' }, 'v8-a'))
const rcState = await GET(v8.base, '/dsh-room/rooms/rc/state')
check(
  'v8：房间 status=closed ⇒ 缺省 room_say 不再接力（正文仍进记录、零投递，并明确告诉它去请求重开）',
  rcClose.status === 200 && /^已写进会议记录 #\d+/.test(rcSay) &&
    rcSay.includes('会议已经散会') && rcSay.includes('room_request_reopen') &&
    v8.host.deliveries.length === rcBefore &&
    (rcState.body?.messages ?? []).some((m) => m.text === 'CLOSED-BODY'),
  'close=' + rcClose.status + ' / ' + rcSay + ' / deliveries=' + (v8.host.deliveries.length - rcBefore),
)

// 落盘护栏：自动接力状态只在内存，不写 room.json
const v8RoomJsonPath = path.join(v8.category, 'r', 'room.json')
const v8RoomBytesBefore = fs.readFileSync(v8RoomJsonPath)
const v8RoomStatBefore = fs.statSync(v8RoomJsonPath)
await v8SayBy(v8, 'v8-c', { text: 'ROOMJSON-PROBE' })
const v8RoomBytesAfter = fs.readFileSync(v8RoomJsonPath)
const v8RoomJsonText = json(readJsonFile(v8RoomJsonPath))
check(
  'v8：autoHop / autoCapNoticed 不写 room.json（字节恒等、无这些键、mtime 记录在案）',
  v8RoomBytesBefore.equals(v8RoomBytesAfter) &&
    !v8RoomJsonText.includes('autoHop') && !v8RoomJsonText.includes('autoCapNoticed'),
  `bytes=${v8RoomBytesBefore.length}/${v8RoomBytesAfter.length} mtime=${v8RoomStatBefore.mtimeMs}/${fs.statSync(v8RoomJsonPath).mtimeMs} keys=${v8RoomJsonText.slice(0, 160)}`,
)

// v8 段收尾：关掉本段起的 6 个真 http 服务器（不关会把事件循环占住，脚本跑完不退出、
// 无法以 exit 0 收口；与其它各段一样显式 closeServer）。
for (const v8StateHost of [v8, v8cap, v8off, v8neg, v8null, v8str]) await closeServer(v8StateHost.served.server)

const readText2 = await useTool(host, 'room_read', { roomId: 'alpha', since: 0, limit: 400 }, 'sess-impl')
check(
  'room_read 返回房间头 + 消息（含之前写入的正文）',
  String(readText2).includes('【会议室') && String(readText2).includes('ALPHA-ONLY-MESSAGE') && String(readText2).includes('#'),
  String(readText2).slice(0, 200),
)
const filesText = await useTool(host, 'room_files', { roomId: 'alpha' }, 'sess-impl')
check('room_files 列出文件', String(filesText).includes('alpha-report.md'), String(filesText).slice(0, 200))
const openText = await useTool(host, 'room_open', { roomId: 'alpha', name: 'alpha-report.md' }, 'sess-impl')
check('room_open 返回文件正文', String(openText).includes('# alpha only'), String(openText).slice(0, 120))

const reportText = await useTool(host, 'room_goal_report', { roomId: 'beta', goalId: betaGoal1.id, verdict: '部分达成', summary: '接口已对齐' }, 'sess-impl')
check('room_goal_report 写入会议记录', String(reportText).includes('已写入会议记录'), String(reportText).slice(0, 200))
const reportMissing = await useTool(host, 'room_goal_report', { roomId: 'beta', goalId: 'nope', verdict: 'x', summary: 'y' }, 'sess-impl')
check('room_goal_report 目标不存在 → 明确文案', String(reportMissing).includes('没有找到对应的会议目标'), String(reportMissing))

const resultBeforeWriteManual = json(readJsonFile(roomDir('beta', 'goals.json')).find((g) => g.id === goal2.id)?.result ?? null)
const writeManual1 = await useTool(host, 'room_result_write', { roomId: 'beta', goalId: goal2.id, title: 't', body: 'b' }, 'sess-other')
check(
  'v4 收口：工具 room_result_write 对 AI 与会者禁用 → 返回禁用提示，不产生/不修改任何草稿',
  isToolDisabledHint(writeManual1) && json(readJsonFile(roomDir('beta', 'goals.json')).find((g) => g.id === goal2.id)?.result ?? null) === resultBeforeWriteManual,
  String(writeManual1),
)
const writeEmpty = await useTool(host, 'room_result_write', { roomId: 'beta', goalId: betaGoal1.id, title: '', body: 'x' }, 'sess-impl')
check('v4 收口：room_result_write 空 title → 同样只回禁用提示（不区分参数是否为空）', isToolDisabledHint(writeEmpty), String(writeEmpty))
// v4 收口（E）：先经 HTTP（人类通路）写一个草稿，再调工具 —— 草稿 title/body 必须逐字未变
const toolPathHttpDraft = await POST(base, '/dsh-room/rooms/beta/results/' + betaGoal1.id + '/draft', { title: 'HTTP 草稿', body: '## 实现方\nHTTP-DRAFT-BODY', by: '手动' })
const toolPathBefore = json(readJsonFile(roomDir('beta', 'goals.json')).find((g) => g.id === betaGoal1.id)?.result ?? null)
const writeOk = await useTool(host, 'room_result_write', { roomId: 'beta', goalId: betaGoal1.id, title: '工具写的草稿', body: '## 实现方\nTOOL-DRAFT' }, 'sess-impl')
check(
  'v4 收口：工具禁用后不改写人类草稿（HTTP 草稿 title/body 逐字未变 + 返回禁用提示）',
  toolPathHttpDraft.status === 200 &&
    isToolDisabledHint(writeOk) &&
    json(readJsonFile(roomDir('beta', 'goals.json')).find((g) => g.id === betaGoal1.id)?.result ?? null) === toolPathBefore &&
    readText(roomDir('beta', '记录', '结果', betaGoal1.id + '.md')).includes('HTTP-DRAFT-BODY') &&
    !readText(roomDir('beta', '记录', '结果', betaGoal1.id + '.md')).includes('TOOL-DRAFT'),
  String(writeOk).slice(0, 200),
)
const reopenTool = await useTool(host, 'room_request_reopen', { roomId: 'beta', reason: '工具请求重开' }, 'sess-impl')
check('room_request_reopen 记入重开请求', String(reopenTool).includes('重开请求'), String(reopenTool).slice(0, 200))

const finalizeTool1 = await useTool(host, 'room_finalize', { title: '工具决议', body: 'TOOL-RES-BODY' }, 'sess-spec')
check(
  'room_finalize 写默认房间 决议.md 并投递给成员',
  String(finalizeTool1).includes('决议已写入') && String(finalizeTool1).includes('投递给') && readText(roomDir('main', '决议.md')).includes('TOOL-RES-BODY'),
  String(finalizeTool1).slice(0, 200),
)
const finalizeToolBlocked = await useTool(host, 'room_finalize', { title: 'x', body: 'y' }, 'sess-spec')
check('room_finalize 已交付且未 force → 明确拒绝文案（不抛错）', String(finalizeToolBlocked).includes('已经交付过'), String(finalizeToolBlocked).slice(0, 200))

const notFoundTool = await useTool(host, 'room_read', { roomId: 'no-such-room' }, 'sess-spec')
check(
  '工具 404 错误带「可以先调用 room_list」提示（读 error.statusCode，不是 error.status）',
  String(notFoundTool).includes('会议室不存在') && String(notFoundTool).includes('room_list'),
  String(notFoundTool).slice(0, 200),
)
const notFoundTool2 = await useTool(host, 'room_goal_report', { roomId: 'nope-room', verdict: '达成', summary: 'x' }, 'sess-spec')
check(
  '第二条 404 工具同样带提示（防止只修一处）',
  String(notFoundTool2).includes('room_list'),
  String(notFoundTool2).slice(0, 200),
)

// ---------------------------------------------------------------- v15② 提醒合并
// 真机症状（用户截图）：与会者会话里堆着「3 条排队消息」，而 DSH 每个轮次只领 1 条 next-turn
// ⇒ 3 条提示 = 白跑 3 个轮次（而且三条说的都是同一件事）。v15② 语义：**同一个人「还没被领走」的
// 自动接力提示最多留 1 条** —— 新提示原地替换旧的（文案刷新到最新 seq）；一旦被领走、或对方根本
// 拿不到 agent.inbox，就照旧每次新投（退化路径绝不静默吞提醒）。

const v15p = await makeV8Host('coalesce')
const v15Queue = (state, id) => state.host.agents.get(id)?.inbox?.nextTurn ?? []
const v15Pings = (state, id) => v15Queue(state, id).map((m) => deliveryText({ message: m }))

const v15Before1 = v15p.host.deliveries.length
const v15Say1 = String(await v8SayBy(v15p, 'v8-a', { text: 'V15-COALESCE-1' }))
const v15Seq1 = Number((v15Say1.match(/^#(\d+)/) ?? [])[1] ?? 0)
check(
  'v15②：第 1 跳 —— 两名收件人各得 1 条提示（队列深度 1，不多不少），文案指向最新 seq',
  v15p.host.deliveries.length === v15Before1 + 2 &&
    v15Queue(v15p, 'v8-b').length === 1 &&
    v15Queue(v15p, 'v8-c').length === 1 &&
    v15Pings(v15p, 'v8-b').every((t) => t.includes(`#${v15Seq1}`)),
  json({ b: v15Queue(v15p, 'v8-b').length, c: v15Queue(v15p, 'v8-c').length, say: v15Say1 }),
)

// v8-c 上一条还没被领走（真机里它正跑一个长轮次），v8-b 又发一条缺省发言：
// v8-c 的队列必须仍是 1 行、旧 message.id 失效、文案刷新到最新 seq；v8-a 那条照旧新投。
const v15StaleId = v15Queue(v15p, 'v8-c')[0].id
const v15Before2 = v15p.host.deliveries.length
const v15Say2 = String(await v8SayBy(v15p, 'v8-b', { text: 'V15-COALESCE-2' }))
const v15Seq2 = Number((v15Say2.match(/^#(\d+)/) ?? [])[1] ?? 0)
const v15CNow = v15Queue(v15p, 'v8-c')
check(
  'v15②：上次提示还没被领走 ⇒ 新提示原地替换它（队列仍 1 行、旧 id 已找不到、文案刷新到最新 seq、只新投另一个人）',
  v15CNow.length === 1 &&
    v15CNow[0].id !== v15StaleId &&
    v15p.host.agents.get('v8-c').inbox.locate(v15StaleId) === undefined &&
    deliveryText({ message: v15CNow[0] }).includes(`#${v15Seq2}`) &&
    v15p.host.deliveries.length === v15Before2 + 1 &&
    v15Queue(v15p, 'v8-a').length === 1,
  json({ c: v15CNow.length, 同一条: v15CNow[0].id === v15StaleId, seq2: v15Seq2, 新投: v15p.host.deliveries.length - v15Before2 }),
)

// 被领走之后（成员真的跑过一轮）⇒ 下一条必须新投，不能因为「曾经合并过」就丢提醒
v8ClaimAll(v15p)
const v15Before3 = v15p.host.deliveries.length
await v8SayBy(v15p, 'v8-a', { text: 'V15-COALESCE-3' })
check(
  'v15②：提示被领走后 ⇒ 下一条重新新投（两名收件人各 1 条，deliveries +2，绝不静默丢）',
  v15p.host.deliveries.length === v15Before3 + 2 &&
    v15Queue(v15p, 'v8-b').length === 1 &&
    v15Queue(v15p, 'v8-c').length === 1,
  json({ add: v15p.host.deliveries.length - v15Before3, b: v15Queue(v15p, 'v8-b').length, c: v15Queue(v15p, 'v8-c').length }),
)

// 拿不到 agent.inbox（原生 agent 没有这个字段）⇒ 退化为每次新投
const v15no = await makeV8Host('no-inbox')
delete v15no.host.agents.get('v8-c').inbox
const v15NoBefore = v15no.host.deliveries.length
await v8SayBy(v15no, 'v8-a', { text: 'V15-NO-INBOX-1' })
const v15NoMid = v15no.host.deliveries.length
await v8SayBy(v15no, 'v8-b', { text: 'V15-NO-INBOX-2' })
check(
  'v15②：收件人没有 agent.inbox ⇒ 不合并、照旧每次新投（退化路径绝不吞提醒）',
  v15NoMid === v15NoBefore + 2 && v15no.host.deliveries.length === v15NoMid + 2,
  json({ 第一条: v15NoMid - v15NoBefore, 第二条: v15no.host.deliveries.length - v15NoMid }),
)

// 只有自动接力 ping 合并：mode:'full' 的正文每次都新投（对方必须逐条看到每一段正文）
const v15full = await makeV8Host('full-mode')
const v15FullBefore = v15full.host.deliveries.length
await v8SayBy(v15full, 'v8-a', { text: 'V15-FULL-1', mode: 'full' })
await v8SayBy(v15full, 'v8-a', { text: 'V15-FULL-2', mode: 'full' })
check(
  'v15②：mode:full 的正文投递不合并 —— 连发两条，收件人队列深度 2（每段正文都要看到）',
  v15full.host.deliveries.length === v15FullBefore + 4 && v15Queue(v15full, 'v8-c').length === 2,
  json({ c: v15Queue(v15full, 'v8-c').length, add: v15full.host.deliveries.length - v15FullBefore }),
)

// ---------------------------------------------------------------- finalize / 重启

section('finalize 门闩 / 重启收养 / 老房间收养')

const finalize1 = await POST(base, '/dsh-room/rooms/echo/finalize', { title: '回声决议', body: '决议正文 BODY-1' })
check(
  'finalize 首次 → 写 决议.md + 落 state',
  finalize1.status === 200 &&
    exists(roomDir('echo', '决议.md')) &&
    readText(roomDir('echo', '决议.md')).includes('BODY-1') &&
    readJsonFile(roomDir('echo', 'resolution-state.json')).delivered === true,
  json(finalize1.body).slice(0, 200),
)
check(
  'finalize 二次 → 409（门闩）',
  (await POST(base, '/dsh-room/rooms/echo/finalize', { title: '再来一次', body: 'BODY-2' })).status === 409,
)
const finalizeForce = await POST(base, '/dsh-room/rooms/echo/finalize', { title: '回声决议 v2', body: 'BODY-2', force: true })
check(
  'finalize force:true → 覆盖重发',
  finalizeForce.status === 200 && readText(roomDir('echo', '决议.md')).includes('BODY-2') && readText(roomDir('echo', '决议.md')).includes('回声决议 v2'),
  json(finalizeForce.body).slice(0, 200),
)
const echoStateRes = await GET(base, '/dsh-room/rooms/echo/state?since=0')
check('state.resolution 反映已交付', echoStateRes.body?.resolution?.delivered === true, json(echoStateRes.body?.resolution))

fs.rmSync(roomDir('echo', 'resolution-state.json'))
const afterStateDelete = await GET(base, '/dsh-room/rooms/echo/state?since=0')
check(
  '删掉 state 文件后 state.resolution 仍按 决议.md 兜底为 delivered:true',
  afterStateDelete.body?.resolution?.delivered === true && afterStateDelete.body.resolution.file.includes('决议.md'),
  json(afterStateDelete.body?.resolution),
)
fs.writeFileSync(roomDir('echo', 'resolution-state.json'), JSON.stringify({ roomId: 'echo', delivered: true, deliveredTo: [], at: Date.now(), resolution: '决议.md', skipped: false }))

const host2 = createHost({ root: ROOT, category: CAT, roomId: 'main', agents: ['sess-spec', 'sess-impl'] })
const served2 = await serve(host2)
await GET(served2.base, '/dsh-room/rooms')
const list2 = await GET(served2.base, '/dsh-room/rooms')
check(
  '同一 root 再 apply（模拟重启）→ 房间全部从磁盘恢复',
  ['main', 'alpha', 'beta', 'gamma', 'delta', 'echo'].every((id) => list2.body?.rooms?.some((r) => r.id === id)),
  json(list2.body?.rooms?.map((r) => r.id)),
)
const alpha2 = await GET(served2.base, '/dsh-room/rooms/alpha/state?since=0')
check(
  '重启后 alpha 的记录/目标/文件从磁盘恢复',
  alpha2.body?.messages?.some((m) => m.text === 'ALPHA-ONLY-MESSAGE') &&
    alpha2.body?.files?.some((f) => f.name === 'alpha-report.md') &&
    alpha2.body?.goals?.length === 1,
  'msgs=' + alpha2.body?.messages?.length + ' files=' + json(alpha2.body?.files?.map((f) => f.name)),
)
const finalizeAfterRestart = await POST(served2.base, '/dsh-room/rooms/echo/finalize', { title: 'x', body: 'y' })
check(
  '重启后决议门闩仍从磁盘恢复 → 二次交付 409',
  finalizeAfterRestart.status === 409,
  finalizeAfterRestart.status + ' ' + json(finalizeAfterRestart.body),
)

const ADOPT_ROOT = path.join(WORK, 'adopt-root')
const ADOPT_CAT = path.join(WORK, 'adopt-cat', '会议')
fs.mkdirSync(path.join(ADOPT_ROOT, 'legacy'), { recursive: true })
// v3 契约：旧布局的判定依据是 <stateRoot>/<roomId>/room.json 存在（index.js:349-367 的 legacy 分支只认 room.json）。
// 真实的 v2 安装里 room.json 一定在房间目录内，所以夹具补上它，才能命中 v3 的搬家路径；
// 本段要断言的仍然只是 v2 原意：登记表（stateRoot/rooms.json）缺失时房间照样被收养。
fs.writeFileSync(
  path.join(ADOPT_ROOT, 'legacy', 'room.json'),
  JSON.stringify({ id: 'legacy', title: '老房间', status: 'open', createdAt: Date.now() }, null, 2) + '\n',
)
fs.writeFileSync(
  path.join(ADOPT_ROOT, 'legacy', 'transcript.jsonl'),
  JSON.stringify({ seq: 1, at: Date.now(), kind: 'chat', author: { kind: 'user', id: 'user', label: '我' }, text: 'LEGACY-MSG' }) + '\n',
)
const adoptHost = createHost({ root: ADOPT_ROOT, category: ADOPT_CAT, roomId: 'main', agents: [] })
const adoptServed = await serve(adoptHost)
await GET(adoptServed.base, '/dsh-room/rooms')
const adoptList = await GET(adoptServed.base, '/dsh-room/rooms')
const adoptState = await GET(adoptServed.base, '/dsh-room/rooms/legacy/state?since=0')
await new Promise((resolve) => setTimeout(resolve, 400)) // rooms.json 写入是 250ms 防抖
check(
  '没有 rooms.json 的老房间被自动收养（status:open）并写下 rooms.json',
  adoptList.body?.rooms?.some((r) => r.id === 'legacy' && r.status === 'open') &&
    adoptState.body?.messages?.some((m) => m.text === 'LEGACY-MSG') &&
    exists(path.join(ADOPT_ROOT, 'rooms.json')),
  json(adoptList.body?.rooms?.map((r) => [r.id, r.status])),
)
check(
  '被收养的老房间按 v3 布局落在 <category>/legacy（旧目录清空）',
  exists(path.join(ADOPT_CAT, 'legacy', 'room.json')) &&
    exists(path.join(ADOPT_CAT, 'legacy', 'transcript.jsonl')) &&
    !exists(path.join(ADOPT_ROOT, 'legacy', 'room.json')),
  json(adoptList.body?.rooms?.find((r) => r.id === 'legacy')),
)
await closeServer(adoptServed.server)
await closeServer(served2.server)
await closeServer(server)

// ---------------------------------------------------------------- 客户端结构

section('客户端 client/client.js（v6 冻结快照）：单入口 / 面板内导航 / 页头无人数与记录员 chip / 自带对话框 / 邀请 / 气泡 / 文件抽屉 / 滚动策略')

const clientSrc = fs.readFileSync(path.join(HERE, '..', 'client', 'client.js'), 'utf8')
// 取某个函数的源码片段（断言 v4 形状用；span 给足，避免括号匹配的脆弱性）
const fnBody = (name, span = 900) => {
  const at = clientSrc.indexOf(`function ${name}(`)
  return at < 0 ? '' : clientSrc.slice(at, at + span)
}
const desiredRowsSrc = fnBody('desiredRows', 420)
const desiredMainSrc = fnBody('desiredMain', 700)
const goInternalSrc = fnBody('goInternal', 380)
const followActiveSrc = fnBody('followActive', 4400)
const openResultSrc = fnBody('openResult', 300)

check('客户端用 __ModuleLoader__.load( 注册', /__ModuleLoader__\.load\(/.test(clientSrc))
check('注册到 sidebar.panellist（面板列表）', /sidebar\.panellist/.test(clientSrc))
check('总入口 order 为 100', /ENTRY_ORDER\s*=\s*100/.test(clientSrc) || /order\s*:\s*100\b/.test(clientSrc))
check('main 槽位 key 前缀 dsh-meeting-room:', /KEY_PREFIX\s*=\s*['"]dsh-meeting-room:['"]/.test(clientSrc))
check('客户端以 /dsh-room 为 API 基址', /['"]\/dsh-room['"]/.test(clientSrc))
check(
  '《会议结果》是 main 的 keyed 整页（key = dsh-meeting-room:result:<roomId>，组件 ResultTab）',
  /function ResultTab/.test(clientSrc) && /result:\$\{room\.id\}/.test(clientSrc) && desiredMainSrc.includes('component: ResultTab'),
  desiredMainSrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v4①：侧边栏收敛成单入口（desiredRows 只返回 PANEL_ID 一行；不再有每房间行/结果行）',
  desiredRowsSrc.includes('id: PANEL_ID') && desiredRowsSrc.includes("label: '会议室'") && !desiredRowsSrc.includes('KEY_PREFIX') && !desiredRowsSrc.includes('RESULT_ROW'),
  desiredRowsSrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v4①：desiredMain() 只注册 PANEL_ID + 有结果房间的 result:<roomId>（不含 :new / :settings / :cat: / :archived / 每房间键）',
  desiredMainSrc.includes('wanted.set(PANEL_ID') &&
    desiredMainSrc.includes('`${KEY_PREFIX}result:${room.id}`') &&
    desiredMainSrc.includes('(room.resultCount || 0) > 0') &&
    !desiredMainSrc.includes('NEW_ID') && !desiredMainSrc.includes('SETTINGS_ID') && !desiredMainSrc.includes('GROUP_PREFIX') && !desiredMainSrc.includes('ARCHIVE_ID') &&
    !desiredMainSrc.includes('`${KEY_PREFIX}${roomId}`'),
  desiredMainSrc.replace(/\s+/g, ' ').slice(0, 240),
)
check(
  'v4②：面板内导航走 goInternal（只改 meeting.activePanelId；宿主不在我们面板时才 selectPanel(PANEL_ID) 一次）',
  goInternalSrc.includes('meeting.activePanelId = next') && /hostActivePanelId\(\)\s*!==\s*PANEL_ID\)\s*selectPanel\(PANEL_ID\)/.test(goInternalSrc),
  goInternalSrc.replace(/\s+/g, ' ').slice(0, 220),
)
check(
  'v10①：followActive 仍跟进 result: 前缀；外壳把选中态清成空时会先判断是不是用户主动导航（自清 1.5 s / sessions 0.7 s / 手势 1.2 s），不是才 remountMain() + selectPanel(PANEL_ID) 抢回；6 s 内抢超 3 次就 giveUp',
  followActiveSrc.includes('startsWith(resultPrefix)') &&
    followActiveSrc.includes('meeting.activePanelId = id') &&
    followActiveSrc.includes('const navigated =') &&
    /now - panelGuard\.selfClearAt < 1500/.test(followActiveSrc) &&
    /now - panelGuard\.lastSessionsAt < 700/.test(followActiveSrc) &&
    /now - panelGuard\.lastGestureAt < 1200/.test(followActiveSrc) &&
    /if \(navigated\) \{\s*panelGuard\.wasOurs = false;/.test(followActiveSrc) &&
    followActiveSrc.includes('panelGuard.rescueTimes.length > 3') &&
    followActiveSrc.includes('panelGuard.giveUp = true') &&
    /now - panelGuard\.lastRescueAt > 400[\s\S]{0,260}remountMain\(\);[\s\S]{0,120}selectPanel\(PANEL_ID\)/.test(followActiveSrc),
  followActiveSrc.replace(/\s+/g, ' ').slice(0, 240),
)
const backSrc = fnBody('backToConversation', 320)
const watchSrc = fnBody('watchPanelGestures', 900)
const panelDiagSrc = fnBody('panelDiag', 700)
const applySrc = fnBody('apply', 3600)
check(
  'v10②：backToConversation() 先记 panelGuard.selfClearAt 再 selectPanel(null)（否则守卫会立刻把用户抢回会议室）',
  /panelGuard\.selfClearAt = Date\.now\(\)[\s\S]{0,90}selectPanel\(null\)/.test(backSrc),
  backSrc.replace(/\s+/g, ' ').slice(0, 160),
)
check(
  'v10③：watchPanelGestures 用 capture 监听 pointerdown/keydown 并订阅 ctx.sessions.list，两个信号源都写进 panelGuard 时限',
  watchSrc.includes("addEventListener('pointerdown', mark, true)") &&
    watchSrc.includes("addEventListener('keydown', mark, true)") &&
    watchSrc.includes('panelGuard.lastGestureAt = Date.now()') &&
    watchSrc.includes('ctx.sessions') && watchSrc.includes('panelGuard.lastSessionsAt = Date.now()'),
  watchSrc.replace(/\s+/g, ' ').slice(0, 220),
)
check(
  'v10④：apply() 里 watchPanelGestures(ctx) 先于 followActive(ctx)（订阅建立后守卫才可能被触发）',
  /watchPanelGestures\(ctx\)[\s\S]{0,600}?followActive\(ctx\)/.test(applySrc),
  applySrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v10⑤：诊断环写 localStorage「dsh-meeting-room.panel-diag」、上限 60 条；mount 失败与面板卸载都留痕（真复现时能看时序）',
  panelDiagSrc.includes("'dsh-meeting-room.panel-diag'") && panelDiagSrc.includes('list.length > 60') &&
    clientSrc.includes("kind: 'register-failed'") && clientSrc.includes("kind: 'inject-failed'") &&
    clientSrc.includes("kind: 'unmount-main'") && clientSrc.includes("kind: 'cleared'") &&
    clientSrc.includes("kind: 'rescue'") && clientSrc.includes("kind: 'giveup'"),
  panelDiagSrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v4②：openResult 仍走 selectPanel(结果键)（结果页是宿主右侧页签）',
  openResultSrc.includes('selectPanel(`${KEY_PREFIX}result:${roomId}`)') && openResultSrc.includes('meeting.rightGoal'),
  openResultSrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v4④：面板不再发 POST /rooms/:id/recorder，也不发带 recorder 的 PATCH /settings',
  !clientSrc.includes('/recorder') && !clientSrc.includes('recorder:'),
)
// v6④：页头只剩「标题 / 已结束|进行中 / 已归档 / spacer / ← 会议室列表 / 策划会议 / 会议文件开关」。
// v4 的「N/M 人」在线人数 chip 与「记录员（内置 AI）」chip 都从页头删掉（成员在线状态与「记录员」
// 角色小字仍在与会者区，见下面的 member.role === 'recorder' 断言；记录员身份说明仍在策划抽屉）。
// v15③ 起页头按钮收成一个右栏开关，「会议文件」这个字面量在开关的收起态上。
const stripLineComments = (src) => src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
// v6③：旧投递档位文案要从「代码」里消失；注释里提到历史不违规（client.js:1207 的 v6 注释就写着「只归档」）。
const clientCode = stripLineComments(clientSrc)
const headerSrc = stripLineComments((() => {
  const at = clientSrc.indexOf('function RoomPanel(')
  const end = clientSrc.indexOf("view.error ? h('div', { style: S.banner }", at)
  return at < 0 || end < at ? '' : clientSrc.slice(at, end)
})())
check(
  'v6④：页头删掉「N/M 人」在线人数 chip 与「记录员（内置 AI）」chip（标题/状态/归档/页头按钮仍在）',
  headerSrc.length > 0 &&
    !headerSrc.includes('记录员') &&
    !headerSrc.includes('liveCount') &&
    !headerSrc.includes('memberCount') &&
    !/\d+\s*\/\s*\d+\s*人/.test(headerSrc) &&
    headerSrc.includes('已结束') && headerSrc.includes('进行中') && headerSrc.includes('已归档') &&
    headerSrc.includes("'会议文件'") && headerSrc.includes("'← 会议室列表'") &&
    !headerSrc.includes("'会议结果'"),
  headerSrc.replace(/\s+/g, ' ').slice(0, 260) + ' / 与会者区仍标角色=' + clientSrc.includes("member.role === 'recorder'"),
)
check(
  'v4⑤：邀请显示名取 title || label || shortId；统计行用 /sessions 的 total/filtered；空列表有中文文案',
  clientSrc.includes('session.title || session.label || shortId(session.sessionId)') &&
    clientSrc.includes('meeting.sessionMeta') &&
    clientSrc.includes('只列顶层会话') &&
    clientSrc.includes('没有可邀请的顶层会话'),
)
check(
  'v4⑥：S.msg 无边框、用户消息右对齐、与会者名字按稳定哈希取色（同名同色）',
  /msg: \{[^}]*\}/.test(clientSrc) && !/msg: \{[^}]*border\s*:/.test(clientSrc) &&
    clientSrc.includes("msgUser: { alignItems: 'flex-end' }") &&
    clientSrc.includes('function hashName') && clientSrc.includes('nameColor(key || kind)'),
)
check(
  "v4③：客户端不含 #fff / surface-primary / color:'inherit'，颜色全走 var(--dsw-*)",
  !/#fff/i.test(clientSrc) && !clientSrc.includes('surface-primary') && !/color:\s*'inherit'/.test(clientSrc) && /var\(--dsw-/.test(clientSrc),
)
check(
  '不再注册 sidebar.right.pane.tab（那是右侧栏页签类型系统的座位，插件直注册不会渲染）',
  !/name:\s*['"]sidebar\.right\.pane\.tab['"]/.test(clientSrc),
)
check('点侧边栏行会同步 activeRoom（订阅 ctx.layout.panelInfo）', /panelInfo/.test(clientSrc))

// ---------- v5 客户端：投递档位文案 / 会议文件抽屉 / 滚动收口（源码形状） ----------
// RoomPanel 的整段源码：从函数头切到下一个函数（MessageRow，v9 里紧跟其后；
// RoomSide 在其后单独取，避免把右栏页签文案算进「页头只有一处会议文件」那条断言）
const roomPanelSrc = (() => {
  // v13：RoomPanel 现在长到 14000 字以上，固定长切片会把它后面的代码切掉；
  // 改成按花括号配对量出整个函数体（字符串里的注释不会影响配对）。
  const at = clientSrc.indexOf('function RoomPanel(')
  if (at < 0) return ''
  const open = clientSrc.indexOf('{', at)
  let depth = 0
  for (let i = open; i < clientSrc.length; i += 1) {
    const ch = clientSrc[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return clientSrc.slice(at, i + 1)
    }
  }
  return clientSrc.slice(at, at + 14000)
})()
const roomSideSrc = fnBody('RoomSide', 4800)
const newViewSrc = fnBody('newView', 1800)
const drawerDeliverySrc = fnBody('DrawerDelivery', 2400)
const sideToggleAt = roomPanelSrc.indexOf("view.sideOpen ? '收起侧栏' : '会议文件'")
const backBtnAt = roomPanelSrc.indexOf("'← 会议室列表'")
const pollLine = roomPanelSrc.split('\n').find((line) => line.includes('setInterval(')) ?? ''
// v17③：输入框下面那条长提示整条删除（用户 m05432③ 的选择），数据条 RoomStats 从输入框上方挪到下方。
// 「唤醒与会者」整块仍 0 命中；踢人也不再问理由（kickReason 已删）。
const composerBoxAt = roomPanelSrc.indexOf("h('div', { style: S.composer },")
const composerStatsAt = roomPanelSrc.indexOf('h(RoomStats, { members: view.members })')
const composerHintGone = !clientSrc.includes('你的消息只留在会议室记录里') && !clientSrc.includes('不会进入与会者对话')
const askTextCount = (clientSrc.match(/askText\(view,\s*\{/g) ?? []).length
const wakeupHits = clientSrc.match(/唤醒与会者/g) ?? []
const reminderHits = clientSrc.match(/有新消息/g) ?? []
const requiredGuardSrc = (() => {
  const at = clientSrc.indexOf("dialog.error = '必填'")
  return at < 0 ? '' : clientSrc.slice(Math.max(0, at - 200), at + 60)
})()
const dialogSrc = (() => {
  const at = clientSrc.indexOf('function Dialog(')
  return at < 0 ? '' : clientSrc.slice(at, at + 2600)
})()
const sendPostSrc = (() => {
  const at = roomPanelSrc.indexOf('const sendPost')
  return at < 0 ? '' : roomPanelSrc.slice(at, at + 700)
})()
const nativePopupHits = clientSrc.match(/window\.(?:prompt|confirm|alert)\b/g) ?? []
// v7③：踢人请求的原点 —— 点 ✕ 立即 POST，不再经过 askText/Dialog，也不再带 reason。
const kickCallSrc = (() => {
  const at = clientSrc.indexOf('/kick`')
  return at < 0 ? '' : clientSrc.slice(Math.max(0, at - 160), at + 200)
})()
check(
  'v7③：window.prompt / confirm / alert 命中 0（原生弹窗全下线，剩下 4 处交互都走自带对话框）',
  nativePopupHits.length === 0 &&
    askTextCount === 4 &&
    clientSrc.includes('function askText(') &&
    clientSrc.includes('function confirmDialog(') &&
    clientSrc.includes('function dismissDialog(') &&
    dialogSrc.includes('S.dialogWrap') && dialogSrc.includes('S.dialogCard') && dialogSrc.includes('autoFocus'),
  `原生弹窗命中=${json(nativePopupHits)} askText 调用=${askTextCount} Dialog=${dialogSrc.length > 0}`,
)
check(
  'v6③：对话框是「必填校验 + 取消不执行 onOk」语义（confirmDialog 里 required 空值直接 return，不清 dialog）',
  clientSrc.includes('function confirmDialog(') &&
    requiredGuardSrc.includes('required') &&
    requiredGuardSrc.includes("dialog.error = '必填'") &&
    requiredGuardSrc.includes('return') &&
    !requiredGuardSrc.includes('onOk') &&
    clientSrc.includes('dismissDialog(view)') &&
    clientSrc.includes('dialog.onOk(value)') &&
    dialogSrc.includes('S.inlineInput') &&
    dialogSrc.includes('Escape') &&
    clientSrc.includes("'取消'") &&
    clientSrc.includes('dialog.confirmLabel'),
  `必填守卫=${requiredGuardSrc.replace(/\s+/g, ' ').trim()} / 取消按钮=${clientSrc.includes("'取消'")} Escape=${dialogSrc.includes('Escape')}`,
)
check(
  'v6③：PUSH_LABEL / PUSH_MODES / defaultFileMode / pushAll 全部下线（0 命中），composer 不再承诺投递档位',
  !clientSrc.includes('PUSH_LABEL') &&
    !clientSrc.includes('PUSH_MODES') &&
    !clientSrc.includes('defaultFileMode') &&
    !clientSrc.includes('pushAll') &&
    !clientSrc.includes('默认投递：'),
  `PUSH_LABEL=${clientSrc.includes('PUSH_LABEL')} PUSH_MODES=${clientSrc.includes('PUSH_MODES')} defaultFileMode=${clientSrc.includes('defaultFileMode')} pushAll=${clientSrc.includes('pushAll')}`,
)
check(
  'v17③：整条长提示已删（含「不会进入与会者对话」）、数据条改挂到 composer 之后；唤醒与会者/旧三档文案仍 0 命中',
  composerHintGone &&
    composerBoxAt >= 0 &&
    composerStatsAt > composerBoxAt &&
    wakeupHits.length === 0 &&
    reminderHits.length >= 1 &&
    !clientCode.includes('只归档') &&
    !clientCode.includes('只记录，不通知') &&
    !clientCode.includes('通知与会者') &&
    !clientCode.includes('通知并投递全文') &&
    !clientCode.includes('别人（与会者 AI）怎么收到我的消息'),
  `composerAt=${composerBoxAt} statsAt=${composerStatsAt} 旧提示=${clientSrc.includes('你的消息只留在会议室记录里')} 提醒=${reminderHits.length}`,
)
check(
  'v7③：DrawerDelivery 两行说明 + 第二行「每次发送后…提醒（不含你的正文）」+「思考程度（房间默认）」，投递档位 0 命中',
  drawerDeliverySrc.includes('你和与会者 AI 之间') &&
    drawerDeliverySrc.includes('不会出现在与会者的对话里') &&
    drawerDeliverySrc.includes('每次发送后') &&
    drawerDeliverySrc.includes('不含你的正文') &&
    drawerDeliverySrc.includes('思考程度（房间默认）') &&
    drawerDeliverySrc.includes('REASONING_LEVELS') &&
    !drawerDeliverySrc.includes('唤醒与会者'),
  drawerDeliverySrc.replace(/\s+/g, ' ').slice(0, 240),
)
check(
  "v7③：sendPost 的 body 固定 { text, mode: 'notice' }（+ 可选 to/files），不再有 pushAll",
  sendPostSrc.includes("const body = { text, mode: 'notice' }") &&
    sendPostSrc.includes('postJson(`/rooms/${q(roomId)}/post`, body)') &&
    sendPostSrc.includes('body.to = targets') &&
    sendPostSrc.includes('body.files = files') &&
    (sendPostSrc.match(/mode:/g) ?? []).length === 1 &&
    !sendPostSrc.includes('pushAll') && !sendPostSrc.includes("mode: 'full'"),
  sendPostSrc.replace(/\s+/g, ' ').slice(0, 240),
)
check(
  'v7③：askText 调用点 4 处（结果列表驳回 / 再议 / 散会 / 结果页驳回），且都带 confirmLabel（踢人那处已删）',
  askTextCount === 4 &&
    clientSrc.includes("title: '驳回原因（必填）'") &&
    clientSrc.includes("title: '再议原因（可选）'") &&
    clientSrc.includes("title: '散会标题（可选）'") &&
    !clientSrc.includes('的理由（可选）') &&
    (clientSrc.match(/confirmLabel:\s*'/g) ?? []).length === 4,
  `askText=${askTextCount} 字面 confirmLabel=${(clientSrc.match(/confirmLabel:\s*'/g) ?? []).length} 踢人理由标题=${clientSrc.includes('的理由（可选）')}`,
)
check(
  'v7③：唤醒与会者按钮整块下线（源码 0 命中），kickReason 状态一并删除，只剩「邀请会话 AI」',
  wakeupHits.length === 0 &&
    !clientCode.includes('唤醒与会者') &&
    !clientSrc.includes('kickReason') &&
    clientSrc.includes('邀请会话 AI'),
  `唤醒与会者=${wakeupHits.length} kickReason=${clientSrc.includes('kickReason')} 邀请会话 AI=${clientSrc.includes('邀请会话 AI')}`,
)
check(
  'v7③：踢人改为点 ✕ 立即请求（不弹对话框、无 reason 字段，只带 sessionId + notify）',
  kickCallSrc.includes('/kick`') &&
    kickCallSrc.includes('{ sessionId: member.sessionId, notify: true }') &&
    !kickCallSrc.includes('reason') && !kickCallSrc.includes('askText') && !kickCallSrc.includes('view.kickReason'),
  kickCallSrc.replace(/\s+/g, ' ').slice(0, 200),
)
check(
  'v15③：页头只留一个右栏开关（收起侧栏 / 会议文件 切 sideOpen）—— v9 那两个与它重复的「会议文件 / 会议结果」页头按钮已删（页签仍在右栏里）；右栏由 RoomSide 常驻渲染（v5 的 FilesDrawer 弹层已下线）',
  sideToggleAt > 0 && backBtnAt > 0 && sideToggleAt > backBtnAt &&
    roomPanelSrc.includes("view.sideOpen ? '收起侧栏' : '会议文件'") &&
    !roomPanelSrc.includes('openSide(') && !roomPanelSrc.includes("'会议结果'") &&
    roomPanelSrc.includes('view.sideOpen ? h(RoomSide, { roomId, view, room, act }) : null') &&
    !clientSrc.includes('FilesDrawer') &&
    (roomPanelSrc.match(/'会议文件'/g) ?? []).length === 1,
  `sideToggleAt=${sideToggleAt} backBtnAt=${backBtnAt} 文案出现=${(roomPanelSrc.match(/'会议文件'/g) ?? []).length} openSide=${roomPanelSrc.includes('openSide(')} FilesDrawer=${clientSrc.includes('FilesDrawer')}`,
)
check(
  'v9①：RoomSide 两个页签（会议文件 / 会议结果），文件链接 raw?name=<name>，两种空态，结果行「看全文」→ openResult，newView 默认 sideOpen:true / sideTab:files',
  roomSideSrc.includes("tabBtn('files', '会议文件'") && roomSideSrc.includes("tabBtn('results', '会议结果'") &&
    roomSideSrc.includes('/raw?name=${q(preview.name)}') && roomSideSrc.includes('还没有会议文件。') &&
    roomSideSrc.includes('还没有会议结果。') && roomSideSrc.includes('openResult(roomId, result.goalId)') &&
    newViewSrc.includes('sideOpen: true') && newViewSrc.includes("sideTab: 'files'"),
  `tabFiles=${roomSideSrc.includes("tabBtn('files'")} tabResults=${roomSideSrc.includes("tabBtn('results'")} raw=${roomSideSrc.includes('/raw?name=')} newView=${newViewSrc.includes('sideOpen: true')}/${newViewSrc.includes("sideTab: 'files'")}`,
)
check(
  'v13③（v16①改形）：滚动收口改成「跟随意图」—— 首载/记录变长各一次 toBottom，轮询行不含 toBottom；不跟随时常驻「回到最底」图标，有新消息时点亮',
  roomPanelSrc.includes('const scrollRef = react.useRef(null)') &&
    roomPanelSrc.includes('const [following, setFollowing] = react.useState(true)') &&
    roomPanelSrc.includes('const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 25') &&
    roomPanelSrc.includes('Date.now() - programmatic.current < 800') &&
    roomPanelSrc.includes("!following ? h('button'") &&
    roomPanelSrc.includes('hasNew ? { ...S.toBottom, ...S.toBottomNew } : S.toBottom') &&
    roomPanelSrc.includes('el.scrollTo({ top: el.scrollHeight, behavior: \'smooth\' })') &&
    (roomPanelSrc.match(/setTimeout\(\(\) => toBottom\(false\), 0\)/g) ?? []).length === 1 &&
    (roomPanelSrc.match(/setTimeout\(toBottom, 0\)/g) ?? []).length === 1 &&
    pollLine.includes('setInterval(() => pullRoom(roomId), POLL_MS)') && pollLine.includes('pullRoom') && !pollLine.includes('toBottom'),
  `toBottom 次数=${(roomPanelSrc.match(/setTimeout\(\(\) => toBottom\(false\), 0\)/g) ?? []).length}+${(roomPanelSrc.match(/setTimeout\(toBottom, 0\)/g) ?? []).length} 轮询行=${pollLine.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
)
const drawerFilesSrc = fnBody('DrawerFiles', 3600)
const railSrc = fnBody('MessageRail', 6200)
check(
  'v15①：文件夹组件只剩「显示文件夹 + 选择文件夹」两件事 —— 选择走系统文件夹界面、选中的文件夹就是房间目录（客户端不再拼 <文件夹>\\<房间id>），记录/附件是两个子文件夹；「换个文件夹/新建/选一个已有文件夹」三件套已删',
  drawerFilesSrc.includes('const picked = await pickSystemFolder()') &&
    drawerFilesSrc.includes('if (picked === undefined) { setPick(true); return; } // 没有系统文件夹界面 ⇒ 退回房间内浏览式') &&
    drawerFilesSrc.includes("await act(() => patchJson(`/rooms/${q(roomId)}`, { dir: picked }), '已换好文件夹')") &&
    drawerFilesSrc.includes('onClick: () => revealDirInOS(dir)') &&
    !drawerFilesSrc.includes('joinPath(') &&
    !drawerFilesSrc.includes('newName') &&
    drawerFilesSrc.includes("S.fieldLabel }, '会议文件'") &&
    drawerFilesSrc.includes("'打开文件夹'") &&
    drawerFilesSrc.includes("'选择文件夹'") &&
    drawerFilesSrc.includes('「附件/」里参会人产生的文件全部删掉，只留「记录/」。') &&
    drawerFilesSrc.includes('会议产生的文件全部留在下面这个文件夹里，不删。') &&
    !drawerFilesSrc.includes('存放位置') && !drawerFilesSrc.includes('保存方式') && !drawerFilesSrc.includes('新建子文件夹') &&
    !drawerFilesSrc.includes('换个文件夹') && !drawerFilesSrc.includes('选一个已有文件夹') &&
    clientSrc.includes('async function pickSystemFolder()') &&
    clientSrc.includes('__DSH_DIRECTORY_PICKER__') &&
    clientSrc.includes("hostCtx.get('uiWorkspace')") &&
    clientSrc.includes('async function revealDirInOS(dir)') &&
    clientSrc.includes("fetch('/open-in-app/open'") &&
    clientSrc.includes('app: \'explorer\''),
  `picker=${drawerFilesSrc.includes('pickSystemFolder()')} joinPathInDrawer=${drawerFilesSrc.includes('joinPath(')} bridge=${clientSrc.includes('__DSH_DIRECTORY_PICKER__')} uiWorkspace=${clientSrc.includes("hostCtx.get('uiWorkspace')")} openInApp=${clientSrc.includes("fetch('/open-in-app/open'")}`,
)
check(
  'v14③④：消息索引仿普通会话轮次轨道 —— 一个轮次（主持人发言/目标时间点）一个刻度、固定 10px 等距、悬浮居中、刻度多于框高时自己滚',
  railSrc.includes('function MessageRail(props)') &&
    clientSrc.includes('function isTurnHead(message)') &&
    clientSrc.includes("author.kind === 'user'") &&
    clientSrc.includes("return typeof message_.kind === 'string' && message_.kind.indexOf('goal') === 0") &&
    railSrc.includes('if (isTurnHead(message)) ticks.push({ message, index })') &&
    railSrc.includes('const shown = ticks.length >= 2 ? ticks : []') &&
    railSrc.includes("'data-rail-list': '1'") &&
    railSrc.includes("'data-mark': isGoalMark(tick.message) ? 'goal' : 'turn'") &&
    railSrc.includes('el.scrollTop = want') &&
    railSrc.includes("scrollIntoView({ block: 'start', behavior: 'smooth' })") &&
    railSrc.includes('S.railPreview') &&
    roomPanelSrc.includes('h(MessageRail, {') && roomPanelSrc.includes('onJump: () => setFollow(false)') &&
    // v13④ 的老坑：索引必须真的拿到消息节点 —— 曾漏传 boxes，点击永远滚不到（这里继续钉住）
    roomPanelSrc.includes('boxes: msgRefs, tailRef: bottomRef') &&
    railSrc.includes('const boxes = props.boxes || fallbackBoxes') &&
    roomPanelSrc.includes("'data-scroll': 'log'") &&
    // v14③：悬浮居中（离边 12px）+ 固定 10px 刻度行 + 横线画在行里 + 轨道自己滚
    clientSrc.includes("rail: { position: 'absolute', right: 12") &&
    clientSrc.includes('maxHeight: RAIL_MAX_HEIGHT') &&
    clientSrc.includes("mark: { width: 20, height: 10") &&
    clientSrc.includes("markLine: { width: 12, height: 2") &&
    clientSrc.includes("markGoal: { width: 20, height: 3") &&
    clientSrc.includes('overflowY: \'auto\''),
  `rail=${railSrc.length} ticks=${railSrc.includes('isTurnHead(message)')} shown=${railSrc.includes('ticks.length >= 2')} preview=${railSrc.includes('S.railPreview')} mounted=${roomPanelSrc.includes('h(MessageRail, {')}`,
)

// ---------------------------------------------------------------- 客户端：node:vm 真渲染
// v2 时代这条断言是「在 node:vm 里真渲染浏览器半区、真点按钮」；v3 客户端换成
// sidebar.panellist + main 两张槽位，v4 又在 main 内部做了「面板内导航」（goInternal）。
// 关键：v4 的槽位根节点是**函数组件**（createElement(Component, …)），所以渲染器必须递归调用
// 函数组件、并给每个组件保留自己的 hook 帧（跨多次渲染保持 useState），否则只看得到根节点，
// 拿不到真实元素/文本 —— 这正是上一版 `walk()` 只看根节点的漏洞。

const mountClientVm = async (data) => {
  const frames = new Map()
  let curStore = null
  let curCursor = 0
  const state = {
    definition: null,
    module: null,
    registered: [],
    elements: [],
    texts: [],
    buttons: [],
    errors: [],
    selectPanelCalls: [],
    fetchLog: [],
    requireCalls: [],
    // v5②：滚动观测 —— S.scroll 容器上的 ref 会被绑到假 DOM 节点，
    // 每次 `el.scrollTop = el.scrollHeight` 都记进 scrollSets，用来断言「首载滚一次 / 轮询不滚 / 发送后再滚」。
    refNodes: new Map(),
    scrollNodes: [],
    scrollSets: [],
    // v13④：索引点击的 scrollIntoView 落点
    scrollCalls: [],
    // v5②：轮询观测 —— setInterval 的回调被存下来，测试可手动拉一拍（真跑 1.5s 太慢）。
    intervalFns: [],
    // v6③：原生弹窗探针 —— 客户端不该再调 window.prompt/confirm/alert；
    // fetch 的 body 也记下来（踢人/驳回这类 POST 的 payload 是断言对象，不是只看 url）。
    nativePopups: [],
    fetchBodies: [],
    // v10：面板粘性守卫观测 —— 外壳 panelInfo 的订阅者真的被叫起来，
    // 手势（pointerdown/keydown）与 sessions 列表变化都在这里留痕。
    panelSubs: [],
    sessionSubs: [],
    gestureHits: [],
    // v13④：这一趟渲染里登记下来的 effect（渲染全部结束后再统一跑，见 reactStub.useEffect 的注释）。
    pendingEffects: [],
  }
  const flattenText = (node, out = []) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const item of node) flattenText(item, out); return out }
    if (typeof node === 'object') flattenText(node.props?.children, out)
    return out
  }
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    useState: (initial) => {
      const store = curStore
      const i = curCursor++
      if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
      // setter 必须绑到「组件自己的帧」：onClick 里同步/异步调用 setState 时并不在渲染中，
      // 全局游标可能为 null（假 react 也得跟真 react 一样按组件实例保存状态）。
      return [store[i], (value) => { store[i] = typeof value === 'function' ? value(store[i]) : value }]
    },
    useRef: (initial) => { const store = curStore; const i = curCursor++; if (!(i in store)) store[i] = { current: initial }; return store[i] },
    useCallback: (fn) => { curCursor += 1; return fn },
    useMemo: (fn) => fn(),
    useEffect: (fn, deps) => {
      const i = curCursor++
      const slot = curStore[i] ?? (curStore[i] = { ran: false, deps: undefined })
      // v5：必须按依赖浅比较重跑（真 react 的语义）。RoomPanel 的「首载滚到底」effect
      // 依赖 [roomId, view.loaded]，view.loaded 从 false 翻转时才该跑一次 —— 只跑一次的实现会漏掉它。
      const changed =
        !slot.ran ||
        !Array.isArray(deps) ||
        !Array.isArray(slot.deps) ||
        deps.length !== slot.deps.length ||
        deps.some((value, index) => !Object.is(value, slot.deps[index]))
      if (!changed) return
      slot.ran = true
      slot.deps = Array.isArray(deps) ? deps.slice() : undefined
      // v13④：effect 不能在这里直接跑 —— MessageRail 要量消息节点的 offsetTop，而在假 react 的
      // 同步递归渲染里，「组件渲染」早于它的子节点挂 ref（真 react 是整棵树 commit 之后才跑 effect）。
      // 所以只登记，等这一趟渲染全部结束再统一跑；否则量到的永远是空的。
      state.pendingEffects.push(fn)
    },
    useSyncExternalStore: (subscribe, getSnapshot) => { const i = curCursor++; if (!(i in curStore)) curStore[i] = subscribe; return getSnapshot() },
  }
  /**
   * v13④：假 DOM 的「同父链 + 布局量」——真 DOM 里 nextSibling/parentNode/offsetTop 由浏览器算，
   * 这里给同一父节点下的 host 元素按顺序编号，offsetTop 按 80px 一条递增（够 MessageRail 量位置用）。
   */
  const linkSiblings = (children) => {
    const list = []
    for (const child of (Array.isArray(children) ? children : [children])) {
      if (child && typeof child === 'object' && !Array.isArray(child) && child.type !== undefined) list.push(child)
    }
    for (let i = 0; i < list.length; i += 1) {
      list[i].nextSibling = list[i + 1] ?? null
      if (list[i].el) list[i].el.offsetTop = (i + 1) * 80
    }
    for (const node of list) if (node.el) node.el.parentNode = list[0]?.el ?? null
  }
  const renderNode = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map((item) => renderNode(item, depth))
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node !== 'object') return null
    const { type, props } = node
    if (typeof type === 'function') {
      if (depth > 14) { state.errors.push('渲染深度超过 14 层（疑似组件环）'); return null }
      const savedStore = curStore
      const savedCursor = curCursor
      let frame = frames.get(type)
      if (!frame) { frame = { store: [] }; frames.set(type, frame) }
      curStore = frame.store
      curCursor = 0
      let out = null
      try { out = type(props ?? {}) } catch (error) { state.errors.push(`组件 ${type.name || '匿名组件'} 渲染失败：${error?.message ?? error}`) } finally { curStore = savedStore; curCursor = savedCursor }
      return renderNode(out, depth + 1)
    }
    const text = flattenText(props?.children, []).join(' ')
    state.elements.push({ type, props, text })
    if (text) state.texts.push(text)
    // v5②：真 react 会把 host 元素的 ref.current 指到 DOM 节点；这里塞一个假节点，
    // 组件里的 `el.scrollTop = el.scrollHeight` 才能被观测到（滚动断言的基础）。
    // 同一个 ref 对象必须复用同一个节点：否则每次渲染都换新节点，跨渲染的赋值就丢了。
    // v13④：**每个** host 元素都有假节点（回调式 ref `(node)=>…` 也要拿到它，MessageRail 靠它量 offsetTop），
    // 但只有对象式 ref 才进 refNodes/scrollNodes —— 那两个集合是既有滚动断言的观测面，不能变形。
    const makeFakeEl = () => {
      const fake = { scrollHeight: Number(data.scrollHeight ?? 240), sets: [], marker: props['data-scroll'] ? String(props['data-scroll']) : '' }
      fake.clientHeight = Number(data.clientHeight ?? 0)
      fake.clientWidth = Number(data.clientWidth ?? 0)
      fake.offsetTop = Number(props['data-offset-top'] ?? 0)
      fake.parentNode = null
      fake.nextSibling = null
      Object.defineProperty(fake, 'scrollTop', {
        configurable: true,
        get: () => fake._top,
        set: (value) => {
          fake._top = value
          fake.sets.push(value)
          state.scrollSets.push(value)
        },
      })
      // v13④：消息索引点击时要 scrollIntoView —— 假节点留痕，用来断言「点横条 = 滚到那条消息」
      fake.scrollIntoView = (options) => { state.scrollCalls.push(options ?? null) }
      fake.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 })
      fake.addEventListener = () => {}
      fake.removeEventListener = () => {}
      fake.dataset = { seq: String(props['data-seq'] ?? '') }
      fake._top = 0
      return fake
    }
    let el = null
    if (props && props.ref && typeof props.ref === 'object') {
      el = state.refNodes.get(props.ref)
      if (!el) {
        el = makeFakeEl()
        state.refNodes.set(props.ref, el)
        state.scrollNodes.push({ type, node: el })
      } else {
        el.offsetTop = Number(props['data-offset-top'] ?? el.offsetTop ?? 0)
      }
      props.ref.current = el
    } else if (props && typeof props.ref === 'function') {
      el = makeFakeEl()
      props.ref(el)
    }
    const children = renderNode(props?.children, depth + 1)
    linkSiblings(children)
    return { type, props, text, children, el }
  }
  /**
   * v5②/v13③：当前聊天滚动容器（S.scroll）假节点。
   * 不能直接取最后一个挂 ref 的节点：页头/上传文件的隐藏 <input> 也带 ref，
   * 现在用组件上的 data-scroll="log" 认准滚动口。
   */
  state.scrollNow = () => {
    const marked = state.scrollNodes.filter((item) => item.node?.marker === 'log')
    if (marked.length) return marked.at(-1).node
    return state.scrollNodes.at(-1)?.node ?? null
  }
  const paint = () => {
    state.elements = []
    state.texts = []
    state.buttons = []
    // 跟真宿主一样：sidebar 的行全部渲染；main 只渲染「宿主当前活动键」对应的那一个面板
    // （否则把 ResultTab 也一起渲染，它的 viewOf('new') 副作用会污染 MainPane 的分支判断）。
    const activeKey = panel.activePanelId || 'dsh-meeting-room'
    for (const item of state.registered) {
      if (item.name === 'main' && (item.options?.key ?? item.options?.id) !== activeKey) continue
      const tree = renderNode({ type: item.component, props: {} })
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const child of node) walk(child); return }
        if (node.type === 'button') state.buttons.push(node)
        walk(node.children)
      }
      walk(tree)
    }
  }
  const flushEffects = () => {
    const queued = state.pendingEffects.splice(0, state.pendingEffects.length)
    for (const fn of queued) {
      try { fn() } catch (error) { state.errors.push(`effect 抛错：${error?.message ?? error}`) }
    }
    return queued.length
  }
  state.renderAll = () => {
    paint()
    // v13④：effect 只在整棵树渲染完之后跑（见 reactStub.useEffect 注释）。effect 里 setState 的
    // 结果必须再画一趟才出现在假 DOM 上 —— 真 react 也是「渲染 → 提交 → effect → 重渲」。
    if (flushEffects() > 0) paint()
    if (flushEffects() > 0) paint()
    return state
  }
  state.text = () => state.texts.join(' | ')
  state.tap = async (label, waitMs = 60) => {
    state.renderAll()
    const hit = state.buttons.find((button) => flattenText(button.props?.children, []).join(' ').includes(label))
    if (!hit) throw new Error(`渲染树里找不到按钮「${label}」，现有按钮：${state.buttons.map((button) => flattenText(button.props?.children, []).join(' ')).join(' / ').slice(0, 200)}`)
    try {
      const out = hit.props.onClick()
      if (out && typeof out.then === 'function') await out
    } catch (error) {
      state.errors.push(`点击「${label}」抛错：${error?.message ?? error}`)
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    state.renderAll()
    return state
  }
  /** v5②：手动拉一拍轮询（把 setInterval 存下的回调跑一次），断言「轮询路径不强制滚」。 */
  state.pollOnce = async (waitMs = 40) => {
    for (const fn of state.intervalFns.slice()) {
      try { fn() } catch (error) { state.errors.push(`轮询回调抛错：${error?.message ?? error}`) }
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    state.renderAll()
    return state
  }
  const panel = { activePanelId: '' }
  // v10：跟真宿主一样，写 activePanelId 会通知订阅者（面板粘性守卫就是靠这个订阅判断「被弹走了」）
  state.notifyPanel = () => {
    for (const cb of state.panelSubs.slice()) {
      try { cb() } catch (error) { state.errors.push(`panelInfo 订阅者抛错：${error?.message ?? error}`) }
    }
    state.renderAll()
  }
  state.setPanel = (id) => { panel.activePanelId = id || ''; state.notifyPanel(); return state }
  state.fireGesture = (type = 'pointerdown') => {
    for (const fn of (state.gestureHits[type] ?? []).slice()) {
      try { fn() } catch (error) { state.errors.push(`手势监听抛错：${error?.message ?? error}`) }
    }
    return state
  }
  state.sessionsChanged = () => {
    for (const cb of state.sessionSubs.slice()) {
      try { cb() } catch (error) { state.errors.push(`sessions 订阅者抛错：${error?.message ?? error}`) }
    }
    return state
  }
  const bodyFor = (rawUrl) => {
    const url = String(rawUrl)
    if (url.includes('/state')) {
      return {
        seq: 2,
        messages: data.messages ?? [
          { seq: 1, at: 1, kind: 'chat', author: { kind: 'user', id: 'u-me', label: '我' }, text: 'VM-USER-MSG' },
          { seq: 2, at: 2, kind: 'chat', author: { kind: 'agent', id: 'sess-a-1', label: '接口对齐' }, text: 'VM-AGENT-MSG' },
        ],
        members: data.members ?? [{ sessionId: 'sess-a-1', label: '接口对齐', live: true }],
        goals: [],
        results: data.results ?? [],
        files: data.files ?? [],
        room: data.rooms[0],
      }
    }
    if (url.includes('/rooms')) return { rooms: data.rooms, defaultRoomId: data.rooms[0]?.id }
    if (url.includes('/settings')) return { settings: { category: CAT, defaultCategory: CAT, defaultPrompt: '默认提示词', prompt: '默认提示词', recorder: null }, defaultCategory: CAT, defaultPrompt: '默认提示词' }
    if (url.includes('/sessions')) return data.sessionMeta === false ? { sessions: data.sessions } : { sessions: data.sessions, total: data.total ?? 0, filtered: data.filtered ?? 0 }
    return {}
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { state.definition = value } },
      localStorage: { getItem: () => null, setItem: () => {} },
      // v6③：三个原生弹窗都留探针（返回合法值，好让「万一被调用」也不炸场景）；
      // 只要它们被调用一次，nativePopups 就不再是空数组 —— 断言端就是靠这个抓回归。
      prompt: (message) => { state.nativePopups.push(`prompt:${message ?? ''}`); return '' },
      confirm: (message) => { state.nativePopups.push(`confirm:${message ?? ''}`); return true },
      alert: (message) => { state.nativePopups.push(`alert:${message ?? ''}`); return undefined },
      // v10：守卫用 capture 监听 pointerdown / keydown 判断「用户有没有导航动作」，
      // 这里把监听器存下来，测试可以 state.fireGesture('pointerdown') 精确模拟。
      addEventListener: (type, fn) => { (state.gestureHits[type] ??= []).push(fn) },
      removeEventListener: () => {},
    },
    fetch: async (rawUrl, init) => {
      state.fetchLog.push(String(rawUrl))
      if (init && init.body !== undefined) {
        let parsed = init.body
        try { parsed = JSON.parse(String(init.body)) } catch { /* 保留原文 */ }
        state.fetchBodies.push({ url: String(rawUrl), method: init.method || 'GET', body: parsed })
      }
      const body = bodyFor(rawUrl)
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    },
    // v5②：真 react 里 setInterval 会按时回调；这里只把回调存起来，
    // 测试用 state.pollOnce() 手动拉一拍（既快，又能精确断言「轮询不强制滚」）。
    setInterval: (fn) => { state.intervalFns.push(fn); return state.intervalFns.length },
    clearInterval: (id) => { if (typeof id === 'number') state.intervalFns[id - 1] = () => {} },
    setTimeout,
    clearTimeout,
    console,
    AbortSignal,
  }
  try {
    vm.runInNewContext(clientSrc, sandbox)
    state.module = state.definition.factory((name) => {
      if (name === 'react') return reactStub
      state.requireCalls.push(name)
      throw new Error('客户端不应该 require 别的模块：' + name)
    })
    state.dispose = state.module.apply({
      slots: {
        inject: (slotName, register) => { register(); return () => {} },
        register: (options, component) => { state.registered.push({ name: options?.name ?? options?.id, options, component }); return () => {} },
      },
      layout: {
        panelInfo: {
          getSnapshot: () => ({ activePanelId: panel.activePanelId }),
          subscribe: (cb) => {
            state.panelSubs.push(cb)
            return () => { const i = state.panelSubs.indexOf(cb); if (i >= 0) state.panelSubs.splice(i, 1) }
          },
        },
        selectPanel: (id) => { state.selectPanelCalls.push(id ?? null); panel.activePanelId = id || ''; state.notifyPanel() },
      },
      // v10：守卫把「sessions 列表变化」当成「用户点了会话/工作区」的强信号
      sessions: { list: { subscribe: (cb) => { state.sessionSubs.push(cb); return () => {} } } },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    state.renderAll()
  } catch (error) {
    state.errors.push(String(error?.stack ?? error))
  }
  return state
}
const vmHtml = (state) => state.texts.join(' | ')

const vm1 = await mountClientVm({
  rooms: [
    { id: 'm-main', title: '算法评审', category: CAT, status: 'open', archived: false, resultCount: 1, liveCount: 1, memberCount: 2, updatedAt: Date.now(), activeGoalText: '把接口写完', dir: path.join(CAT, 'm-main'), recorder: { kind: 'builtin', label: '记录员' } },
    { id: 'm-arch', title: '旧项目复盘', category: CAT, status: 'closed', archived: true, archivedAt: Date.now(), resultCount: 0, recorder: { kind: 'builtin', label: '记录员' } },
  ],
  sessions: [
    { sessionId: 'sess-a-1', title: '接口对齐', label: '旧名字', live: true, cwd: 'C:\\work\\align' },
    { sessionId: 'sess-b-2', title: '', label: '写文档', live: false },
  ],
  total: 5,
  filtered: 3,
  results: [{ goalId: 'g-1', title: '算法评审 · 会议结果', status: 'draft', excerpt: '首段内容' }],
})
const vmRows = vm1.registered.filter((item) => item.name === 'sidebar.panellist')
const vmMainKeys = vm1.registered.filter((item) => item.name === 'main').map((item) => item.options?.key)

check(
  'vm：真跑 client.js 注册 __ModuleLoader__ 定义（id + factory，只 require react）',
  vm1.definition?.id === 'dsh-meeting-room' && typeof vm1.definition?.factory === 'function' && typeof vm1.module?.apply === 'function' && vm1.requireCalls.length === 0,
  `requires=${json(vm1.requireCalls)} errors=${json(vm1.errors.slice(0, 2)).slice(0, 240)}`,
)
check(
  'vm：apply(假 ctx) 真注册槽位（sidebar.panellist 恰好 1 条 id=dsh-meeting-room；main = PANEL_ID ∪ 有结果房间的 result:<roomId>）',
  vmRows.length === 1 && vmRows[0].options?.id === 'dsh-meeting-room' &&
    vmMainKeys.length === 2 && vmMainKeys.includes('dsh-meeting-room') && vmMainKeys.includes('dsh-meeting-room:result:m-main') &&
    !vmMainKeys.some((key) => key !== 'dsh-meeting-room' && !String(key).startsWith('dsh-meeting-room:result:')),
  json({ rows: vmRows.map((item) => item.options?.id), main: vmMainKeys }).slice(0, 240),
)
check(
  'vm：函数组件被递归渲染出真实元素节点（svg/button/div，且无渲染错误）',
  vm1.errors.length === 0 && vm1.elements.length > 10 && ['svg', 'button', 'div'].every((type) => vm1.elements.some((el) => el.type === type)),
  `elements=${vm1.elements.length} types=${json([...new Set(vm1.elements.map((el) => el.type))]).slice(0, 160)} errors=${json(vm1.errors).slice(0, 240)}`,
)
check(
  'vm：main 的「会议室」面板渲染出房间树（房间名 + 房间行可见文案）',
  vmHtml(vm1).includes('算法评审') && vmHtml(vm1).includes('旧项目复盘') && vmHtml(vm1).includes('会议室'),
  vmHtml(vm1).slice(0, 200),
)

vm1.selectPanelCalls.length = 0
await vm1.tap('设置')
check(
  'v4②vm：面板内点「设置」→ 内部切屏，宿主 selectPanel 只被叫一次（PANEL_ID），没有抢焦点',
  vm1.selectPanelCalls.length === 1 && vm1.selectPanelCalls[0] === 'dsh-meeting-room' && vmHtml(vm1).includes('返回会议室列表') && vm1.errors.length === 0,
  `calls=${json(vm1.selectPanelCalls)} texts=${vmHtml(vm1).slice(0, 160)}`,
)
await vm1.tap('返回会议室列表')
await vm1.tap('算法评审')
check(
  'v4②vm：面板内点「返回列表 / 房间行」都不再调宿主 selectPanel；房间面板页头只留 标题/进行中/会议文件/← 会议室列表/策划会议',
  vm1.selectPanelCalls.length === 1 && vm1.selectPanelCalls[0] === 'dsh-meeting-room' &&
    vmHtml(vm1).includes('← 会议室列表') && vmHtml(vm1).includes('会议文件') && vmHtml(vm1).includes('进行中') &&
    // v6④：页头不再渲染「N/M 人」人数 chip 与「记录员（内置 AI）」chip；与会者区仍然只有成员本身
    !vmHtml(vm1).includes('记录员') && !/\d+\s*\/\s*\d+\s*人/.test(vmHtml(vm1)),
  `calls=${json(vm1.selectPanelCalls)} texts=${vmHtml(vm1).slice(0, 200)}`,
)
const vmUserRow = vm1.elements.find((el) => el.props?.style?.alignItems === 'flex-end' && String(el.text).includes('VM-USER-MSG'))
const vmAgentRow = vm1.elements.find((el) => el.props?.style?.alignItems === 'flex-start' && String(el.text).includes('VM-AGENT-MSG'))
const vmUserBubble = vm1.elements.find((el) => el.props?.style?.borderRadius === 10 && String(el.text).includes('VM-USER-MSG'))
const vmWhoSpans = vm1.elements.filter((el) => el.type === 'span' && el.props?.style?.fontWeight === 600 && 'color' in (el.props.style ?? {}))
check(
  'v4⑥vm：用户消息行右对齐、与会者消息行左对齐、气泡圆角且无边框；名字 span 走 whoStyle（同 kind/名字同色）',
  Boolean(vmUserRow) && Boolean(vmAgentRow) && Boolean(vmUserBubble) && !('border' in (vmUserBubble.props?.style ?? {})) &&
    vmWhoSpans.length >= 1 && typeof vmWhoSpans[0].props.style.color === 'string' &&
    vmWhoSpans.every((el) => el.props.style.color === vmWhoSpans[0].props.style.color),
  `user=${Boolean(vmUserRow)} agent=${Boolean(vmAgentRow)} bubble=${Boolean(vmUserBubble)} colors=${json(vmWhoSpans.map((el) => el.props.style.color)).slice(0, 120)}`,
)
await vm1.tap('策划会议')
await vm1.tap('邀请会话 AI')
check(
  'v4⑤vm：邀请列表显示名优先会话真标题（不回落旧 label），统计行显示「共 5 条，已隐藏 3 条」',
  vmHtml(vm1).includes('接口对齐') && !vmHtml(vm1).includes('旧名字') &&
    vmHtml(vm1).includes('共 5 条') && vmHtml(vm1).includes('已隐藏 3 条') && vmHtml(vm1).includes('写文档'),
  vmHtml(vm1).slice(0, 300),
)
await vm1.tap('关闭')
// v9①：「看全文」已从抽屉挪进右栏「会议结果」页签 —— 先把右栏切到结果页签
await vm1.tap('会议结果 (1)')
await vm1.tap('看全文')
check(
  'v4②vm：房间面板点「看全文」→ selectPanel(结果键)，宿主 main 槽位随之只渲染 ResultTab（房间面板不再渲染）',
  vm1.selectPanelCalls.includes('dsh-meeting-room:result:m-main') &&
    vm1.selectPanelCalls.every((id) => id === 'dsh-meeting-room' || String(id).startsWith('dsh-meeting-room:result:')) &&
    !vmHtml(vm1).includes('策划会议'),
  `calls=${json(vm1.selectPanelCalls)} texts=${vmHtml(vm1).slice(0, 200)}`,
)

// 新建屏单独用一个实例：房间面板/结果页签的状态不互相影响（真宿主也只会渲染活动键那一个 main 面板）
const vm2 = await mountClientVm({
  rooms: [{ id: 'm-main', title: '算法评审', category: CAT, status: 'open', archived: false, resultCount: 1, recorder: { kind: 'builtin', label: '记录员' } }],
  sessions: [],
  results: [],
})
await vm2.tap('＋ 新建会议室', 0)
check(
  'v4②vm：面板内「＋ 新建会议室」→ 内部切到新建屏（分类目录/创建/取消 可见），宿主 selectPanel 只被叫一次（PANEL_ID）',
  vm2.selectPanelCalls.length === 1 && vm2.selectPanelCalls[0] === 'dsh-meeting-room' &&
    vmHtml(vm2).includes('换分类目录') && vmHtml(vm2).includes('创建') && vmHtml(vm2).includes('取消') && vm2.errors.length === 0,
  `calls=${json(vm2.selectPanelCalls)} texts=${vmHtml(vm2).slice(0, 200)}`,
)

const vm3 = await mountClientVm({
  rooms: [{ id: 'm-solo', title: '单人房', category: CAT, status: 'open', archived: false, resultCount: 0, recorder: { kind: 'builtin', label: '记录员' } }],
  sessions: [],
  sessionMeta: false,
  results: [],
})
await vm3.tap('单人房')
await vm3.tap('策划会议')
await vm3.tap('邀请会话 AI')
check(
  'v4⑤vm：旧宿主（/sessions 不带 total/filtered）不渲染统计行；空列表显示「没有可邀请的顶层会话」',
  vmHtml(vm3).includes('没有可邀请的顶层会话') && !vmHtml(vm3).includes('只列顶层会话') && vm3.errors.length === 0,
  `errors=${json(vm3.errors.slice(0, 2)).slice(0, 200)} texts=${vmHtml(vm3).slice(0, 200)}`,
)

// ---------- v5②③④：滚动策略 / 投递档位文案 / 会议文件抽屉（real client.js + 假宿主） ----------
const vmSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// v6③：自带对话框的「确认」按钮与页面里同名按钮会同时出现在渲染树里（典型：结果列表的「驳回」与
// 对话框的「驳回」）。v9 起右栏（RoomSide）渲染在对话框之后，末位匹配会点到右栏的行按钮上；
// 这里优先点对话框里的确认按钮（S.btnPrimary ⇒ 有底色），没有再退回落最后一个。
const vmTapLast = async (state, label, waitMs = 60) => {
  state.renderAll()
  const hits = state.buttons.filter((button) => String(button.text ?? '').includes(label))
  if (!hits.length) throw new Error(`渲染树里找不到按钮「${label}」，现有按钮：${state.buttons.map((button) => String(button.text ?? '')).join(' / ').slice(0, 200)}`)
  const primary = hits.filter((button) => {
    const background = button.props?.style?.background
    return typeof background === 'string' && background !== 'transparent'
  })
  const pool = primary.length ? primary : hits
  const hit = pool[pool.length - 1]
  try {
    const out = hit.props.onClick()
    if (out && typeof out.then === 'function') await out
  } catch (error) {
    state.errors.push(`点击「${label}」抛错：${error?.message ?? error}`)
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  state.renderAll()
  return state
}
const vmPostsTo = (state, fragment) => state.fetchBodies.filter((item) => item.url.includes(fragment))
const vm4Data = {
  rooms: [
    { id: 'm-main', title: '算法评审', category: CAT, status: 'open', archived: false, resultCount: 0, liveCount: 0, memberCount: 1, push: 'off', recorder: { kind: 'builtin', label: '记录员' } },
  ],
  sessions: [],
  results: [],
  files: [{ name: '记要.md', bytes: 2048 }],
  scrollHeight: 640,
}
const vm4 = await mountClientVm(vm4Data)
await vm4.tap('算法评审') // 进房间面板（首帧 view.loaded 仍是 false）
await vmSleep(50)
vm4.renderAll() // pullRoom 落地 → view.loaded 翻 true → 首载 effect 跑一次
await vmSleep(20) // 等 setTimeout(toBottom, 0)
const vm4Scroll = vm4.scrollNow()
const vmFirstLoadSets = vm4Scroll ? vm4Scroll.sets.slice() : []
check(
  'v5②vm：房间首载完成 → scrollTop 被设为 scrollHeight（恰好一次；didFirstScroll 保证不重复滚）',
  Boolean(vm4Scroll) && vmFirstLoadSets.length === 1 && vmFirstLoadSets[0] === 640 && vm4Scroll.scrollTop === 640,
  `sets=${json(vmFirstLoadSets)} scrollTop=${vm4Scroll?.scrollTop} refs=${vm4.scrollNodes.length} errors=${json(vm4.errors.slice(0, 2)).slice(0, 160)}`,
)
// 轮询：手动拉一拍 setInterval 回调（真跑 1.5s 太慢），用户正在翻记录时不该被拽回底部
vm4Scroll.sets.length = 0
vm4Scroll._top = 0
await vm4.pollOnce(60)
check(
  'v5②vm：轮询一轮（手动拉 setInterval 回调）不强制滚动（scrollTop 未被重新赋值）',
  vm4Scroll.sets.length === 0 && vm4Scroll.scrollTop === 0 && vm4.fetchLog.some((url) => String(url).includes('/rooms/m-main/state')),
  `新增赋值=${json(vm4Scroll.sets)} scrollTop=${vm4Scroll.scrollTop} 轮询次数=${vm4.fetchLog.filter((url) => String(url).includes('/rooms/m-main/state')).length}`,
)

// 会议文件右侧栏（v9①：v5 的页头抽屉 + overlay 已下线，改成 RoomSide 常驻右栏）
await vm4.tap('会议文件')
check(
  'v9①vm：点页头「会议文件」→ 右栏（RoomSide）列出「记要.md」与字节数，且 0 个 overlay/sheet 弹层',
  vmHtml(vm4).includes('记要.md') && vmHtml(vm4).includes('2.0 KB') &&
    !vm4.elements.some((el) => el.props?.style?.zIndex === 60) && !vm4.elements.some((el) => el.props?.style?.zIndex === 61) &&
    vm4.errors.length === 0,
  `file=${vmHtml(vm4).includes('记要.md')} bytes=${vmHtml(vm4).includes('2.0 KB')} overlay=${vm4.elements.filter((el) => el.props?.style?.zIndex === 60 || el.props?.style?.zIndex === 61).length} errors=${json(vm4.errors.slice(0, 2)).slice(0, 160)}`,
)
await vm4.tap('记要.md')
const vmFileLink = vm4.elements.find((el) => el.type === 'a' && typeof el.props?.href === 'string' &&
  el.props.href.includes(`/rooms/m-main/raw?name=${encodeURIComponent('记要.md')}`))
check(
  'v9①vm：点右栏文件名 → 出「原文件」外链（raw?name=记要.md）与预览区（取正文一次）',
  Boolean(vmFileLink) && vm4.fetchLog.some((url) => String(url).includes('/rooms/m-main/file?name=')) && vm4.errors.length === 0,
  `link=${String(vmFileLink?.props?.href ?? '').slice(0, 120)} fetch=${vm4.fetchLog.filter((url) => String(url).includes('/file?name=')).length} errors=${json(vm4.errors.slice(0, 2)).slice(0, 160)}`,
)
await vm4.tap('收起侧栏')
check(
  'v15③vm：点「收起侧栏」→ 右栏整块不再渲染（raw 链接与页签都消失，页头那个开关变「会议文件」）',
  !vm4.elements.some((el) => el.type === 'a' && String(el.props?.href ?? '').includes('/raw?name=')) &&
    !vmHtml(vm4).includes('还没有会议文件。') && vmHtml(vm4).includes('会议文件'),
  `rawLinks=${vm4.elements.filter((el) => el.type === 'a' && String(el.props?.href ?? '').includes('/raw?name=')).length} 会议文件=${vmHtml(vm4).includes('会议文件')}`,
)
await vm4.tap('会议文件')
check(
  'v15③vm：点页头「会议文件」→ 右栏回来且仍停在 files 页签（view.sideTab 记住了选择）',
  vmHtml(vm4).includes('还没有会议文件。') === false && vmHtml(vm4).includes('记要.md') && vmHtml(vm4).includes('收起侧栏'),
  `含记要=${vmHtml(vm4).includes('记要.md')} 收起=${vmHtml(vm4).includes('收起侧栏')}`,
)
// v17③vm：composer 下方那条长提示整条没了；数据条改挂在 composer 之后（真渲染顺序：发送按钮 → 数据条）
const vmHintGone = () => !vmHtml(vm4).includes('你的消息只留在会议室记录里') && !vmHtml(vm4).includes('不会进入与会者对话')
check(
  'v17③vm：长提示整页 0 命中；唤醒与会者/「默认投递：」/旧三档文案仍 0 命中',
  vmHintGone() &&
    !vmHtml(vm4).includes('唤醒与会者') &&
    !vmHtml(vm4).includes('默认投递：') && !vmHtml(vm4).includes('只记录，不通知') && !vmHtml(vm4).includes('提醒并附上全文'),
  `提示残留=${!vmHintGone()} 唤醒=${vmHtml(vm4).includes('唤醒与会者')} 默认投递=${vmHtml(vm4).includes('默认投递：')}`,
)
check(
  'v17③vm：与会者没有 stats 时数据条整条不渲染（不占地方、不显示假数字）',
  !vmHtml(vm4).includes('轮次 '),
  `stats=${vmHtml(vm4).includes('轮次 ')} texts=${vmHtml(vm4).slice(-160)}`,
)
vm4Data.members = [{ sessionId: 'sess-a-1', label: '接口对齐', live: true, stats: { turns: 3, steps: 12, totalTokens: 12345, cacheReadTokens: 10000, contextPercent: 7 } }]
await vm4.pollOnce(70)
const vmStatsTexts = vm4.texts
check(
  'v17③vm：有 stats 后数字条渲染在 composer 之后（发送按钮 → 轮次/步/累计/缓存命中/上下文 五个 pill）',
  vmStatsTexts.indexOf('轮次 3') > vmStatsTexts.indexOf('发送') &&
    vmHtml(vm4).includes('步 12') && vmHtml(vm4).includes('累计 12K tok') &&
    vmHtml(vm4).includes('缓存命中 81%') && vmHtml(vm4).includes('上下文 7%（接口对齐）') &&
    vm4.errors.length === 0,
  `轮次=${vmStatsTexts.indexOf('轮次 3')} 发送=${vmStatsTexts.indexOf('发送')} html=${vmHtml(vm4).slice(-200)}`,
)
delete vm4Data.members
await vm4.pollOnce(70)
check(
  'v17③vm：stats 消失后数据条随之消失（不留上一轮数字）',
  !vmHtml(vm4).includes('轮次 ') && vm4.errors.length === 0,
  `残留=${vmHtml(vm4).includes('轮次 ')}`,
)
// v6①：房间 push 只管「要不要唤醒」，跟用户正文/页面其它内容都无关（full 已下线 ⇒ 载入归一 off，PATCH full 400）
vm4Data.rooms[0].push = 'notice'
await vm4.pollOnce(60)
const vmHtmlNotice = vmHtml(vm4)
vm4Data.rooms[0].push = 'full'
await vm4.pollOnce(60)
check(
  'v6③vm：房间 push 改成 notice/full 都不改房间面板内容，也不渲染任何投递档位（页头无人数 chip）',
  vmHtmlNotice === vmHtml(vm4) &&
    !vmHtml(vm4).includes('默认投递：') && !vmHtml(vm4).includes('只记录，不通知') &&
    !/\d+\s*\/\s*\d+\s*人/.test(vmHtml(vm4)),
  `notice=${vmHtmlNotice.slice(-90)} full=${vmHtml(vm4).slice(-90)}`,
)
await vm4.tap('策划会议')
check(
  'v7③vm：「策划会议」抽屉两行说明 + 第二行「每次发送后…提醒」+「思考程度（房间默认）」，唤醒与会者与旧标题 0 命中',
  vmHtml(vm4).includes('你和与会者 AI 之间') &&
    vmHtml(vm4).includes('不会出现在与会者的对话里') &&
    vmHtml(vm4).includes('每次发送后') && vmHtml(vm4).includes('不含你的正文') &&
    vmHtml(vm4).includes('思考程度（房间默认）') && !vmHtml(vm4).includes('唤醒与会者') &&
    !vmHtml(vm4).includes('只记录，不通知') && !vmHtml(vm4).includes('别人（与会者 AI）怎么收到我的消息'),
  vmHtml(vm4).slice(0, 400),
)
// v7③D：踢人链路 —— 点 ✕ 立即 POST（不再弹对话框、不带 reason、不调原生弹窗）。v7 取消了「填理由」路径，
// 因此也不再存在「取消 ⇒ 0 请求」这种依赖对话框的用例。
const vmKickBefore = vmPostsTo(vm4, '/kick').length
const vmAutoFocusBefore = vm4.elements.filter((el) => el.type === 'input' && el.props?.autoFocus === true).length
await vm4.tap('✕')
const vmKickPosts = vmPostsTo(vm4, '/kick')
check(
  'v7③vm：点成员行 ✕ 立即 POST /rooms/m-main/kick，body 恰 {sessionId, notify:true}（无 reason 字段）',
  vmKickPosts.length === vmKickBefore + 1 &&
    vmKickPosts.at(-1).body.sessionId === 'sess-a-1' &&
    vmKickPosts.at(-1).body.notify === true &&
    !('reason' in vmKickPosts.at(-1).body) &&
    Object.keys(vmKickPosts.at(-1).body).sort().join(',') === 'notify,sessionId' &&
    vm4.nativePopups.length === 0,
  `body=${json(vmKickPosts.at(-1)?.body)} 请求数=${vmKickPosts.length} 原生弹窗=${json(vm4.nativePopups)}`,
)
check(
  'v7③vm：踢人不再经过自带对话框（Dialog 渲染 0 次：无「理由」标题、无新增 autoFocus 输入框）',
  !vmHtml(vm4).includes('的理由（可选）') &&
    vm4.elements.filter((el) => el.type === 'input' && el.props?.autoFocus === true).length === vmAutoFocusBefore &&
    vm4.nativePopups.length === 0,
  `对话框输入框=${vm4.elements.filter((el) => el.type === 'input' && el.props?.autoFocus === true).length}/${vmAutoFocusBefore} 含理由标题=${vmHtml(vm4).includes('的理由（可选）')}`,
)
await vm4.tap('关闭')
// v6③D：required 拦截 —— 结果列表「驳回」弹必填对话框；空值确认被拦（不关框、不发请求）
vm4Data.results = [{ goalId: 'g-1', title: '算法评审 · 会议结果', status: 'draft' }]
await vm4.pollOnce(60)
// v9①：结果行在右栏「会议结果」页签里
await vm4.tap('会议结果 (')
const vmRejectBefore = vmPostsTo(vm4, '/results/g-1/reject').length
await vm4.tap('驳回')
check(
  'v6③vm：结果列表点「驳回」→ 自带必填对话框（标题「驳回原因（必填）」+ 取消/驳回按钮），原生弹窗 0 次',
  vmHtml(vm4).includes('驳回原因（必填）') && vmHtml(vm4).includes('取消') &&
    vm4.elements.some((el) => el.type === 'input' && el.props?.autoFocus === true) &&
    vm4.nativePopups.length === 0,
  `标题=${vmHtml(vm4).includes('驳回原因（必填）')} 原生弹窗=${json(vm4.nativePopups)}`,
)
await vmTapLast(vm4, '驳回')
check(
  'v6③vm：必填空值直接确认 ⇒ 不关框、不发请求、显示错误行「必填」（confirmDialog 的 required 守卫）',
  vmPostsTo(vm4, '/results/g-1/reject').length === vmRejectBefore &&
    vmHtml(vm4).includes('驳回原因（必填）') &&
    vm4.elements.some((el) => String(el.text) === '必填') && vm4.nativePopups.length === 0,
  `reject 请求=${vmPostsTo(vm4, '/results/g-1/reject').length} 错误行=${vm4.elements.some((el) => String(el.text) === '必填')}`,
)
const vmRejectInput = vm4.elements.find((el) => el.type === 'input' && el.props?.autoFocus === true)
if (vmRejectInput) vmRejectInput.props.onChange({ target: { value: '证据不足' } })
vm4.renderAll()
await vmTapLast(vm4, '驳回')
const vmRejects = vmPostsTo(vm4, '/results/g-1/reject')
check(
  'v6③vm：填入理由再确认 ⇒ POST /rooms/m-main/results/g-1/reject body={note, by}，对话框关闭',
  vmRejects.length === vmRejectBefore + 1 && vmRejects.at(-1).body.note === '证据不足' &&
    vmRejects.at(-1).body.by === '我' && !vmHtml(vm4).includes('驳回原因（必填）'),
  `body=${json(vmRejects.at(-1)?.body)} 请求数=${vmRejects.length}`,
)
// sendPost：自己发完消息后才滚到底（v5②的第二条滚动通路）
const vm4Composer = vm4.elements.find((el) => el.type === 'textarea' && String(el.props?.placeholder ?? '').includes('对会议室说点什么'))
if (vm4Composer) vm4Composer.props.onChange({ target: { value: 'VM-POST-TEXT' } })
vm4.renderAll()
vm4Scroll.sets.length = 0
vm4Scroll._top = 0
await vm4.tap('发送', 80)
check(
  'v5②vm：自己发完消息（sendPost）后滚到底一次（scrollTop === scrollHeight，POST 真的发出去了）',
  Boolean(vm4Composer) && vm4Scroll.sets.length >= 1 && vm4Scroll.scrollTop === vm4Scroll.scrollHeight &&
    vm4.fetchLog.some((url) => String(url).includes('/rooms/m-main/post')),
  `sets=${json(vm4Scroll.sets)} post=${vm4.fetchLog.filter((url) => String(url).includes('/post')).length} errors=${json(vm4.errors.slice(0, 2)).slice(0, 160)}`,
)
// v7③vm：vm 实测发帖请求体（不是源码推断）——固定 mode:'notice'，未点名时 keys 恰 mode+text
const vmSendBodies = vmPostsTo(vm4, '/rooms/m-main/post')
check(
  "v7③vm：sendPost 真发出的请求 body 恰 { text:'VM-POST-TEXT', mode:'notice' }（未点名 ⇒ 无 to/files）",
  vmSendBodies.length >= 1 &&
    vmSendBodies.at(-1).body.text === 'VM-POST-TEXT' &&
    vmSendBodies.at(-1).body.mode === 'notice' &&
    Object.keys(vmSendBodies.at(-1).body).sort().join(',') === 'mode,text',
  json(vmSendBodies.at(-1)?.body ?? null),
)

// v14③④vm：消息索引真渲染 —— 一个轮次一个刻度（主持人发言 #1/#6、目标时间点 #3/#5），与会者发言 #2/#4 不上索引；
// 目标刻度用主题色加长加粗；悬停出预览卡；点击滚到那条消息并停止自动跟随；内容没溢出（span <= h+4）时一条都不画。
const vmRailRoom = { id: 'm-main', title: '索引用例', category: CAT, status: 'open', archived: false, resultCount: 0, recorder: { kind: 'builtin', label: '记录员' } }
const vmRailMsgs = [
  { seq: 1, at: 1, kind: 'chat', author: { kind: 'user', id: 'u-me', label: '我' }, text: '开场' },
  { seq: 2, at: 2, kind: 'chat', author: { kind: 'agent', id: 'sess-a-1', label: '接口对齐' }, text: '第一条意见' },
  { seq: 3, at: 3, kind: 'goal', author: { kind: 'system', id: 'system', label: '系统' }, text: '会议目标已定：写一篇湿纸巾的文章', data: { goalId: 'g-rail' } },
  { seq: 4, at: 4, kind: 'chat', author: { kind: 'agent', id: 'sess-a-1', label: '接口对齐' }, text: '第二条意见' },
  { seq: 5, at: 5, kind: 'goal-complete', author: { kind: 'agent', id: 'sess-a-1', label: '接口对齐' }, text: '任务已完成：写一篇湿纸巾的文章', data: { goalId: 'g-rail' } },
  { seq: 6, at: 6, kind: 'chat', author: { kind: 'user', id: 'u-me', label: '我' }, text: '收尾' },
]
const vmRail = await mountClientVm({ rooms: [vmRailRoom], sessions: [], results: [], files: [], clientHeight: 40, clientWidth: 400, messages: vmRailMsgs })
await vmRail.tap('索引用例')
const vmRailSeqOf = (el) => Number(String(el.props?.['aria-label'] ?? '').replace('跳到 #', ''))
const vmRailMarks = vmRail.elements.filter((el) => el.type === 'button' && String(el.props?.['aria-label'] ?? '').startsWith('跳到 #'))
const vmRailGoal = vmRailMarks.find((el) => vmRailSeqOf(el) === 3)
const vmRailSpans = vmRail.elements.filter((el) => el.type === 'span' && (el.props?.['data-mark'] === 'goal' || el.props?.['data-mark'] === 'turn'))
const vmRailStyleOf = (seq) => {
  const index = vmRailMarks.findIndex((el) => vmRailSeqOf(el) === seq)
  return (index >= 0 ? vmRailSpans[index]?.props?.style : null) || {}
}
const vmRailGoalStyles = [3, 5].map((seq) => vmRailStyleOf(seq))
const vmRailTurnStyles = [1, 6].map((seq) => vmRailStyleOf(seq))
check(
  'v14③④vm：索引真渲染 —— 4 个轮次刻度（主持人 #1/#6、目标 #3/#5），目标刻度主题色加长加粗，与会者 #2/#4 不上索引',
  vmRailMarks.map((el) => vmRailSeqOf(el)).join(',') === '1,3,5,6' &&
    vmRailSpans.length === 4 &&
    vmRailSpans.map((el) => el.props['data-mark']).join(',') === 'turn,goal,goal,turn' &&
    vmRailGoalStyles.every((style) => style.width === 20 && style.height === 3) &&
    vmRailGoalStyles.some((style) => style.background === 'var(--dsw-alias-brand-primary)' && style.opacity === 0.85) &&
    vmRailTurnStyles.every((style) => style.height === 2 && (style.width === 12 || style.width === 20)) &&
    !vmHtml(vmRail).includes('跳到 #7') &&
    vmRail.errors.length === 0,
  `刻度=${vmRailMarks.map((el) => vmRailSeqOf(el)).join(',')} 标记=${vmRailSpans.map((el) => el.props['data-mark']).join(',')} 目标条=${json(vmRailGoalStyles)} 普通条=${json(vmRailTurnStyles)} errors=${json(vmRail.errors.slice(0, 2)).slice(0, 160)}`,
)
if (vmRailGoal) vmRailGoal.props.onMouseEnter()
vmRail.renderAll()
check(
  'v13④vm：悬停某条横条 → 只出这一个预览卡（`#序号 正文`），移开就收回去',
  vmHtml(vmRail).includes('#3　会议目标已定') && vmRail.errors.length === 0,
  `preview=${vmHtml(vmRail).includes('#3　会议目标已定')} errors=${json(vmRail.errors.slice(0, 2)).slice(0, 160)}`,
)
// 点击横条 = 滚到那条消息 + 停止自动跟随（否则用户一点就被新消息拽回底部）
if (vmRailGoal) vmRailGoal.props.onClick()
check(
  'v13④vm：点横条 → 对那条消息 scrollIntoView({block:start,behavior:smooth})，且把「跟随最新」关掉（不跟随时才出现「跳到最新」按钮）',
  vmRail.scrollCalls.some((call) => call && call.block === 'start' && call.behavior === 'smooth') &&
    vmRail.errors.length === 0,
  `scrollCalls=${json(vmRail.scrollCalls.slice(0, 3))} errors=${json(vmRail.errors.slice(0, 2)).slice(0, 160)}`,
)
// 内容没溢出（span <= clientHeight+4）时一条横条都不该画
const vmRailShort = await mountClientVm({ rooms: [vmRailRoom], sessions: [], results: [], files: [], clientHeight: 400, clientWidth: 400, messages: vmRailMsgs.slice(0, 2) })
await vmRailShort.tap('索引用例')
check(
  'v13④vm：内容没溢出（2 条消息、视口 400px）时索引一条都不画（不占位、不报错）',
  vmRailShort.elements.filter((el) => el.type === 'button' && String(el.props?.['aria-label'] ?? '').startsWith('跳到 #')).length === 0 &&
    vmRailShort.errors.length === 0,
  `横条=${vmRailShort.elements.filter((el) => el.type === 'button' && String(el.props?.['aria-label'] ?? '').startsWith('跳到 #')).length} errors=${json(vmRailShort.errors.slice(0, 2)).slice(0, 160)}`,
)

const vm5 = await mountClientVm({
  rooms: [{ id: 'm-main', title: '算法评审', category: CAT, status: 'open', archived: false, resultCount: 0, recorder: { kind: 'builtin', label: '记录员' } }],
  sessions: [],
  results: [],
  files: [],
})
// v9①：右栏是常驻的（默认 sideOpen:true / sideTab:'files'），没有文件时直接显示空态
await vm5.tap('算法评审')
await vm5.tap('会议文件')
check(
  'v9①vm：没有文件时右栏显示空态「还没有会议文件。」（不是空白，也没有渲染错误），两个页签都在',
  vmHtml(vm5).includes('还没有会议文件。') && vmHtml(vm5).includes('会议结果 (0)') && vm5.errors.length === 0,
  `errors=${json(vm5.errors.slice(0, 2)).slice(0, 200)} texts=${vmHtml(vm5).slice(0, 200)}`,
)
// v6③D：第 5 处对话框（散会）—— 预填默认标题、取消即 dismissDialog（原生弹窗 0 次）
await vm5.tap('策划会议')
await vm5.tap('散会')
check(
  'v6③vm：「散会」弹自带对话框且预填默认标题「会议已散会」（不再 window.prompt），原生弹窗 0 次',
  vmHtml(vm5).includes('散会标题（可选）') &&
    vm5.elements.some((el) => el.type === 'input' && el.props?.value === '会议已散会') &&
    vm5.elements.some((el) => el.type === 'input' && el.props?.autoFocus === true) &&
    vm5.nativePopups.length === 0,
  `标题=${vmHtml(vm5).includes('散会标题（可选）')} 原生弹窗=${json(vm5.nativePopups)}`,
)
await vmTapLast(vm5, '取消')
check(
  'v6③vm：散会对话框点「取消」⇒ 不 POST /close、对话框收掉（取消路径不执行 onOk）',
  vmPostsTo(vm5, '/close').length === 0 &&
    !vmHtml(vm5).includes('散会标题（可选）') && vm5.nativePopups.length === 0,
  `close 请求=${vmPostsTo(vm5, '/close').length} 弹窗残留=${vmHtml(vm5).includes('散会标题（可选）')}`,
)
const vmInstances = [['vm1', vm1], ['vm2', vm2], ['vm3', vm3], ['vm4', vm4], ['vm5', vm5]]
check(
  'v6③D：五个真渲染实例把主要交互全点了一遍，window.prompt / confirm / alert 命中总数 0',
  vmInstances.every(([, state]) => state.nativePopups.length === 0) &&
    vmInstances.every(([, state]) => state.errors.length === 0),
  json(vmInstances.map(([name, state]) => `${name}: 弹窗${state.nativePopups.length} 错误${state.errors.length}`)).slice(0, 220),
)

// ---------------------------------------------------------------- v10：面板粘性守卫（真订阅驱动）
section('v10：面板粘性守卫（外壳清空选中态时，按「用户有没有在导航」决定抢不抢回）')

const vm6 = await mountClientVm({
  rooms: [{ id: 'm-main', title: '算法评审', category: CAT, status: 'open', archived: false, resultCount: 0, recorder: { kind: 'builtin', label: '记录员' } }],
  sessions: [], results: [], files: [],
})
const vm6Count = () => vm6.selectPanelCalls.filter((id) => id === 'dsh-meeting-room').length
check(
  'v10①vm：守卫订上了宿主 panelInfo（followActive 订阅 1 次）',
  vm6.panelSubs.length === 1 && vm6.sessionSubs.length === 1,
  `panelSubs=${vm6.panelSubs.length} sessionSubs=${vm6.sessionSubs.length}`,
)
await vm6.tap('算法评审')
vm6.setPanel('dsh-meeting-room')
const vm6Base = vm6Count()
vm6.setPanel('')
check(
  'v10②vm：停在会议室面板、用户没做任何导航动作，外壳把 activePanelId 清成空 → 守卫立刻抢回（selectPanel 恰 +1）',
  vm6Count() === vm6Base + 1 && vm6.errors.length === 0,
  `base=${vm6Base} now=${vm6Count()} last=${json(vm6.selectPanelCalls.slice(-3))} errors=${json(vm6.errors.slice(0, 2)).slice(0, 160)}`,
)
// 用户自己在导航：清空前 1.2 s 内有 pointerdown → 尊重，不抢
vm6.setPanel('dsh-meeting-room')
const vm6GestureBase = vm6Count()
vm6.fireGesture('pointerdown')
vm6.setPanel('')
check(
  'v10③vm：清空前 1.2 s 内有 pointerdown（用户在点会话/工作区）→ 守卫不抢（selectPanel 不变）',
  vm6Count() === vm6GestureBase,
  `base=${vm6GestureBase} now=${vm6Count()}`,
)
// 用户切到别的全局面板 → 明确尊重
vm6.setPanel('dsh-meeting-room')
const vm6OtherBase = vm6Count()
vm6.setPanel('some-other-plugin-panel')
check(
  'v10④vm：用户切到别的全局面板 → 守卫只记「离开」，不抢回',
  vm6Count() === vm6OtherBase,
  `base=${vm6OtherBase} now=${vm6Count()}`,
)
// sessions 列表变化（= 用户点了会话/工作区）后 0.7 s 内清空 → 不抢（走 ctx.sessions.list 真订阅）
await new Promise((resolve) => setTimeout(resolve, 1300))
vm6.setPanel('dsh-meeting-room')
const vm6SessBase = vm6Count()
vm6.sessionsChanged()
vm6.setPanel('')
check(
  'v10⑤vm：sessions 列表刚变（用户点了会话）→ 清空不抢（ctx.sessions.list 真订阅生效）',
  vm6Count() === vm6SessBase,
  `base=${vm6SessBase} now=${vm6Count()}`,
)
// 反复被清空（用户始终没导航）→ 6 s 内抢超 3 次就 giveUp，之后不再抢
await new Promise((resolve) => setTimeout(resolve, 1300))
for (let i = 0; i < 5; i += 1) {
  vm6.setPanel('dsh-meeting-room')
  vm6.setPanel('')
  await new Promise((resolve) => setTimeout(resolve, 450))
}
vm6.setPanel('dsh-meeting-room')
const vm6GiveBase = vm6Count()
vm6.setPanel('')
check(
  'v10⑥vm：外壳反复清空（用户始终没导航）→ 抢回超过 3 次即 giveUp，之后清空不再 selectPanel（不和外壳打架）',
  vm6Count() === vm6GiveBase && vm6.errors.length === 0,
  `base=${vm6GiveBase} now=${vm6Count()} calls=${json(vm6.selectPanelCalls.slice(-6))} errors=${json(vm6.errors.slice(0, 2)).slice(0, 160)}`,
)

// ---------------------------------------------------------------- F-case：大小写 / junction 等价路径护栏

section('F-case：大小写 / junction 等价路径护栏（Windows 折叠比较 + 真实路径复校）')

// 真机形状：状态根 = <home>/.dsh/meeting-room（configHome = <home>/.dsh）、分类 = <home>/dsh/会议。
// 靠 process.env.USERPROFILE/HOME 把 homedir 指向临时假主目录 —— 大小写与 junction 用例全都在临时目录里跑，
// 绝不碰真实 ~/.dsh 与真实 ~/dsh/会议。测试末尾还原环境变量。
const FC_WORK = path.join(WORK, 'fcase')
const FC_HOME = path.join(FC_WORK, 'home')
const FC_CFG = path.join(FC_HOME, '.dsh')
const FC_ROOT = path.join(FC_CFG, 'meeting-room')
const FC_CAT = path.join(FC_HOME, 'dsh', '会议')
const FC_OUTSIDE = path.join(FC_WORK, 'outside')
fs.mkdirSync(FC_HOME, { recursive: true })
fs.mkdirSync(FC_CAT, { recursive: true })
fs.mkdirSync(FC_OUTSIDE, { recursive: true })
const FC_ENV_BACKUP = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
process.env.USERPROFILE = FC_HOME
process.env.HOME = FC_HOME
const upperPath = (target) => path.resolve(target).toUpperCase()

const fcHost = createHost({ root: FC_ROOT, category: FC_CAT, roomId: 'main', agents: [] })
const { server: fcServer, base: fcBase } = await serve(fcHost)
const fcRooms = async () => (await GET(fcBase, '/dsh-room/rooms')).body?.rooms ?? []

check(
  'F-case 假主目录生效：homedir 指向临时 home，状态根 ~/.dsh/meeting-room、分类 <home>/dsh/会议（apply 无错）',
  os.homedir() === FC_HOME &&
    path.dirname(FC_ROOT) === FC_CFG &&
    upperPath(FC_CFG) !== FC_CFG &&
    fcHost.applyError === null &&
    fcHost.routes.length === 1,
  json({ homedir: os.homedir(), applyError: String(fcHost.applyError ?? ''), upper: upperPath(FC_CFG) }),
)

// ① 大小写翻转的配置目录内部
const fcCaseNew = path.join(upperPath(FC_CFG), 'CaseNew')
const fcCase1 = await POST(fcBase, '/dsh-room/rooms', { id: 'case-new', title: 'F-case ①', category: fcCaseNew })
check(
  'F-case ①POST {category:<CFG 全大写>/CaseNew} → 400，未 mkdir（含真实 CFG 下同名目录）、未登记',
  fcCase1.status === 400 &&
    !exists(fcCaseNew) &&
    !exists(path.join(FC_CFG, 'CaseNew')) &&
    !(await fcRooms()).some((r) => r.id === 'case-new'),
  json({ status: fcCase1.status, error: fcCase1.body?.error }),
)
const fcCase1b = await POST(fcBase, '/dsh-room/rooms', { id: 'case-new2', category: path.join(FC_CFG, 'CaseNewExact') })
check(
  'F-case ①′ 同一位置但大小写正确也 400（护栏按折叠后的位置判断，不是只挡全大写）',
  fcCase1b.status === 400 && !exists(path.join(FC_CFG, 'CaseNewExact')),
  json({ status: fcCase1b.status, error: fcCase1b.body?.error }),
)

// ② 大小写翻转的状态根内部
const fcRootSub = path.join(upperPath(FC_ROOT), 'sub')
const fcCase2 = await POST(fcBase, '/dsh-room/rooms', { id: 'case-sub', title: 'F-case ②', category: fcRootSub })
check(
  'F-case ②POST {category:<状态根全大写>/sub} → 400，真实状态根内没建目录、未登记',
  fcCase2.status === 400 && !exists(path.join(FC_ROOT, 'sub')) && !(await fcRooms()).some((r) => r.id === 'case-sub'),
  json({ status: fcCase2.status, error: fcCase2.body?.error }),
)

// ③ 大小写翻转 + 目录名 == 房间 id（原可骗过 purge 判据）
const fcPurgeCase = path.join(upperPath(FC_CFG), 'PurgeCase', 'case-purge')
const fcCase3 = await POST(fcBase, '/dsh-room/rooms', { id: 'case-purge', title: 'F-case ③', dir: fcPurgeCase })
check(
  'F-case ③POST {id:case-purge, dir:<CFG 全大写>/PurgeCase/case-purge} → 400，目录未创建',
  fcCase3.status === 400 && !exists(fcPurgeCase) && !exists(path.join(FC_CFG, 'PurgeCase')) && !(await fcRooms()).some((r) => r.id === 'case-purge'),
  json({ status: fcCase3.status, error: fcCase3.body?.error }),
)
const fcCase3Del = await DELETE(fcBase, '/dsh-room/rooms/case-purge?purge=1')
check('F-case ③′ 未登记的 case-purge 走 purge → 404（没登记就没东西可删）', fcCase3Del.status === 404, json(fcCase3Del.body))

// ④ P0：id=meeting-room + 状态根本身当房间目录，再 purge
const fcP0Dir = path.join(upperPath(FC_CFG), 'meeting-room')
const fcCase4 = await POST(fcBase, '/dsh-room/rooms', { id: 'meeting-room', title: 'F-case ④', dir: fcP0Dir })
check(
  'F-case ④（P0）POST {id:meeting-room, dir:<CFG 全大写>/meeting-room} → 400，状态根与 rooms.json 仍在',
  fcCase4.status === 400 &&
    exists(path.join(FC_ROOT, 'rooms.json')) &&
    !(await fcRooms()).some((r) => r.id === 'meeting-room'),
  json({ status: fcCase4.status, error: fcCase4.body?.error }),
)
const fcCase4Del = await DELETE(fcBase, '/dsh-room/rooms/meeting-room?purge=1')
check(
  'F-case ④′（P0）DELETE /rooms/meeting-room?purge=1 → 404 且状态根 rooms.json 未被删',
  fcCase4Del.status === 404 && exists(path.join(FC_ROOT, 'rooms.json')),
  json({ status: fcCase4Del.status, roomsJson: exists(path.join(FC_ROOT, 'rooms.json')) }),
)
const fcCase4b = await POST(fcBase, '/dsh-room/rooms', { id: 'meeting-room', dir: FC_ROOT })
check(
  'F-case ④″（P0 不用任何花招）POST {id:meeting-room, dir:<状态根本身>} → 400 且状态根完好',
  fcCase4b.status === 400 && exists(path.join(FC_ROOT, 'rooms.json')) && !exists(path.join(FC_ROOT, 'goals.json')),
  json({ status: fcCase4b.status, error: fcCase4b.body?.error }),
)

// ⑤ 全局设置也不能靠大小写把默认分类指进配置目录
const fcSetCase = path.join(upperPath(FC_CFG), 'SetCase')
const fcCase5 = await PATCH(fcBase, '/dsh-room/settings', { category: fcSetCase })
const fcSetAfter = await GET(fcBase, '/dsh-room/settings')
check(
  'F-case ⑤PATCH /settings {category:<CFG 全大写>/SetCase} → 400，未创建、settings.category 未变',
  fcCase5.status === 400 &&
    !exists(path.join(FC_CFG, 'SetCase')) &&
    fcSetAfter.body?.settings?.category === FC_CAT,
  json({ status: fcCase5.status, error: fcCase5.body?.error, category: fcSetAfter.body?.settings?.category }),
)

// ⑥ junction 指向配置目录（真实路径复校；建不出 junction 就显式记 skip，不静默跳过）
const fcLinkCfg = path.join(FC_WORK, 'link-cfg')
let fcLinkCfgError = ''
let fcLinkCfgOk = true
try {
  fs.symlinkSync(FC_CFG, fcLinkCfg, 'junction')
} catch (error) {
  fcLinkCfgOk = false
  fcLinkCfgError = String(error?.message ?? error)
}
if (fcLinkCfgOk) {
  const fcJ1 = await POST(fcBase, '/dsh-room/rooms', { id: 'junction-new', title: 'F-case ⑥', category: path.join(fcLinkCfg, 'JunctionNew') })
  check(
    'F-case ⑥junction→CFG：POST {category:<junction>/JunctionNew} → 400，真实 CFG 下未创建',
    fcJ1.status === 400 && !exists(path.join(FC_CFG, 'JunctionNew')),
    json({ status: fcJ1.status, error: fcJ1.body?.error }),
  )
  const fcJ2 = await POST(fcBase, '/dsh-room/rooms', { id: 'meeting-room', dir: path.join(fcLinkCfg, 'meeting-room') })
  check(
    'F-case ⑥′junction→CFG：POST {id:meeting-room, dir:<junction>/meeting-room} → 400 且状态根完好',
    fcJ2.status === 400 && exists(path.join(FC_ROOT, 'rooms.json')) && !exists(path.join(FC_ROOT, 'goals.json')),
    json({ status: fcJ2.status, error: fcJ2.body?.error }),
  )
} else {
  check('F-case ⑥junction 用例显式跳过（本机建不出 junction→CFG）', true, `[skip] symlinkSync(junction) 失败：${fcLinkCfgError}`)
}

// ⑦ 非回归：正常真机形状仍能建房间；junction 指向普通目录仍能用
const fcNormal = await POST(fcBase, '/dsh-room/rooms', { id: 'normal', title: '正常房间', category: FC_CAT })
check(
  'F-case ⑦非回归 POST {category:<home>/dsh/会议} → 200 且 room.json 落位（护栏没把正常形状一起挡掉）',
  fcNormal.status === 200 && exists(path.join(FC_CAT, 'normal', 'room.json')),
  json({ status: fcNormal.status, error: fcNormal.body?.error }),
)
const fcLinkOutside = path.join(FC_WORK, 'link-outside')
let fcLinkOutError = ''
let fcLinkOutOk = true
try {
  fs.symlinkSync(FC_OUTSIDE, fcLinkOutside, 'junction')
} catch (error) {
  fcLinkOutOk = false
  fcLinkOutError = String(error?.message ?? error)
}
if (fcLinkOutOk) {
  const fcJroom = await POST(fcBase, '/dsh-room/rooms', { id: 'jroom', title: '软链正例', dir: path.join(fcLinkOutside, 'jroom') })
  // 诊断（不改期望）：宿主用非 bigint 的 st.ino 做「同一位置」判据（index.js pathIdentity()），
  // 本机 ino ≈ 1e16 > 2^53 ⇒ 两个相差 1 的 ino 会舍入成同一个 double，guard 与目标目录可能被误判成同一位置。
  // 这条正例偶发误 400 时，detail 直接把碰撞对打出来，报告自带证据（期望仍是 200：正常 junction 就该能用）。
  const fcInoDiag = (() => {
    const picked = [
      ['guard:CFG', FC_CFG], ['guard:ROOT', FC_ROOT], ['guard:CAT', FC_CAT],
      ['target:link', fcLinkOutside], ['target:jroom', path.join(fcLinkOutside, 'jroom')], ['real:jroom', path.join(FC_OUTSIDE, 'jroom')],
    ]
    const rows = []
    for (const [name, target] of picked) {
      try {
        const st = fs.statSync(target, { bigint: true })
        rows.push({ name, bigint: String(st.ino), double: `${st.dev}:${Number(st.ino)}` })
      } catch { rows.push({ name, bigint: '(missing)', double: '' }) }
    }
    const byDouble = new Map()
    for (const row of rows) {
      if (!row.double) continue
      byDouble.set(row.double, [...(byDouble.get(row.double) ?? []), row.bigint])
    }
    const collisions = [...byDouble.entries()]
      .filter(([, inos]) => new Set(inos).size > 1)
      .map(([key, inos]) => `${key} ← ${inos.join(' / ')}`)
    return { inos: rows.map((row) => `${row.name}=${row.bigint}/${row.double}`), collisions }
  })()
  check(
    'F-case ⑦′非回归 POST {dir:<junction→普通目录>/jroom} → 200，真实目录真落盘',
    fcJroom.status === 200 && exists(path.join(FC_OUTSIDE, 'jroom', 'room.json')),
    json({ status: fcJroom.status, error: fcJroom.body?.error, inoCollisions: fcInoDiag.collisions, inos: fcInoDiag.inos }),
  )
} else {
  check('F-case ⑦′软链正例显式跳过（本机建不出 junction→普通目录）', true, `[skip] symlinkSync(junction) 失败：${fcLinkOutError}`)
}

// ⑧ 非回归：正常房间的 purge 仍然真的删目录（修复没把正常删除一起禁掉）
const fcPurgeOkDir = path.join(FC_CAT, 'purge-ok')
const fcPurgeOk = await POST(fcBase, '/dsh-room/rooms', { id: 'purge-ok', title: '正常删除', dir: fcPurgeOkDir })
check(
  'F-case ⑧非回归 POST {dir:<分类>/purge-ok} → 200 且目录已建',
  fcPurgeOk.status === 200 && exists(path.join(fcPurgeOkDir, 'room.json')),
  json({ status: fcPurgeOk.status, error: fcPurgeOk.body?.error }),
)
const fcPurgeDel = await DELETE(fcBase, '/dsh-room/rooms/purge-ok?purge=1')
check(
  'F-case ⑧′非回归 DELETE ?purge=1（目录名 == 房间 id）→ purged:true 且目录真的被删',
  fcPurgeDel.status === 200 && fcPurgeDel.body?.purged === true && !exists(fcPurgeOkDir),
  json(fcPurgeDel.body),
)

// ⑨ 非回归：状态根内部仍然一律禁写（不因为折叠比较而放宽）
const fcStateRoom = await POST(fcBase, '/dsh-room/rooms', { id: 'stateRoom', dir: path.join(FC_ROOT, 'stateRoom') })
check(
  'F-case ⑨非回归 POST {dir:<状态根>/<id>} → 400，状态根里还是只有两个 json',
  fcStateRoom.status === 400 && !exists(path.join(FC_ROOT, 'stateRoom')) && exists(path.join(FC_ROOT, 'rooms.json')),
  json({ status: fcStateRoom.status, error: fcStateRoom.body?.error }),
)

await closeServer(fcServer)
disposeHost(fcHost)
if (FC_ENV_BACKUP.USERPROFILE === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = FC_ENV_BACKUP.USERPROFILE
if (FC_ENV_BACKUP.HOME === undefined) delete process.env.HOME
else process.env.HOME = FC_ENV_BACKUP.HOME
check(
  'F-case 收尾：假主目录已还原（后续步骤回到真实 homedir，临时目录只落在 <tmp>/fcase）',
  os.homedir() !== FC_HOME && exists(FC_ROOT) && exists(FC_CAT),
  json({ homedir: os.homedir(), fcase: FC_WORK }),
)

// ---------------------------------------------------------------- v12
// ① 记录员看门狗（修「signal timed out」只报超时不给原因）② room_task_done ③ 文件管理
// 全部在独立状态根 / 独立分类目录上跑，不碰前面任何夹具的房间。

const V12_ROOT = path.join(WORK, 'v12-root')
const V12_CAT = path.join(WORK, 'v12-cat', '会议')

section('v12①：记录员看门狗（慢流不被误杀 / 卡死抛中文 503 并写进会议记录）')

const v12Host = createHost({ root: V12_ROOT, category: V12_CAT, recorderTimeoutMs: 300 })
v12Host.setLlmMode('slow')
const { server: v12Server, base: v12Base, ready: v12Ready } = await serveReady(v12Host, 'v12')
check(
  'v12 独立宿主就绪',
  v12Ready.ok === true,
  json(v12Ready.res?.body).slice(0, 160),
)
const v12Make = await POST(v12Base, '/dsh-room/rooms', { id: 'watch', title: '看门狗' })
check('v12：建房间 watch', v12Make.status === 200, json(v12Make.body).slice(0, 120))
const v12GoalRes = await POST(v12Base, '/dsh-room/rooms/watch/goals', { text: '看门狗用例目标' })
const v12Gid = v12GoalRes.body?.goal?.id
check('v12：目标已建', typeof v12Gid === 'string', json(v12GoalRes.body).slice(0, 120))

const slowDone = await POST(v12Base, `/dsh-room/rooms/watch/goals/${v12Gid}/complete`, {})
check(
  'v12①慢流（两段间隔 < 看门狗）：看门狗被每个 chunk 重置，草稿照常生成',
  slowDone.status === 200 && slowDone.body?.asked === true && slowDone.body?.result?.status === 'draft',
  json(slowDone.body).slice(0, 240),
)

v12Host.setLlmMode('normal')
const v12Goal2 = await POST(v12Base, '/dsh-room/rooms/watch/goals', { text: '看门狗卡死用例目标' })
const v12Gid2 = v12Goal2.body?.goal?.id
check('v12：第二个目标已建', typeof v12Gid2 === 'string', json(v12Goal2.body).slice(0, 120))
v12Host.setLlmMode('stall')
const stallDone = await POST(v12Base, `/dsh-room/rooms/watch/goals/${v12Gid2}/complete`, {})
v12Host.stallGate?.release()
v12Host.setLlmMode('normal')
check(
  'v12①卡死：300ms 看门狗 → 503 中文原因（不再是 signal timed out），result 保持 pending',
  stallDone.status === 503 && String(stallDone.body?.error ?? '').includes('超过 0 秒没有任何返回') &&
    (await GET(v12Base, '/dsh-room/rooms/watch/goals')).body?.goals?.find((g) => g.id === v12Gid2)?.result == null,
  'status=' + stallDone.status + ' ' + json(stallDone.body).slice(0, 200),
)
const stallMsg = (await GET(v12Base, '/dsh-room/rooms/watch/state?since=0')).body?.messages?.find((m) => String(m.text).includes('记录员没能整理出'))
check(
  'v12①：超时原因也写进会议记录（不能只回荡在 HTTP 响应体里）',
  !!stallMsg && stallMsg.kind === 'system',
  json(stallMsg).slice(0, 200),
)

section('v12②：room_task_done（与会者 AI 发出的「任务完成」指令）')

// 重新开一个进行中的目标：前面的 complete 会把目标收尾、activeGoalId 随之交棒/置空，
// room_task_done 要面对的正是「有一个还没收尾的目标」这种正常状态。
const v12Goal3 = await POST(v12Base, '/dsh-room/rooms/watch/goals', { text: '看门狗指令用例目标' })
const v12Gid3 = v12Goal3.body?.goal?.id
check('v12②：第三个目标已建（room_task_done 的收尾对象）', typeof v12Gid3 === 'string', json(v12Goal3.body).slice(0, 120))

const v12Tool = toolOf(v12Host, 'room_task_done')
check(
  'v12②：room_task_done 已注册，description 把「只在该收尾时调」和「汇报进展请用 room_goal_report」写清楚',
  !!v12Tool && String(v12Tool.description).includes('只在该收尾时调') === false &&
    String(v12Tool.description).includes('只在讨论真正得出结果') && String(v12Tool.description).includes('room_goal_report'),
  String(v12Tool?.description ?? '').slice(0, 200),
)
const taskDoneOutsider = await useTool(v12Host, 'room_task_done', { roomId: 'watch' }, 'sess-outsider')
check(
  'v12②：非与会者调用 → 中文拒绝（先 room_join）',
  String(taskDoneOutsider).includes('你还不在这个会议室里'),
  String(taskDoneOutsider).slice(0, 160),
)
const v12Join = await useTool(v12Host, 'room_join', { roomId: 'watch', label: '实现方' }, 'sess-impl')
check('v12②：room_join 与会', String(v12Join).includes('实现方'), String(v12Join).slice(0, 120))
const taskDoneOut = await useTool(v12Host, 'room_task_done', { roomId: 'watch', note: '重点记分工' }, 'sess-impl')
check(
  'v12②：与会者调 room_task_done → 目标 done + 记录员草稿 + 中文回执（等用户审核发布）',
  String(taskDoneOut).includes('已宣告任务完成') && String(taskDoneOut).includes('等用户审核发布') &&
    (await GET(v12Base, '/dsh-room/rooms/watch/goals')).body?.goals?.find((g) => g.id === v12Gid3)?.status === 'done',
  String(taskDoneOut).slice(0, 240),
)
const v12State = await GET(v12Base, '/dsh-room/rooms/watch/state?since=0')
const v12DoneMsg = (v12State.body?.messages ?? []).find((m) => String(m.text).includes('任务已完成：') && String(m.text).includes('room_task_done'))
check(
  'v12②：会议记录里留下「任务已完成：…（实现方 / room_task_done）」这一行',
  !!v12DoneMsg,
  json(v12DoneMsg).slice(0, 200),
)
const v12Again = await useTool(v12Host, 'room_task_done', { roomId: 'watch' }, 'sess-impl')
check(
  'v12②：目标已达成后再调 → 中文拒绝（已有草稿 / 没有进行中的目标），不重复出草稿',
  String(v12Again).includes('已有草稿') || String(v12Again).includes('没有进行中的会议目标'),
  String(v12Again).slice(0, 200),
)

section('v12③：文件布局迁移 / 保存方式 / 附件清理')

const v12RoomRes = await GET(v12Base, '/dsh-room/rooms/watch')
const v12Sum = v12RoomRes.body?.room ?? {}
const v12Dir = v12Sum.dir
check(
  'v12③：房间摘要带 dir / saveMode / recordsDir / resultsDir / attachmentsDir',
  typeof v12Dir === 'string' && v12Dir.length > 0 &&
    v12Sum.saveMode === 'all' &&
    typeof v12Sum.recordsDir === 'string' && v12Sum.recordsDir.endsWith('记录') &&
    typeof v12Sum.resultsDir === 'string' && v12Sum.resultsDir.endsWith(path.join('记录', '结果')) &&
    typeof v12Sum.attachmentsDir === 'string' && v12Sum.attachmentsDir.endsWith('附件'),
  json({ saveMode: v12Sum.saveMode, recordsDir: v12Sum.recordsDir, resultsDir: v12Sum.resultsDir, attachmentsDir: v12Sum.attachmentsDir }),
)
check(
  'v12③：新布局已建出（记录/结果/ 与 附件/）',
  fs.existsSync(path.join(v12Dir, '记录', '结果')) && fs.existsSync(path.join(v12Dir, '附件')),
  v12Dir,
)
check(
  'v12③：草稿写在新位置 记录/结果/<gid>.md（不再是 results/）',
  fs.existsSync(path.join(v12Dir, '记录', '结果', `${v12Gid}.md`)) && !fs.existsSync(path.join(v12Dir, 'results')) && !fs.existsSync(path.join(v12Dir, 'files')),
  fs.readdirSync(path.join(v12Dir, '记录', '结果')).join(','),
)

// v11 老布局（dir/results、dir/files）→ 一次性搬家到 记录/结果、附件
// v12 回归：标记文件已经在（第一个宿主启动时写过），旧目录是**后来**才出现的 —— 也必须再搬一次
fs.mkdirSync(path.join(v12Dir, 'results'), { recursive: true })
fs.writeFileSync(path.join(v12Dir, 'results', 'old.md'), 'OLD-RESULT')
fs.mkdirSync(path.join(v12Dir, 'files'), { recursive: true })
fs.writeFileSync(path.join(v12Dir, 'files', 'old.txt'), 'OLD-FILE')
const v12Host2 = createHost({ root: V12_ROOT, category: V12_CAT })
const { server: v12Server2, base: v12Base2, ready: v12Ready2 } = await serveReady(v12Host2, 'v12-第二次启动')
check('v12③：第二次启动的宿主已就绪', v12Ready2.ok === true, json(v12Ready2.res?.body).slice(0, 160))
check(
  'v12③：老布局一次性搬家 → 记录/结果/old.md + 附件/old.txt，且 记录/.v12-migrated 标记已写',
  fs.existsSync(path.join(v12Dir, '记录', '结果', 'old.md')) && !fs.existsSync(path.join(v12Dir, 'results')) &&
    fs.existsSync(path.join(v12Dir, '附件', 'old.txt')) && !fs.existsSync(path.join(v12Dir, 'files')) &&
    fs.existsSync(path.join(v12Dir, '记录', '.v12-migrated')),
  fs.existsSync(path.join(v12Dir, '记录')) ? fs.readdirSync(path.join(v12Dir, '记录')).join(',') : '（没有 记录/）',
)

// 保存方式：坏值回落 all、好值落盘 room.json、400 拒绝
await PATCH(v12Base, '/dsh-room/rooms/watch', { saveMode: 'bogus' })
const v12AfterBad = (await GET(v12Base, '/dsh-room/rooms/watch')).body?.room ?? {}
check('v12③：PATCH saveMode 非法值 → 400 且仍保持 all', v12AfterBad.saveMode === 'all', json(v12AfterBad.saveMode))
const v12Recorder = await PATCH(v12Base, '/dsh-room/rooms/watch', { saveMode: 'recorder' })
const v12RecorderMode = v12Recorder.body?.patch?.saveMode ?? v12Recorder.body?.room?.saveMode
check('v12③：PATCH saveMode=recorder → 200 + 值为 recorder', v12Recorder.status === 200 && v12RecorderMode === 'recorder', json(v12Recorder.body).slice(0, 160))
check(
  'v12③：saveMode 落进 room.json（重启后不丢）',
  JSON.parse(fs.readFileSync(path.join(v12Dir, 'room.json'), 'utf8')).saveMode === 'recorder',
  fs.readFileSync(path.join(v12Dir, 'room.json'), 'utf8').slice(0, 200),
)
const v12Host3 = createHost({ root: V12_ROOT, category: V12_CAT })
const { server: v12Server3, base: v12Base3, ready: v12Ready3 } = await serveReady(v12Host3, 'v12-重启验 saveMode')
check('v12③：第三次启动的宿主已就绪', v12Ready3.ok === true, json(v12Ready3.res?.body).slice(0, 160))
check(
  'v12③：重启后 saveMode 仍是 recorder（load() 白名单不漏字段）',
  ((await GET(v12Base3, '/dsh-room/rooms/watch')).body?.room ?? {}).saveMode === 'recorder',
  json((await GET(v12Base3, '/dsh-room/rooms/watch')).body?.room ?? {}).slice(0, 200),
)

// v12 回归：标记文件已在、旧目录后来又冒出来（用户把 v11 的 results/ 拷回来 / 上次搬一半失败）
// —— 必须再搬一次，而不是被标记一句「已迁移」就永远跳过
fs.mkdirSync(path.join(v12Dir, 'results'), { recursive: true })
fs.writeFileSync(path.join(v12Dir, 'results', 'late.md'), 'LATE-RESULT')
const v12Host4 = createHost({ root: V12_ROOT, category: V12_CAT })
const { server: v12Server4, ready: v12Ready4 } = await serveReady(v12Host4, 'v12-标记已存在后再启动')
check('v12③：第四次启动的宿主已就绪', v12Ready4.ok === true, json(v12Ready4.res?.body).slice(0, 160))
check(
  'v12③：标记文件已在时，后来出现的旧 results/ 仍会被搬进 记录/结果（不被标记跳过）',
  fs.existsSync(path.join(v12Dir, '记录', '结果', 'late.md')) && !fs.existsSync(path.join(v12Dir, 'results')),
  fs.readdirSync(path.join(v12Dir, '记录', '结果')).join(','),
)
fs.rmSync(path.join(v12Dir, '记录', '结果', 'late.md'), { force: true })

// 清空「附件/」再上传，让 cleaned 的计数是确定的（前面几次迁移可能已经往这里搬过文件）
const v12AttachDir = path.join(v12Dir, '附件')
for (const name of fs.readdirSync(v12AttachDir)) fs.rmSync(path.join(v12AttachDir, name), { recursive: true, force: true })

const v12Up1 = await POST(v12Base3, '/dsh-room/rooms/watch/upload', { name: 'a.txt', base64: Buffer.from('A').toString('base64') })
const v12Up2 = await POST(v12Base3, '/dsh-room/rooms/watch/upload', { name: 'b.txt', base64: Buffer.from('B').toString('base64') })
const v12FilesBefore = await GET(v12Base3, '/dsh-room/rooms/watch/files')
check(
  'v12③：两个附件落在 附件/',
  v12Up1.status === 200 && v12Up2.status === 200 && fs.existsSync(path.join(v12Dir, '附件', 'a.txt')) && fs.existsSync(path.join(v12Dir, '附件', 'b.txt')),
  json(v12FilesBefore.body).slice(0, 160),
)
const v12Close = await POST(v12Base3, '/dsh-room/rooms/watch/close', { title: '散会' })
check(
  'v12③：recorder 模式散会 → 附件清空、记录/结果 保留、响应带 cleaned',
  v12Close.status === 200 && v12Close.body?.cleaned === 2 &&
    !fs.existsSync(path.join(v12Dir, '附件', 'a.txt')) && !fs.existsSync(path.join(v12Dir, '附件', 'b.txt')) &&
    fs.existsSync(path.join(v12Dir, '记录', '结果', 'old.md')),
  'cleaned=' + String(v12Close.body?.cleaned) + ' ' + json(v12Close.body).slice(0, 160),
)

// all 模式：同样上传 + 散会，附件必须留着
await PATCH(v12Base3, '/dsh-room/rooms/watch', { saveMode: 'all' })
const v12Up3 = await POST(v12Base3, '/dsh-room/rooms/watch/upload', { name: 'keep.txt', base64: Buffer.from('K').toString('base64') })
const v12Close2 = await POST(v12Base3, '/dsh-room/rooms/watch/close', { title: '再散会' })
check(
  'v12③：all 模式散会 → 附件照旧留着、cleaned 为 0',
  v12Up3.status === 200 && v12Close2.status === 200 && (v12Close2.body?.cleaned ?? 0) === 0 && fs.existsSync(path.join(v12Dir, '附件', 'keep.txt')),
  'cleaned=' + String(v12Close2.body?.cleaned) + ' keep=' + fs.existsSync(path.join(v12Dir, '附件', 'keep.txt')),
)

// approve 也清一次（recorder 模式）
await PATCH(v12Base3, '/dsh-room/rooms/watch', { saveMode: 'recorder' })
const v12Up4 = await POST(v12Base3, '/dsh-room/rooms/watch/upload', { name: 'gone-on-approve.txt', base64: Buffer.from('G').toString('base64') })
const v12Approve = await POST(v12Base3, `/dsh-room/rooms/watch/results/${v12Gid}/approve`, { by: 'user' })
check(
  'v12③：recorder 模式发布《会议结果》→ 附件也清掉（cleaned>=1），结果文件仍在',
  v12Approve.status === 200 && (v12Approve.body?.cleaned ?? 0) >= 1 &&
    !fs.existsSync(path.join(v12Dir, '附件', 'gone-on-approve.txt')) && fs.existsSync(path.join(v12Dir, '记录', '结果', `${v12Gid}.md`)),
  'status=' + v12Approve.status + ' cleaned=' + String(v12Approve.body?.cleaned) + ' ' + json(v12Approve.body).slice(0, 160),
)

await closeServer(v12Server)
await closeServer(v12Server2)
await closeServer(v12Server3)
await closeServer(v12Server4)
disposeHost(v12Host)
disposeHost(v12Host2)
disposeHost(v12Host3)
disposeHost(v12Host4)

// ---------------------------------------------------------------- v13
// ① 会议文件夹可改（新建/选择文件夹 = 分类目录下新建一个文件夹，把整个房间搬进去，绝不允许搬进自己）
// ② 散会后不再自动接力 ③ 唤醒消息带「文件写在房间 附件/ 里」 ④ 消息索引（源码形状已在上面钉过）
// 全部在独立状态根 / 独立分类目录上跑，不碰前面任何夹具的房间。

const V13_ROOT = path.join(WORK, 'v13-root')
const V13_CAT = path.join(WORK, 'v13-cat', '会议')

section('v13①：换会议文件夹（同级新建/搬移 OK；搬进自己子目录、搬到分类目录本身一律 400）')

const v13Host = createHost({ root: V13_ROOT, category: V13_CAT, roomId: 'main', agents: ['v13-a', 'v13-b'] })
const { server: v13Server, base: v13Base, ready: v13Ready } = await serveReady(v13Host, 'v13')
check('v13 独立宿主就绪', v13Ready.ok === true, json(v13Ready.res?.body).slice(0, 160))
const v13Make = await POST(v13Base, '/dsh-room/rooms', { id: 'mv', title: '搬移用例' })
const v13Join = await POST(v13Base, '/dsh-room/rooms/mv/join', { sessionId: 'v13-a', label: 'v13-a' })
const v13Dir = path.join(V13_CAT, 'mv')
check(
  'v13①：房间建好，v12 目录布局到位（附件/ 记录/结果/）',
  v13Make.status === 200 && v13Join.status === 200 &&
    fs.existsSync(path.join(v13Dir, '附件')) && fs.existsSync(path.join(v13Dir, '记录', '结果')),
  json({ make: v13Make.status, join: v13Join.status, dir: v13Dir }),
)

const v13Self = await PATCH(v13Base, '/dsh-room/rooms/mv', { dir: path.join(v13Dir, '子文件夹') })
check(
  'v13①护栏：把目录改成它自己的子目录 → 400 中文说明（不是卡死 / 不是无限复制）',
  v13Self.status === 400 && String(v13Self.body?.error ?? '').includes('不能把会议文件目录改成它自己的子目录') &&
    !fs.existsSync(path.join(v13Dir, '子文件夹')),
  'status=' + v13Self.status + ' ' + json(v13Self.body).slice(0, 200),
)
const v13Cat = await PATCH(v13Base, '/dsh-room/rooms/mv', { dir: V13_CAT })
check(
  'v13①护栏：把目录改成分类目录本身 → 400（各房间文件会混在一起）',
  // 走的是更前面的那道守卫（assertSafeTarget），文案是「会议室目录不能正好是分类目录本身」；
  // 换目录那一步的 moveTargetReason 是第二道，只认「分类目录本身」这几个字即可。
  v13Cat.status === 400 && String(v13Cat.body?.error ?? '').includes('分类目录本身'),
  'status=' + v13Cat.status + ' ' + json(v13Cat.body).slice(0, 200),
)
// 客户端「新建子文件夹」的拼法：<父目录>\<新名字>\<房间 id>
const v13NewDir = path.join(V13_CAT, '存档', 'mv')
const v13Move = await PATCH(v13Base, '/dsh-room/rooms/mv', { dir: v13NewDir })
const v13After = await GET(v13Base, '/dsh-room/rooms/mv')
check(
  'v13①：新建子文件夹（拼 <分类目录>\\<新名字>\\<房间id>）→ 200，整个房间搬过去，新处有 附件/ 记录/结果/，旧处已搬空',
  v13Move.status === 200 && v13After.body?.room?.dir === v13NewDir &&
    fs.existsSync(path.join(v13NewDir, '附件')) && fs.existsSync(path.join(v13NewDir, '记录', '结果')) &&
    !fs.existsSync(v13Dir),
  'status=' + v13Move.status + ' dir=' + String(v13After.body?.room?.dir) + ' 旧处还在=' + fs.existsSync(v13Dir),
)
const v13Deep = await PATCH(v13Base, '/dsh-room/rooms/mv', { dir: path.join(v13NewDir, '记录') })
check(
  'v13①护栏：搬进新家的子目录（记录/）同样 400，房间不会被复制成套娃',
  v13Deep.status === 400 && String(v13Deep.body?.error ?? '').includes('不能把会议文件目录改成它自己的子目录') &&
    fs.existsSync(path.join(v13NewDir, '附件')),
  'status=' + v13Deep.status + ' ' + json(v13Deep.body).slice(0, 200),
)
// v15①：用户选文件夹时「选中的文件夹就是房间目录」（客户端不再拼 <文件夹>\<房间id>），
// 所以必须拦住「选了别人会议室的家」这种会把两个房间的 附件/记录 混在一起的形状。
const v15Other = await POST(v13Base, '/dsh-room/rooms', { id: 'other', title: '别人的房间' })
const v15OtherDir = path.join(V13_CAT, 'other')
const v15Clash = await PATCH(v13Base, '/dsh-room/rooms/mv', { dir: v15OtherDir })
check(
  'v15①护栏：目标文件夹已经是另一个会议室的家（里面是它的 room.json）→ 400，不把两个房间混在一起',
  v15Other.status === 200 && v15Clash.status === 400 &&
    String(v15Clash.body?.error ?? '').includes('已经属于另一个会议室') &&
    fs.existsSync(path.join(v13NewDir, '附件')) && fs.existsSync(path.join(v15OtherDir, '附件')),
  'make=' + v15Other.status + ' status=' + v15Clash.status + ' ' + json(v15Clash.body).slice(0, 200),
)
check(
  'v13①回归：被拒绝的三次请求没有污染状态根（进程没崩、房间还在、错误没进 handlerErrors）',
  (await GET(v13Base, '/dsh-room/rooms')).body?.rooms?.some((room) => room.id === 'mv') === true &&
    v13Host.handlerErrors.length === 0,
  'handlerErrors=' + json(v13Host.handlerErrors.slice(0, 2)),
)

// ── v16：交互与规范七项（静态字面量 + 只读诊断端点） ─────────────────────────────
const v16Staging = await GET(v13Base, '/dsh-room/staging')
check(
  'v16⑥：只读诊断端点 GET /dsh-room/staging 可用 —— 回 root/stageTools/members/swept/events，重载后靠它核验接管是否生效',
  v16Staging.status === 200 && Boolean(v16Staging.body?.root) &&
    Array.isArray(v16Staging.body?.stageTools) && Array.isArray(v16Staging.body?.members) &&
    Array.isArray(v16Staging.body?.swept) && Array.isArray(v16Staging.body?.events),
  'status=' + v16Staging.status + ' ' + json(v16Staging.body).slice(0, 220),
)
check(
  'v16⑦：底栏数字由宿主投影算（sessionStats/tokenUsage/contextPressure），带 4 秒短缓存，缺服务即返回 null 不影响会议',
  pluginSource.includes('const STATS_TTL = 4000;') &&
    pluginSource.includes('statsFor(sessionId) {') &&
    pluginSource.includes("this.ctx.get?.('sessionProjections')") &&
    pluginSource.includes("['sessionStats', 'tokenUsage', 'contextPressure']") &&
    pluginSource.includes('this.statsCache = new Map()') &&
    pluginSource.includes('stats: this.host.statsFor(m.sessionId)'),
  `ttl=${pluginSource.includes('STATS_TTL = 4000')} snap=${pluginSource.includes("'tokenUsage', 'contextPressure'")}`,
)
check(
  'v16⑦：客户端底栏数字条 —— 每人明细进 title、聚合五个指标、没有数字就整条不显示（不编造）',
  clientSrc.includes('function RoomStats(props)') &&
    clientSrc.includes('function memberStatLine(member)') &&
    clientSrc.includes('function formatTokens(value)') &&
    clientSrc.includes('h(RoomStats, { members: view.members })') &&
    clientSrc.includes('const members = (Array.isArray(props.members) ? props.members : []).filter((m) => m && m.stats)') &&
    clientSrc.includes("if (!members.length) return null") &&
    clientSrc.includes("h('div', { style: S.stats, title }") &&
    clientSrc.includes('statPill:'),
  `client=${clientSrc.includes('RoomStats')} stats=${clientSrc.includes('S.stats')}`,
)
check(
  'v16③(a)：与会者守则按「注入 system prompt」落地 —— CONDUCT_PROMPT + agent 作用域 section(meeting-room:conduct)，拿不到就静默降级',
  pluginSource.includes('const CONDUCT_PROMPT = [') &&
    pluginSource.includes("'1) 围绕会议目标讨论：") &&
    pluginSource.includes("name: 'meeting-room:conduct'") &&
    pluginSource.includes('this.installConduct(agentCtx, rec)') &&
    pluginSource.includes("rec.conduct = 'on'") && pluginSource.includes("rec.conduct = 'none'"),
  `conduct=${pluginSource.includes("meeting-room:conduct")} call=${pluginSource.includes('installConduct(agentCtx, rec)')}`,
)
check(
  'v16③(b)：驳回《会议结果》草稿后立刻把驳回原因投给全体与会者，要求围绕目标与原因重议',
  pluginSource.includes("kind: 'reject'") && pluginSource.includes("authorLabel: '审核意见'") &&
    pluginSource.includes('rejectText') && pluginSource.includes('请逐条回应'),
  `reject=${pluginSource.includes("kind: 'reject'")}`,
)
check(
  'v16③(c)：记录员只记最终共识/分工/待办 —— 讨论过程与被否决方案不写、不得编造、不把单方长篇当共识',
  pluginSource.includes('只记录会议最终达成的共识、分工与待办') &&
    pluginSource.includes('不得编造：不替与会者补写他们没有说过的观点') &&
    pluginSource.includes('能写清单就不写段落'),
  `rec=${pluginSource.includes('只记录会议最终达成的共识')}`,
)
check(
  'v17①：批准重开不再只改状态 —— 立刻 deliver(kind:reopen, mode:full) 给全体，并带申请理由与继续口径',
  pluginSource.includes("kind: 'reopen'") &&
    pluginSource.includes("authorLabel: '主持人'") &&
    pluginSource.includes('会议已重开，请立即接着讨论。') &&
    pluginSource.includes('重开原因（') &&
    pluginSource.includes('const pending = room.room.reopenRequest ?? null') &&
    pluginSource.includes('重开后投递失败'),
  `reopen=${pluginSource.includes("kind: 'reopen'")} pending=${pluginSource.includes('const pending = room.room.reopenRequest')}`,
)
check(
  'v17②：宿主注册 ctx.on(approval/request) —— 只接管本房间成员，非成员/取消一律 next() 交回原审批链',
  pluginSource.includes("this.ctx.on('approval/request'") &&
    pluginSource.includes('const APPROVAL_WAIT_MS = 120000;') &&
    pluginSource.includes('if (!hit) return next();') &&
    pluginSource.includes("return resolve('allowed-once')") &&
    pluginSource.includes("return resolve('rejected')") &&
    pluginSource.includes('installApprovals()'),
  `on=${pluginSource.includes("ctx.on('approval/request'")} wait=${pluginSource.includes('APPROVAL_WAIT_MS')}`,
)
check(
  'v18：审批监听必须 prepend（抢在浏览器审批桥前面）+ 诊断环 + 端点透出 —— 真机 bug 的三处修复形状',
  pluginSource.includes("this.ctx.on('approval/request', (req, next) => this.handleApproval(req, next), approvalOptions)") &&
    pluginSource.includes('const approvalOptions = { global: true, prepend: true };') &&
    pluginSource.includes('this.approvalsSeen = [];') &&
    pluginSource.includes('this.recordApproval({ sessionId, toolName, callId: req?.callId ?? null, roomId: hit?.room?.id ?? null, matched: !!hit })') &&
    pluginSource.includes("key.replace(/^session-/, '')") &&
    pluginSource.includes('options: host.approvalOptions ?? null'),
  `prepend=${pluginSource.includes('{ global: true, prepend: true }')} seen=${pluginSource.includes('approvalsSeen')}`,
)
check(
  'v17②：房间端点 /rooms/:id/approvals（列出待批 / allow|deny）+ RoomSummary.approvals 让面板直接弹横幅',
  pluginSource.includes("case 'approvals':") &&
    pluginSource.includes('host.pendingApprovals(room.id)') &&
    pluginSource.includes('host.decideApproval(') &&
    pluginSource.includes('approvals: this.host.pendingApprovals(this.room.id)'),
  `ep=${pluginSource.includes("case 'approvals':")} summary=${pluginSource.includes('approvals: this.host.pendingApprovals')}`,
)
check(
  'v16⑥：投递即开窗 + 轮末兜底巡检 + 交作业时巡检 —— 顶层新文件搬进「附件/」并移走原件；巡检不依赖 agent 钩子',
  pluginSource.includes('this.openWindow(rec, room, agent)') &&
    pluginSource.includes('await this.collectLeftovers(active).catch(() => 0)') &&
    pluginSource.includes('async sweepSession(room, sessionId) {') &&
    pluginSource.includes('await host.staging?.sweepSession?.(room, sessionId)') &&
    pluginSource.includes('await this.host.staging?.sweepSession?.(this, member.sessionId)') &&
    pluginSource.includes("if (since === null) return 0;") &&
    pluginSource.includes('this.registry = new Map()') && pluginSource.includes("rec.tools = installed > 0 ? 'on' : 'none'"),
  `sweep=${pluginSource.includes('sweepSession')} window=${pluginSource.includes('openWindow')}`,
)
check(
  'v16②④⑤：草稿正文编辑区够大（minHeight 260）、分组里可直接新建会议室、换分类目录走系统文件夹界面',
  clientSrc.includes('minHeight: 260') &&
    clientSrc.includes('// v16④：直接在这个分组里新建会议室') &&
    clientSrc.includes('meeting.createCategory = group.category || \'\'') &&
    clientSrc.includes('// v16⑤：换分类目录也先走系统文件夹界面'),
  `editor=${clientSrc.includes('minHeight: 260')} group=${clientSrc.includes('group.category')}`,
)


section('v13②：散会后不再自动接力（room_say 只归档 / 人类发帖 relaySkipped）')

const v13Closed = await POST(v13Base, '/dsh-room/rooms/mv/close', { title: '散会' })
const v13BeforeSay = v13Host.deliveries.length
const v13Say = String(await useTool(v13Host, 'room_say', { roomId: 'mv', text: 'V13-CLOSED-SAY' }, 'v13-a'))
check(
  'v13②：散会后 room_say 仍写进记录，但明确回「会议已经散会…不再自动接力」，零投递',
  /^已写进会议记录 #\d+/.test(v13Say) && v13Say.includes('会议已经散会') && v13Say.includes('room_request_reopen') &&
    v13Host.deliveries.length === v13BeforeSay,
  v13Say.slice(0, 200) + ' / 投递增量=' + (v13Host.deliveries.length - v13BeforeSay),
)
const v13Post = await POST(v13Base, '/dsh-room/rooms/mv/post', { text: 'V13-CLOSED-POST' })
const v13State = await GET(v13Base, '/dsh-room/rooms/mv/state?since=0')
check(
  'v13②：散会后人类发帖 → relaySkipped:true、零投递，但正文照旧进记录',
  v13Closed.status === 200 && v13Post.status === 200 && v13Post.body?.relaySkipped === true &&
    (v13Post.body?.delivered ?? []).length === 0 &&
    (v13State.body?.messages ?? []).some((m) => String(m.text).includes('V13-CLOSED-POST')),
  json(v13Post.body).slice(0, 200),
)

section('v13③（v14 改文案）：唤醒消息里的「文件放哪」只在本来就用 room_say 的投递里出现')

// 正向：新开一个进行中的房间（散会后 room_say 不再投递），投递文案里逐字带「相对文件名即可 +
// 插件把这轮写在顶层的新文件收进 <附件目录> 并移走 + 不要写到工作区以外」。v14① 改文案的原因：v13 让
// AI「写在 <附件目录> 里」在 workspace-write 沙箱下根本写不进去（附件目录在会话 cwd 之外）；
// v16⑥ 再改一次：真机取证发现影子工具没接管，改成「投递即开窗 + 轮末/交作业巡检」后文案与实现对齐。
// 注意：自动接力的对象是「除本人外的成员」，所以这个房间至少要有两名成员，投递才会发生。
await POST(v13Base, '/dsh-room/rooms', { id: 'hint', title: '文件提示用例' })
await POST(v13Base, '/dsh-room/rooms/hint/join', { sessionId: 'v13-b', label: 'v13-b' })
await POST(v13Base, '/dsh-room/rooms/hint/join', { sessionId: 'v13-a', label: 'v13-a' })
const v13HintBefore = v13Host.deliveries.length
await useTool(v13Host, 'room_say', { roomId: 'hint', text: 'V13-HINT-正文' }, 'v13-b')
const v13Hint = String(deliveryText(v13Host.deliveries.at(-1)))
check(
  'v13③（v16⑥ 改文案）：room_say 触发的唤醒消息逐字带「相对文件名即可 + 轮末收进 <附件目录> 并移走 + 不要写到工作区以外」',
  v13Host.deliveries.length > v13HintBefore &&
    v13Hint.includes('本次会议的文件直接以相对文件名保存即可，例如 报告.md') &&
    v13Hint.includes(`插件会在这一轮结束时收进 ${path.join(V13_CAT, 'hint', '附件')} 并从原地移走`) &&
    v13Hint.includes('不要写到工作区以外的地方'),
  json(v13Hint.slice(-200)),
)
// 反向：走同一条投递通路、但正文里没有 room_say 的（room_finalize 的决议投递）不该被追加这句
const v13PlainBefore = v13Host.deliveries.length
await useTool(v13Host, 'room_finalize', { roomId: 'hint', title: 'V13 决议', body: 'V13 决议正文' }, 'v13-b')
const v13Plain = String(deliveryText(v13Host.deliveries.at(-1)))
check(
  'v13③反向：同一条投递通路里不带 room_say 的正文（决议投递）不会被追加「文件放哪」这句',
  v13Host.deliveries.length > v13PlainBefore && v13Plain.includes('V13 决议正文') && !v13Plain.includes('不要写到工作区以外'),
  json(v13Plain.slice(0, 140)),
)

await closeServer(v13Server)
disposeHost(v13Host)

// ── v16⑥ 第③层兜底（sweepSession）行为级探针 ────────────────────────────────────
// 动机：v16⑥ 的其余断言都只是「源码形状 + 诊断端点」，缺一条真跑的行为验证；而真机取证证明
// 影子工具在部分宿主上根本没接管，必须靠第③层。这里用与真机同形的路径验证：文件由 fs 直接写进
// 会话 cwd 顶层（等价于真机上与会者用 pwsh 写绝对路径 —— 既不经影子工具、也不依赖任何 agent 钩子），
// 两次 room_say 之间它必须被收走；会议之前就存在的文件必须原封不动。
section('v16⑥ 探针：不依赖任何 agent 钩子的兜底巡检')
{
  const probeRoot = path.join(WORK, 'v16b-root')
  const probeCat = path.join(WORK, 'v16b-cat', '会议')
  const probeCwd = path.join(WORK, 'v16b-cwd')
  fs.mkdirSync(probeCwd, { recursive: true })
  const oldFile = path.join(probeCwd, '会议之前就有的.md')
  fs.writeFileSync(oldFile, 'OLD', 'utf8')
  const ph = createHost({ root: probeRoot, category: probeCat, roomId: 'main', agents: ['pa', 'pb'], agentCwd: probeCwd })
  const pserved = await serveReady(ph, 'v16⑥ 探针')
  const pbase = pserved.base
  const pMake = await POST(pbase, '/dsh-room/rooms', { id: 'probe', title: '兜底探针', goal: '验证兜底巡检' })
  const pJoinA = await POST(pbase, '/dsh-room/rooms/probe/join', { sessionId: 'pa', label: 'pa' })
  const pJoinB = await POST(pbase, '/dsh-room/rooms/probe/join', { sessionId: 'pb', label: 'pb' })

  // ① 第一次交作业：只立基线（此刻 cwd 里已经有「会议之前就有的.md」）
  await useTool(ph, 'room_say', { roomId: 'probe', text: '第一次（立基线）' }, 'pa')
  // ② 基线之后新写一份到 cwd 顶层 —— 完全用 fs 写，不走 write 工具、不触发任何 agent 钩子
  const freshFile = path.join(probeCwd, '兜底探针-新写的.md')
  fs.writeFileSync(freshFile, 'NEW', 'utf8')
  // ③ 第二次交作业：兜底巡检应当把它收走（原件移走、暂存区留副本）
  await useTool(ph, 'room_say', { roomId: 'probe', text: '第二次（应当收走新文件）' }, 'pa')

  const stag = (await GET(pbase, '/dsh-room/staging')).body ?? {}
  const stagedFile = path.join(String(stag.root ?? ''), 'probe', '兜底探针-新写的.md')
  check(
    'v16⑥ 探针：兜底巡检把「上次巡检之后」新建的 cwd 顶层文件移出工作区、收进暂存区（原件已删、内容一致）',
    pMake.status === 200 && pJoinA.status === 200 && pJoinB.status === 200 &&
      !fs.existsSync(freshFile) && fs.existsSync(stagedFile) &&
      fs.readFileSync(stagedFile, 'utf8') === 'NEW',
    'make=' + pMake.status + ' 原件还在=' + fs.existsSync(freshFile) + ' 暂存=' + fs.existsSync(stagedFile) + ' cwd=' + probeCwd,
  )
  check(
    'v16⑥ 探针：会议之前就存在的顶层文件绝不被兜底巡检动（首次只立基线）',
    fs.existsSync(oldFile),
    'old=' + fs.existsSync(oldFile),
  )
  check(
    'v16⑥ 探针：诊断端点回 swept 含该会话，events 里留下 handin 且 removed:true（重载后照这条核验真机）',
    Array.isArray(stag.swept) && stag.swept.includes('pa') &&
      (stag.events ?? []).some((e) => e.kind === 'handin' && e.removed === true),
    'swept=' + json(stag.swept) + ' events=' + json((stag.events ?? []).slice(-2)),
  )

  await closeServer(pserved.server)
  disposeHost(ph)
}

// ---------------------------------------------------------------- 汇总

if (unhandled.length) {
  failed += 1
  failures.push({ name: '无未处理的 Promise 拒绝', detail: unhandled.join(' | ') })
  console.log('FAIL  无未处理的 Promise 拒绝\n      ' + unhandled.join(' | '))
} else {
  passed += 1
  console.log('PASS  无未处理的 Promise 拒绝')
}

console.log('')
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  - ' + f.name + (f.detail ? '\n      ' + String(f.detail).slice(0, 600) : ''))
  console.log('')
}
console.log('合计 ' + (passed + failed) + ' 项：通过 ' + passed + '，失败 ' + failed)
if (failed > 0) {
  process.exitCode = 1
} else {
  console.log('房间数据留档：' + ROOT)
}

// v18：结果已经打完就**显式退出**。夹具里还活着的句柄（主宿主那个一直 listen 的 HTTP server、
// 被刻意留在「慢流 / 卡死流」里的定时器等）会让 node 的 event loop 一直有事可做 —— 上一层的
// 包装命令因此看起来「卡死」（v17/v18 收尾时踩过好几次），退出码也拿不到。
// 用 stdout 的空写回调保证前面几行先落盘，再退出。
process.stdout.write('', () => process.exit(failed > 0 ? 1 : 0))
