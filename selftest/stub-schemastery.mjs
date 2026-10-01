/** @deepseek-ai/schemastery 的最小桩：只要链式调用不炸即可。 */
const field = () => {
  const node = {
    default: () => node,
    optional: () => node,
    description: () => node,
    required: () => node,
  }
  return node
}

export default {
  object: (shape) => ({ type: 'object', shape }),
  string: field,
  natural: field,
  number: field,
  boolean: field,
  array: field,
}
