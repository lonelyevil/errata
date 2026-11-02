import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import type { LibrarianChatSnapshot, LibrarianChatStartInput } from '@/lib/librarian-chat'
import { createGenerationRunId } from '@/lib/api/generation-run'

const POLL_MS = 750
const IDLE_POLL_MS = 5000

export function librarianChatStorageKey(storyId: string, branchId: string, conversationId?: string | null) {
  return `errata.librarian.pending.${JSON.stringify([storyId, branchId, conversationId ?? null])}`
}

function readPending(key: string, branchId: string): LibrarianChatStartInput | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    if (value && typeof value.runId === 'string' && typeof value.prompt === 'string'
      && value.branchId === branchId && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0) {
      return value
    }
  } catch { /* An unavailable or malformed local record is not a server transcript. */ }
  return null
}

interface ChatState {
  scope: string
  snapshot: LibrarianChatSnapshot | null
  loading: boolean
  pending: boolean
  stopping: boolean
  reconnecting: boolean
  error: string | null
  unsentPrompt: string | null
}

const emptyState: Omit<ChatState, 'scope'> = {
  snapshot: null, loading: true, pending: false, stopping: false, reconnecting: false, error: null, unsentPrompt: null,
}

interface Session {
  scope: string
  send: (prompt: string) => boolean
  stop: () => Promise<void>
}

/** A view of server-owned work. Disposing this hook only detaches its requests. */
export function useLibrarianChat(storyId: string, branchId: string, conversationId?: string | null) {
  const queryClient = useQueryClient()
  const scope = JSON.stringify([storyId, branchId, conversationId ?? null])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const sessionRef = useRef<Session | null>(null)
  const [state, setState] = useState<ChatState>({ scope, ...emptyState })

  useEffect(() => {
    const queryKey = ['librarian-chat-state', storyId, branchId, conversationId ?? null]
    const storageKey = librarianChatStorageKey(storyId, branchId, conversationId)
    const controller = new AbortController()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pulling = false
    let starting = false
    let failures = 0
    let pollingBlocked = false
    let pending = readPending(storageKey, branchId)
    let snapshot = queryClient.getQueryData<LibrarianChatSnapshot>(queryKey) ?? null
    let view: ChatState = { scope, ...emptyState, snapshot, pending: !!pending }
    const terminalSeen = new Set<string>()
    const isCurrent = () => !disposed && scopeRef.current === scope
    const publish = (patch: Partial<ChatState>) => {
      if (!isCurrent()) return
      view = { ...view, ...patch }
      setState(view)
    }
    const clearPending = () => {
      pending = null
      try { window.localStorage.removeItem(storageKey) } catch { /* Confirmed server state still wins. */ }
      publish({ pending: false })
    }
    const accept = (next: LibrarianChatSnapshot) => {
      if (!isCurrent()) return
      if (next.branchId !== branchId) throw new Error('Could not confirm the current timeline. Reconnecting…')
      pollingBlocked = false
      if (snapshot && next.revision < snapshot.revision) return
      snapshot = next
      queryClient.setQueryData(queryKey, next)
      publish({ snapshot: next, loading: false, reconnecting: false })
      if (pending && next.messages.some(message => message.runId === pending?.runId)) clearPending()

      // Catch completion even when it happened while this view was detached.
      const last = next.messages.at(-1)
      if (last?.role === 'assistant' && last.runId && last.status && last.status !== 'running'
        && !terminalSeen.has(last.runId)) {
        terminalSeen.add(last.runId)
        for (const key of ['fragments', 'librarian-analyses', 'librarian-analysis', 'librarian-status', 'librarian-analysis-index']) {
          void queryClient.invalidateQueries({ queryKey: [key, storyId] })
        }
        void queryClient.invalidateQueries({ queryKey: ['librarian-conversations', storyId, branchId] })
      }
    }
    const schedule = () => {
      if (!isCurrent()) return
      clearTimeout(timer)
      if (pollingBlocked) return
      // An idle view must still discover work submitted by another client.
      const delay = pending || snapshot?.activeRun || view.reconnecting
        ? Math.min(POLL_MS * 2 ** Math.min(failures, 3), 6000)
        : IDLE_POLL_MS
      timer = setTimeout(() => { void refresh() }, delay)
    }
    const fail = (err: unknown) => {
      if (!isCurrent()) return
      failures += 1
      const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500
        && ![408, 425, 429].includes(err.status)
      pollingBlocked = definitive
      publish({ loading: false, reconnecting: !definitive, error: definitive
        ? err.message : null })
    }
    const flushPending = async () => {
      if (!isCurrent() || !pending || starting) return
      const request = pending
      starting = true
      let refreshConflict = false
      try {
        const next = await api.librarian.startChatRun(storyId, request, conversationId, controller.signal)
        if (!isCurrent()) return
        accept(next)
        // An acknowledged start is safe even if its response raced a newer GET.
        if (pending?.runId === request.runId) clearPending()
        failures = 0
        publish({ error: null, reconnecting: false })
      } catch (err) {
        if (!isCurrent()) return
        const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500
          && ![408, 425, 429].includes(err.status)
        if (definitive) {
          clearPending()
          publish({ unsentPrompt: request.prompt })
          refreshConflict = err.status === 409
        }
        fail(err)
      } finally {
        starting = false
        schedule()
        if (isCurrent() && refreshConflict) {
          clearTimeout(timer)
          timer = setTimeout(() => { void refresh() }, 0)
        }
      }
    }
    async function refresh() {
      if (!isCurrent() || pulling) return
      pulling = true
      try {
        const next = await api.librarian.getChatState(storyId, branchId, conversationId, controller.signal)
        if (!isCurrent()) return
        accept(next)
        failures = 0
        // A saved request is replayed unchanged, never as a new run. GET may
        // already have confirmed it and removed the pending record above.
        if (pending) await flushPending()
      } catch (err) {
        fail(err)
      } finally {
        pulling = false
        schedule()
      }
    }
    const session: Session = {
      scope,
      send(prompt) {
        const text = prompt.trim()
        if (!isCurrent() || !text || view.loading || !snapshot || snapshot.activeRun || pending || starting) return false
        const request: LibrarianChatStartInput = {
          runId: createGenerationRunId(), prompt: text, branchId, expectedRevision: snapshot.revision,
        }
        try {
          // This must precede the POST: a reload during an ambiguous response
          // must retain the exact idempotent request, not generate another ID.
          window.localStorage.setItem(storageKey, JSON.stringify(request))
        } catch {
          publish({ error: 'Could not save this request for recovery. Please check browser storage and try again.' })
          return false
        }
        pending = request
        publish({ pending: true, error: null, unsentPrompt: null })
        void flushPending()
        return true
      },
      async stop() {
        if (!isCurrent() || !snapshot?.activeRun || view.stopping) return
        const runId = snapshot.activeRun.runId
        publish({ stopping: true, error: null })
        try {
          accept(await api.librarian.cancelChatRun(storyId, branchId, runId, conversationId, controller.signal))
        } catch (err) {
          if (isCurrent()) publish({ error: err instanceof Error ? `Could not stop response: ${err.message}` : 'Could not stop response.' })
        } finally {
          publish({ stopping: false })
          schedule()
        }
      },
    }
    sessionRef.current = session
    publish({})
    void refresh()
    const onReconnect = () => { void refresh() }
    window.addEventListener('focus', onReconnect)
    window.addEventListener('online', onReconnect)
    return () => {
      disposed = true
      clearTimeout(timer)
      controller.abort()
      window.removeEventListener('focus', onReconnect)
      window.removeEventListener('online', onReconnect)
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [storyId, branchId, conversationId, scope, queryClient])

  const send = useCallback((prompt: string) => sessionRef.current?.scope === scope
    ? sessionRef.current.send(prompt) : false, [scope])
  const stop = useCallback(async () => {
    if (sessionRef.current?.scope === scope) await sessionRef.current.stop()
  }, [scope])
  const current = state.scope === scope ? state : { scope, ...emptyState }
  return { ...current, messages: current.snapshot?.messages ?? [],
    busy: current.pending || !!current.snapshot?.activeRun, send, stop }
}
