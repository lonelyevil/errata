import { createAgentInstance } from '../agents'
import type { AgentStreamResult } from '../agents'
import { getStory } from '../fragments/storage'
import { withBranch } from '../fragments/branches'
import { withKeyLock } from '../async-lock'
import { createLogger } from '../logging'
import type {
  LibrarianChatSnapshot,
  LibrarianChatStartInput,
  LibrarianChatStatus,
} from '@/lib/librarian-chat'
import {
  isSafeChatId,
  mutateChatHistoryDocument,
  readChatHistoryDocument,
  toLibrarianChatSnapshot,
  type ChatHistory,
  type ChatHistoryMessage,
  type ChatHistoryToolCall,
  type ChatRunRecord,
} from './storage'

/**
 * Server-owned librarian chat runs.
 *
 * A run is accepted once, persisted atomically (user prompt + assistant
 * placeholder + run metadata), and then executed by a background reader that
 * is independent of any HTTP request. Clients poll the canonical history
 * document for a full snapshot. Dropping a poller has no effect; only an
 * explicit cancel request aborts the provider lifecycle signal.
 */

const logger = createLogger('librarian-chat-state')

/** Checkpoint coalescing interval. Rich partial state is flushed at most this often. */
export const LIBRARIAN_CHAT_CHECKPOINT_MS = 250

const MAX_PROMPT_LENGTH = 100_000
// Run IDs are only object keys and URL segments, never filesystem paths. Allow
// common client-generated punctuation (UUIDs, `run.1`, `run:abc`) while still
// rejecting separators and traversal-shaped values.
const SAFE_RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/

export class LibrarianChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'LibrarianChatRequestError'
  }
}

interface RunPartial {
  content: string
  reasoning: string
  toolCalls: ChatHistoryToolCall[]
}

interface ChatRunRuntime {
  key: string
  dataDir: string
  storyId: string
  branchId: string
  conversationId: string | null
  runId: string
  prompt: string
  maxSteps?: number
  abortController: AbortController
  cancelRequested: boolean
  done: boolean
  partial: RunPartial
  checkpointTimer: ReturnType<typeof setTimeout> | null
  writeChain: Promise<void>
}

const runtimes = new Map<string, ChatRunRuntime>()

function scopeKey(
  dataDir: string,
  storyId: string,
  branchId: string,
  conversationId?: string | null,
): string {
  return `${dataDir}\u0000${storyId}\u0000${branchId}\u0000${conversationId ?? '__default__'}`
}

function managerLockKey(
  dataDir: string,
  storyId: string,
  branchId: string,
  conversationId?: string | null,
): string {
  return `librarian-chat-manager:${scopeKey(dataDir, storyId, branchId, conversationId)}`
}

function makeMessageId(runId: string, role: 'user' | 'assistant'): string {
  return `msg-${role}-${runId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function validateRunId(runId: unknown): asserts runId is string {
  if (
    typeof runId !== 'string'
    || !SAFE_RUN_ID.test(runId)
    || runId === '.'
    || runId === '..'
  ) {
    throw new LibrarianChatRequestError('Invalid runId', 422)
  }
}

function validateStartInput(input: LibrarianChatStartInput): void {
  validateRunId(input.runId)
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new LibrarianChatRequestError('prompt is required', 422)
  }
  if (input.prompt.length > MAX_PROMPT_LENGTH) {
    throw new LibrarianChatRequestError(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`, 422)
  }
  if (typeof input.branchId !== 'string' || !isSafeChatId(input.branchId)) {
    throw new LibrarianChatRequestError('Invalid branchId', 422)
  }
  if (
    typeof input.expectedRevision !== 'number'
    || !Number.isInteger(input.expectedRevision)
    || input.expectedRevision < 0
  ) {
    throw new LibrarianChatRequestError('expectedRevision must be a non-negative integer', 422)
  }
  if (
    input.maxSteps !== undefined
    && (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 100)
  ) {
    throw new LibrarianChatRequestError('maxSteps must be an integer between 1 and 100', 422)
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (error instanceof Error) {
    return error.name === 'AbortError' || /aborted|cancelled|canceled/i.test(error.message)
  }
  return false
}

function findAssistantMessage(history: ChatHistory, runId: string, messageId?: string): ChatHistoryMessage | undefined {
  if (messageId) {
    const byId = history.messages.find(m => m.id === messageId && m.role === 'assistant')
    if (byId) return byId
  }
  for (let i = history.messages.length - 1; i >= 0; i -= 1) {
    const message = history.messages[i]
    if (message.role === 'assistant' && message.runId === runId) return message
  }
  return undefined
}

/**
 * Build the model input from committed server history.
 *
 * - Running (empty placeholder) assistant messages are excluded.
 * - Prior interrupted/cancelled/error partials are included with an explicit
 *   note so the model treats them as unconfirmed partial output.
 * - Empty assistant messages without tool evidence are excluded.
 */
export function buildLibrarianChatInputMessages(history: ChatHistory, currentRunId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of history.messages) {
    if (message.role === 'user') {
      if (message.content.trim()) {
        messages.push({ role: 'user', content: message.content })
      }
      continue
    }

    // Never feed the still-running placeholder for the current run back into
    // the model. Other running placeholders can only be orphaned/in-progress
    // concurrent runs, which are rejected by the one-active-run rule.
    if (message.status === 'running' || (message.runId === currentRunId && !message.content.trim() && !message.reasoning?.trim())) {
      continue
    }

    const content = message.content.trim()
    if (!content) {
      if (message.toolCalls?.length) {
        const names = [...new Set(message.toolCalls.map(tc => tc.toolName))]
        messages.push({ role: 'assistant', content: `[Assistant used tools: ${names.join(', ')}]` })
      }
      continue
    }

    if (message.status === 'interrupted') {
      messages.push({
        role: 'assistant',
        content: `${content}\n\n[Previous response was interrupted before completion. The text above is partial, unconfirmed output.]`,
      })
    } else if (message.status === 'cancelled') {
      messages.push({
        role: 'assistant',
        content: `${content}\n\n[Previous response was explicitly cancelled. The text above is partial output.]`,
      })
    } else if (message.status === 'error') {
      messages.push({
        role: 'assistant',
        content: `${content}\n\n[Previous response failed${message.error ? `: ${message.error}` : ''}. The text above is partial output.]`,
      })
    } else {
      messages.push({ role: 'assistant', content })
    }
  }

  return messages
}

function clonePartial(partial: RunPartial): RunPartial {
  return {
    content: partial.content,
    reasoning: partial.reasoning,
    toolCalls: partial.toolCalls.map(tc => ({ ...tc, args: { ...tc.args } })),
  }
}

function applyStreamEvent(runtime: ChatRunRuntime, event: Record<string, unknown>): void {
  switch (event.type) {
    case 'text':
      if (typeof event.text === 'string') runtime.partial.content += event.text
      break
    case 'reasoning':
      if (typeof event.text === 'string') runtime.partial.reasoning += event.text
      break
    case 'tool-call': {
      const id = typeof event.id === 'string' ? event.id : makeMessageId(runtime.runId, 'assistant')
      runtime.partial.toolCalls.push({
        id,
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
        args: (event.args && typeof event.args === 'object') ? event.args as Record<string, unknown> : {},
      })
      break
    }
    case 'tool-result': {
      const id = typeof event.id === 'string' ? event.id : ''
      const existing = runtime.partial.toolCalls.find(tc => tc.id === id)
      if (existing) {
        existing.result = event.result
      } else {
        runtime.partial.toolCalls.push({
          id,
          toolName: typeof event.toolName === 'string' ? event.toolName : '',
          args: {},
          result: event.result,
        })
      }
      break
    }
    default:
      // finish/finish-step do not change the persisted partial.
      break
  }
}

function scheduleCheckpoint(runtime: ChatRunRuntime): void {
  if (runtime.done || runtime.checkpointTimer) return
  runtime.checkpointTimer = setTimeout(() => {
    runtime.checkpointTimer = null
    enqueueCheckpoint(runtime)
  }, LIBRARIAN_CHAT_CHECKPOINT_MS)
}

function enqueueCheckpoint(runtime: ChatRunRuntime): Promise<void> {
  runtime.writeChain = runtime.writeChain
    .then(() => writePartial(runtime))
    .catch((error) => {
      logger.error('Failed to checkpoint librarian chat partial', {
        storyId: runtime.storyId,
        runId: runtime.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  return runtime.writeChain
}

async function writePartial(runtime: ChatRunRuntime): Promise<void> {
  const partial = clonePartial(runtime.partial)

  await withBranch(runtime.dataDir, runtime.storyId, async () => {
    await withKeyLock(
      managerLockKey(runtime.dataDir, runtime.storyId, runtime.branchId, runtime.conversationId),
      async () => {
        const history = await readChatHistoryDocument(
          runtime.dataDir,
          runtime.storyId,
          runtime.conversationId,
        )
        if (!history.activeRun || history.activeRun.runId !== runtime.runId) return

        await mutateChatHistoryDocument(
          runtime.dataDir,
          runtime.storyId,
          runtime.conversationId,
          (doc) => {
            if (!doc.activeRun || doc.activeRun.runId !== runtime.runId) return
            const message = findAssistantMessage(doc, runtime.runId, doc.activeRun.assistantMessageId)
            if (!message) return
            message.content = partial.content
            if (partial.reasoning) message.reasoning = partial.reasoning
            if (partial.toolCalls.length > 0) message.toolCalls = partial.toolCalls
            const record = doc.runs?.[runtime.runId]
            if (record) record.updatedAt = new Date().toISOString()
          },
        )
      },
    )
  }, runtime.branchId)
}

async function finalizeRun(
  runtime: ChatRunRuntime,
  status: Extract<LibrarianChatStatus, 'done' | 'cancelled' | 'error'>,
  errorMessage?: string,
): Promise<void> {
  if (runtime.done) return
  runtime.done = true
  if (runtime.checkpointTimer) {
    clearTimeout(runtime.checkpointTimer)
    runtime.checkpointTimer = null
  }

  // Wait for any in-flight checkpoint so the terminal write is ordered last.
  await runtime.writeChain

  const partial = clonePartial(runtime.partial)
  const now = new Date().toISOString()

  try {
    await withBranch(runtime.dataDir, runtime.storyId, async () => {
      await withKeyLock(
        managerLockKey(runtime.dataDir, runtime.storyId, runtime.branchId, runtime.conversationId),
        async () => {
          const history = await readChatHistoryDocument(
            runtime.dataDir,
            runtime.storyId,
            runtime.conversationId,
          )
          if (!history.activeRun || history.activeRun.runId !== runtime.runId) return

          await mutateChatHistoryDocument(
            runtime.dataDir,
            runtime.storyId,
            runtime.conversationId,
            (doc) => {
              if (!doc.activeRun || doc.activeRun.runId !== runtime.runId) return

              const message = findAssistantMessage(doc, runtime.runId, doc.activeRun.assistantMessageId)
              if (message) {
                message.content = partial.content
                message.reasoning = partial.reasoning || undefined
                message.toolCalls = partial.toolCalls.length > 0 ? partial.toolCalls : undefined
                message.status = status
                message.error = errorMessage
              }

              const record = doc.runs?.[runtime.runId]
              if (record) {
                record.status = status
                record.updatedAt = now
                record.finishedAt = now
                if (status === 'cancelled') record.cancelledAt = now
                if (errorMessage) record.error = errorMessage
              }
              doc.activeRun = null
            },
          )
        },
      )
    }, runtime.branchId)
  } catch (error) {
    logger.error('Failed to persist terminal librarian chat state', {
      storyId: runtime.storyId,
      runId: runtime.runId,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    runtimes.delete(runtime.key)
  }
}

async function executeRun(runtime: ChatRunRuntime): Promise<void> {
  const runLogger = logger.child({
    storyId: runtime.storyId,
    extra: {
      runId: runtime.runId,
      branchId: runtime.branchId,
      conversationId: runtime.conversationId ?? undefined,
    },
  })
  runLogger.info('Starting background librarian chat run')

  try {
    await withBranch(runtime.dataDir, runtime.storyId, async () => {
      const history = await readChatHistoryDocument(
        runtime.dataDir,
        runtime.storyId,
        runtime.conversationId,
      )
      const messages = buildLibrarianChatInputMessages(history, runtime.runId)
      const story = await getStory(runtime.dataDir, runtime.storyId)
      const maxSteps = runtime.maxSteps ?? story?.settings.maxSteps ?? 10

      let agent: ReturnType<typeof createAgentInstance> | undefined
      let streamResult: AgentStreamResult
      try {
        agent = createAgentInstance('librarian.chat', {
          dataDir: runtime.dataDir,
          storyId: runtime.storyId,
        })
        streamResult = await agent.execute({
          messages,
          maxSteps,
          signal: runtime.abortController.signal,
        })
      } catch (error) {
        // The agent instance registered itself as active before `execute` ran.
        // If it throws before producing a stream, release that registration
        // and record the failed agent trace just like the legacy routes do.
        agent?.fail(error)
        throw error
      }

      const { eventStream, completion } = streamResult

      // Mark the completion as observed immediately so a stream failure cannot
      // surface as an unhandled rejection; the awaited completion below still
      // propagates the actual error to the run terminal state.
      completion.catch(() => {})

      const reader = eventStream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const consumeLine = (line: string) => {
        if (!line.trim()) return
        try {
          applyStreamEvent(runtime, JSON.parse(line) as Record<string, unknown>)
          scheduleCheckpoint(runtime)
        } catch (error) {
          runLogger.warn('Ignoring malformed librarian chat stream part', {
            error: error instanceof Error ? error.message : String(error),
            line: line.slice(0, 200),
          })
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += typeof value === 'string' ? value : decoder.decode(value as unknown as Uint8Array, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) consumeLine(line)
        }
        // Flush any decoder bytes and a final line that arrived without a
        // trailing newline. Losing this would silently drop the last partial.
        buffer += decoder.decode()
        consumeLine(buffer)
      } finally {
        reader.releaseLock()
      }

      // Never convert a rejected completion (provider error chunk, or a stream
      // that closed after rejecting) into a successful `done` run.
      await completion
    }, runtime.branchId)

    await finalizeRun(runtime, runtime.cancelRequested ? 'cancelled' : 'done')
    runLogger.info('Background librarian chat run finished', {
      status: runtime.cancelRequested ? 'cancelled' : 'done',
    })
  } catch (error) {
    const cancelled = runtime.cancelRequested || isAbortError(error, runtime.abortController.signal)
    const message = error instanceof Error ? error.message : String(error)
    if (cancelled) {
      runLogger.info('Background librarian chat run cancelled', { error: message })
      await finalizeRun(runtime, 'cancelled')
    } else {
      runLogger.error('Background librarian chat run failed', { error: message })
      await finalizeRun(runtime, 'error', message)
    }
  }
}

/**
 * If an active run exists on disk but this process has no live runtime for it,
 * the process restarted (or the manager was recreated). Mark it interrupted
 * without calling the LLM, preserving the latest committed partial.
 */
async function recoverOrphanedRun(
  dataDir: string,
  storyId: string,
  branchId: string,
  conversationId: string | null | undefined,
  history: ChatHistory,
): Promise<ChatHistory> {
  const active = history.activeRun
  if (!active) return history

  const key = scopeKey(dataDir, storyId, branchId, conversationId)
  const runtime = runtimes.get(key)
  // A live runtime owns the terminal transition even if it has already closed
  // its stream (`done` is set just before its final write). Treating that
  // window as an orphan would race the terminal write into `interrupted`.
  if (runtime && runtime.runId === active.runId) return history
  if (runtime && runtime.runId !== active.runId) {
    runtimes.delete(key)
  }

  const now = new Date().toISOString()
  const updated = await mutateChatHistoryDocument(dataDir, storyId, conversationId, (doc) => {
    if (!doc.activeRun || doc.activeRun.runId !== active.runId) return
    const message = findAssistantMessage(doc, active.runId, doc.activeRun.assistantMessageId)
    if (message) message.status = 'interrupted'
    const record = doc.runs?.[active.runId]
    if (record) {
      record.status = 'interrupted'
      record.updatedAt = now
      record.finishedAt = now
    }
    doc.activeRun = null
  })

  logger.warn('Marked orphaned librarian chat run as interrupted', {
    storyId,
    branchId,
    conversationId: conversationId ?? undefined,
    runId: active.runId,
  })

  return updated ?? history
}

/** Read a full committed snapshot. In-memory uncommitted partials are never returned. */
export async function getLibrarianChatSnapshot(
  dataDir: string,
  storyId: string,
  branchId: string,
  conversationId?: string | null,
): Promise<LibrarianChatSnapshot> {
  if (!isSafeChatId(branchId)) {
    throw new LibrarianChatRequestError('Invalid branchId', 422)
  }

  return withBranch(dataDir, storyId, async () => {
    return withKeyLock(managerLockKey(dataDir, storyId, branchId, conversationId), async () => {
      const history = await readChatHistoryDocument(dataDir, storyId, conversationId)
      const recovered = await recoverOrphanedRun(dataDir, storyId, branchId, conversationId, history)
      return toLibrarianChatSnapshot(recovered, branchId)
    })
  }, branchId)
}

export interface StartLibrarianChatRunResult {
  snapshot: LibrarianChatSnapshot
  started: boolean
}

/**
 * Accept a run. Duplicate `runId` + `prompt` (and branch) is checked first and
 * returns the current snapshot without rerunning, even after later turns or a
 * process restart. Otherwise stale revisions and an existing active run are
 * rejected with 409 before any model work starts.
 */
export async function startLibrarianChatRun(
  dataDir: string,
  storyId: string,
  conversationId: string | null | undefined,
  input: LibrarianChatStartInput,
): Promise<StartLibrarianChatRunResult> {
  validateStartInput(input)

  let runtimeToStart: ChatRunRuntime | null = null

  const snapshot = await withBranch(dataDir, storyId, async () => {
    return withKeyLock(managerLockKey(dataDir, storyId, input.branchId, conversationId), async () => {
      const initial = await readChatHistoryDocument(dataDir, storyId, conversationId)
      const history = await recoverOrphanedRun(dataDir, storyId, input.branchId, conversationId, initial)

      const existing = history.runs?.[input.runId]
      if (existing) {
        // Dedupe only an exact replay of the original request. A reused runId
        // with a changed prompt, branch, maxSteps, or expectedRevision is a
        // conflicting request, not a retry.
        const sameRequest = existing.prompt === input.prompt
          && existing.branchId === input.branchId
          && existing.expectedRevision === input.expectedRevision
          && (existing.maxSteps ?? null) === (input.maxSteps ?? null)
        if (!sameRequest) {
          throw new LibrarianChatRequestError('runId was already used for a different request', 409)
        }
        return toLibrarianChatSnapshot(history, input.branchId)
      }

      if (history.activeRun) {
        throw new LibrarianChatRequestError('Another chat run is already active', 409)
      }

      const currentRevision = history.revision ?? 0
      if (input.expectedRevision !== currentRevision) {
        throw new LibrarianChatRequestError(
          `Stale revision: expected ${input.expectedRevision}, current ${currentRevision}`,
          409,
        )
      }

      const messageId = makeMessageId(input.runId, 'user')
      const assistantMessageId = makeMessageId(input.runId, 'assistant')

      const runtime: ChatRunRuntime = {
        key: scopeKey(dataDir, storyId, input.branchId, conversationId),
        dataDir,
        storyId,
        branchId: input.branchId,
        conversationId: conversationId ?? null,
        runId: input.runId,
        prompt: input.prompt,
        maxSteps: input.maxSteps,
        abortController: new AbortController(),
        cancelRequested: false,
        done: false,
        partial: { content: '', reasoning: '', toolCalls: [] },
        checkpointTimer: null,
        writeChain: Promise.resolve(),
      }

      // Register before the atomic write so a concurrent GET cannot mistake
      // this newly accepted run for a restart orphan.
      runtimes.set(runtime.key, runtime)

      let updated: ChatHistory | null
      try {
        updated = await mutateChatHistoryDocument(dataDir, storyId, conversationId, (doc) => {
          const timestamp = new Date().toISOString()
          doc.branchId = input.branchId
          doc.messages.push(
            { id: messageId, role: 'user', content: input.prompt, runId: input.runId },
            {
              id: assistantMessageId,
              role: 'assistant',
              content: '',
              runId: input.runId,
              status: 'running',
            },
          )

          doc.runs = doc.runs ?? {}
          const runRecord: ChatRunRecord = {
            runId: input.runId,
            prompt: input.prompt,
            branchId: input.branchId,
            expectedRevision: input.expectedRevision,
            ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
            status: 'running',
            startedAt: timestamp,
            updatedAt: timestamp,
            messageId,
            assistantMessageId,
          }
          doc.runs[input.runId] = runRecord
          doc.activeRun = {
            runId: input.runId,
            status: 'running',
            prompt: input.prompt,
            branchId: input.branchId,
            expectedRevision: input.expectedRevision,
            ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
            startedAt: timestamp,
            messageId,
            assistantMessageId,
          }
        })
      } catch (error) {
        runtimes.delete(runtime.key)
        throw error
      }

      if (!updated) {
        runtimes.delete(runtime.key)
        throw new LibrarianChatRequestError('Conversation not found', 404)
      }

      runtimeToStart = runtime
      return toLibrarianChatSnapshot(updated, input.branchId)
    })
  }, input.branchId)

  const runtimeToLaunch = runtimeToStart as ChatRunRuntime | null
  if (runtimeToLaunch) {
    // Detached from the request: do not await model completion before acking.
    void executeRun(runtimeToLaunch).catch((error) => {
      logger.error('Unhandled librarian chat run rejection', {
        storyId: runtimeToLaunch.storyId,
        extra: { runId: runtimeToLaunch.runId },
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  return { snapshot, started: runtimeToStart !== null }
}

/**
 * Explicitly cancel a run. Returns the same snapshot shape as start/get.
 * Cancelling is idempotent once the run is terminal; a different active run
 * in the same scope still returns 409.
 */
export async function cancelLibrarianChatRun(
  dataDir: string,
  storyId: string,
  branchId: string,
  conversationId: string | null | undefined,
  runId: string,
): Promise<LibrarianChatSnapshot> {
  validateRunId(runId)
  if (!isSafeChatId(branchId)) {
    throw new LibrarianChatRequestError('Invalid branchId', 422)
  }

  return withBranch(dataDir, storyId, async () => {
    return withKeyLock(managerLockKey(dataDir, storyId, branchId, conversationId), async () => {
      const initial = await readChatHistoryDocument(dataDir, storyId, conversationId)
      let history = await recoverOrphanedRun(dataDir, storyId, branchId, conversationId, initial)

      const record = history.runs?.[runId]
      if (!record) {
        throw new LibrarianChatRequestError('Chat run not found', 404)
      }

      const active = history.activeRun
      if (active && active.runId !== runId) {
        throw new LibrarianChatRequestError('Another chat run is already active', 409)
      }

      if (!active || active.runId !== runId) {
        // Already terminal (or recovered as interrupted) — idempotent response.
        return toLibrarianChatSnapshot(history, branchId)
      }

      const runtime = runtimes.get(scopeKey(dataDir, storyId, branchId, conversationId))
      if (!runtime || runtime.runId !== runId) {
        history = await recoverOrphanedRun(dataDir, storyId, branchId, conversationId, history)
        return toLibrarianChatSnapshot(history, branchId)
      }

      if (runtime.done) {
        // The provider has already finished and the terminal write is queued.
        // Return the current committed snapshot; the next poll observes the
        // terminal status.
        return toLibrarianChatSnapshot(history, branchId)
      }

      runtime.cancelRequested = true

      if (active.status !== 'cancelling') {
        const updated = await mutateChatHistoryDocument(dataDir, storyId, conversationId, (doc) => {
          if (doc.activeRun?.runId === runId) {
            doc.activeRun.status = 'cancelling'
          }
          const runRecord = doc.runs?.[runId]
          if (runRecord) runRecord.updatedAt = new Date().toISOString()
        })
        if (updated) history = updated
      }

      // The provider receives a real AbortSignal. Any committed checkpoint is
      // preserved; terminal handling writes the partial as `cancelled`.
      runtime.abortController.abort()
      return toLibrarianChatSnapshot(history, branchId)
    })
  }, branchId)
}

/**
 * Best-effort drain of in-memory partials to disk on a graceful shutdown.
 * Does not abort providers and does not attempt to resume a run after restart;
 * on the next process the persisted active run is marked `interrupted` and its
 * last committed partial is preserved.
 */
export async function flushLibrarianChatRuns(): Promise<void> {
  const active = [...runtimes.values()]
  await Promise.all(active.map(async (runtime) => {
    if (runtime.checkpointTimer) {
      clearTimeout(runtime.checkpointTimer)
      runtime.checkpointTimer = null
    }
    try {
      await runtime.writeChain
      await writePartial(runtime)
    } catch (error) {
      logger.error('Failed to flush librarian chat run during shutdown', {
        storyId: runtime.storyId,
        extra: { runId: runtime.runId, conversationId: runtime.conversationId ?? undefined },
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }))
}

// Best-effort drain when the event loop empties. SIGINT/SIGTERM are left to
// the application's termination handling; call flushLibrarianChatRuns()
// explicitly from a signal handler if a hard stop is imminent.
const FLUSH_HOOK_KEY = Symbol.for('errata.librarianChat.flushHookRegistered')
if (
  typeof process !== 'undefined'
  && typeof process.once === 'function'
  && !(globalThis as Record<symbol, unknown>)[FLUSH_HOOK_KEY]
) {
  ;(globalThis as Record<symbol, unknown>)[FLUSH_HOOK_KEY] = true
  process.once('beforeExit', () => {
    void flushLibrarianChatRuns()
  })
}

/**
 * Test-only manager reset. Simulates a process restart: in-memory runtimes are
 * dropped while the persisted document remains, so the next access lazily
 * marks the orphan interrupted without calling the LLM.
 */
export function __resetLibrarianChatRuntimesForTests(): void {
  runtimes.clear()
}
