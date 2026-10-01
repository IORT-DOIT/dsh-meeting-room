/** 把三个官方 import 换成桩，本目录自测时不需要 DSH 运行时。 */
const STUBS = {
  '@deepseek-ai/schemastery': './stub-schemastery.mjs',
  '@deepseek-ai/dsh-tools': './stub-dsh-tools.mjs',
  '@deepseek-ai/dsh-llm/message': './stub-dsh-llm-message.mjs',
}

export function resolve(specifier, context, next) {
  const stub = STUBS[specifier]
  if (stub !== undefined) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
