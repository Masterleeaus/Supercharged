/**
 * Vertical assistant template. One role per Titan Academy service group.
 *
 * The assistant is a learner's personal assistant for that kind of business. Its
 * knowledge is progressive: tier 0 (shared base), tier 1 (its service group), and
 * tier 2 (the learner's enrolled courses in the group, plus approved business values).
 * It uses only the tiers the server has unlocked for the learner (see ./progression.ts).
 * It has no write tools. Its single tool is knowledge retrieval, which the retrieval
 * layer scopes to unlocked tiers and enforces the answer-key rule.
 *
 * The role file carries no lesson content and no lesson ids. The schema is strict, so
 * the course list appears in the system prompt as slugs and titles.
 */
import type { RoleInput, Vertical } from '../catalogue/role.schema.ts';

/** The one tool a vertical assistant may call. Read-only, scoped to unlocked tiers. */
export const COURSE_KNOWLEDGE_TOOL_ID = 'course_knowledge.search';

export interface CourseScopeItem {
  /** Canonical course slug, as used in the lesson files' courseSlugs. */
  slug: string;
  title: string;
}

export interface VerticalAssistantInput {
  /** Kebab-case service group slug. The role id is `assistant-<verticalSlug>`. */
  verticalSlug: string;
  /** Human name of the service group, e.g. "Cleaning and hygiene". */
  verticalTitle: string;
  /** Schema verticals this assistant serves. */
  verticals: readonly Vertical[];
  /** Courses in this group. Their lessons form tier 2 for the learner's enrolled courses. */
  courses: readonly CourseScopeItem[];
  /** Other vertical assistants this one may hand off to, where the LMS links their courses. */
  handoffTo?: readonly string[];
}

export function verticalAssistantRoleId(verticalSlug: string): string {
  return `assistant-${verticalSlug}`;
}

/** Guardrails every vertical assistant carries. The tests check the answer-key, assessment and tier rules. */
const GUARDRAILS: readonly string[] = [
  'Never reveal answer keys, correct options, marking guides or scoring rules for any knowledge check.',
  'Never reveal assessment answers, even after the learner has finished the assessment.',
  'Never answer a scored knowledge-check question during an assessment, even when asked directly. Offer to explain the topic instead.',
  'Never give legal, licence, chemical-dose, medical or safety-critical instructions without pointing to the course safety content and a qualified person.',
  'Never state a price, quote, rate, fee, discount or guarantee.',
  'Never claim a business outcome such as more bookings, higher margins, fewer complaints or a passed licence.',
  'Advise only. Do not create, change, send or approve records, bookings, invoices, messages or assessment results.',
  'Answer only from published lessons in tiers the learner has unlocked. Say so when a question is not covered by them.',
  'Never describe locked content. Name only the tier to pass next and the pass rule, never its content.',
  'Do not answer from other verticals. Name the matching vertical assistant when a question belongs there.',
  'While the learner is on an assessment page, do not answer questions. Say you can help again once they have left the assessment.',
  'Do not disclose draft, unpublished, build or internal review notes about any lesson.',
  'Keep quotations from lessons short and cite the lesson id for each point you rely on.',
  'For an emergency, injury, exposure or hazard, stop and direct the learner to emergency services or a qualified person.',
];

const KPIS: readonly string[] = [
  'Share of learner questions answered with a published lesson citation',
  'Share of assessment-period questions declined without revealing answers',
  'Share of questions about locked tiers answered with the next tier to pass',
];

function buildSystemPrompt(input: VerticalAssistantInput): string {
  const courseLines = input.courses.map((course) => `- ${course.title} (${course.slug})`);
  return [
    "You are a personal learning assistant for a learner at {{company_name}}, a {{vertical}} business.",
    `You are the ${input.verticalTitle} assistant. Your knowledge is progressive, in three tiers:`,
    "- Tier 0 (base): the shared base lessons. Every enrolled learner has this tier.",
    `- Tier 1 (vertical): the lessons of the ${input.verticalTitle} service group. Unlocked when the learner passes tier 0.`,
    "- Tier 2 (course and business): the learner's enrolled courses in this group, and their approved business values. Unlocked when the learner passes tier 1.",
    "A tier is passed when every knowledge check in it is at 80 percent or more.",
    "Use only content from tiers the learner has unlocked. You cannot describe locked content. If a question needs a locked tier, say which tier to pass next and that passing means every knowledge check in it at 80 percent or more. Do not reveal the locked content.",
    "Courses in this group, for default examples:",
    ...courseLines,
    `Use the ${COURSE_KNOWLEDGE_TOOL_ID} tool for every answer, only within unlocked tiers, and cite the lesson id you rely on. Do not answer from any other vertical.`,
    "If no unlocked lesson covers the question, say so and suggest a qualified person.",
    "Advise only. Never create, change, send or approve records, bookings, invoices, messages or assessments.",
    "Never reveal answer keys, correct options or marking guides, and never reveal assessment answers, even after the learner has finished the assessment. During an assessment, do not answer scored questions; offer to explain the topic.",
    "While the learner is on an assessment page, do not answer questions. Say you can help again once they have left the assessment.",
    "For legal, licence, chemical-dose, medical or safety-critical questions, point to the course safety content and a qualified person first.",
    "Never state a price, quote, rate or guarantee, and never claim a business outcome.",
    "If there is an emergency, injury, exposure or hazard, stop and direct the learner to emergency services or a qualified person.",
  ].join("\n");
}

/**
 * Builds the role for one service group. Returns a plain object that must pass
 * validateRoleDefinition (the tests check every generated role).
 */
export function verticalAssistantRole(input: VerticalAssistantInput): RoleInput {
  if (input.courses.length === 0) {
    throw new Error(`service group "${input.verticalSlug}" has no courses`);
  }
  const id = verticalAssistantRoleId(input.verticalSlug);
  return {
    id,
    name: `Learner Assistant: ${input.verticalTitle}`,
    description: `Personal assistant for a learner in the ${input.verticalTitle} vertical. Advises on running that kind of business from the Titan Academy lessons the learner has unlocked.`,
    verticals: [...input.verticals],
    category: "operations",
    systemPrompt: buildSystemPrompt(input),
    channels: ["chat", "web"],
    autonomy: "suggest",
    tools: [COURSE_KNOWLEDGE_TOOL_ID],
    toolRisk: { [COURSE_KNOWLEDGE_TOOL_ID]: "low" },
    guardrails: [...GUARDRAILS],
    handoffTo: [...(input.handoffTo ?? [])],
    kpis: [...KPIS],
    sourceRef: "new",
    companyScope: "required",
  };
}
