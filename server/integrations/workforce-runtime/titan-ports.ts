/**
 * Trusted ports for the Titan workforce preview routes: identity, resource ownership and
 * authorization. The HTTP runtime client (http-runtime.ts) does not provide these. The identity
 * and authority integration owner registers them here. Until one does, workforceLoaderOptions()
 * returns no ports and the preview routes answer 503 (fail closed).
 */
export interface TitanWorkforcePorts {
  resolveIdentity: (authContext: unknown) => unknown | Promise<unknown>;
  resolveResource: (args: { context: unknown; kind: string; reference: unknown }) => unknown | Promise<unknown>;
  authorize: (args: { context: unknown; workflow: string; resource: unknown }) => unknown | Promise<unknown>;
}

const REQUIRED_PORTS = ['resolveIdentity', 'resolveResource', 'authorize'] as const;
let configured: Readonly<TitanWorkforcePorts> | undefined;

/** Register the trusted ports, or clear them with undefined. Throws on an incomplete object. */
export function setTitanWorkforcePorts(ports: unknown): void {
  if (ports === undefined) {
    configured = undefined;
    return;
  }
  if (typeof ports !== 'object' || ports === null) {
    throw new TypeError('titan_workforce_ports_invalid');
  }
  const candidate = ports as Record<string, unknown>;
  if (REQUIRED_PORTS.some((key) => typeof candidate[key] !== 'function')) {
    throw new TypeError('titan_workforce_ports_invalid');
  }
  configured = Object.freeze({
    resolveIdentity: candidate.resolveIdentity as TitanWorkforcePorts['resolveIdentity'],
    resolveResource: candidate.resolveResource as TitanWorkforcePorts['resolveResource'],
    authorize: candidate.authorize as TitanWorkforcePorts['authorize'],
  });
}

export function getTitanWorkforcePorts(): Readonly<TitanWorkforcePorts> | undefined {
  return configured;
}

/** Spread into the loadPlugins options so plugins receive the trusted ports as titanWorkforcePorts. */
export function workforceLoaderOptions(): { titanWorkforcePorts: Readonly<TitanWorkforcePorts> | undefined } {
  return { titanWorkforcePorts: configured };
}
