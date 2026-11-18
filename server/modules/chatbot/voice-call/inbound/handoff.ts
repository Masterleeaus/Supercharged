// Warm handoff brief and transcript policy (#333). Pure.
// Policy: the transcript goes to staff only when the caller consented to the call. Without consent,
// staff get the reason and the masked number, never the words spoken. Phone-like digit runs are
// masked in every line that leaves this module.

export const HANDOFF_TRANSCRIPT_TURN_LIMIT = 20;

export interface TranscriptTurn {
  speaker: 'caller' | 'assistant';
  text: string;
}

export interface HandoffBriefInput {
  reason: 'urgent' | 'provider_down' | 'caller_request';
  consent: boolean | null;
  callerNumber: string;
  turns: TranscriptTurn[];
}

export interface HandoffBrief {
  reason: HandoffBriefInput['reason'];
  callerNumberMasked: string;
  transcriptIncluded: boolean;
  transcript: TranscriptTurn[];
  notes: string[];
}

export function maskDigits(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return '*'.repeat(Math.max(0, digits.length - 4)) + digits.slice(-4);
  });
}

export function maskCaller(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

export function buildHandoffBrief(input: HandoffBriefInput): HandoffBrief {
  const transcriptIncluded = input.consent === true;
  const transcript = transcriptIncluded
    ? input.turns.slice(-HANDOFF_TRANSCRIPT_TURN_LIMIT).map((t) => ({ speaker: t.speaker, text: maskDigits(t.text) }))
    : [];
  const notes: string[] = [];
  if (!transcriptIncluded) notes.push('Caller did not consent to recording. Transcript withheld.');
  if (input.reason === 'urgent') notes.push('Caller raised an urgent matter. Call back as a priority.');
  if (input.reason === 'provider_down') notes.push('Automated line was unavailable. Caller was passed to staff.');
  return {
    reason: input.reason,
    callerNumberMasked: maskCaller(input.callerNumber),
    transcriptIncluded,
    transcript,
    notes,
  };
}
