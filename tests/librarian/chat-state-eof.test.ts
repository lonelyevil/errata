import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir, makeTestSettings } from '../setup'
import { createStory } from '@/server/fragments/storage'
import type { StoryMeta } from '@/server/fragments/schema'

const agentMock = vi.hoisted(() => ({
  execute: vi.fn(),
  fail: vi.fn(),
}))

// Keep the manager real but replace the agent boundary so this test can emit
// an NDJSON chunk without a trailing newline.
vi.mock('@/server/agents', async () => {
  const actual = await vi.importActual<typeof import('@/server/agents')>('@/server/agents')
  return {
    ...actual,
    createAgentInstance: () => ({
      agentName: 'librarian.chat',
      execute: agentMock.execute,
      fail: agentMock.fail,
    }),
  }
})

import { __resetLibrarianChatRuntimesForTests, startLibrarianChatRun } from '@/server/librarian/chat-state'
import { getChatHistory } from '@/server/librarian/storage'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-chat-eof',
    name: 'Chat EOF Test',
    description: 'Trailing NDJSON buffer',
    coverImage: null,
    summary: 'A test story.',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('librarian chat stream EOF handling', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    await createStory(dataDir, makeStory())
    agentMock.execute.mockReset()
    agentMock.fail.mockReset()
    __resetLibrarianChatRuntimesForTests()
  })

  afterEach(async () => {
    __resetLibrarianChatRuntimesForTests()
    await cleanup()
  })

  it('consumes a final NDJSON part that has no trailing newline', async () => {
    agentMock.execute.mockImplementation(async () => {
      const eventStream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(JSON.stringify({ type: 'text', text: 'tail survives' }))
          controller.close()
        },
      })
      return {
        eventStream,
        completion: Promise.resolve({}),
      }
    })

    const result = await startLibrarianChatRun(dataDir, 'story-chat-eof', null, {
      runId: 'run-eof',
      prompt: 'Emit a tail',
      branchId: 'main',
      expectedRevision: 0,
    })
    expect(result.started).toBe(true)

    const final = await waitFor(async () => {
      const history = await getChatHistory(dataDir, 'story-chat-eof')
      return history.messages[1]?.status === 'done' ? history : null
    }, 'trailing-buffer completion')

    expect(final.messages[1].content).toBe('tail survives')
    expect(final.activeRun).toBeNull()
    expect(agentMock.execute).toHaveBeenCalledTimes(1)
  })
})
