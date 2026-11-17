'use strict';
/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */

/**
 * Re-export invoice service from the centralized payment engine.
 * This ensures a single source of truth for invoice generation.
 */
export { 
  InvoiceService, 
  invoiceService, 
  generateInvoiceForTransaction,
  type LineItem,
  type CompanyInfo
} from '../engines/payment/invoice-service';
