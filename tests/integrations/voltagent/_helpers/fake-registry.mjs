/**
 * Fake tool registry for VoltAgent tests. Tools are plain functions keyed by name.
 * Unknown names fail loudly so a test cannot pass by accident.
 */
export function createFakeRegistry(tools = {}) {
  const invocations = [];
  return {
    invocations,
    names() {
      return Object.keys(tools).sort();
    },
    async invoke(name, params = {}, context = {}) {
      invocations.push({ name, params: structuredClone(params), companyId: context.companyId ?? null });
      if (!Object.hasOwn(tools, name)) {
        throw new Error(`fake registry: unknown tool "${name}"`);
      }
      return tools[name](params, context);
    },
  };
}
