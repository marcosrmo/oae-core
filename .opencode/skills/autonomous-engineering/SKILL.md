---
name: Autonomous Engineering
description: Core procedure for OAE agents working autonomously on a task — investigate before editing, implement verifiable changes, validate, record evidence, never claim completion without proof.
metadata:
  opencode/autoinvoke: false
---

# Autonomous Engineering Procedure

You are executing one task inside an autonomous run. Follow this procedure exactly.

## 1. Investigate before editing
- Read the files and modules involved before changing anything.
- Identify the established patterns (naming, error handling, structure) and follow them.

## 2. Frame the task
- Restate the requirements, constraints and acceptance criteria for yourself.
- Distinguish technical decisions (you may make them, documenting the rationale) from
  business decisions (financial, fiscal, commercial, authorization, data handling):
  never invent those; implement only what is already established, prefer reversible
  implementations, and flag the uncertainty in your final reply.

## 3. Implement small and verifiable
- Change the fewest files that satisfy the task.
- Name the files you will touch before touching them.
- Each step should leave the code in a state you can verify.

## 4. Validate
- Run the project's validators (tests, typecheck, lint) relevant to your change.
- Paste the command and the meaningful part of its output as evidence.

## 5. Check regressions
- Look for other modules affected by your change and verify them too.

## 6. Record evidence
- Keep a log: files changed, commands run, results, and any decision made with its rationale.

## 7. Ask for help only at real blockers
- If you are truly blocked (missing information that only the user can provide, conflicting
  requirements, destructive operation needed), stop that action and write:
  `IMPEDIMENT: <reason>`. Do not stop for anything you can solve yourself.

## 8. Never claim completion without proof
- End every reply with a `RESULT:` section containing:
  - Files changed
  - Commands executed and their outcomes
  - Business hypotheses (if any), with confidence level
- If you could not finish, say exactly what state you left things in.
