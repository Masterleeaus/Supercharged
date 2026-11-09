/*
 * Ported from @agentkitai/agentgate-core (packages/core/src/policy-engine.ts).
 * Only the import specifiers were changed to fit Desk's module layout.
 *
 * MIT License
 *
 * Copyright (c) 2026 Amit Paz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import isSafeRegex from 'safe-regex2';
import type { ApprovalRequest, Policy, PolicyRule, PolicyDecision, MatcherValue } from './types';
import { logger } from '../../utils/logger.ts';

/**
 * Context used to scope which policies apply to a request.
 * `agentId` MUST be a cryptographically verified id (not a client-claimed one),
 * so a `per_agent` policy can't be dodged by spoofing a request field.
 */
export interface PolicyEvalContext {
  agentId?: string | null;
  tool?: string;
}

/**
 * Whether a policy applies to a request, given its scope. `per_agent`/`per_tool`
 * fail CLOSED: an empty/missing id list or absent context means the policy is
 * skipped (so an unidentified caller falls through to the safe default rather
 * than matching an agent-scoped rule). An unknown scope is excluded.
 */
function policyInScope(p: Policy, context?: PolicyEvalContext): boolean {
  const scope = p.scope ?? 'global';
  if (scope === 'global') return true;
  if (scope === 'per_agent')
    return !!context?.agentId && (p.agentIds?.includes(context.agentId) ?? false);
  if (scope === 'per_tool')
    return !!context?.tool && (p.toolIds?.includes(context.tool) ?? false);
  return false;
}

/**
 * Get a nested value from an object using dot notation
 * @example getNestedValue({ context: { user: { role: 'admin' } } }, 'context.user.role') => 'admin'
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  
  return current;
}

/**
 * Check if a value matches a matcher
 */
function matchValue(value: unknown, matcher: MatcherValue): boolean {
  // Exact match for primitives
  if (typeof matcher === 'string' || typeof matcher === 'number' || typeof matcher === 'boolean') {
    return value === matcher;
  }
  
  // Operator matchers
  if (typeof matcher === 'object' && matcher !== null) {
    // $lt - less than
    if ('$lt' in matcher) {
      return typeof value === 'number' && value < matcher.$lt;
    }
    
    // $gt - greater than
    if ('$gt' in matcher) {
      return typeof value === 'number' && value > matcher.$gt;
    }
    
    // $lte - less than or equal
    if ('$lte' in matcher) {
      return typeof value === 'number' && value <= matcher.$lte;
    }
    
    // $gte - greater than or equal
    if ('$gte' in matcher) {
      return typeof value === 'number' && value >= matcher.$gte;
    }
    
    // $in - value in array
    if ('$in' in matcher) {
      return matcher.$in.includes(value as string | number);
    }
    
    // $regex - regex match (with ReDoS protection)
    if ('$regex' in matcher) {
      if (typeof value !== 'string') return false;
      try {
        if (!isSafeRegex(matcher.$regex)) {
          logger.warn(`[PolicyEngine] Unsafe regex pattern rejected at evaluation: ${matcher.$regex}`);
          return false; // Unsafe regex — treat as non-match
        }
        const regex = new RegExp(matcher.$regex);
        return regex.test(value);
      } catch {
        return false;
      }
    }
  }
  
  return false;
}

/**
 * Check if a request matches all matchers in a rule
 */
function matchesRule(request: ApprovalRequest, rule: PolicyRule): boolean {
  // Build a flat object for matching that includes top-level request fields
  const requestData: Record<string, unknown> = {
    action: request.action,
    status: request.status,
    urgency: request.urgency,
    ...request.params,
    context: request.context,
    params: request.params,
  };
  
  for (const [path, matcher] of Object.entries(rule.match)) {
    const value = getNestedValue(requestData, path);
    if (!matchValue(value, matcher)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Evaluate policies against a request and return the decision
 * 
 * Policies are sorted by priority (lower number = higher priority).
 * For each policy, rules are evaluated in order.
 * First matching rule determines the decision.
 * If no rule matches, defaults to 'route_to_human'.
 */
export function evaluatePolicy(
  request: ApprovalRequest,
  policies: Policy[],
  context?: PolicyEvalContext
): PolicyDecision {
  // Filter to enabled + in-scope policies, then sort by priority (ascending)
  const sortedPolicies = policies
    .filter(p => p.enabled)
    .filter(p => policyInScope(p, context))
    .sort((a, b) => a.priority - b.priority);
  
  // Evaluate each policy's rules in order
  for (const policy of sortedPolicies) {
    for (const rule of policy.rules) {
      if (matchesRule(request, rule)) {
        return {
          decision: rule.decision,
          matchedRule: rule,
          approvers: rule.approvers,
          channels: rule.channels,
        };
      }
    }
  }
  
  // Default: route to human for safety
  return {
    decision: 'route_to_human',
  };
}
