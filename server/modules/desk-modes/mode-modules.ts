// Which Desk modules each mode mounts. Data only; the mounting code reads this.
// A module listed in both modes is shared code, mounted once per mode with the
// same company_id scoping.

import type { DeskMode } from './mode-resolver.ts';

export const SHARED_MODULES = ['auth', 'audit', 'tenancy', 'approvals'] as const;

export const MODE_MODULES: Readonly<Record<DeskMode, readonly string[]>> = {
  workforce: [
    ...SHARED_MODULES,
    'workforce-runtime',
    'workforce-catalogue',
    'ai-runtime',
    'booking-agent',
    'decision-engine',
    'agent-embed',
  ],
  comms: [
    ...SHARED_MODULES,
    'chatbot',
    'inbox',
    'campaigns',
    'marketing',
  ],
};

export function modulesForMode(mode: DeskMode): readonly string[] {
  return MODE_MODULES[mode];
}

export function isModuleAllowed(mode: DeskMode, moduleName: string): boolean {
  return MODE_MODULES[mode].includes(moduleName);
}

// Modules that belong to exactly one mode. Used by tests and by the mount guard
// to stop the workforce from reaching comms routes and the reverse.
export function exclusiveModules(mode: DeskMode): readonly string[] {
  const other: DeskMode = mode === 'workforce' ? 'comms' : 'workforce';
  return MODE_MODULES[mode].filter((m) => !MODE_MODULES[other].includes(m));
}
