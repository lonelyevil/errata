import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { librarian } from '@/lib/api/librarian'
import type { LibrarianChatSnapshot, LibrarianChatStartInput } from '@/lib/librarian-chat'

const snapshot: LibrarianChatSnapshot = {
  branchId: 'alternate/one', revision: 4, updatedAt: '2026-11-02T00:00:00.000Z', messages: [], activeRun: null,
}
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify(snapshot), {
    headers: { 'Content-Type': 'application/json' },
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('Librarian snapshot client', () => {
  it.each([null, 'conv/one'])('pulls branch-scoped state with a detachable signal (conversation %s)', async conversationId => {
    const controller = new AbortController()
    await expect(librarian.getChatState('story/one', 'alternate/one', conversationId, controller.signal)).resolves.toEqual(snapshot)
    const path = conversationId ? '/conversations/conv%2Fone' : ''
    expect(fetchMock).toHaveBeenCalledWith(`/api/stories/story%2Fone/librarian${path}/chat-state?branchId=alternate%2Fone`, expect.objectContaining({
      signal: controller.signal, cache: 'no-store',
    }))
    controller.abort()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts with only the stable request payload, not a client transcript', async () => {
    const signal = new AbortController().signal
    const input: LibrarianChatStartInput = { runId: 'run-stable', prompt: 'Update Mara', branchId: 'alternate/one', expectedRevision: 4 }
    await expect(librarian.startChatRun('story', input, 'conv', signal)).resolves.toEqual(snapshot)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/stories/story/librarian/conversations/conv/chat-runs')
    expect(options.method).toBe('POST')
    expect(options.signal).toBe(signal)
    expect(JSON.parse(options.body)).toEqual(input)
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json')
  })

  it('explicitly cancels only the scoped run and returns the canonical snapshot', async () => {
    const signal = new AbortController().signal
    await expect(librarian.cancelChatRun('story', 'alternate/one', 'run/one', 'conv', signal)).resolves.toEqual(snapshot)
    expect(fetchMock).toHaveBeenCalledWith('/api/stories/story/librarian/conversations/conv/chat-runs/run%2Fone/cancel?branchId=alternate%2Fone', expect.objectContaining({
      method: 'POST', signal,
    }))
  })

  it('uses the legacy/default scope for start and cancel when no conversation is selected', async () => {
    const input: LibrarianChatStartInput = { runId: 'r', prompt: 'Hello', branchId: 'main', expectedRevision: 0 }
    await librarian.startChatRun('story', input)
    await librarian.cancelChatRun('story', 'main', 'r')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/stories/story/librarian/chat-runs', '/api/stories/story/librarian/chat-runs/r/cancel?branchId=main',
    ])
  })

  it('scopes conversation CRUD and history to the explicit branch', async () => {
    await librarian.listConversations('story', 'alternate/one')
    await librarian.createConversation('story', 'Research', 'alternate/one')
    await librarian.getConversationHistory('story', 'conv/one', 'alternate/one')
    await librarian.deleteConversation('story', 'conv/one', 'alternate/one')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/stories/story/librarian/conversations?branchId=alternate%2Fone',
      '/api/stories/story/librarian/conversations?branchId=alternate%2Fone',
      '/api/stories/story/librarian/conversations/conv%2Fone/chat?branchId=alternate%2Fone',
      '/api/stories/story/librarian/conversations/conv%2Fone?branchId=alternate%2Fone',
    ])
    expect(fetchMock.mock.calls[3][1].method).toBe('DELETE')
  })

  it('surfaces an active-run deletion conflict rather than claiming success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Stop the active response before deleting.' }), { status: 409 }))
    await expect(librarian.deleteConversation('story', 'conv', 'main')).rejects.toMatchObject({ status: 409, message: 'Stop the active response before deleting.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
