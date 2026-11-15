/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */

export const DIPLOY_BRAND = {
  name: 'Diploy',
  company: 'Bisht Technologies Private Limited',
  website: 'https://diploy.in',
  email: 'cs@diploy.in',
  copyright: '© 2025 Diploy',
  product: 'AgentLabs'
} as const;

export const DIPLOY_VERSION = {
  core: '1.0.0',
  api: 'v1',
  build: process.env.BUILD_NUMBER || 'dev'
} as const;

export const DIPLOY_HEADERS = {
  author: 'X-Author',
  version: 'X-Api-Version',
  requestId: 'X-Request-Id'
} as const;
