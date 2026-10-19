/**
 * Typed event layer for OAE observability.
 *
 * Events live in `<project>/.oae/events.jsonl` (append-only, one JSON object
 * per line, pushed by Store.event). This module gives them names and the
 * small amount of logic that must be shared between the orchestrator (which
 * emits) and the dashboard/viewmodel (which consumes).
 *
 * Design: the taxonomy is ADDITIVE over the historical kinds
 * (run_started, plan_ready, task_added, task_updated, attempt_added, validator,
 * attempt_finished, agent_progress, retry_scheduled, session_interrupted,
 * provider_error, supervisor_*, decision, task_error, run_finished).
 * Nothing is renamed — existing state.json/events.jsonl keep their meaning.
 *
 * No event requires an LLM; narratives are rendered by deterministic
 * templates (see dashboard.ts).
 */
import { nowISO } from "./util.ts";
import { classifyProviderError } from "./contracts.ts";

/** Event kinds written by OAE itself (subset of `Store.event` kinds). */
export const EventKind = {
  RunStarted: "run_started",
  PlanReady: "plan_ready",
  TaskAdded: "task_added",
  TaskUpdated: "task_updated",
  AttemptAdded: "attempt_added",
  AttemptFinished: "attempt_finished",
  AgentProgress: "agent_progress",
  RetryScheduled: "retry_scheduled",
  SessionInterrupted: "session_interrupted",
  ProviderError: "provider_error",
  Validator: "validator",
  Decision: "decision",
  SupervisorDiagnose: "supervisor_diagnose",
  SupervisorRecover: "supervisor_recover",
  SupervisorQuarantine: "supervisor_quarantine",
  TaskError: "task_error",
  RunFinished: "run_finished",
  RunReconciled: "run_reconciled",
} as const;

/** One parsed events.jsonl line (unknown kinds are preserved, not dropped). */
export interface OaeEvent {
  at: string;
  kind: string;
  [key: string]: unknown;
}

/**
 * Classify a provider/runtime failure surfaced by a runner outcome.
 * The service reports e.g. "Provider request failed with HTTP 429: {...}".
 * Recognition is by stable markers in the message, never by assumptions.
 *
 * Single classification engine (review finding F5): the kind/httpStatus
 * rules live ONLY in contracts.ts (classifyProviderError); this function is
 * a compatibility FACET of that engine, preserving the coarse provider/runner
 * source distinction used by the orchestrator and the availability gates.
 */
export interface ProviderFailure {
  kind: "provider" | "runner";
  /** HTTP status when identifiable (401/429/…), else undefined. */
  httpStatus?: number;
  message: string;
}

export function classifyProviderFailure(raw: string): ProviderFailure {
  const msg = String(raw ?? "").trim();
  const engine = classifyProviderError(msg, "provider" as const);
  // source facet: runner-marker wins, everything else (unmarked included)
  // stays provider — exactly the historical precedence
  const kind: ProviderFailure["kind"] = msg.startsWith("runner error:") ? "runner" : "provider";
  return { kind, httpStatus: engine.httpStatus, message: msg };
}

/** True when a failure means "the provider never delivered compute" — e.g.
 * HTTP 429 rate limiting or 401 auth — provable today by the recorded
 * benchmarks (0 tokens in every attempt of run-mvb4b2ov/run-mvb4xohu). */
export function isProviderUnavailableFailure(f: ProviderFailure): boolean {
  if (f.kind === "provider" && (f.httpStatus === 429 || f.httpStatus === 401)) return true;
  return false;
}

/** Build a minimal, flat event record (timestamps here; truncation by caller). */
export function makeEvent(kind: string, data: Record<string, unknown>): OaeEvent {
  return { at: nowISO(), kind, ...data };
}
