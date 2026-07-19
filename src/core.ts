import init, { core_abi_version, type InitInput } from './generated/rp-engine-core/rp_engine_core.js';

export * from './generated/rp-engine-core/rp_engine_core.js';

let initialization: Promise<void> | undefined;

/** Loads the stripped first-party core once in the current page or worker. */
export function initializeCore(input?: InitInput) {
  initialization ??= init(input).then(() => {
    if (core_abi_version() !== 3) throw new Error('The RPEngine core ABI is incompatible with this web client.');
  });
  return initialization;
}
