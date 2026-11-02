import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getContentRoot } from '../fragments/branches'
import { generateConversationId } from '@/lib/fragment-ids'
import type { LibrarianChatMessage, LibrarianChatSnapshot, LibrarianChatStatus } from '@/lib/librarian-chat'
import { writeJsonAtomic } from '../fs-utils'
import { withKeyLock } from '../async-lock'

/**
 * Tracks index-lock depth by key for the current async chain. Nested storage
 * calls (saveAnalysis -> delete -> rebuild, or a plugin prune) must not
 * self-deadlock on the non-reentrant withKeyLock, but concurrent siblings
 * spawned inside the same context must still serialize with each other.
 */
const heldIndexLocks = new AsyncLocalStorage<Map<string, number>>()

/**
 * Serializes analysis file/index mutations for a story. Exported so server
 * plugins that need to read, delete, and rebuild in one critical section can
 * share the same lock as saveAnalysis.
 */
export function withAnalysisLock<T>(
  dataDir: string,
  storyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withIndexLock(dataDir, storyId, fn)
}

/** Serializes read-modify-write of a story's analysis index against concurrent saves. */
function withIndexLock<T>(dataDir: string, storyId: string, fn: () => Promise<T>): Promise<T> {
  const key = `librarian-index:${dataDir}:${storyId}`
  const held = heldIndexLocks.getStore()
  const depth = held?.get(key) ?? 0
  // Outer calls use `key`; nested calls use a depth-specific key so parallel
  // nested operations can't bypass the outer lock, while sequential nesting
  // remains reentrant.
  const lockKey = depth === 0 ? key : `${key}::${depth}`

  return withKeyLock(lockKey, () => {
    const next = new Map(held ?? [])
    next.set(key, depth + 1)
    return heldIndexLocks.run(next, fn)
  })
}

// --- Types ---

export interface LibrarianAnalysis {
  id: string
  createdAt: string
  fragmentId: string
  /** The summary text the librarian intended to record (intent). */
  summaryUpdate: string
  /**
   * ID of the summary fragment this analysis contributed to (artifact).
   * Set when the deferred-summary application creates or appends to a
   * chapter summary fragment. Undefined for legacy analyses written before
   * summary fragments existed.
   */
  summaryFragmentId?: string
  structuredSummary?: {
    events: string[]
    stateChanges: string[]
    openThreads: string[]
  }
  mentionedCharacters: string[]
  mentions?: Array<{ characterId: string; text: string }>
  contradictions: Array<{
    description: string
    fragmentIds: string[]
  }>
  fragmentSuggestions: Array<{
    type: 'character' | 'knowledge'
    targetFragmentId?: string
    name: string
    description: string
    content: string
    sourceFragmentId?: string
    accepted?: boolean
    autoApplied?: boolean
    createdFragmentId?: string
    dismissed?: boolean
  }>
  /** @deprecated Use fragmentSuggestions. Kept for backward compat with stored JSON. */
  knowledgeSuggestions?: Array<{
    type: 'character' | 'knowledge'
    targetFragmentId?: string
    name: string
    description: string
    content: string
    sourceFragmentId?: string
    accepted?: boolean
    autoApplied?: boolean
    createdFragmentId?: string
  }>
  timelineEvents: Array<{
    event: string
    position: 'before' | 'during' | 'after'
  }>
  directions?: Array<{
    title: string
    description: string
    instruction: string
  }>
  trace?: Array<{
    type: string
    [key: string]: unknown
  }>
}

export function selectLatestAnalysesByFragment(
  summaries: LibrarianAnalysisSummary[],
): Map<string, LibrarianAnalysisSummary> {
  const latest = new Map<string, LibrarianAnalysisSummary>()

  for (const summary of summaries) {
    const prev = latest.get(summary.fragmentId)
    if (!prev) {
      latest.set(summary.fragmentId, summary)
      continue
    }

    if (
      summary.createdAt > prev.createdAt
      || (summary.createdAt === prev.createdAt && summary.id > prev.id)
    ) {
      latest.set(summary.fragmentId, summary)
    }
  }

  return latest
}

export interface LibrarianAnalysisSummary {
  id: string
  createdAt: string
  fragmentId: string
  contradictionCount: number
  suggestionCount: number
  pendingSuggestionCount: number
  timelineEventCount: number
  directionsCount: number
  hasTrace?: boolean
}

export interface LibrarianState {
  lastAnalyzedFragmentId: string | null
  /** Fragment ID up to which summaries have been applied to the story summary */
  summarizedUpTo: string | null
  recentMentions: Record<string, string[]>
  timeline: Array<{ event: string; fragmentId: string }>
}

export interface LibrarianAnalysisIndexEntry {
  analysisId: string
  createdAt: string
}

export interface LibrarianAnalysisIndex {
  version: 1
  updatedAt: string
  latestByFragmentId: Record<string, LibrarianAnalysisIndexEntry>
  appliedSummarySequence?: string[]
}

// --- Path helpers ---

async function librarianDir(dataDir: string, storyId: string): Promise<string> {
  const root = await getContentRoot(dataDir, storyId)
  return join(root, 'librarian')
}

async function analysesDir(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'analyses')
}

async function analysisPath(dataDir: string, storyId: string, analysisId: string): Promise<string> {
  const dir = await analysesDir(dataDir, storyId)
  return join(dir, `${analysisId}.json`)
}

async function statePath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'state.json')
}

async function analysisIndexPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'index.json')
}

function shouldReplaceIndexEntry(
  previous: LibrarianAnalysisIndexEntry | undefined,
  incoming: { createdAt: string; analysisId: string },
): boolean {
  if (!previous) return true
  if (incoming.createdAt > previous.createdAt) return true
  if (incoming.createdAt < previous.createdAt) return false
  return incoming.analysisId > previous.analysisId
}

function defaultAnalysisIndex(): LibrarianAnalysisIndex {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    latestByFragmentId: {},
  }
}

async function saveAnalysisIndex(
  dataDir: string,
  storyId: string,
  index: LibrarianAnalysisIndex,
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await analysisIndexPath(dataDir, storyId), index)
}

export async function getAnalysisIndex(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisIndex | null> {
  const path = await analysisIndexPath(dataDir, storyId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<LibrarianAnalysisIndex>
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    latestByFragmentId: parsed.latestByFragmentId ?? {},
    appliedSummarySequence: Array.isArray(parsed.appliedSummarySequence) ? parsed.appliedSummarySequence : undefined,
  }
}

function analysisSummaryToIndexEntry(summary: LibrarianAnalysisSummary): LibrarianAnalysisIndexEntry {
  return {
    analysisId: summary.id,
    createdAt: summary.createdAt,
  }
}

export async function rebuildAnalysisIndex(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisIndex> {
  return withIndexLock(dataDir, storyId, async () => {
    const existing = await getAnalysisIndex(dataDir, storyId)
    const summaries = await listAnalyses(dataDir, storyId)
    const latest = selectLatestAnalysesByFragment(summaries)
    const rebuilt: LibrarianAnalysisIndex = defaultAnalysisIndex()
    for (const [fragmentId, summary] of latest.entries()) {
      rebuilt.latestByFragmentId[fragmentId] = analysisSummaryToIndexEntry(summary)
    }
    // Rebuilding must not discard metadata owned by other librarian flows.
    if (existing?.appliedSummarySequence) {
      rebuilt.appliedSummarySequence = existing.appliedSummarySequence
    }
    rebuilt.updatedAt = new Date().toISOString()
    await saveAnalysisIndex(dataDir, storyId, rebuilt)
    return rebuilt
  })
}

export async function clearAnalysisIndexEntry(
  dataDir: string,
  storyId: string,
  fragmentId: string,
): Promise<void> {
  await withIndexLock(dataDir, storyId, async () => {
    const index = await getAnalysisIndex(dataDir, storyId)
    if (!index) return
    if (!(fragmentId in index.latestByFragmentId)) return
    delete index.latestByFragmentId[fragmentId]
    index.updatedAt = new Date().toISOString()
    await saveAnalysisIndex(dataDir, storyId, index)
  })
}

export async function getLatestAnalysisIdsByFragment(
  dataDir: string,
  storyId: string,
): Promise<Map<string, string>> {
  const index = await getAnalysisIndex(dataDir, storyId) ?? await rebuildAnalysisIndex(dataDir, storyId)
  return new Map(
    Object.entries(index.latestByFragmentId)
      .map(([fragmentId, entry]) => [fragmentId, entry.analysisId]),
  )
}

// --- Storage functions ---

export async function saveAnalysis(
  dataDir: string,
  storyId: string,
  analysis: LibrarianAnalysis,
): Promise<void> {
  // The analysis file and its index update form one critical section: a prune
  // must never observe a saved file that is not yet reflected in the index (or
  // vice versa). This is safe to nest because withIndexLock is reentrant for
  // the current async chain.
  await withIndexLock(dataDir, storyId, async () => {
    const dir = await analysesDir(dataDir, storyId)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(
      await analysisPath(dataDir, storyId, analysis.id),
      analysis,
    )

    // Index read-modify-write must be serialized: concurrent saves would each
    // read the same index and the later write would drop the earlier entry.
    const currentIndex = await getAnalysisIndex(dataDir, storyId) ?? defaultAnalysisIndex()
    const previous = currentIndex.latestByFragmentId[analysis.fragmentId]
    if (shouldReplaceIndexEntry(previous, { createdAt: analysis.createdAt, analysisId: analysis.id })) {
      currentIndex.latestByFragmentId[analysis.fragmentId] = {
        analysisId: analysis.id,
        createdAt: analysis.createdAt,
      }
    }
    currentIndex.updatedAt = new Date().toISOString()
    await saveAnalysisIndex(dataDir, storyId, currentIndex)
  })
}

export async function getAnalysis(
  dataDir: string,
  storyId: string,
  analysisId: string,
): Promise<LibrarianAnalysis | null> {
  const path = await analysisPath(dataDir, storyId, analysisId)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  return normalizeAnalysis(JSON.parse(raw))
}

/** Migrate old knowledgeSuggestions → fragmentSuggestions on read */
function normalizeAnalysis(data: Record<string, unknown>): LibrarianAnalysis {
  const analysis = data as unknown as LibrarianAnalysis
  if (!analysis.fragmentSuggestions && analysis.knowledgeSuggestions) {
    analysis.fragmentSuggestions = analysis.knowledgeSuggestions
  }
  if (!analysis.fragmentSuggestions) {
    analysis.fragmentSuggestions = []
  }
  return analysis
}

export async function deleteAnalysis(
  dataDir: string,
  storyId: string,
  analysisId: string,
): Promise<boolean> {
  return withIndexLock(dataDir, storyId, async () => {
    const path = await analysisPath(dataDir, storyId, analysisId)
    if (!existsSync(path)) return false

    // Read the analysis to get fragmentId for index cleanup
    const raw = await readFile(path, 'utf-8')
    const analysis = normalizeAnalysis(JSON.parse(raw))

    await unlink(path)

    // Clean up index entry if it points to this analysis
    const index = await getAnalysisIndex(dataDir, storyId)
    if (index) {
      const entry = index.latestByFragmentId[analysis.fragmentId]
      if (entry && entry.analysisId === analysisId) {
        delete index.latestByFragmentId[analysis.fragmentId]
        index.updatedAt = new Date().toISOString()
        await saveAnalysisIndex(dataDir, storyId, index)
      }
    }

    return true
  })
}

export async function listAnalyses(
  dataDir: string,
  storyId: string,
): Promise<LibrarianAnalysisSummary[]> {
  const dir = await analysesDir(dataDir, storyId)
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const summaries: LibrarianAnalysisSummary[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = await readFile(join(dir, entry), 'utf-8')
    const analysis = normalizeAnalysis(JSON.parse(raw))
    summaries.push({
      id: analysis.id,
      createdAt: analysis.createdAt,
      fragmentId: analysis.fragmentId,
      contradictionCount: analysis.contradictions.length,
      suggestionCount: analysis.fragmentSuggestions.length,
      pendingSuggestionCount: analysis.fragmentSuggestions.filter((s) => !s.accepted && !s.dismissed).length,
      timelineEventCount: analysis.timelineEvents.length,
      directionsCount: analysis.directions?.length ?? 0,
      hasTrace: !!analysis.trace?.length,
    })
  }

  // Sort newest first
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return summaries
}

export async function getState(
  dataDir: string,
  storyId: string,
): Promise<LibrarianState> {
  const path = await statePath(dataDir, storyId)
  if (!existsSync(path)) {
    return {
      lastAnalyzedFragmentId: null,
      summarizedUpTo: null,
      recentMentions: {},
      timeline: [],
    }
  }
  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as LibrarianState
}

export async function saveState(
  dataDir: string,
  storyId: string,
  state: LibrarianState,
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await statePath(dataDir, storyId), state)
}

// --- Chat history ---

/**
 * One canonical history document backs both the legacy chat endpoints and the
 * server-owned run snapshot. Older documents only had `messages`/`updatedAt`;
 * the run bookkeeping fields are optional so legacy readers keep working.
 */
export interface ChatHistoryToolCall {
  id: string
  toolName: string
  args: Record<string, unknown>
  result?: unknown
}

export interface ChatHistoryMessage {
  /** Optional only for legacy documents. New writes always assign an ID. */
  id?: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: ChatHistoryToolCall[]
  runId?: string
  status?: LibrarianChatStatus
  error?: string
}

/** Metadata retained for every accepted run so retries dedupe after restart. */
export interface ChatRunRecord {
  runId: string
  prompt: string
  branchId: string
  expectedRevision: number
  maxSteps?: number
  status: LibrarianChatStatus
  startedAt: string
  updatedAt: string
  messageId: string
  assistantMessageId: string
  finishedAt?: string
  cancelledAt?: string
  error?: string
}

export interface ChatActiveRun {
  runId: string
  status: 'running' | 'cancelling'
  prompt: string
  branchId: string
  expectedRevision: number
  maxSteps?: number
  startedAt: string
  messageId: string
  assistantMessageId: string
}

export interface ChatHistory {
  messages: ChatHistoryMessage[]
  updatedAt: string
  /** Monotonic snapshot revision. Missing in legacy documents (treated as 0). */
  revision?: number
  /** Branch this document belongs to. Storage is already branch-scoped. */
  branchId?: string
  activeRun?: ChatActiveRun | null
  runs?: Record<string, ChatRunRecord>
}

/** Typed conflict raised while a server-owned run is active (HTTP 409). */
export class ChatHistoryConflictError extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'ChatHistoryConflictError'
  }
}

const SAFE_CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeChatId(value: string): boolean {
  return SAFE_CHAT_ID.test(value)
}

function assertSafeChatId(value: string, label: string): void {
  if (!isSafeChatId(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function normalizeChatHistory(value: unknown): ChatHistory {
  const parsed = (value && typeof value === 'object' ? value : {}) as Partial<ChatHistory>
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.filter((m): m is ChatHistoryMessage => {
        if (!m || typeof m !== 'object') return false
        const candidate = m as Partial<ChatHistoryMessage>
        return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string'
      })
    : []

  return {
    messages,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    revision: typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) && parsed.revision >= 0
      ? Math.floor(parsed.revision)
      : 0,
    ...(typeof parsed.branchId === 'string' ? { branchId: parsed.branchId } : {}),
    activeRun: parsed.activeRun && typeof parsed.activeRun === 'object'
      ? parsed.activeRun
      : null,
    runs: parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {},
  }
}

async function chatHistoryPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'chat-history.json')
}

function defaultChatHistory(): ChatHistory {
  return {
    messages: [],
    updatedAt: new Date().toISOString(),
    revision: 0,
    activeRun: null,
    runs: {},
  }
}

async function readChatHistoryFile(path: string): Promise<ChatHistory> {
  if (!existsSync(path)) return defaultChatHistory()
  const raw = await readFile(path, 'utf-8')
  return normalizeChatHistory(JSON.parse(raw))
}

export async function getChatHistory(
  dataDir: string,
  storyId: string,
): Promise<ChatHistory> {
  return readChatHistoryFile(await chatHistoryPath(dataDir, storyId))
}

export async function getConversationHistory(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<ChatHistory> {
  assertSafeChatId(conversationId, 'conversation ID')
  const dir = await librarianDir(dataDir, storyId)
  return readChatHistoryFile(conversationHistoryPath(dir, conversationId))
}

/**
 * Read the canonical document for a scope. `conversationId = null` selects the
 * legacy default chat document.
 */
export async function readChatHistoryDocument(
  dataDir: string,
  storyId: string,
  conversationId?: string | null,
): Promise<ChatHistory> {
  if (conversationId) {
    return getConversationHistory(dataDir, storyId, conversationId)
  }
  return getChatHistory(dataDir, storyId)
}

/**
 * Apply a mutation to the canonical history document under a per-document lock,
 * then atomically write it. Conversation histories are never created if the
 * conversation no longer exists in the index, so a deleted conversation cannot
 * be resurrected by a late writer.
 *
 * Returns null when the conversation is missing.
 */
export interface MutateChatHistoryOptions {
  /** Refuse to mutate while a server-owned run is active. */
  rejectIfActive?: boolean
  /** Only write if the document is still at this revision (legacy fence). */
  expectedRevision?: number
}

export async function mutateChatHistoryDocument(
  dataDir: string,
  storyId: string,
  conversationId: string | null | undefined,
  mutate: (history: ChatHistory) => void | Promise<void>,
  options: MutateChatHistoryOptions = {},
): Promise<ChatHistory | null> {
  if (conversationId) assertSafeChatId(conversationId, 'conversation ID')

  const dir = await librarianDir(dataDir, storyId)
  const path = conversationId
    ? conversationHistoryPath(dir, conversationId)
    : join(dir, 'chat-history.json')
  const lockKey = `librarian-chat-history:${path}`

  return withKeyLock(lockKey, async () => {
    if (conversationId && !(await conversationExistsUnlocked(dataDir, storyId, conversationId))) {
      return null
    }

    const history = await readChatHistoryFile(path)
    if (options.rejectIfActive && history.activeRun) {
      throw new ChatHistoryConflictError('Cannot modify chat history while a run is active')
    }
    if (
      options.expectedRevision !== undefined
      && (history.revision ?? 0) !== options.expectedRevision
    ) {
      throw new ChatHistoryConflictError('Chat history changed since this legacy request started')
    }
    await mutate(history)
    history.updatedAt = new Date().toISOString()
    history.revision = (history.revision ?? 0) + 1

    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(path, history)

    if (conversationId) {
      const firstUser = history.messages.find(message => message.role === 'user')?.content
      await touchConversationMeta(dataDir, storyId, conversationId, history.updatedAt, firstUser)
    }
    return history
  })
}

export interface LegacyChatHistoryWriteOptions {
  /**
   * Revision captured when the legacy streaming request started. A mismatch
   * means a newer server-owned turn committed first, so the old completion
   * must not replace it.
   */
  expectedRevision?: number
}

/**
 * Persist a legacy transcript. Returns false (and leaves the file untouched)
 * when a server-owned run is active or the optional revision fence no longer
 * matches. The active check and write share the document lock, so a run that
 * is accepted concurrently cannot be overwritten.
 */
export async function saveChatHistory(
  dataDir: string,
  storyId: string,
  messages: ChatHistoryMessage[],
  options: LegacyChatHistoryWriteOptions = {},
): Promise<boolean> {
  try {
    const history = await mutateChatHistoryDocument(dataDir, storyId, null, (doc) => {
      doc.messages = messages
    }, {
      rejectIfActive: true,
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
    })
    return history !== null
  } catch (error) {
    if (error instanceof ChatHistoryConflictError) return false
    throw error
  }
}

/**
 * Clear the visible transcript while retaining the run ledger. Keeping the
 * ledger preserves start-run dedupe (a client retrying a lost POST after a
 * clear still gets the same accepted run instead of a second side-effecting
 * execution).
 */
export async function clearChatHistory(
  dataDir: string,
  storyId: string,
): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  const path = join(dir, 'chat-history.json')
  await withKeyLock(`librarian-chat-history:${path}`, async () => {
    if (!existsSync(path)) return
    const history = await readChatHistoryFile(path)
    // The route's snapshot check is advisory; this lock is the authority. A
    // run accepted between the check and this call must win.
    if (history.activeRun) {
      throw new ChatHistoryConflictError('Cannot clear chat history while a run is active')
    }
    history.messages = []
    history.updatedAt = new Date().toISOString()
    history.revision = (history.revision ?? 0) + 1
    await writeJsonAtomic(path, history)
  })
}

export function toLibrarianChatSnapshot(history: ChatHistory, branchId: string): LibrarianChatSnapshot {
  const messages: LibrarianChatMessage[] = history.messages.map((message, index) => {
    const converted: LibrarianChatMessage = {
      id: message.id ?? `msg-legacy-${index}`,
      role: message.role,
      content: message.content,
      ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
      ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
      ...(message.status !== undefined ? { status: message.status } : {}),
      ...(message.error !== undefined ? { error: message.error } : {}),
    }
    return converted
  })

  return {
    branchId,
    revision: history.revision ?? 0,
    updatedAt: history.updatedAt,
    messages,
    activeRun: history.activeRun
      ? { runId: history.activeRun.runId, status: history.activeRun.status }
      : null,
  }
}

// --- Conversations ---

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface ConversationsIndex {
  conversations: ConversationMeta[]
}

async function conversationsIndexPath(dataDir: string, storyId: string): Promise<string> {
  const dir = await librarianDir(dataDir, storyId)
  return join(dir, 'conversations.json')
}

function conversationHistoryPath(dir: string, conversationId: string): string {
  assertSafeChatId(conversationId, 'conversation ID')
  return join(dir, `chat-${conversationId}.json`)
}

async function readConversationsIndex(dataDir: string, storyId: string): Promise<ConversationsIndex> {
  const path = await conversationsIndexPath(dataDir, storyId)
  if (!existsSync(path)) return { conversations: [] }
  const raw = await readFile(path, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<ConversationsIndex>
  return { conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [] }
}

async function writeConversationsIndex(dataDir: string, storyId: string, index: ConversationsIndex): Promise<void> {
  const dir = await librarianDir(dataDir, storyId)
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(await conversationsIndexPath(dataDir, storyId), index)
}

function conversationsLockKey(dataDir: string, storyId: string): Promise<string> {
  return conversationsIndexPath(dataDir, storyId).then(path => `librarian-conversations:${path}`)
}

async function conversationExistsUnlocked(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<boolean> {
  const index = await readConversationsIndex(dataDir, storyId)
  return index.conversations.some(c => c.id === conversationId)
}

/**
 * Serializes all read-modify-write updates to the conversation index. Multiple
 * named conversations may run concurrently, but index updates must never
 * clobber each other.
 */
async function withConversationsIndexLock<T>(
  dataDir: string,
  storyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyLock(await conversationsLockKey(dataDir, storyId), fn)
}

async function touchConversationMeta(
  dataDir: string,
  storyId: string,
  conversationId: string,
  updatedAt: string,
  firstUserContent?: string,
): Promise<void> {
  await withConversationsIndexLock(dataDir, storyId, async () => {
    const index = await readConversationsIndex(dataDir, storyId)
    const conv = index.conversations.find(c => c.id === conversationId)
    if (!conv) return
    conv.updatedAt = updatedAt
    // Preserve the legacy auto-title behavior: the first user message names a
    // still-default conversation.
    if (conv.title === 'New chat' && firstUserContent) {
      conv.title = firstUserContent.slice(0, 60).trim() || 'New chat'
    }
    await writeConversationsIndex(dataDir, storyId, index)
  })
}

/** Test/utility helper: whether the conversation currently exists in the index. */
export async function conversationExists(
  dataDir: string,
  storyId: string,
  conversationId: string,
): Promise<boolean> {
  if (!isSafeChatId(conversationId)) return false
  return conversationExistsUnlocked(dataDir, storyId, conversationId)
}

export async function listConversations(dataDir: string, storyId: string): Promise<ConversationMeta[]> {
  const index = await readConversationsIndex(dataDir, storyId)
  // Most recently updated first. Copy before sorting so a concurrent reader
  // never observes an in-place mutation of the stored array.
  return [...index.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createConversation(dataDir: string, storyId: string, title: string): Promise<ConversationMeta> {
  return withConversationsIndexLock(dataDir, storyId, async () => {
    const index = await readConversationsIndex(dataDir, storyId)
    const now = new Date().toISOString()
    const conversation: ConversationMeta = {
      id: generateConversationId(),
      title,
      createdAt: now,
      updatedAt: now,
    }
    index.conversations.push(conversation)
    await writeConversationsIndex(dataDir, storyId, index)
    return conversation
  })
}

export async function updateConversationTitle(
  dataDir: string,
  storyId: string,
  conversationId: string,
  title: string,
): Promise<ConversationMeta | null> {
  if (!isSafeChatId(conversationId)) return null
  return withConversationsIndexLock(dataDir, storyId, async () => {
    const index = await readConversationsIndex(dataDir, storyId)
    const conv = index.conversations.find(c => c.id === conversationId)
    if (!conv) return null
    conv.title = title
    conv.updatedAt = new Date().toISOString()
    await writeConversationsIndex(dataDir, storyId, index)
    return conv
  })
}

export async function deleteConversation(dataDir: string, storyId: string, conversationId: string): Promise<boolean> {
  if (!isSafeChatId(conversationId)) return false

  const dir = await librarianDir(dataDir, storyId)
  const historyFile = conversationHistoryPath(dir, conversationId)
  // Lock order is always history → index, matching mutateChatHistoryDocument.
  return withKeyLock(`librarian-chat-history:${historyFile}`, () =>
    withConversationsIndexLock(dataDir, storyId, async () => {
      // Re-check under the same lock the run acceptance uses. This closes the
      // check-then-delete race where a new run could be accepted in between.
      if (existsSync(historyFile)) {
        const history = await readChatHistoryFile(historyFile)
        if (history.activeRun) {
          throw new ChatHistoryConflictError('Cannot delete a conversation while a run is active')
        }
      }

      const index = await readConversationsIndex(dataDir, storyId)
      const idx = index.conversations.findIndex(c => c.id === conversationId)
      if (idx === -1) return false
      index.conversations.splice(idx, 1)
      await writeConversationsIndex(dataDir, storyId, index)
      if (existsSync(historyFile)) await unlink(historyFile)
      return true
    }),
  )
}

/**
 * Persist a legacy conversation transcript. Returns false when the
 * conversation no longer exists so a deleted conversation cannot be
 * resurrected by an in-flight legacy completion.
 */
export async function saveConversationHistory(
  dataDir: string,
  storyId: string,
  conversationId: string,
  messages: ChatHistoryMessage[],
  options: LegacyChatHistoryWriteOptions = {},
): Promise<boolean> {
  assertSafeChatId(conversationId, 'conversation ID')
  try {
    const history = await mutateChatHistoryDocument(dataDir, storyId, conversationId, (doc) => {
      doc.messages = messages
    }, {
      rejectIfActive: true,
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
    })
    return history !== null
  } catch (error) {
    if (error instanceof ChatHistoryConflictError) return false
    throw error
  }
}
