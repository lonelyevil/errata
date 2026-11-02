import { apiFetch, fetchEventStream, fetchGetEventStream } from './client'
import type { LibrarianChatSnapshot, LibrarianChatStartInput } from '@/lib/librarian-chat'
import type {
  LibrarianState,
  LibrarianAnalysisSummary,
  LibrarianAnalysis,
  LibrarianAcceptSuggestionResponse,
  ChatHistory,
  ConversationMeta,
  AgentRunTraceRecord,
} from './types'

function branchQuery(branchId?: string): string {
  return branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''
}

function chatPath(storyId: string, conversationId?: string | null): string {
  const base = `/stories/${encodeURIComponent(storyId)}/librarian`
  return conversationId ? `${base}/conversations/${encodeURIComponent(conversationId)}` : base
}

export const librarian = {
  getChatState: (storyId: string, branchId: string, conversationId?: string | null, signal?: AbortSignal) =>
    apiFetch<LibrarianChatSnapshot>(`${chatPath(storyId, conversationId)}/chat-state${branchQuery(branchId)}`, { signal, cache: 'no-store' }),
  startChatRun: (storyId: string, input: LibrarianChatStartInput, conversationId?: string | null, signal?: AbortSignal) =>
    apiFetch<LibrarianChatSnapshot>(`${chatPath(storyId, conversationId)}/chat-runs`, {
      method: 'POST', body: JSON.stringify(input), signal,
    }),
  cancelChatRun: (storyId: string, branchId: string, runId: string, conversationId?: string | null, signal?: AbortSignal) =>
    apiFetch<LibrarianChatSnapshot>(`${chatPath(storyId, conversationId)}/chat-runs/${encodeURIComponent(runId)}/cancel${branchQuery(branchId)}`, {
      method: 'POST', signal,
    }),
  getStatus: (storyId: string) =>
    apiFetch<LibrarianState>(`/stories/${storyId}/librarian/status`),
  getAnalysisIndex: (storyId: string) =>
    apiFetch<Record<string, string>>(`/stories/${storyId}/librarian/analysis-index`),
  analyze: (storyId: string, fragmentId: string) =>
    apiFetch<{ ok: boolean; fragmentId: string }>(`/stories/${storyId}/librarian/analyze`, {
      method: 'POST',
      body: JSON.stringify({ fragmentId }),
    }),
  listAnalyses: (storyId: string) =>
    apiFetch<LibrarianAnalysisSummary[]>(`/stories/${storyId}/librarian/analyses`),
  listAgentRuns: (storyId: string) =>
    apiFetch<AgentRunTraceRecord[]>(`/stories/${storyId}/librarian/agent-runs`),
  getAnalysis: (storyId: string, id: string) =>
    apiFetch<LibrarianAnalysis>(`/stories/${storyId}/librarian/analyses/${id}`),
  updateAnalysis: (storyId: string, analysisId: string, data: { summaryUpdate: string }) =>
    apiFetch<LibrarianAnalysis>(`/stories/${storyId}/librarian/analyses/${analysisId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  acceptSuggestion: (storyId: string, analysisId: string, index: number) =>
    apiFetch<LibrarianAcceptSuggestionResponse>(`/stories/${storyId}/librarian/analyses/${analysisId}/suggestions/${index}/accept`, { method: 'POST' }),
  dismissSuggestion: (storyId: string, analysisId: string, index: number) =>
    apiFetch<{ analysis: LibrarianAnalysis }>(`/stories/${storyId}/librarian/analyses/${analysisId}/suggestions/${index}/dismiss`, { method: 'POST' }),
  deleteAnalysis: (storyId: string, analysisId: string) =>
    apiFetch<{ ok: boolean }>(`/stories/${storyId}/librarian/analyses/${analysisId}`, { method: 'DELETE' }),
  refine: (storyId: string, fragmentId: string, instructions?: string) =>
    fetchEventStream(`/stories/${storyId}/librarian/refine`, { fragmentId, instructions }),
  transformProseSelection: (
    storyId: string,
    fragmentId: string,
    operation: 'rewrite' | 'expand' | 'compress' | 'custom',
    selectedText: string,
    options?: { sourceContent?: string; contextBefore?: string; contextAfter?: string; instruction?: string },
  ) => fetchEventStream(`/stories/${storyId}/librarian/prose-transform`, {
    fragmentId,
    operation,
    selectedText,
    sourceContent: options?.sourceContent,
    contextBefore: options?.contextBefore,
    contextAfter: options?.contextAfter,
    instruction: options?.instruction,
  }),
  chat: (storyId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    fetchEventStream(`/stories/${storyId}/librarian/chat`, { messages }),
  getChatHistory: (storyId: string, branchId?: string) =>
    apiFetch<ChatHistory>(`${chatPath(storyId)}/chat${branchQuery(branchId)}`),
  clearChatHistory: (storyId: string, branchId?: string) =>
    apiFetch<{ ok: boolean }>(`${chatPath(storyId)}/chat${branchQuery(branchId)}`, { method: 'DELETE' }),
  getAnalysisStream: (storyId: string) =>
    fetchGetEventStream(`/stories/${storyId}/librarian/analysis-stream`),
  // Conversations
  listConversations: (storyId: string, branchId?: string) =>
    apiFetch<ConversationMeta[]>(`${chatPath(storyId)}/conversations${branchQuery(branchId)}`),
  createConversation: (storyId: string, title?: string, branchId?: string) =>
    apiFetch<ConversationMeta>(`${chatPath(storyId)}/conversations${branchQuery(branchId)}`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (storyId: string, conversationId: string, branchId?: string) =>
    apiFetch<{ ok: boolean }>(`${chatPath(storyId, conversationId)}${branchQuery(branchId)}`, {
      method: 'DELETE',
    }),
  getConversationHistory: (storyId: string, conversationId: string, branchId?: string) =>
    apiFetch<ChatHistory>(`${chatPath(storyId, conversationId)}/chat${branchQuery(branchId)}`),
  conversationChat: (storyId: string, conversationId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    fetchEventStream(`/stories/${storyId}/librarian/conversations/${conversationId}/chat`, { messages }),
}
