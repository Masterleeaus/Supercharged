'use strict';
/**
 * YooKassa Service
 * Configuration loaders, connection testing, payment initialization, and refunds
 */

import axios from 'axios';
import crypto from 'crypto';
import { storage } from '../../../../storage';
import { PaymentError } from '../../../../utils/errors';
import { GLOBAL_SETTINGS_KEYS, getCurrencySymbol } from '../../types';

async function getSetting(key: string): Promise<any> {
  const setting = await storage.getGlobalSetting(key);
  return setting?.value ?? null;
}

export async function isYookassaConfigured(): Promise<boolean> {
  const dbShopId = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_SHOP_ID);
  const dbSecretKey = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_SECRET_KEY);
  const envShopId = process.env.YOOKASSA_SHOP_ID;
  const envSecretKey = process.env.YOOKASSA_SECRET_KEY;

  return !!((dbShopId && dbSecretKey) || (envShopId && envSecretKey));
}

export async function isYookassaEnabled(): Promise<boolean> {
  const isConfigured = await isYookassaConfigured();
  if (!isConfigured) return false;

  const enabled = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_ENABLED);
  return enabled === true || enabled === 'true';
}

export async function getYookassaShopId(): Promise<string | null> {
  const dbShopId = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_SHOP_ID);
  return dbShopId || process.env.YOOKASSA_SHOP_ID || null;
}

export async function getYookassaSecretKey(): Promise<string | null> {
  const dbSecretKey = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_SECRET_KEY);
  return dbSecretKey || process.env.YOOKASSA_SECRET_KEY || null;
}

export async function getYookassaWebhookSecret(): Promise<string | null> {
  const dbSecret = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_WEBHOOK_SECRET);
  return dbSecret || process.env.YOOKASSA_WEBHOOK_SECRET || null;
}

export interface YookassaCurrencyConfig {
  currency: string;
  currencyLocked: boolean;
  symbol: string;
}

export function getSupportedCurrencies(): Array<{ code: string; symbol: string; name: string }> {
  return [
    { code: 'RUB', symbol: '₽', name: 'Russian Ruble' },
    { code: 'USD', symbol: '$', name: 'US Dollar' },
    { code: 'EUR', symbol: '€', name: 'Euro' },
  ];
}

export async function getYookassaCurrency(): Promise<YookassaCurrencyConfig> {
  const currency = await getSetting(GLOBAL_SETTINGS_KEYS.YOOKASSA_CURRENCY);
  const currencyCode = currency || 'RUB';

  return {
    currency: currencyCode.toUpperCase(),
    currencyLocked: true,
    symbol: getCurrencySymbol(currencyCode),
  };
}

export async function testYookassaConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const shopId = await getYookassaShopId();
    const secretKey = await getYookassaSecretKey();
    if (!shopId || !secretKey) {
      return { success: false, error: 'YooKassa not configured' };
    }

    // Attempt a list payments search (or fetch first page) to test credentials
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
    const response = await axios.get("https://api.yookassa.ru/v3/payments?limit=1", {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (response.status === 200) {
      return { success: true };
    }
    return { success: false, error: `Connection check failed with status: ${response.status}` };
  } catch (error: any) {
    console.error('❌ [YooKassa] Connection test failed:', error.message);
    return { success: false, error: error.response?.data?.description || error.message };
  }
}

export async function getYookassaConfig(): Promise<{
  enabled: boolean;
  configured: boolean;
  shopId: string | null;
  currency: YookassaCurrencyConfig;
}> {
  const [enabled, configured, shopId, currency] = await Promise.all([
    isYookassaEnabled(),
    isYookassaConfigured(),
    getYookassaShopId(),
    getYookassaCurrency(),
  ]);

  return {
    enabled,
    configured,
    shopId: enabled ? shopId : null,
    currency,
  };
}

export async function initYookassaPayment({
  amount,
  currency,
  orderId,
  redirectUrl,
  metadata
}: {
  amount: number;
  currency: string;
  orderId: string;
  redirectUrl: string;
  metadata?: any;
}) {
  const shopId = await getYookassaShopId();
  const secretKey = await getYookassaSecretKey();

  if (!shopId || !secretKey) {
    throw new PaymentError('yookassa', 'YooKassa is not configured', undefined, { operation: 'initPayment' });
  }

  const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
  const idempotenceKey = crypto.randomUUID();

  const payload = {
    amount: {
      value: amount.toFixed(2),
      currency: currency.toUpperCase()
    },
    capture: true,
    confirmation: {
      type: "redirect",
      return_url: redirectUrl
    },
    description: `Payment for order ${orderId}`,
    metadata: {
      orderId,
      ...metadata
    }
  };

  const res = await axios.post(
    "https://api.yookassa.ru/v3/payments",
    payload,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Idempotence-Key": idempotenceKey,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.data.confirmation || !res.data.confirmation.confirmation_url) {
    throw new Error("YooKassa payment initialization failed: No confirmation URL returned");
  }

  return {
    provider: "yookassa",
    authorizationUrl: res.data.confirmation.confirmation_url,
    reference: res.data.id,
  };
}

export async function processYookassaRefund(
  gatewayTransactionId: string,
  amount: number,
  currency: string
): Promise<{ success: boolean; gatewayRefundId?: string; error?: string }> {
  try {
    const shopId = await getYookassaShopId();
    const secretKey = await getYookassaSecretKey();

    if (!shopId || !secretKey) {
      return { success: false, error: 'YooKassa is not configured' };
    }

    const auth = Buffer.from(`${shopId}:${secretKey}`).toString("base64");
    const idempotenceKey = crypto.randomUUID();

    const response = await axios.post(
      'https://api.yookassa.ru/v3/refunds',
      {
        amount: {
          value: amount.toFixed(2),
          currency: currency.toUpperCase(),
        },
        payment_id: gatewayTransactionId,
      },
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data && response.data.status === 'succeeded') {
      console.log(`✅ [YooKassa] Created refund ${response.data.id} for payment ${gatewayTransactionId}`);
      return { success: true, gatewayRefundId: response.data.id };
    } else if (response.data && response.data.status === 'pending') {
      console.log(`⏳ [YooKassa] Refund ${response.data.id} is pending for payment ${gatewayTransactionId}`);
      return { success: true, gatewayRefundId: response.data.id };
    }

    return { success: false, error: 'Refund failed' };
  } catch (error: any) {
    console.error(`❌ [YooKassa] Refund failed:`, error.message);
    return { success: false, error: error.response?.data?.description || error.message };
  }
}
