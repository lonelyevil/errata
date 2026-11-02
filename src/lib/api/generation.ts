import { apiFetch } from './client'
import { resumeGenerationRun, startResumableGenerationRun } from './generation-run'
import type { GenerationLogSummary, GenerationLog, SuggestionDirection, Clarification, ChatEvent } from './types'
import type { GenerationRunStatus } from './generation-run'

export type { GenerationRunStatus } from './generation-run'

/** Optional clarify-before-generate answers carried into a (re)generation request. */
export interface ClarifyOpts {
  clarifications?: Clarification[]
  clarifyRound?: number
}

export function clarifyBody(opts?: ClarifyOpts): Record<string, unknown> {
  const clarifications = opts?.clarifications ?? []
  const round = opts?.clarifyRound ?? 0
  // Send the round even with no clarifications so "write anyway" (a high
  // force-proceed round) actually withholds the ask tool server-side. Without
  // this, skipping on the first round would just re-ask.
  if (!clarifications.length && round <= 0) return {}
  return { clarifications, clarifyRound: round }
}

export const generation = {
  /** Stream prose generation (returns ReadableStream of ChatEvent) */
  stream: (storyId: string, input: string, signal?: AbortSignal, opts?: ClarifyOpts): Promise<ReadableStream<ChatEvent>> =>
    startResumableGenerationRun(storyId, { input, saveResult: false, ...clarifyBody(opts) }, signal),
  /** Generate and save as a new prose fragment */
  generateAndSave: (storyId: string, input: string, signal?: AbortSignal, opts?: ClarifyOpts): Promise<ReadableStream<ChatEvent>> =>
    startResumableGenerationRun(storyId, { input, saveResult: true, ...clarifyBody(opts) }, signal),
  /** Regenerate an existing fragment with a new prompt */
  regenerate: (storyId: string, fragmentId: string, input: string, signal?: AbortSignal, opts?: ClarifyOpts): Promise<ReadableStream<ChatEvent>> =>
    startResumableGenerationRun(storyId, { input, saveResult: true, mode: 'regenerate', fragmentId, ...clarifyBody(opts) }, signal),
  /** Refine an existing fragment with instructions */
  refine: (storyId: string, fragmentId: string, input: string, signal?: AbortSignal, opts?: ClarifyOpts): Promise<ReadableStream<ChatEvent>> =>
    startResumableGenerationRun(storyId, { input, saveResult: true, mode: 'refine', fragmentId, ...clarifyBody(opts) }, signal),
  /** Re-attach to an existing generation run, optionally after a known seq. */
  resume: (storyId: string, runId: string, signal?: AbortSignal, after = 0): Promise<ReadableStream<ChatEvent>> =>
    resumeGenerationRun(storyId, runId, signal, after),
  /** Get the server-side state of a generation run. */
  getRun: (storyId: string, runId: string): Promise<GenerationRunStatus> =>
    apiFetch<GenerationRunStatus>(`/stories/${encodeURIComponent(storyId)}/generation-runs/${encodeURIComponent(runId)}`),
  /** Explicitly stop a generation run on the server. */
  cancelRun: (storyId: string, runId: string): Promise<{ runId?: string; status?: string }> =>
    apiFetch<{ runId?: string; status?: string }>(
      `/stories/${encodeURIComponent(storyId)}/generation-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    ),
  /** Get AI-generated story direction suggestions */
  suggestDirections: (storyId: string, count?: number) =>
    apiFetch<{ suggestions: SuggestionDirection[] }>(
      `/stories/${storyId}/suggest-directions`,
      { method: 'POST', body: JSON.stringify({ count }) },
    ),
  /** List generation log summaries (newest first) */
  listLogs: (storyId: string) =>
    apiFetch<GenerationLogSummary[]>(`/stories/${storyId}/generation-logs`),
  /** Get a full generation log by ID */
  getLog: (storyId: string, logId: string) =>
    apiFetch<GenerationLog>(`/stories/${storyId}/generation-logs/${logId}`),
}
