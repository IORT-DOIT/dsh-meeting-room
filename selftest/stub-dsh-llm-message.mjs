/**
 * @deepseek-ai/dsh-llm/message 的最小桩：与真实实现同形（补 role: 'user' + 身份 id）。
 * 真机 createMessage = deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))
 * —— id 由工厂生成、调用方给什么都覆盖掉；桩只保留「一定会有一条唯一 id」这一条契约
 * （v15② 要拿 message.id 去 agent.inbox 里认「还没被领走的那一条」）。
 */
let seq = 0
export const createUserMessage = (input) => ({ ...input, role: 'user', id: `msg-${++seq}` })
