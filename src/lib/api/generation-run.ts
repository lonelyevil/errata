import { ApiError, API_BASE } from './client'
import type { ChatEvent } from './types'

/** User-facing state of a generation run, as reported by the server. */
export interface GenerationRunStatus {
  runId: string
  status: string
  lastSeq: number
  error?: string
}

function isGenerationRunStatus(value: unknown): value is GenerationRunStatus {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { runId?: unknown; status?: unknown }
  return typeof candidate.runId === 'string' && candidate.runId.length > 0 && typeof candidate.status === 'string'
}

/** Tunables for reconnect behaviour. Exposed for tests; production callers use defaults. */
export interface ResumableGenerationOptions {
  /** First retry delay; doubles on every failed attempt. */
  reconnectBaseDelayMs?: number
  /** Upper bound for a single retry delay. */
  reconnectMaxDelayMs?: number
  /** Give up after this many consecutive failed reconnect attempts. */
  reconnectMaxAttempts?: number
  /** Give up starting the run after this many attempts. */
  startMaxAttempts?: number
}

interface ReconnectConfig {
  baseDelayMs: number
  maxDelayMs: number
  maxAttempts: number
  startMaxAttempts: number
}

const DEFAULT_RECONNECT: ReconnectConfig = {
  baseDelayMs: 200,
  maxDelayMs: 4000,
  maxAttempts: 8,
  startMaxAttempts: 8,
}

type ConnectOutcome =
  | { kind: 'done' }
  | { kind: 'fatal'; error: Error }
  | { kind: 'retry'; received: number; error?: unknown }

interface RunStreamConfig {
  storyId: string
  runId: string
  /** Present for a new run; absent when resuming an existing run. */
  body?: Record<string, unknown> | null
  signal?: AbortSignal
  after: number
  options?: ResumableGenerationOptions
}

/**
 * Creates a run id before the first request. Prefers `crypto.randomUUID` and
 * falls back to a v4-shaped id from `crypto.getRandomValues` or Math.random so
 * the same id can be replayed for idempotent start requests.
 */
export function createGenerationRunId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryDelayMs(attempt: number, config: ReconnectConfig): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(config.maxDelayMs, exponential)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readErrorBody(res: Response): Promise<{ message: string; data: Record<string, unknown> }> {
  try {
    const parsed: unknown = await res.json()
    if (parsed && typeof parsed === 'object') {
      const data = parsed as Record<string, unknown>
      const message = typeof data.error === 'string' ? data.error : `API error: ${res.status}`
      return { message, data }
    }
  } catch {
    // Fall through to the generic message.
  }
  return { message: `API error: ${res.status}`, data: {} }
}

/**
 * Reads a chunk while also reacting to the internal abort signal. A mocked or
 * misbehaving fetch may ignore the signal; racing keeps abort responsive.
 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(createAbortError(signal))

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function resolveConfig(options?: ResumableGenerationOptions): ReconnectConfig {
  return {
    baseDelayMs: options?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT.baseDelayMs,
    maxDelayMs: options?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    maxAttempts: options?.reconnectMaxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
    startMaxAttempts: options?.startMaxAttempts ?? DEFAULT_RECONNECT.startMaxAttempts,
  }
}

/**
 * Starts a generation run and returns a resumable stream of ChatEvents. The
 * POST is idempotent on `runId`, and dropped event connections are resumed
 * from `after=lastSeq` with bounded exponential backoff.
 */
export async function startResumableGenerationRun(
  storyId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  options?: ResumableGenerationOptions,
): Promise<ReadableStream<ChatEvent>> {
  return createRunStream({
    storyId,
    runId: createGenerationRunId(),
    body,
    signal,
    after: 0,
    options,
  })
}

/**
 * Re-attaches to an existing generation run. `after` lets a caller replay from
 * a previously observed sequence number (defaults to replaying the whole run).
 */
export async function resumeGenerationRun(
  storyId: string,
  runId: string,
  signal?: AbortSignal,
  after = 0,
  options?: ResumableGenerationOptions,
): Promise<ReadableStream<ChatEvent>> {
  return createRunStream({
    storyId,
    runId,
    body: null,
    signal,
    after,
    options,
  })
}

function createRunStream(config: RunStreamConfig): ReadableStream<ChatEvent> {
  const reconnect = resolveConfig(config.options)
  const externalSignal = config.signal
  const internalAbort = new AbortController()

  let runId = config.runId
  let lastSeq = Number.isFinite(config.after) ? Math.max(0, Math.trunc(config.after)) : 0
  let aborted = false
  let closed = false
  let cancelSent = false

  const runPath = () => `${API_BASE}/stories/${encodeURIComponent(config.storyId)}/generation-runs/${encodeURIComponent(runId)}`
  const eventsPath = (after: number) => `${runPath()}/events?after=${after}`

  const cancelServerRun = () => {
    if (cancelSent) return
    cancelSent = true
    // Fire-and-forget: the user asked to stop, so do not block on this and do
    // not resurrect the aborted signal.
    void fetch(`${runPath()}/cancel`, { method: 'POST' }).catch(() => {})
  }

  const stop = () => {
    if (aborted) return
    aborted = true
    internalAbort.abort()
    cancelServerRun()
  }

  const onExternalAbort = () => stop()
  if (externalSignal) {
    if (externalSignal.aborted) {
      // Defer so the stream still exists for the caller to observe the abort.
      aborted = true
      internalAbort.abort()
      cancelServerRun()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  const cleanup = () => {
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }

  const safeClose = (controller: ReadableStreamDefaultController<ChatEvent>) => {
    if (closed) return
    closed = true
    try {
      controller.close()
    } catch {
      // Consumer already cancelled the stream.
    }
  }

  const safeFail = (controller: ReadableStreamDefaultController<ChatEvent>, error: unknown) => {
    if (closed) return
    closed = true
    try {
      controller.error(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // Consumer already cancelled the stream.
    }
  }

  const enqueue = (controller: ReadableStreamDefaultController<ChatEvent>, event: ChatEvent) => {
    if (closed || aborted) return
    try {
      controller.enqueue(event)
    } catch {
      closed = true
    }
  }

  /**
   * Starts the run. A lost response is recovered by querying the run with the
   * id we already know; if the server has not created it yet, retry the
   * idempotent POST with the same id.
   */
  const startRun = async (): Promise<void> => {
    let attempts = 0
    let lastError: unknown

    while (attempts < reconnect.startMaxAttempts) {
      if (aborted) throw createAbortError(externalSignal)

      let retryable = false
      try {
        const res = await fetch(`${API_BASE}/stories/${encodeURIComponent(config.storyId)}/generation-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(config.body ?? {}), runId }),
          signal: internalAbort.signal,
        })

        if (res.ok) {
          try {
            const data = (await res.json()) as { runId?: unknown }
            if (data && typeof data.runId === 'string' && data.runId) runId = data.runId
          } catch {
            // The run was accepted; the echoed id is optional.
          }
          return
        }

        const { message, data } = await readErrorBody(res)
        const error = new ApiError(message, res.status, data)
        if (!isRetryableStatus(res.status)) throw error
        lastError = error
        retryable = true
      } catch (error) {
        if (aborted || isAbortError(error)) throw createAbortError(externalSignal)
        if (error instanceof ApiError) throw error
        lastError = error

        // The request may have reached the server even though the response was
        // lost. Only attach if the status response positively identifies the
        // run; a 404, a malformed body, or an unreadable response means we
        // cannot confirm it exists, so replay the idempotent POST instead.
        const status = await queryRunStatus()
        if (status.ok && status.status !== null) return
        retryable = true
      }

      if (!retryable) return
      attempts += 1
      if (attempts >= reconnect.startMaxAttempts) break
      await delay(retryDelayMs(attempts, reconnect), internalAbort.signal)
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to start generation run')
  }

  const queryRunStatus = async (): Promise<
    { ok: true; status: GenerationRunStatus | null } | { ok: false }
  > => {
    try {
      const res = await fetch(runPath(), {
        method: 'GET',
        signal: internalAbort.signal,
        cache: 'no-store',
      })
      if (res.status === 404) return { ok: true, status: null }
      if (!res.ok) return { ok: false }
      try {
        const data: unknown = await res.json()
        return { ok: true, status: isGenerationRunStatus(data) ? data : null }
      } catch {
        return { ok: true, status: null }
      }
    } catch {
      return { ok: false }
    }
  }

  const connectOnce = async (
    controller: ReadableStreamDefaultController<ChatEvent>,
  ): Promise<ConnectOutcome> => {
    let res: Response
    try {
      res = await fetch(eventsPath(lastSeq), {
        method: 'GET',
        headers: { Accept: 'application/x-ndjson, application/json' },
        signal: internalAbort.signal,
        cache: 'no-store',
      })
    } catch (error) {
      if (aborted || isAbortError(error)) throw createAbortError(externalSignal)
      return { kind: 'retry', received: 0, error }
    }

    if (!res.ok) {
      const { message, data } = await readErrorBody(res)
      const error = new ApiError(message, res.status, data)
      return isRetryableStatus(res.status)
        ? { kind: 'retry', received: 0, error }
        : { kind: 'fatal', error }
    }

    if (!res.body) {
      return { kind: 'retry', received: 0, error: new Error('No response body') }
    }

    const reader = res.body.getReader()
    // Each connection gets its own decoder and buffer so a half line from a
    // dropped connection can never leak into the next one.
    const decoder = new TextDecoder()
    let buffer = ''
    let received = 0
    let terminal: ConnectOutcome | null = null

    const handleLine = (raw: string): ConnectOutcome | null => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null
      }
      if (!parsed || typeof parsed !== 'object') return null

      const envelope = parsed as { seq?: unknown; event?: unknown }
      if (typeof envelope.seq !== 'number' || !Number.isFinite(envelope.seq)) return null
      const seq = Math.trunc(envelope.seq)
      if (seq <= lastSeq) return null // duplicate or out-of-order replay
      if (!envelope.event || typeof envelope.event !== 'object') return null

      lastSeq = seq
      const event = envelope.event as ChatEvent | { type: 'run-done' } | { type: 'run-error'; error?: unknown }

      if (event.type === 'run-done') return { kind: 'done' }
      if (event.type === 'run-error') {
        const message =
          typeof (event as { error?: unknown }).error === 'string'
            ? (event as { error: string }).error
            : 'Generation run failed'
        const error = new Error(message)
        error.name = 'GenerationRunError'
        return { kind: 'fatal', error }
      }

      received += 1
      enqueue(controller, event as ChatEvent)
      return null
    }

    try {
      while (true) {
        const { done, value } = await readWithAbort(reader, internalAbort.signal)
        if (done) {
          buffer += decoder.decode()
          const tail = buffer.trim()
          buffer = ''
          if (tail) terminal = handleLine(tail)
          break
        }

        buffer += decoder.decode(value, { stream: true })
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)
          if (!line) continue
          terminal = handleLine(line)
          if (terminal) break
        }
        if (terminal) break
      }
    } catch (error) {
      try {
        await reader.cancel(error)
      } catch {
        // Already released or aborted.
      }
      if (aborted || isAbortError(error)) throw createAbortError(externalSignal)
      return { kind: 'retry', received, error }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // A read may still be pending after abort; releaseLock throws then.
      }
    }

    if (terminal) return terminal
    // EOF without run-done/run-error means the connection dropped mid-run.
    return { kind: 'retry', received }
  }

  const pump = async (controller: ReadableStreamDefaultController<ChatEvent>) => {
    try {
      if (aborted) throw createAbortError(externalSignal)
      if (config.body) await startRun()

      let attempts = 0
      while (true) {
        if (aborted) throw createAbortError(externalSignal)

        let outcome: ConnectOutcome
        try {
          outcome = await connectOnce(controller)
        } catch (error) {
          if (aborted || isAbortError(error)) throw createAbortError(externalSignal)
          outcome = { kind: 'retry', received: 0, error }
        }

        if (outcome.kind === 'done') {
          safeClose(controller)
          return
        }
        if (outcome.kind === 'fatal') throw outcome.error

        // A connection that delivered events made progress; reset the budget so
        // a long run may recover from occasional drops, while a server that
        // keeps failing immediately is still bounded.
        if (outcome.received > 0) attempts = 0
        attempts += 1

        if (attempts > reconnect.maxAttempts) {
          const reason = outcome.error instanceof Error ? `: ${outcome.error.message}` : ''
          throw new Error(`Generation stream disconnected and could not recover${reason}`)
        }

        await delay(retryDelayMs(attempts, reconnect), internalAbort.signal)
      }
    } catch (error) {
      if (aborted) {
        safeFail(controller, createAbortError(externalSignal))
        return
      }
      safeFail(controller, error)
    } finally {
      cleanup()
    }
  }

  return new ReadableStream<ChatEvent>({
    start(controller) {
      void pump(controller)
    },
    cancel() {
      // Consumer abandoned the stream: stop the server run too.
      stop()
      cleanup()
    },
  })
}
