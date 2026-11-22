# mend

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![agent](https://make.fun/badge-agent.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![dynamic](https://make.fun/badge-dynamic.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — and mend reads each one as SPEC.md says, finds the lines an edit names even when the model drifted them (three-tier fuzzy matching with re-indentation, nearest-occurrence and cursor rules), and changes every file or nothing.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, with the patch from a file or standard input; `node check.ts <practice.json>` runs the practice set. Node 22, standard library only.
