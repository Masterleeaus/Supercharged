/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */



export interface ConnectionStatus {
  connected: boolean;
  mode?: string;
  currency?: string;
  availableBalance?: string;
  source?: string;
  error?: string;
  success?: boolean;
}

/**
 * Sanitize error messages to prevent displaying raw HTML or overly technical errors
 * Returns a clean, user-friendly error message
 */
export function sanitizeErrorMessage(error: string | undefined, fallbackMessage: string): string | undefined {
  if (!error) return undefined;

  // Detect HTML content (like 502 Bad Gateway pages)
  if (error.includes('<html') || error.includes('<!DOCTYPE') || error.includes('<head>') || error.includes('<body>')) {
    return 'Service temporarily unavailable. Please check your server configuration.';
  }

  // Detect JSON parsing errors (indicates server returned non-JSON)
  if (error.includes('Unexpected token') || error.includes('JSON')) {
    return 'Service temporarily unavailable. Please check your server configuration.';
  }

  // Detect network/connection errors
  if (error.includes('Failed to fetch') || error.includes('NetworkError') || error.includes('ECONNREFUSED')) {
    return 'Unable to connect to server. Please check if the service is running.';
  }

  // If error is too long (likely contains debug info), truncate it
  if (error.length > 200) {
    return fallbackMessage;
  }

  return error;
}

export const CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "CAD", symbol: "$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "$", name: "Australian Dollar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "MXN", symbol: "$", name: "Mexican Peso" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc" },
];

export const PAYPAL_CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
];

export const PAYSTACK_CURRENCIES = [
  { code: "NGN", symbol: "₦", name: "Nigerian Naira" },
  { code: "GHS", symbol: "GH₵", name: "Ghanaian Cedi" },
  { code: "ZAR", symbol: "R", name: "South African Rand" },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling" },
  { code: "USD", symbol: "$", name: "US Dollar" },
];

export const MERCADOPAGO_CURRENCIES = [
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "ARS", symbol: "$", name: "Argentine Peso" },
  { code: "MXN", symbol: "MX$", name: "Mexican Peso" },
  { code: "CLP", symbol: "$", name: "Chilean Peso" },
  { code: "COP", symbol: "$", name: "Colombian Peso" },
];

export const YOOKASSA_CURRENCIES = [
  { code: "RUB", symbol: "₽", name: "Russian Ruble" },
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
];