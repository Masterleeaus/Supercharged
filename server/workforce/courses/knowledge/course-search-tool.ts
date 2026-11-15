/**
 * The course_knowledge.search tool for the Academy assistants (issue #49).
 *
 * A thin, read-only wrapper over the shared retrieval path (runtime/knowledge-retrieval.ts), with the
 * course search port (courses/store/search-port.ts) behind it. The port re-checks publication, enrolment,
 * tier unlock, assessment state and answer-material screening on every call.
 *
 * Identity comes only from the verified handler context. Any companyId or userId in the tool params is
 * ignored, so a learner cannot ask for another learner's lessons by naming them.
 *
 * Not registered anywhere yet. Registration needs a learner-context reader and a revision store bound to
 * the LMS database, which this checkout does not have. See docs/working/named-managers.md.
 */
import type { KnowledgeSearchPort } from "../../runtime/knowledge-retrieval.ts";
import { retrieveCompanyKnowledge, type RetrievalOutcome } from "../../runtime/knowledge-retrieval.ts";
import type { ToolDefinition } from "../../runtime/tool-registry.ts";
import { COURSE_KNOWLEDGE_TOOL_ID } from "../course-agent.template.ts";

export interface CourseSearchToolOptions {
  port: KnowledgeSearchPort;
}

/**
 * Builds the read-only course_knowledge.search tool. The handler never throws: every failure is returned as
 * { ok: false, error } by the shared retrieval path.
 */
export function createCourseKnowledgeSearchTool(options: CourseSearchToolOptions): ToolDefinition {
  return {
    id: COURSE_KNOWLEDGE_TOOL_ID,
    risk: "low",
    access: "read",
    schema: {
      query: { type: "string", required: true },
      maxResults: { type: "number" },
    },
    handler: (params, context): Promise<RetrievalOutcome> => retrieveCompanyKnowledge(options.port, {
      companyId: context.companyId,
      // The learner is read from the verified context. The params carry no identity and any userId in them is ignored.
      userId: (context as { userId?: unknown }).userId,
      query: params.query,
      maxResults: params.maxResults,
    }),
  };
}
