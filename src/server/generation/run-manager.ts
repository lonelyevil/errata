// In-memory registry for background generation runs.
//
// A run owns its own abort controller and event buffer, and consumes the
// shared generation executor exactly once. HTTP subscribers only attach to the
// buffer: cancelling an events request unsubscribes, it never aborts the LLM.
import { randomUUID } from 'node:crypto'
import { createLogger, type Logger } from '../logging'
import {
  executeGeneration,
  resolveGenerationRequest,
  type GenerationRunBody,
  type GenerationEvent,
  type ResolvedGenerationRequest,
} from './executor'

export type GenerationRunStatus = 'running' | 'saving' | 'done' | 'error'

export interface BufferedGenerationEvent {
  seq: number
  event: GenerationEvent
}

export interface GenerationRunSnapshot {
  runId: string
  status: GenerationRunStatus
  lastSeq: number
  error?: string
}

export interface StartGenerationRunOptions {
  runId?: string
  /** Pre-resolved request; callers validate before creating the run. */
  resolved: ResolvedGenerationRequest
}

interface GenerationRun {
  runId: string
  storyId: string
  status: GenerationRunStatus
  events: BufferedGenerationEvent[]
  error?: string
  waiters: Array<() => void>
  abortController: AbortController
  terminalEventPushed: boolean
  completedAt?: number
}

export interface GenerationRunManagerOptions {
  /** How long a finished run stays queryable. Defaults to 5 minutes. */
  ttlMs?: number
  /** Clock injection for tests. */
  now?: () => number
}

const DEFAULT_TTL_MS = 5 * 60_000
const MAX_COMPLETED_RUNS = 100

function isTerminal(status: GenerationRunStatus): boolean {
  return status === 'done' || status === 'error'
}

function runKey(storyId: string, runId: string): string {
  return `${storyId}\u0000${runId}`
}

export class GenerationRunManager {
  private readonly runs = new Map<string, GenerationRun>()
  private readonly dataDir: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly logger: Logger

  constructor(dataDir: string, options: GenerationRunManagerOptions = {}) {
    this.dataDir = dataDir
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => Date.now())
    this.logger = createLogger('generation:run-manager', { dataDir })
  }

  /**
   * Create (or return) a run and start executing it in the background. When a
   * runId is supplied, repeated starts for the same story return the existing
   * run without invoking the LLM again.
   */
  startRun(
    storyId: string,
    body: GenerationRunBody,
    options: StartGenerationRunOptions,
  ): { runId: string; existing: boolean } {
    this.sweep()

    const requestedRunId = options.runId
    if (requestedRunId) {
      const existing = this.runs.get(runKey(storyId, requestedRunId))
      if (existing) {
        return { runId: existing.runId, existing: true }
      }
    }

    const runId = requestedRunId ?? randomUUID()
    const run: GenerationRun = {
      runId,
      storyId,
      status: 'running',
      events: [],
      waiters: [],
      abortController: new AbortController(),
      terminalEventPushed: false,
    }
    this.runs.set(runKey(storyId, runId), run)

    void this.executeRun(run, body, options.resolved)
    return { runId, existing: false }
  }

  getSnapshot(storyId: string, runId: string): GenerationRunSnapshot | null {
    this.sweep()
    const run = this.runs.get(runKey(storyId, runId))
    if (!run) return null

    return {
      runId: run.runId,
      status: run.status,
      lastSeq: run.events.length,
      ...(run.error ? { error: run.error } : {}),
    }
  }

  /** Explicitly abort a run. Returns null when the run is unknown. */
  cancel(storyId: string, runId: string): { ok: true } | null {
    this.sweep()
    const run = this.runs.get(runKey(storyId, runId))
    if (!run) return null
    if (!isTerminal(run.status)) {
      run.abortController.abort()
    }
    return { ok: true }
  }

  /**
   * Replay every buffered event with `seq > after`, then follow live until the
   * run reaches a terminal state. Cancelling the returned stream only removes
   * this subscriber; the run keeps executing.
   */
  createEventStream(
    storyId: string,
    runId: string,
    after: number,
  ): ReadableStream<Uint8Array> | null {
    this.sweep()
    const run = this.runs.get(runKey(storyId, runId))
    if (!run) return null

    const encoder = new TextEncoder()
    let cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0
    let closed = false
    let waiter: (() => void) | null = null

    const unsubscribe = () => {
      closed = true
      if (waiter) {
        const index = run.waiters.indexOf(waiter)
        if (index >= 0) run.waiters.splice(index, 1)
        const wake = waiter
        waiter = null
        wake()
      }
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (!closed) {
          if (cursor < run.events.length) {
            const entry = run.events[cursor++]
            controller.enqueue(encoder.encode(JSON.stringify(entry) + '\n'))
            return
          }

          if (isTerminal(run.status)) {
            closed = true
            controller.close()
            return
          }

          await new Promise<void>((resolve) => {
            waiter = resolve
            run.waiters.push(resolve)
          })
          waiter = null
        }
      },
      cancel() {
        unsubscribe()
      },
    })
  }

  private async executeRun(
    run: GenerationRun,
    body: GenerationRunBody,
    resolved: ResolvedGenerationRequest,
  ): Promise<void> {
    try {
      const outcome = await executeGeneration({
        dataDir: this.dataDir,
        storyId: run.storyId,
        body,
        resolved,
        signal: run.abortController.signal,
        logger: this.logger.child({ storyId: run.storyId }),
        emit: (event) => this.pushEvent(run, event),
        onStatus: (status) => {
          if (!isTerminal(run.status)) run.status = status
        },
      })

      if (outcome.status === 'error') {
        this.finishRun(run, 'error', outcome.error ?? 'Generation failed')
      } else {
        this.finishRun(run, 'done')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.finishRun(run, 'error', message)
    }
  }

  private pushEvent(run: GenerationRun, event: GenerationEvent): void {
    if (run.terminalEventPushed) return
    run.events.push({ seq: run.events.length + 1, event })
    this.wake(run)
  }

  private finishRun(
    run: GenerationRun,
    status: 'done' | 'error',
    error?: string,
  ): void {
    if (run.terminalEventPushed) return

    if (status === 'error') {
      run.error = error ?? 'Generation failed'
      this.pushEvent(run, { type: 'run-error', error: run.error })
    } else {
      this.pushEvent(run, { type: 'run-done' })
    }

    run.terminalEventPushed = true
    run.status = status
    run.completedAt = this.now()
    this.wake(run)
  }

  private wake(run: GenerationRun): void {
    const waiters = run.waiters.splice(0)
    for (const wake of waiters) {
      wake()
    }
  }

  /** Drop expired finished runs and bound the number of retained runs. */
  private sweep(): void {
    const timestamp = this.now()

    for (const [key, run] of this.runs) {
      if (run.completedAt !== undefined && timestamp - run.completedAt >= this.ttlMs) {
        for (const wake of run.waiters.splice(0)) wake()
        this.runs.delete(key)
      }
    }

    if (this.runs.size <= MAX_COMPLETED_RUNS) return

    const completed = [...this.runs.entries()]
      .filter(([, run]) => isTerminal(run.status))
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0))
    let excess = this.runs.size - MAX_COMPLETED_RUNS
    for (const [key] of completed) {
      if (excess <= 0) break
      this.runs.delete(key)
      excess--
    }
  }
}

export { resolveGenerationRequest }
