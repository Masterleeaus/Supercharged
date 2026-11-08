import type { LanguageUnderstanding } from './types';

const intents: Array<[string, RegExp[]]> = [
  ['create_quote', [/\bquote\b/i, /\bestimate\b/i, /\bprice\b/i]],
  ['schedule_job', [/\bbook\b/i, /\bschedule\b/i, /\bappointment\b/i]],
  ['create_invoice', [/\binvoice\b/i, /\bbill\b/i]],
  ['complete_job', [/\bcomplete(?:d)?\b.*\bjob\b/i, /\bfinish(?:ed)?\b.*\bjob\b/i]],
  ['create_customer', [/\bnew customer\b/i, /\badd customer\b/i]],
];

export class LocalLanguageEngine {
  understand(input: string): LanguageUnderstanding {
    const normalized = input.trim().replace(/\s+/g, ' ');
    let intent = 'unknown';
    let intentScore = 0;
    for (const [candidate, patterns] of intents) {
      const score = patterns.reduce((total, pattern) => total + (pattern.test(normalized) ? 1 : 0), 0);
      if (score > intentScore) {
        intent = candidate;
        intentScore = score;
      }
    }

    const customerMatch = normalized.match(/\bfor\s+([A-Z][\p{L}'-]*)/u);
    const dateMatch = normalized.match(/\b(next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)/i);
    const amountMatch = normalized.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
    const serviceMatch = normalized.match(/\b(?:for|a)\s+((?:regular|carpet|commercial|residential|end of lease|deep)\s+(?:clean|cleaning|service))\b/i);

    const entities: LanguageUnderstanding['entities'] = {};
    if (customerMatch?.[1]) entities.customer = customerMatch[1];
    if (dateMatch?.[1]) entities.relativeDate = dateMatch[1].toLowerCase();
    if (amountMatch?.[1]) entities.amount = Number(amountMatch[1]);
    if (serviceMatch?.[1]) entities.service = serviceMatch[1].toLowerCase();

    const evidence = intentScore + Object.keys(entities).length;
    const confidence = intent === 'unknown' ? Math.min(0.49, evidence * 0.15) : Math.min(0.98, 0.55 + evidence * 0.1);
    return { intent, confidence, entities, normalized };
  }
}
