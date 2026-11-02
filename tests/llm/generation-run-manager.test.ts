import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import { GenerationRunManager } from '@/server/generation/run-manager'
import { resolveGenerationRequest } from '@/server/generation/executor'
import type { StoryMeta } from '@/server/fragments/schema'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-ttl',
    name: 'TTL Story',
    description: '',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('GenerationRunManager', () => {
  let dataDir: string
  let cleanup: () => Promise<void>
  const storyId = 'story-ttl'

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('expires completed runs after the TTL and forgets their waiters', async () => {
    // No provider is configured, so preparation fails immediately and the run
    // reaches a terminal error state without needing an LLM mock.
    let clock = 1_000
    const manager = new GenerationRunManager(dataDir, {
      ttlMs: 1_000,
      now: () => clock,
    })

    const body = { input: 'Write something' }
    const resolved = await resolveGenerationRequest(dataDir, storyId, body)
    const { runId } = manager.startRun(storyId, body, { runId: 'ttl-run', resolved })

    let snapshot = manager.getSnapshot(storyId, runId)
    const deadline = Date.now() + 2_000
    while (snapshot?.status !== 'error' && Date.now() < deadline) {
      await sleep(10)
      snapshot = manager.getSnapshot(storyId, runId)
    }
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.lastSeq).toBeGreaterThan(0)

    // Just before the TTL the run is still queryable.
    clock += 500
    expect(manager.getSnapshot(storyId, runId)).not.toBeNull()

    // After the TTL it is swept away, including any pending subscribers.
    clock += 501
    expect(manager.getSnapshot(storyId, runId)).toBeNull()
    expect(manager.createEventStream(storyId, runId, 0)).toBeNull()
    expect(manager.cancel(storyId, runId)).toBeNull()
  })

  it('is idempotent for an in-flight run and advertises the terminal status', async () => {
    const manager = new GenerationRunManager(dataDir)
    const body = { input: 'Write something' }
    const resolved = await resolveGenerationRequest(dataDir, storyId, body)

    const first = manager.startRun(storyId, body, { runId: 'same-run', resolved })
    const second = manager.startRun(storyId, body, { runId: 'same-run', resolved })
    expect(first).toEqual({ runId: 'same-run', existing: false })
    expect(second).toEqual({ runId: 'same-run', existing: true })

    const deadline = Date.now() + 2_000
    let snapshot = manager.getSnapshot(storyId, 'same-run')
    while (snapshot?.status !== 'error' && Date.now() < deadline) {
      await sleep(10)
      snapshot = manager.getSnapshot(storyId, 'same-run')
    }
    expect(snapshot?.status).toBe('error')

    const stream = manager.createEventStream(storyId, 'same-run', 0)
    expect(stream).not.toBeNull()
    const reader = stream!.getReader()
    const decoder = new TextDecoder()
    const lines: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lines.push(...decoder.decode(value).split('\n').filter(Boolean))
    }
    const events = lines.map((line) => JSON.parse(line))
    expect(events.at(-1).event.type).toBe('run-error')
  })
})
