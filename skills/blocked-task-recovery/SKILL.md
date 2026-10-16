---
name: Blocked Task Recovery
description: How an OAE agent should resume a task after the supervisor interrupted it for stalling — consume the recovery context, reduce scope, verify each step.
metadata:
  opencode/autoinvoke: false
---

# Blocked Task Recovery Procedure

The supervisor interrupted your predecessor because it made no verifiable progress.
You are starting fresh on the same task. Do not continue the failed approach blindly.

## 1. Read the recovery context
- The prompt contains the transcript tail of the stalled attempt and the diagnosis.
- Identify the exact point where progress stopped and the error that repeated.

## 2. Reduce scope
- Pick the smallest step that still moves an acceptance criterion forward.
- If the task can be split, implement one verifiable piece now.

## 3. Change strategy
- If the previous agent looped on the same failing approach, choose a materially
  different solution (different file, different technique, different ordering).

## 4. Verify every step
- After each edit, run a validator or a focused check and confirm the result.

## 5. Report honestly
- If the task still cannot be completed, state the impediment precisely
  (`IMPEDIMENT: <reason>`) — a precise report is a valid outcome.
