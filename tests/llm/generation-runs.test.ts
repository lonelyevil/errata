import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDir, seedTestProvider, makeTestSettings } from '../setup'
import { createStory, listFragments } from '@/server/fragments/storage'
import { clearPending } from '@/server/librarian/scheduler'
import type { StoryMeta } from '@/server/fragments/schema'

const { mockAgentStream } = vi.hoisted(() => ({
  mockAgentStream: vi.fn(),
}))

// Mock the AI SDK ToolLoopAgent
vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    ToolLoopAgent: class {
      stream(args: unknown) {
        return mockAgentStream(args)
      }
    },
  }
})

import { createApp } from '@/server/api'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-runs',
    name: 'Runs Story',
    description: 'A test story',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function immediateStreamResult(text: string) {
  async function* fullStream() {
    yield { type: 'text-delta' as const, text }
    yield { type: 'finish' as const, finishReason: 'stop' }
  }
  return {
    fullStream: fullStream(),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
  }
}

function throwingStreamResult(partialText: string) {
  async function* fullStream() {
    if (partialText) yield { type: 'text-delta' as const, text: partialText }
    throw new Error('provider exploded')
  }
  return {
    fullStream: fullStream(),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, unknown>> = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) events.push(JSON.parse(line))
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer))
  return events
}

/** Read one NDJSON line from a live response, then cancel the subscription. */
async function readFirstAndDisconnect(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let first: Record<string, unknown> | null = null

  while (!first) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) {
        first = JSON.parse(line)
        break
      }
    }
  }

  await reader.cancel()
  if (!first) throw new Error('stream ended before first event')
  return first
}

describe('generation runs endpoint', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  let app: ReturnType<typeof createApp>
  const storyId = 'story-runs'

  function api(path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://localhost/api${path}`, init))
  }

  async function startRun(body: Record<string, unknown>) {
    const res = await api(`/stories/${storyId}/generation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    return await res.json() as { runId: string }
  }

  async function status(runId: string) {
    const res = await api(`/stories/${storyId}/generation-runs/${runId}`)
    expect(res.status).toBe(200)
    return await res.json() as { runId: string; status: string; lastSeq: number; error?: string }
  }

  async function waitForStatus(runId: string, target: string, timeoutMs = 4000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const snapshot = await status(runId)
      if (snapshot.status === target) return snapshot
      await sleep(10)
    }
    throw new Error(`timed out waiting for run ${runId} to reach ${target}`)
  }

  beforeEach(async () => {
    clearPending()
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await seedTestProvider(dataDir)
    app = createApp(dataDir)
    await createStory(dataDir, makeStory())
    vi.clearAllMocks()
  })

  afterEach(async () => {
    clearPending()
    await cleanup()
  })

  it('replays buffered events and honors the after cursor without gaps or duplicates', async () => {
    mockAgentStream.mockResolvedValue(immediateStreamResult('Hello world') as never)
    const { runId } = await startRun({ input: 'Write', saveResult: false, runId: 'replay-run' })
    expect(runId).toBe('replay-run')

    const done = await waitForStatus(runId, 'done')

    const allRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=0`)
    expect(allRes.status).toBe(200)
    expect(allRes.headers.get('content-type')).toContain('application/x-ndjson')
    const all = await readNdjson(allRes)

    expect(all.length).toBe(done.lastSeq)
    expect(all.map((entry) => entry.seq)).toEqual(all.map((_, index) => index + 1))
    expect(all.at(-1)?.event).toEqual({ type: 'run-done' })
    expect(all.some((entry) => (entry.event as { type: string }).type === 'text')).toBe(true)
    expect(all.some((entry) => (entry.event as { type: string }).type === 'finish')).toBe(true)

    const tailRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=1`)
    const tail = await readNdjson(tailRes)
    expect(tail).toEqual(all.filter((entry) => (entry.seq as number) > 1))
    expect(tail[0]?.seq).toBe(2)

    // Past the end: replay nothing and close immediately.
    const pastRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=${done.lastSeq}`)
    expect(await readNdjson(pastRes)).toEqual([])

    // Status endpoint agrees with the event buffer length.
    const snapshot = await status(runId)
    expect(snapshot).toEqual({ runId, status: 'done', lastSeq: done.lastSeq })
  })

  it('keeps generating after the subscriber disconnects, then reconnects with no gap and saves once', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let capturedSignal: AbortSignal | undefined

    mockAgentStream.mockImplementation((args: { abortSignal?: AbortSignal }) => {
      capturedSignal = args.abortSignal
      async function* fullStream() {
        yield { type: 'text-delta' as const, text: 'First' }
        await gate
        if (capturedSignal?.aborted) throw new Error('aborted')
        yield { type: 'text-delta' as const, text: 'Second' }
        yield { type: 'finish' as const, finishReason: 'stop' }
      }
      return {
        fullStream: fullStream(),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      } as never
    })

    const { runId } = await startRun({ input: 'Write', saveResult: true, runId: 'resume-run' })

    const liveRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=0`)
    const first = await readFirstAndDisconnect(liveRes)
    expect(first.seq).toBe(1)
    expect((first.event as { type: string }).type).toBe('text')

    // Subscriber is gone; the run must still finish.
    releaseGate()
    const done = await waitForStatus(runId, 'done')

    // Replay from the cursor without gaps or duplicates.
    const replayRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=1`)
    const replay = await readNdjson(replayRes)
    const replayedSeqs = replay.map((entry) => entry.seq as number)
    expect(replayedSeqs[0]).toBe(2)
    expect(replayedSeqs).toEqual(Array.from({ length: done.lastSeq - 1 }, (_, index) => index + 2))
    expect(replay.at(-1)?.event).toEqual({ type: 'run-done' })
    expect(replay.filter((entry) => (entry.event as { type: string }).type === 'text')).toHaveLength(1)
    expect((replay.find((entry) => (entry.event as { type: string }).type === 'text')?.event as { text: string }).text).toBe('Second')

    const fragments = await listFragments(dataDir, storyId, 'prose')
    expect(fragments).toHaveLength(1)
    expect(fragments[0].content).toBe('FirstSecond')
  })

  it('start is idempotent for the same story + runId and never re-invokes the LLM', async () => {
    mockAgentStream.mockResolvedValue(immediateStreamResult('Once') as never)

    const first = await startRun({ input: 'Write', saveResult: false, runId: 'idem-run' })
    expect(first).toEqual({ runId: 'idem-run' })
    await waitForStatus('idem-run', 'done')
    expect(mockAgentStream).toHaveBeenCalledTimes(1)

    const second = await startRun({ input: 'Different input', saveResult: true, runId: 'idem-run' })
    expect(second).toEqual({ runId: 'idem-run' })

    // Give a stray second execution a chance to show up.
    await sleep(100)
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
    expect(await listFragments(dataDir, storyId, 'prose')).toHaveLength(0)
  })

  it('explicit cancel aborts the run and still saves partial prose', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let capturedSignal: AbortSignal | undefined

    mockAgentStream.mockImplementation((args: { abortSignal?: AbortSignal }) => {
      capturedSignal = args.abortSignal
      async function* fullStream() {
        yield { type: 'text-delta' as const, text: 'Partial' }
        await gate
        if (capturedSignal?.aborted) throw new Error('aborted')
        yield { type: 'text-delta' as const, text: 'Never' }
        yield { type: 'finish' as const, finishReason: 'stop' }
      }
      return {
        fullStream: fullStream(),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      } as never
    })

    const { runId } = await startRun({ input: 'Write', saveResult: true, runId: 'cancel-run' })

    const liveRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=0`)
    await readFirstAndDisconnect(liveRes)

    const cancelRes = await api(`/stories/${storyId}/generation-runs/${runId}/cancel`, { method: 'POST' })
    expect(cancelRes.status).toBe(200)
    expect(await cancelRes.json()).toEqual({ ok: true })

    releaseGate()
    const done = await waitForStatus(runId, 'done')

    const eventsRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=0`)
    const events = await readNdjson(eventsRes)
    expect(events.length).toBe(done.lastSeq)
    expect(events.at(-1)?.event).toEqual({ type: 'run-done' })

    const fragments = await listFragments(dataDir, storyId, 'prose')
    expect(fragments).toHaveLength(1)
    expect(fragments[0].content).toBe('Partial')
  })

  it('ends a failed run with a single run-error event and saves nothing', async () => {
    mockAgentStream.mockResolvedValue(throwingStreamResult('partial') as never)

    const { runId } = await startRun({ input: 'Write', saveResult: true, runId: 'error-run' })
    const snapshot = await waitForStatus(runId, 'error')
    expect(snapshot.error).toContain('provider exploded')

    const eventsRes = await api(`/stories/${storyId}/generation-runs/${runId}/events?after=0`)
    const events = await readNdjson(eventsRes)
    expect(events.at(-1)?.event).toEqual({ type: 'run-error', error: 'provider exploded' })
    expect(events.filter((entry) => (entry.event as { type: string }).type === 'run-error')).toHaveLength(1)
    expect(events.some((entry) => (entry.event as { type: string }).type === 'run-done')).toBe(false)
    expect(await listFragments(dataDir, storyId, 'prose')).toHaveLength(0)
  })

  it('returns 404 for unknown runs on status, events and cancel', async () => {
    const statusRes = await api(`/stories/${storyId}/generation-runs/ghost`)
    expect(statusRes.status).toBe(404)

    const eventsRes = await api(`/stories/${storyId}/generation-runs/ghost/events?after=0`)
    expect(eventsRes.status).toBe(404)

    const cancelRes = await api(`/stories/${storyId}/generation-runs/ghost/cancel`, { method: 'POST' })
    expect(cancelRes.status).toBe(404)
  })

  it('validates start requests like the legacy endpoint', async () => {
    const missingStory = await api('/stories/nope/generation-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Write' }),
    })
    expect(missingStory.status).toBe(404)

    const emptyInput = await api(`/stories/${storyId}/generation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '  ' }),
    })
    expect(emptyInput.status).toBe(422)
  })
})
