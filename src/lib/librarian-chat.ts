/**
 * Shared contract for server-owned librarian chat state.
 *
 * The server persists chat history and runs the model independently of any
 * HTTP connection. Clients submit a run once and then poll `chat-state` for a
 * complete snapshot; they never own the run lifetime.
 */

export type LibrarianChatStatus = 'running' | 'done' | 'cancelled' | 'error' | 'interrupted'

export interface LibrarianChatToolCall {
  id: string
  toolName: string
  args: Record<string, unknown>
  result?: unknown
}

export interface LibrarianChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: LibrarianChatToolCall[]
  runId?: string
  status?: LibrarianChatStatus
  error?: string
}

export interface LibrarianChatSnapshot {
  branchId: string
  revision: number
  updatedAt: string
  messages: LibrarianChatMessage[]
  activeRun: {
    runId: string
    status: 'running' | 'cancelling'
  } | null
}

export interface LibrarianChatStartInput {
  runId: string
  prompt: string
  branchId: string
  expectedRevision: number
  maxSteps?: number
}
