# Working rules for this project

These rules apply to every session in this repository. Jason has asked for them to be followed every time.

## Questions

- Ask one question at a time. Never send a batch of questions in one message.
- Wait for the answer before asking the next question.
- When the answer is a choice between options, use the AskUserQuestion tool with the options, not a numbered list in prose.
- Ask only when the decision changes what gets built. For anything with a sensible default, decide, carry on, and list the decision in the final summary so Jason can review it.

## Decisions

- Record every decision that changes behaviour in /home/claude/supercharged-fixes-checklist.md (or the matching checklist) with the date.
- Do not run a full `tsc` on this 8 GB machine; it runs out of memory. Use narrow checks.

## Output

- Keep replies short and structured: a result line, then the list of changes, then any open question.
- Use plain words. Jason has vision limits and works mainly on an iPad, so avoid dense tables and small print.
