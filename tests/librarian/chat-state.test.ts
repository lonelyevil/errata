import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { createBranch, switchActiveBranch } from '@/server/fragments/branches'
import { listActiveAgents } from '@/server/agents'
import {
  ChatHistoryConflictError,
  clearChatHistory,
  deleteConversation,
  getChatHistory,
  getConversationHistory,
  saveChatHistory,
  saveConversationHistory,
} from '@/server/librarian/storage'
import { __resetLibrarianChatRuntimesForTests } from '@/server/librarian/chat-state'
import { createApp } from '@/server/api'
import type { StoryMeta } from '@/server/fragments/schema'

const mockAgentStream = vi.fn()

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class MockToolLoopAgent {
      constructor() {
        return { stream: mockAgentStream } as unknown as MockToolLoopAgent
      }
    },
  }
})

interface TestGate {
  stream: ReadableStream<unknown>
  abortSignal?: AbortSignal
  push: (part: Record<string, unknown>) => void
  close: () => void
  error: (error: unknown) => void
}

function createGate(): TestGate {
  let controller: ReadableStreamDefaultController<unknown>
  let closed = false
  const stream = new ReadableStream<unknown>({
    start(c) {
      controller = c
    },
  })

  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    try {
      controller.error(error)
    } catch {
      // The stream may already have been torn down by the adapter.
    }
  }

  return {
    stream,
    push(part) {
      if (closed) return
      try {
        controller.enqueue(part)
      } catch {
        closed = true
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        controller.close()
      } catch {
        // The stream may already have been torn down by the adapter.
      }
    },
    error: fail,
    abortSignal: undefined,
  }
}

function installGate(gate: TestGate): void {
  mockAgentStream.mockImplementationOnce(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
    gate.abortSignal = abortSignal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        gate.error(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }
    return { fullStream: gate.stream }
  })
}

function installGateMap(gates: Map<string, TestGate>): void {
  mockAgentStream.mockImplementation(async ({ messages, abortSignal }: {
    messages?: Array<{ role: string; content: string }>
    abortSignal?: AbortSignal
  }) => {
    const lastUser = [...(messages ?? [])].reverse().find(message => message.role === 'user')
    const gate = gates.get(lastUser?.content ?? '')
    if (!gate) throw new Error(`No gate configured for prompt: ${lastUser?.content ?? '<none>'}`)
    gate.abortSignal = abortSignal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        gate.error(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    }
    return { fullStream: gate.stream }
  })
}

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-chat-state',
    name: 'Chat State Test',
    description: 'Server-owned chat run tests',
    coverImage: null,
    summary: 'A test story.',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('server-owned librarian chat state', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  let storyId: string
  let base: string

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    const story = makeStory()
    storyId = story.id
    await createStory(dataDir, story)
    app = createApp(dataDir)
    base = `http://localhost/api/stories/${storyId}/librarian`
    mockAgentStream.mockReset()
    __resetLibrarianChatRuntimesForTests()
  })

  afterEach(async () => {
    __resetLibrarianChatRuntimesForTests()
    await cleanup()
  })

  async function getSnapshot(conversationId?: string | null, branchId = 'main') {
    const path = conversationId
      ? `${base}/conversations/${conversationId}/chat-state?branchId=${branchId}`
      : `${base}/chat-state?branchId=${branchId}`
    const res = await app.fetch(new Request(path))
    return { res, snapshot: await readJson<any>(res) }
  }

  async function startRun(
    input: { runId: string; prompt: string; expectedRevision: number; branchId?: string; maxSteps?: number },
    conversationId?: string | null,
  ) {
    const path = conversationId
      ? `${base}/conversations/${conversationId}/chat-runs`
      : `${base}/chat-runs`
    const res = await app.fetch(new Request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId: 'main', ...input }),
    }))
    return { res, snapshot: await readJson<any>(res) }
  }

  async function cancelRun(runId: string, conversationId?: string | null, branchId = 'main') {
    const path = conversationId
      ? `${base}/conversations/${conversationId}/chat-runs/${runId}/cancel?branchId=${branchId}`
      : `${base}/chat-runs/${runId}/cancel?branchId=${branchId}`
    const res = await app.fetch(new Request(path, { method: 'POST' }))
    return { res, snapshot: await readJson<any>(res) }
  }

  async function createConversation(title: string, branchId = 'main') {
    const res = await app.fetch(new Request(`${base}/conversations?branchId=${branchId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }))
    return await readJson<{ id: string; title: string }>(res)
  }

  it('accepts and persists the prompt + placeholder before the model completes', async () => {
    const gate = createGate()
    installGate(gate)

    const started = await startRun({ runId: 'run-accept', prompt: 'Hello librarian', expectedRevision: 0 })

    expect(started.res.status).toBe(200)
    expect(started.snapshot.activeRun).toEqual({ runId: 'run-accept', status: 'running' })
    expect(started.snapshot.messages).toHaveLength(2)
    expect(started.snapshot.messages[0]).toMatchObject({ role: 'user', content: 'Hello librarian' })
    expect(started.snapshot.messages[1]).toMatchObject({ role: 'assistant', content: '', status: 'running' })

    // The model stream is still gated open, yet the accepted prompt is already
    // committed to the canonical history document on disk.
    const disk = await getChatHistory(dataDir, storyId)
    expect(disk.messages).toHaveLength(2)
    expect(disk.messages[0].content).toBe('Hello librarian')
    expect(disk.messages[1].status).toBe('running')
    expect(disk.runs?.['run-accept']).toMatchObject({
      prompt: 'Hello librarian',
      branchId: 'main',
      status: 'running',
      messageId: disk.messages[0].id,
      assistantMessageId: disk.messages[1].id,
    })

    gate.close()
    await waitFor(async () => (await getChatHistory(dataDir, storyId)).activeRun === null, 'run completion')
  })

  it('completes with no GET polling at all', async () => {
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-no-poller', prompt: 'Answer without a poller', expectedRevision: 0 })

    await waitFor(async () => gate.abortSignal !== undefined, 'provider stream start')
    gate.push({ type: 'text-delta', text: 'Completed in the background.' })
    gate.close()

    const disk = await waitFor(async () => {
      const history = await getChatHistory(dataDir, storyId)
      return history.messages[1]?.status === 'done' ? history : null
    }, 'background completion without polling')

    expect(disk.messages[1].content).toBe('Completed in the background.')
    expect(disk.activeRun).toBeNull()
  })

  it('returns committed rich partials (text, reasoning, tool calls) and the final transcript', async () => {
    const gate = createGate()
    installGate(gate)
    const started = await startRun({ runId: 'run-rich', prompt: 'Use a tool', expectedRevision: 0 })
    expect(started.res.status).toBe(200)
    await waitFor(async () => gate.abortSignal !== undefined, 'provider stream start')

    gate.push({ type: 'text-delta', text: 'Checking' })
    gate.push({ type: 'reasoning-delta', text: 'I should inspect the prose first.' })
    gate.push({
      type: 'tool-call',
      toolCallId: 'tc-1',
      toolName: 'getFragment',
      input: { fragmentId: 'pr-0001' },
    })
    gate.push({
      type: 'tool-result',
      toolCallId: 'tc-1',
      toolName: 'getFragment',
      output: { id: 'pr-0001', content: 'Once upon a time.' },
    })

    const partial = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.toolCalls?.length ? snapshot : null
    }, 'rich partial checkpoint')

    expect(partial.messages[1].content).toBe('Checking')
    expect(partial.messages[1].reasoning).toBe('I should inspect the prose first.')
    expect(partial.messages[1].toolCalls).toEqual([{
      id: 'tc-1',
      toolName: 'getFragment',
      args: { fragmentId: 'pr-0001' },
      result: { id: 'pr-0001', content: 'Once upon a time.' },
    }])
    expect(partial.activeRun).toEqual({ runId: 'run-rich', status: 'running' })

    // GET returns exactly the committed disk state, not the live in-memory buffer.
    const disk = await getChatHistory(dataDir, storyId)
    expect(disk.messages[1].content).toBe(partial.messages[1].content)
    expect(disk.messages[1].toolCalls).toEqual(partial.messages[1].toolCalls)

    gate.push({ type: 'text-delta', text: ' the prose.' })
    gate.close()

    const final = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.activeRun === null ? snapshot : null
    }, 'rich final state')
    expect(final.messages[1].content).toBe('Checking the prose.')
    expect(final.messages[1].status).toBe('done')
    expect(final.messages[1].toolCalls).toHaveLength(1)
  })

  it('dedupes the same runId + prompt before and after manager reload, and rejects changed payloads', async () => {
    const gate1 = createGate()
    installGate(gate1)
    const first = await startRun({ runId: 'run-dedupe', prompt: 'Remember me', expectedRevision: 0 })
    expect(first.res.status).toBe(200)
    await waitFor(async () => gate1.abortSignal !== undefined, 'first provider start')

    const retryWhileActive = await startRun({ runId: 'run-dedupe', prompt: 'Remember me', expectedRevision: 0 })
    expect(retryWhileActive.res.status).toBe(200)
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
    expect(retryWhileActive.snapshot.messages).toHaveLength(2)

    const changedWhileActive = await startRun({ runId: 'run-dedupe', prompt: 'Different prompt', expectedRevision: 0 })
    expect(changedWhileActive.res.status).toBe(409)

    const changedMaxSteps = await startRun({
      runId: 'run-dedupe',
      prompt: 'Remember me',
      expectedRevision: 0,
      maxSteps: 3,
    })
    expect(changedMaxSteps.res.status).toBe(409)

    const changedRevision = await startRun({
      runId: 'run-dedupe',
      prompt: 'Remember me',
      expectedRevision: 1,
    })
    expect(changedRevision.res.status).toBe(409)

    gate1.push({ type: 'text-delta', text: 'First answer' })
    gate1.close()
    await waitFor(async () => (await getChatHistory(dataDir, storyId)).messages[1]?.status === 'done', 'first done')

    const gate2 = createGate()
    installGate(gate2)
    const snapshotAfterFirst = (await getSnapshot()).snapshot
    const second = await startRun({
      runId: 'run-second',
      prompt: 'Second turn',
      expectedRevision: snapshotAfterFirst.revision,
    })
    expect(second.res.status).toBe(200)
    await waitFor(async () => gate2.abortSignal !== undefined, 'second provider start')
    gate2.push({ type: 'text-delta', text: 'Second answer' })
    gate2.close()
    await waitFor(async () => (await getChatHistory(dataDir, storyId)).messages[3]?.status === 'done', 'second done')

    // Simulate a process restart/manager recreation. The run ledger lives on
    // disk, so the old runId still dedupes without invoking the model.
    __resetLibrarianChatRuntimesForTests()
    const callsBeforeReloadRetry = mockAgentStream.mock.calls.length
    const retryAfterReload = await startRun({
      runId: 'run-dedupe',
      prompt: 'Remember me',
      expectedRevision: 0,
    })
    expect(retryAfterReload.res.status).toBe(200)
    expect(mockAgentStream.mock.calls.length).toBe(callsBeforeReloadRetry)
    expect(retryAfterReload.snapshot.messages).toHaveLength(4)

    const changedAfterReload = await startRun({
      runId: 'run-dedupe',
      prompt: 'Changed after restart',
      expectedRevision: 0,
    })
    expect(changedAfterReload.res.status).toBe(409)
  })

  it('returns 409 for stale revisions and a different active run, 404 for unknown scopes, 422 for unsafe runIds', async () => {
    const gate = createGate()
    installGate(gate)
    const first = await startRun({ runId: 'run-active', prompt: 'First', expectedRevision: 0 })
    expect(first.res.status).toBe(200)
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    const differentActive = await startRun({ runId: 'run-other', prompt: 'Other', expectedRevision: first.snapshot.revision })
    expect(differentActive.res.status).toBe(409)

    gate.close()
    await waitFor(async () => (await getChatHistory(dataDir, storyId)).activeRun === null, 'first done')

    const stale = await startRun({ runId: 'run-stale', prompt: 'Stale', expectedRevision: 0 })
    expect(stale.res.status).toBe(409)

    const unsafeRunId = await startRun({ runId: '../escape', prompt: 'Nope', expectedRevision: (await getSnapshot()).snapshot.revision })
    expect(unsafeRunId.res.status).toBe(422)

    const missingBranch = await app.fetch(new Request(`${base}/chat-state?branchId=../../etc`))
    expect(missingBranch.status).toBe(404)

    const missingConversation = await app.fetch(new Request(`${base}/conversations/cv-missing/chat-state?branchId=main`))
    expect(missingConversation.status).toBe(404)

    const missingStartConversation = await app.fetch(new Request(`${base}/conversations/cv-missing/chat-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-missing-conv',
        prompt: 'Hello?',
        branchId: 'main',
        expectedRevision: 0,
      }),
    }))
    expect(missingStartConversation.status).toBe(404)
  })

  it('does not abort on polling disconnect, but explicit cancel aborts the provider and retains the partial', async () => {
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-cancel', prompt: 'Cancel me', expectedRevision: 0 })
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    const pollAbort = new AbortController()
    const poll = await app.fetch(new Request(`${base}/chat-state?branchId=main`, { signal: pollAbort.signal }))
    expect(poll.status).toBe(200)
    pollAbort.abort()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(gate.abortSignal?.aborted).toBe(false)

    gate.push({ type: 'text-delta', text: 'Partial answer' })
    await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.content === 'Partial answer' ? snapshot : null
    }, 'partial checkpoint before cancel')

    const cancelled = await cancelRun('run-cancel')
    expect(cancelled.res.status).toBe(200)
    expect(cancelled.snapshot).toHaveProperty('messages')
    expect(cancelled.snapshot).toHaveProperty('activeRun')

    const final = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.status === 'cancelled' ? snapshot : null
    }, 'cancelled final state')

    expect(gate.abortSignal?.aborted).toBe(true)
    expect(final.activeRun).toBeNull()
    expect(final.messages[1].content).toBe('Partial answer')
    expect(final.messages[1].status).toBe('cancelled')
    expect(mockAgentStream).toHaveBeenCalledTimes(1)

    // Idempotent cancel after terminal state.
    const cancelAgain = await cancelRun('run-cancel')
    expect(cancelAgain.res.status).toBe(200)
    expect(cancelAgain.snapshot.messages[1].status).toBe('cancelled')
  })

  it('retains the committed partial and records an error when the provider fails', async () => {
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-error', prompt: 'Fail halfway', expectedRevision: 0 })
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    gate.push({ type: 'text-delta', text: 'Half an answer' })
    await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.content === 'Half an answer' ? snapshot : null
    }, 'error partial checkpoint')

    gate.error(new Error('provider exploded'))

    const final = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.status === 'error' ? snapshot : null
    }, 'error final state')

    expect(final.activeRun).toBeNull()
    expect(final.messages[1].content).toBe('Half an answer')
    expect(final.messages[1].status).toBe('error')
    expect(final.messages[1].error).toContain('provider exploded')

    const disk = await getChatHistory(dataDir, storyId)
    expect(disk.messages[1].content).toBe('Half an answer')
    expect(disk.messages[1].error).toContain('provider exploded')
    expect(disk.runs?.['run-error'].status).toBe('error')
  })

  it('treats an AI SDK provider error stream part as a failed run, not an empty success', async () => {
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-error-part', prompt: 'Fail via error part', expectedRevision: 0 })
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    gate.push({ type: 'text-delta', text: 'Partial before chunk error' })
    await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.content === 'Partial before chunk error' ? snapshot : null
    }, 'chunk-error partial checkpoint')

    gate.push({ type: 'error', error: new Error('provider chunk error') })

    const final = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.status === 'error' ? snapshot : null
    }, 'chunk-error final state')

    expect(final.activeRun).toBeNull()
    expect(final.messages[1].content).toBe('Partial before chunk error')
    expect(final.messages[1].status).toBe('error')
    expect(final.messages[1].error).toContain('provider chunk error')
    gate.close()
  })

  it('releases the active agent registration when stream setup throws before streaming', async () => {
    mockAgentStream.mockRejectedValueOnce(new Error('stream setup failed'))

    await startRun({ runId: 'run-pre-stream-fail', prompt: 'Fail before stream', expectedRevision: 0 })

    const final = await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.status === 'error' ? snapshot : null
    }, 'pre-stream failure terminal state')

    expect(final.messages[1].error).toContain('stream setup failed')
    expect(listActiveAgents(storyId)).toEqual([])
  })

  it('keeps a run pinned to its branch when the active branch switches mid-run', async () => {
    const alt = await createBranch(dataDir, storyId, 'Alternate', 'main')

    const gate = createGate()
    installGate(gate)
    const started = await startRun({ runId: 'run-pinned', prompt: 'Pinned prompt', expectedRevision: 0 })
    expect(started.res.status).toBe(200)
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    await switchActiveBranch(dataDir, storyId, alt.id)
    gate.push({ type: 'text-delta', text: 'Answer pinned to main' })
    gate.close()

    const mainFinal = await waitFor(async () => {
      const { snapshot } = await getSnapshot(null, 'main')
      return snapshot.messages[1]?.status === 'done' ? snapshot : null
    }, 'pinned main completion')
    expect(mainFinal.branchId).toBe('main')
    expect(mainFinal.messages[1].content).toBe('Answer pinned to main')

    const altSnapshot = (await getSnapshot(null, alt.id)).snapshot
    expect(altSnapshot.branchId).toBe(alt.id)
    expect(altSnapshot.messages).toHaveLength(0)
    expect((await getChatHistory(dataDir, storyId)).messages).toHaveLength(0)
  })

  it('marks an orphaned running snapshot interrupted on manager reload without invoking the LLM', async () => {
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-orphan', prompt: 'Survive a restart', expectedRevision: 0 })
    await waitFor(async () => gate.abortSignal !== undefined, 'provider start')

    gate.push({ type: 'text-delta', text: 'Saved before restart' })
    await waitFor(async () => {
      const { snapshot } = await getSnapshot()
      return snapshot.messages[1]?.content === 'Saved before restart' ? snapshot : null
    }, 'orphan checkpoint')

    __resetLibrarianChatRuntimesForTests()
    const callsBeforeRecovery = mockAgentStream.mock.calls.length

    const recovered = (await getSnapshot()).snapshot
    expect(recovered.activeRun).toBeNull()
    expect(recovered.messages[1].status).toBe('interrupted')
    expect(recovered.messages[1].content).toBe('Saved before restart')
    expect(mockAgentStream.mock.calls.length).toBe(callsBeforeRecovery)

    // Release the detached test stream so the process does not keep it open.
    gate.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await getChatHistory(dataDir, storyId)).messages[1].status).toBe('interrupted')
  })

  it('atomically refuses destructive/legacy overwrites and fences late legacy completions', async () => {
    const conversation = await createConversation('Guarded conversation')
    const gate = createGate()
    installGate(gate)
    await startRun({ runId: 'run-guarded', prompt: 'Guarded prompt', expectedRevision: 0 }, conversation.id)
    await waitFor(async () => gate.abortSignal !== undefined, 'guarded provider start')

    // The direct storage calls bypass the route snapshot check: the guard must
    // still win under the history lock.
    expect(await saveConversationHistory(dataDir, storyId, conversation.id, [
      { role: 'user', content: 'legacy overwrite while active' },
    ])).toBe(false)
    await expect(deleteConversation(dataDir, storyId, conversation.id))
      .rejects.toBeInstanceOf(ChatHistoryConflictError)

    const during = await getConversationHistory(dataDir, storyId, conversation.id)
    expect(during.messages).toHaveLength(2)
    expect(during.messages[0].content).toBe('Guarded prompt')
    expect(during.activeRun?.runId).toBe('run-guarded')

    gate.push({ type: 'text-delta', text: 'Guarded answer' })
    gate.close()
    await waitFor(async () => {
      const history = await getConversationHistory(dataDir, storyId, conversation.id)
      return history.messages[1]?.status === 'done' ? history : null
    }, 'guarded conversation completion')

    // The original revision (0) is now stale: a late legacy completion must
    // not delete the newer server-owned turn.
    expect(await saveConversationHistory(dataDir, storyId, conversation.id, [
      { role: 'user', content: 'late legacy overwrite' },
    ], { expectedRevision: 0 })).toBe(false)
    const fenced = await getConversationHistory(dataDir, storyId, conversation.id)
    expect(fenced.messages).toHaveLength(2)
    expect(fenced.messages[1].content).toBe('Guarded answer')

    const defaultGate = createGate()
    installGate(defaultGate)
    await startRun({ runId: 'run-guarded-default', prompt: 'Default guarded prompt', expectedRevision: 0 })
    await waitFor(async () => defaultGate.abortSignal !== undefined, 'guarded default provider start')

    await expect(clearChatHistory(dataDir, storyId)).rejects.toBeInstanceOf(ChatHistoryConflictError)
    defaultGate.push({ type: 'text-delta', text: 'Default guarded answer' })
    defaultGate.close()
    await waitFor(async () => {
      const history = await getChatHistory(dataDir, storyId)
      return history.messages[1]?.status === 'done' ? history : null
    }, 'guarded default completion')

    expect(await saveChatHistory(dataDir, storyId, [
      { role: 'user', content: 'late default overwrite' },
    ], { expectedRevision: 0 })).toBe(false)
    const defaultFinal = await getChatHistory(dataDir, storyId)
    expect(defaultFinal.messages).toHaveLength(2)
    expect(defaultFinal.messages[1].content).toBe('Default guarded answer')
  })

  it('rejects clear/delete while running and keeps parallel conversations independent', async () => {
    const defaultGate = createGate()
    installGate(defaultGate)
    await startRun({ runId: 'run-default-active', prompt: 'Default active', expectedRevision: 0 })
    await waitFor(async () => defaultGate.abortSignal !== undefined, 'default provider start')

    const clearWhileActive = await app.fetch(new Request(`${base}/chat`, { method: 'DELETE' }))
    expect(clearWhileActive.status).toBe(409)

    defaultGate.push({ type: 'text-delta', text: 'Default done' })
    defaultGate.close()
    await waitFor(async () => (await getChatHistory(dataDir, storyId)).activeRun === null, 'default completion')

    const conversationA = await createConversation('Conversation A')
    const conversationB = await createConversation('Conversation B')

    const gates = new Map<string, TestGate>([
      ['Prompt A', createGate()],
      ['Prompt B', createGate()],
    ])
    installGateMap(gates)

    const startA = await startRun({ runId: 'run-a', prompt: 'Prompt A', expectedRevision: 0 }, conversationA.id)
    const startB = await startRun({ runId: 'run-b', prompt: 'Prompt B', expectedRevision: 0 }, conversationB.id)
    expect(startA.res.status).toBe(200)
    expect(startB.res.status).toBe(200)

    const deleteWhileActive = await app.fetch(new Request(`${base}/conversations/${conversationA.id}?branchId=main`, { method: 'DELETE' }))
    expect(deleteWhileActive.status).toBe(409)

    await waitFor(async () => gates.get('Prompt A')?.abortSignal !== undefined, 'conversation A start')
    await waitFor(async () => gates.get('Prompt B')?.abortSignal !== undefined, 'conversation B start')

    gates.get('Prompt A')!.push({ type: 'text-delta', text: 'Answer A' })
    gates.get('Prompt B')!.push({ type: 'text-delta', text: 'Answer B' })
    gates.get('Prompt A')!.close()
    gates.get('Prompt B')!.close()

    const finalA = await waitFor(async () => {
      const { snapshot } = await getSnapshot(conversationA.id)
      return snapshot.messages[1]?.status === 'done' ? snapshot : null
    }, 'conversation A completion')
    const finalB = await waitFor(async () => {
      const { snapshot } = await getSnapshot(conversationB.id)
      return snapshot.messages[1]?.status === 'done' ? snapshot : null
    }, 'conversation B completion')

    expect(finalA.messages[0].content).toBe('Prompt A')
    expect(finalA.messages[1].content).toBe('Answer A')
    expect(finalB.messages[0].content).toBe('Prompt B')
    expect(finalB.messages[1].content).toBe('Answer B')

    const listRes = await app.fetch(new Request(`${base}/conversations?branchId=main`))
    const conversations = await readJson<Array<{ id: string; title: string }>>(listRes)
    expect(conversations.map(c => c.id).sort()).toEqual([conversationA.id, conversationB.id].sort())

    const historyA = await getConversationHistory(dataDir, storyId, conversationA.id)
    const historyB = await getConversationHistory(dataDir, storyId, conversationB.id)
    expect(historyA.messages[1].content).toBe('Answer A')
    expect(historyB.messages[1].content).toBe('Answer B')

    const deleted = await app.fetch(new Request(`${base}/conversations/${conversationA.id}?branchId=main`, { method: 'DELETE' }))
    expect(deleted.status).toBe(200)

    // A late legacy save must not resurrect the deleted conversation file.
    const resurrected = await saveConversationHistory(dataDir, storyId, conversationA.id, [
      { role: 'user', content: 'Late write' },
    ])
    expect(resurrected).toBe(false)
    await expect(getConversationHistory(dataDir, storyId, conversationA.id)).resolves.toMatchObject({
      messages: [],
    })
  })
})
