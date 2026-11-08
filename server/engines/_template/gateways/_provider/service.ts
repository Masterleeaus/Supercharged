/**
 * __PROVIDER_PASCAL__ provider service. The only layer that talks to the provider's API.
 * Every method fails with not_implemented until the provider fills it in.
 */

import type {
  GatewayAdapter,
  CreateRequest,
  CreateResult,
  VerifyResult,
  WebhookRequest,
  WebhookResult,
} from '../../types';
import { PROVIDER_ID } from '../../config';
import { handleProviderWebhook } from './handlers';

/**
 * Secret used to verify this provider's webhooks. Returns null until implemented,
 * so every webhook is rejected (fail closed).
 * Replace with a read from the settings store or the environment.
 */
export async function loadWebhookSecret(): Promise<string | null> {
  return null;
}

export function create__PROVIDER_PASCAL__Adapter(): GatewayAdapter {
  return {
    id: PROVIDER_ID,

    async create(_input: CreateRequest): Promise<CreateResult> {
      return { ok: false, error: 'not_implemented' };
    },

    async verify(providerRef: string): Promise<VerifyResult> {
      return { ok: false, status: 'pending', providerRef, error: 'not_implemented' };
    },

    async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
      return handleProviderWebhook(req, await loadWebhookSecret());
    },
  };
}
