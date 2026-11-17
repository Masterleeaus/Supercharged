---
name: "Implementation issue — verified checklist"
about: "Track implementation, tests, release evidence and closure criteria."
title: ""
labels: []
assignees: []
---

## Objective
Describe the specific outcome and why it matters. Link related issues and canonical owners.

## Scope and dependencies
Identify the actual source paths, integrations, security or privacy constraints, and existing behavior to preserve.

## Implementation tasks
- [ ] Inspect the current code and reproduce or confirm the gap with evidence.
- [ ] Implement the smallest separately reviewable functional change.
- [ ] Implement remaining required functionality and integration boundaries.
- [ ] Add or update automated tests, including error and permission cases.
- [ ] Run relevant tests and required CI checks; link passing evidence.
- [ ] Document affected contracts, deployment/rollback, and PR/commit references.

## Definition of done
Every checkbox must correspond to completed **verified** work. Keep tasks unchecked when work, review, or test evidence is missing. The issue-closure workflow reopens issues closed with missing or unchecked tasks.
