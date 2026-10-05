/**
 * The op contract.
 *
 * An op is one thing the browser can ask the Host to do. The shape is checked
 * when the module loads, for the same reason the adapter contract is: an op
 * wired up wrong should fail at startup, loudly, rather than half-work on the
 * first click and look like a data problem.
 *
 * `store` is not bookkeeping — it is what the Host uses to decide whether an op
 * may run at all. An op that reads agent storage has to be refused while the
 * active environment is unreachable, and that rule belongs in one place, not in
 * each handler.
 *
 * @typedef {object} Op
 * @property {string} name The `op` value a request must carry.
 * @property {boolean} [store] True when this op reads or writes agent storage,
 *   and so must be refused while the environment is unreachable.
 * @property {(payload: object, ctx: object) => Promise<object>} handle
 */

export function defineOp(spec) {
  const { name, store = false, handle } = spec ?? {};
  if (typeof name !== "string" || name === "") throw new TypeError("an op needs a non-empty name");
  if (typeof handle !== "function") throw new TypeError(`op "${name}" needs a handle function`);
  if (typeof store !== "boolean") throw new TypeError(`op "${name}": store must be a boolean`);
  return { name, store, handle };
}

/** Build a lookup from a list of ops, refusing a name declared twice. */
export function opRegistry(ops) {
  const registry = new Map();
  for (const op of ops) {
    if (registry.has(op.name)) throw new TypeError(`op "${op.name}" is registered twice`);
    registry.set(op.name, op);
  }
  return registry;
}
