---
name: Implementation task with verified completion
about: Track actionable engineering tasks with evidence before closure
title: ""
labels: ""
assignees: ""
---

## Problem and expected outcome
Describe the current observable behaviour, the desired result and who is affected.

## Scope and dependencies
Identify repositories, services, API contracts, risks and linked issues or PRs. Do not duplicate an existing authoritative implementation.

## Actionable task checklist
Replace these starter tasks with specific independently verifiable work items. Keep each item unchecked until its work and verification are complete.

- [ ] Inspect the existing implementation and document the failing or missing behaviour
- [ ] Implement the required source, schema, API, UI and configuration changes
- [ ] Add or update automated positive, negative, security and regression tests
- [ ] Run relevant CI, integration and end-to-end tests and record the results
- [ ] Verify tenancy, permissions, privacy, data migration and rollback where applicable
- [ ] Update necessary operational documentation and release notes
- [ ] Link the implementation PR/commit and test evidence; verify all acceptance criteria

## Acceptance criteria
State measurable expected behaviour, including edge cases and failure handling.

## Completion evidence
- Implementation PR/commit:
- Tests/CI:
- Manual or staging verification:
- Residual risks / follow-up issues:

**Closure policy:** All Markdown checklist tasks must be marked `[x]` only with credible implementation and verification evidence. Issues closed with unchecked tasks or without any checklist are automatically reopened by the repository's issue-completion guard.
