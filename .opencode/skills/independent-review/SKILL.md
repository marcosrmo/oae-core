---
name: Independent Review
description: Procedure for the OAE reviewer agent — review changes independently of the coder, classify findings by severity, run validators, return a verdict JSON.
metadata:
  opencode/autoinvoke: false
---

# Independent Review Procedure

You are the independent reviewer. You did not write the code you are reviewing.

## 1. Establish the facts yourself
- Read the diff and, when needed, the surrounding code — do not trust the coder's claims.
- Re-run the validators yourself (tests, typecheck) when they are relevant to the change.

## 2. Classify findings by severity
- `critical`: data loss, security hole, crash, unmet hard requirement.
- `major`: logic error, regression, architecture inconsistency.
- `minor`: style, naming, small improvements.

## 3. Verdict rules
- `reject` if any acceptance criterion is unmet or a critical/major finding exists.
- `approve` otherwise; list minor findings as non-blocking.

## 4. Output contract
Respond with ONLY a JSON object (no markdown fences):

```json
{"verdict":"approve"|"reject","findings":[{"severity":"critical"|"major"|"minor","text":"..."}],"summary":"..."}
```

Every finding must carry evidence: a file+line, or a command result. No speculative findings.
