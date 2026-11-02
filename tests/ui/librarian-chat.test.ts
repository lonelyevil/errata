// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LibrarianChat } from '@/components/librarian/LibrarianChat'
import { LibrarianPanel } from '@/components/sidebar/LibrarianPanel'
import { librarianChatStorageKey } from '@/hooks/use-librarian-chat'
import { ApiError } from '@/lib/api'
import type { LibrarianChatSnapshot, LibrarianChatStartInput } from '@/lib/librarian-chat'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), start: vi.fn(), cancel: vi.fn(), branches: vi.fn(), list: vi.fn(), create: vi.fn(), delete: vi.fn(), status: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, api: {
    ...original.api,
    branches: { ...original.api.branches, list: mocks.branches },
    librarian: { ...original.api.librarian, getChatState: mocks.get, startChatRun: mocks.start, cancelChatRun: mocks.cancel,
      listConversations: mocks.list, createConversation: mocks.create, deleteConversation: mocks.delete, getStatus: mocks.status },
  } }
})
vi.mock('@/components/ui/stream-markdown', () => ({
  StreamMarkdown: ({ content }: { content: string }) => createElement('div', null, content),
}))

function snapshot(revision = 1, content = 'Partial answer', branchId = 'main'): LibrarianChatSnapshot {
  return {
    branchId, revision, updatedAt: '2026-11-02T00:00:00.000Z', activeRun: { runId: 'run-1', status: 'running' },
    messages: [
      { id: 'user-1', role: 'user', content: 'Check Mara', runId: 'run-1' },
      { id: 'assistant-1', role: 'assistant', content, runId: 'run-1', status: 'running', reasoning: 'Checking continuity',
        toolCalls: [{ id: 'tool-1', toolName: 'update_character', args: { name: 'Mara' } }] },
    ],
  }
}
function idle(branchId = 'main'): LibrarianChatSnapshot {
  return { branchId, revision: 0, updatedAt: '2026-11-02T00:00:00.000Z', messages: [], activeRun: null }
}
function terminal(status: 'done' | 'cancelled' | 'error' | 'interrupted' = 'done'): LibrarianChatSnapshot {
  const state = snapshot(3, 'Completed answer')
  state.activeRun = null
  state.messages[1].status = status
  return state
}
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
}
const defaultProps = { storyId: 'story-1', branchId: 'main', conversationId: 'conv-1' }
function chatTree(queryClient: QueryClient, props = defaultProps) {
  return createElement(QueryClientProvider, { client: queryClient }, createElement(LibrarianChat, props))
}
async function advance(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
function send(view: ReturnType<typeof render>, text = 'Update Mara') {
  fireEvent.change(view.getByLabelText('Ask the librarian'), { target: { value: text } })
  fireEvent.click(view.getByLabelText('Send message'))
}

beforeEach(() => {
  vi.useFakeTimers()
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
    removeItem: (key: string) => { stored.delete(key) },
    clear: () => stored.clear(),
  })
  mocks.get.mockResolvedValue(snapshot())
  mocks.start.mockResolvedValue(snapshot())
  mocks.cancel.mockResolvedValue(terminal('cancelled'))
  mocks.branches.mockResolvedValue({ activeBranchId: 'main', branches: [] })
  mocks.list.mockResolvedValue([{ id: 'conv-1', title: 'Continuity', createdAt: '2026-11-02', updatedAt: '2026-11-02' }])
  mocks.status.mockResolvedValue({})
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Librarian server-owned chat', () => {
  it('discovers another client starting work while idle and follows it to completion without POST', async () => {
    mocks.get.mockResolvedValue(idle())
    const view = render(chatTree(client()))
    await advance()
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(view.queryByLabelText('Stop response')).toBeNull()

    mocks.get.mockResolvedValue(snapshot(1, 'Started in another tab'))
    await advance(4998)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    await advance(2)
    expect(view.getByText('Started in another tab')).toBeTruthy()
    expect(view.getByLabelText('Stop response')).toBeTruthy()

    mocks.get.mockResolvedValue(terminal())
    await advance(750)
    expect(view.getByText('Completed answer')).toBeTruthy()
    expect(view.queryByLabelText('Stop response')).toBeNull()
    const terminalCalls = mocks.get.mock.calls.length
    await advance(750)
    expect(mocks.get).toHaveBeenCalledTimes(terminalCalls)
    await advance(4250)
    expect(mocks.get).toHaveBeenCalledTimes(terminalCalls + 1)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('does not keep idle polling after a definitive GET rejection', async () => {
    mocks.get.mockRejectedValue(new ApiError('Conversation not found', 404, {}))
    const view = render(chatTree(client()))
    await advance()
    expect(view.getByRole('alert').textContent).toContain('Conversation not found')
    await advance(15000)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('recovers active work on mount and replaces progressive rich snapshots without duplication', async () => {
    const queryClient = client()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const view = render(chatTree(queryClient))
    await advance()
    expect(view.getByText('Partial answer')).toBeTruthy()
    expect(view.getByText('update_character')).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()

    const next = snapshot(2, 'Partial answer, continued')
    next.messages[1].toolCalls![0].result = { updated: true }
    mocks.get.mockResolvedValue(next)
    await advance(750)
    expect(view.queryByText('Partial answer')).toBeNull()
    expect(view.getByText('Partial answer, continued')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-component-id="librarian-message-assistant-1"]')).toHaveLength(1)
    expect(view.getAllByText('update_character')).toHaveLength(1)
    expect(view.getByText('done')).toBeTruthy()
    fireEvent.click(view.getByText('Reasoning'))
    expect(view.getByText('Checking continuity')).toBeTruthy()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('detaches on unmount without cancelling, then remounts and resumes by GET only', async () => {
    const first = render(chatTree(client()))
    await advance()
    const signal = mocks.get.mock.calls[0][3] as AbortSignal
    first.unmount()
    expect(signal.aborted).toBe(true)
    const calls = mocks.get.mock.calls.length
    await advance(2000)
    expect(mocks.get).toHaveBeenCalledTimes(calls)
    expect(mocks.cancel).not.toHaveBeenCalled()

    mocks.get.mockResolvedValue(snapshot(2, 'Progress while away'))
    const second = render(chatTree(client()))
    await advance()
    expect(second.getByText('Progress while away')).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('retains partial output across a transient pull failure and refreshes on reconnect/focus', async () => {
    const view = render(chatTree(client()))
    await advance()
    mocks.get.mockRejectedValueOnce(new TypeError('network lost'))
    await advance(750)
    expect(view.getByText('Partial answer')).toBeTruthy()
    expect(view.getByText('Reconnecting…')).toBeTruthy()
    mocks.get.mockResolvedValue(snapshot(2, 'Connection restored'))
    fireEvent.online(window)
    await advance()
    expect(view.getByText('Connection restored')).toBeTruthy()
    expect(view.queryByText('Reconnecting…')).toBeNull()
    fireEvent.focus(window)
    await advance()
    expect(mocks.get).toHaveBeenCalledTimes(4)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it.each([
    { ...defaultProps, storyId: 'story-2' },
    { ...defaultProps, branchId: 'alternate' },
    { ...defaultProps, conversationId: 'conv-2' },
  ])('ignores a late response after scope changes to %j', async props => {
    const old = deferred<LibrarianChatSnapshot>()
    mocks.get.mockReturnValueOnce(old.promise).mockResolvedValue(snapshot(2, 'Current scope', props.branchId))
    const queryClient = client()
    const view = render(chatTree(queryClient))
    view.rerender(chatTree(queryClient, props))
    await advance()
    await act(async () => { old.resolve(snapshot(99, 'Wrong scope')) })
    expect(view.getByText('Current scope')).toBeTruthy()
    expect(view.queryByText('Wrong scope')).toBeNull()
    expect(queryClient.getQueryData(['librarian-chat-state', 'story-1', 'main', 'conv-1'])).toBeUndefined()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('rejects revision regression and preserves partial output on terminal failure, invalidating once', async () => {
    mocks.get.mockResolvedValue(snapshot(5, 'Latest partial'))
    const queryClient = client()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const view = render(chatTree(queryClient))
    await advance()
    mocks.get.mockResolvedValue(snapshot(4, 'Stale partial'))
    await advance(750)
    expect(view.getByText('Latest partial')).toBeTruthy()
    expect(view.queryByText('Stale partial')).toBeNull()
    const failed = terminal('error')
    failed.revision = 6
    failed.messages[1].content = 'Latest partial'
    failed.messages[1].error = 'Provider disconnected'
    mocks.get.mockResolvedValue(failed)
    await advance(750)
    expect(view.getByText('Latest partial')).toBeTruthy()
    expect(view.getByText('Provider disconnected')).toBeTruthy()
    expect(view.queryByLabelText('Stop response')).toBeNull()
    const invalidations = invalidate.mock.calls.length
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['fragments', 'story-1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['librarian-conversations', 'story-1', 'main'] })
    fireEvent.focus(window)
    await advance()
    expect(invalidate).toHaveBeenCalledTimes(invalidations)
  })

  it('stops only through the explicit accessible Stop response control', async () => {
    const view = render(chatTree(client()))
    await advance()
    fireEvent.click(view.getByLabelText('Stop response'))
    await advance()
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.cancel).toHaveBeenCalledWith('story-1', 'main', 'run-1', 'conv-1', expect.any(AbortSignal))
    expect(view.getByText('Completed answer')).toBeTruthy()
    expect(view.getByText('Response stopped.')).toBeTruthy()
    view.unmount()
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })

  it('persists before POST and retries a lost acknowledgment using the exact same request', async () => {
    mocks.get.mockResolvedValue(idle())
    const key = librarianChatStorageKey('story-1', 'main', 'conv-1')
    mocks.start.mockImplementationOnce(async (_storyId: string, input: LibrarianChatStartInput) => {
      expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(input)
      throw new TypeError('response lost')
    }).mockImplementation(async (_storyId: string, input: LibrarianChatStartInput) => {
      const next = snapshot()
      next.messages.forEach(message => { message.runId = input.runId })
      next.activeRun!.runId = input.runId
      return next
    })
    const view = render(chatTree(client()))
    await advance()
    send(view)
    await advance()
    const request = mocks.start.mock.calls[0][1]
    expect(request).toMatchObject({ prompt: 'Update Mara', branchId: 'main', expectedRevision: 0 })
    expect(request.messages).toBeUndefined()
    expect(window.localStorage.getItem(key)).not.toBeNull()
    await advance(1500)
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(mocks.start.mock.calls[1][1]).toEqual(request)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('recovers a saved ambiguous submission after reload without creating a new run ID', async () => {
    mocks.get.mockResolvedValue(idle())
    const request: LibrarianChatStartInput = { runId: 'saved-run', prompt: 'Saved prompt', branchId: 'main', expectedRevision: 0 }
    const key = librarianChatStorageKey('story-1', 'main', 'conv-1')
    window.localStorage.setItem(key, JSON.stringify(request))
    render(chatTree(client()))
    await advance()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.start.mock.calls[0][1]).toEqual(request)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('resolves an already accepted saved submission by GET without replaying POST', async () => {
    const request: LibrarianChatStartInput = { runId: 'run-1', prompt: 'Check Mara', branchId: 'main', expectedRevision: 0 }
    const key = librarianChatStorageKey('story-1', 'main', 'conv-1')
    window.localStorage.setItem(key, JSON.stringify(request))
    const view = render(chatTree(client()))
    await advance()
    expect(view.getByText('Partial answer')).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('retries the exact ambiguous POST after an actual unmount and remount', async () => {
    mocks.get.mockResolvedValue(idle())
    mocks.start.mockRejectedValueOnce(new TypeError('acknowledgment lost')).mockResolvedValue(snapshot())
    const first = render(chatTree(client()))
    await advance()
    send(first, 'Keep this exact prompt')
    await advance()
    const original = mocks.start.mock.calls[0][1]
    first.unmount()
    const second = render(chatTree(client()))
    await advance()
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(mocks.start.mock.calls[1][1]).toEqual(original)
    expect(second.getByText('Partial answer')).toBeTruthy()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('keeps ambiguous submissions through detach and isolates their storage from other scopes', async () => {
    mocks.get.mockResolvedValue(idle())
    const ack = deferred<LibrarianChatSnapshot>()
    mocks.start.mockReturnValue(ack.promise)
    const first = render(chatTree(client()))
    await advance()
    send(first)
    const key = librarianChatStorageKey('story-1', 'main', 'conv-1')
    const saved = JSON.parse(window.localStorage.getItem(key)!)
    const exactSaved = window.localStorage.getItem(key)
    const requestSignal = mocks.start.mock.calls[0][3] as AbortSignal
    first.unmount()
    expect(requestSignal.aborted).toBe(true)
    expect(window.localStorage.getItem(key)).toBe(exactSaved)
    const second = render(chatTree(client(), { ...defaultProps, conversationId: 'conv-2' }))
    await advance()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    await act(async () => { ack.resolve(snapshot()) })
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(saved)
    expect(second.queryByText('Partial answer')).toBeNull()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('does not retry a definitive revision conflict as a new run', async () => {
    mocks.get.mockResolvedValue(idle())
    mocks.start.mockRejectedValue(new ApiError('Conversation changed. Refresh and try again.', 409, {}))
    const view = render(chatTree(client()))
    await advance()
    send(view)
    await advance()
    expect(view.getByRole('alert').textContent).toContain('Conversation changed')
    expect((view.getByLabelText('Ask the librarian') as HTMLTextAreaElement).value).toBe('Update Mara')
    expect(window.localStorage.getItem(librarianChatStorageKey('story-1', 'main', 'conv-1'))).toBeNull()
    await advance(3000)
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft and does not POST when recovery storage cannot be written', async () => {
    mocks.get.mockResolvedValue(idle())
    const view = render(chatTree(client()))
    await advance()
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage full') })
    send(view)
    expect(view.getByRole('alert').textContent).toContain('Could not save this request')
    expect((view.getByLabelText('Ask the librarian') as HTMLTextAreaElement).value).toBe('Update Mara')
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

describe('Librarian conversation selection', () => {
  it('restores branch-scoped selection and shows active-run deletion conflicts without leaving chat', async () => {
    window.localStorage.setItem('errata.librarian.selectedConversation.["story-1","main"]', 'conv-1')
    mocks.delete.mockRejectedValue(new ApiError('Stop the active response before deleting.', 409, {}))
    const queryClient = client()
    const view = render(createElement(QueryClientProvider, { client: queryClient }, createElement(LibrarianPanel, { storyId: 'story-1' })))
    await advance(10)
    expect(view.getByText('Partial answer')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledWith('story-1', 'main')
    fireEvent.click(view.getByTitle('Delete conversation'))
    await advance(10)
    expect(mocks.delete).toHaveBeenCalledWith('story-1', 'conv-1', 'main')
    expect(view.getByRole('alert').textContent).toContain('Stop the active response')
    expect(view.getByText('Partial answer')).toBeTruthy()

    mocks.branches.mockResolvedValue({ activeBranchId: 'alternate', branches: [] })
    mocks.list.mockResolvedValue([])
    await act(async () => { queryClient.setQueryData(['branches', 'story-1'], { activeBranchId: 'alternate', branches: [] }) })
    await advance(10)
    expect(view.queryByText('Partial answer')).toBeNull()
    expect(view.getByText('New chat')).toBeTruthy()
    expect(mocks.list).toHaveBeenLastCalledWith('story-1', 'alternate')
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('clears a stale saved selection when that scoped conversation no longer exists', async () => {
    window.localStorage.setItem('errata.librarian.selectedConversation.["story-1","main"]', 'missing')
    const view = render(createElement(QueryClientProvider, { client: client() }, createElement(LibrarianPanel, { storyId: 'story-1' })))
    await advance(10)
    expect(view.getByText('New chat')).toBeTruthy()
    expect(window.localStorage.getItem('errata.librarian.selectedConversation.["story-1","main"]')).toBeNull()
  })
})
