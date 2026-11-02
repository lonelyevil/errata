import { Elysia, t } from 'elysia'
import { getStory, getFragment, updateFragment, updateStory } from '../fragments/storage'
import { getBranchesIndex, withBranch } from '../fragments/branches'
import {
  getGenerationLog,
  listGenerationLogs,
} from '../llm/generation-logs'
import { getLibrarianRuntimeStatus, triggerLibrarian } from '../librarian/scheduler'
import { createSSEStream } from '../librarian/analysis-stream'
import { createAgentInstance, listAgentRuns } from '../agents'
import {
  getState as getLibrarianState,
  listAnalyses as listLibrarianAnalyses,
  getAnalysis as getLibrarianAnalysis,
  saveAnalysis as saveLibrarianAnalysis,
  getChatHistory as getLibrarianChatHistory,
  saveChatHistory as saveLibrarianChatHistory,
  clearChatHistory as clearLibrarianChatHistory,
  listConversations,
  createConversation,
  deleteConversation,
  getConversationHistory,
  saveConversationHistory,
  conversationExists,
  isSafeChatId,
  getLatestAnalysisIdsByFragment,
  ChatHistoryConflictError,
} from '../librarian/storage'
import {
  cancelLibrarianChatRun,
  getLibrarianChatSnapshot,
  startLibrarianChatRun,
  LibrarianChatRequestError,
} from '../librarian/chat-state'
import { applyFragmentSuggestion } from '../librarian/suggestions'
import { createLogger } from '../logging'
import { encodeStream } from './encode-stream'
import type { LibrarianChatStartInput } from '@/lib/librarian-chat'

export function librarianRoutes(dataDir: string) {
  const logger = createLogger('api:librarian', { dataDir })

  function requestedBranchId(query: unknown): string | undefined {
    const raw = (query as { branchId?: unknown } | undefined)?.branchId
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }

  /**
   * Resolve and validate a branch scope. Branch IDs are checked against the
   * story's index, which also prevents path traversal through `?branchId=`.
   * With no query parameter the active branch is used (old clients unaffected).
   */
  async function resolveBranchId(storyId: string, requested?: string): Promise<string | null> {
    const story = await getStory(dataDir, storyId)
    if (!story) return null
    const index = await getBranchesIndex(dataDir, storyId)
    if (requested !== undefined) {
      if (!isSafeChatId(requested)) return null
      return index.branches.some(b => b.id === requested) ? requested : null
    }
    if (!isSafeChatId(index.activeBranchId)) return null
    return index.activeBranchId
  }

  function chatErrorResponse(set: { status?: number | string }, error: unknown): { error: string } | never {
    if (error instanceof LibrarianChatRequestError) {
      set.status = error.status
      return { error: error.message }
    }
    throw error
  }

  return new Elysia({ detail: { tags: ['Librarian'] } })
    // --- Generation Logs ---
    .get('/stories/:storyId/generation-logs', async ({ params }) => {
      return listGenerationLogs(dataDir, params.storyId)
    }, { detail: { summary: 'List generation logs' } })

    .get('/stories/:storyId/generation-logs/:logId', async ({ params, set }) => {
      const log = await getGenerationLog(dataDir, params.storyId, params.logId)
      if (!log) {
        set.status = 404
        return { error: 'Generation log not found' }
      }
      return log
    }, { detail: { summary: 'Get a generation log by ID' } })

    // --- Librarian ---
    .get('/stories/:storyId/librarian/status', async ({ params }) => {
      const state = await getLibrarianState(dataDir, params.storyId)
      const runtime = getLibrarianRuntimeStatus(params.storyId)
      return {
        ...state,
        ...runtime,
      }
    }, { detail: { summary: 'Get librarian status' } })

    .get('/stories/:storyId/librarian/analysis-index', async ({ params }) => {
      const index = await getLatestAnalysisIdsByFragment(dataDir, params.storyId)
      return Object.fromEntries(index)
    }, { detail: { summary: 'Get fragment → analysis ID mapping' } })

    .post('/stories/:storyId/librarian/analyze', async ({ params, body, set }) => {
      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }
      const { fragmentId } = body as { fragmentId: string }
      if (!fragmentId) {
        set.status = 422
        return { error: 'fragmentId is required' }
      }
      const fragment = await getFragment(dataDir, params.storyId, fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }
      triggerLibrarian(dataDir, params.storyId, fragment).catch((err) => {
        logger.error('Manual librarian trigger failed', { error: err instanceof Error ? err.message : String(err) })
      })
      return { ok: true, fragmentId }
    }, { detail: { summary: 'Trigger librarian analysis on a specific fragment' } })

    .get('/stories/:storyId/librarian/analysis-stream', async ({ params, set }) => {
      const stream = createSSEStream(params.storyId)
      if (!stream) {
        set.status = 404
        return { error: 'No active analysis' }
      }
      return new Response(encodeStream(stream), {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      })
    }, { detail: { summary: 'Stream live analysis events (NDJSON)' } })

    .get('/stories/:storyId/librarian/analyses', async ({ params }) => {
      return listLibrarianAnalyses(dataDir, params.storyId)
    }, { detail: { summary: 'List all analyses' } })

    .get('/stories/:storyId/librarian/agent-runs', async ({ params }) => {
      return listAgentRuns(params.storyId)
    }, { detail: { summary: 'List agent runs' } })

    .get('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return analysis
    }, { detail: { summary: 'Get an analysis by ID' } })

    /**
     * @deprecated DEPRECATED (summary-fragments migration). Edits the
     * analysis's `summaryUpdate` field (the librarian's stated intent)
     * and performs a legacy string-replace into `story.summary`. Both
     * the intent write and the string-replace are no longer read by
     * downstream code — the artifact is the linked summary fragment
     * (`analysis.summaryFragmentId`). The correct edit surface is the
     * Summaries section in LibrarianPanel, which updates the fragment
     * directly via PUT /fragments/:id. Kept for backward compatibility
     * until the legacy inline edit UI is migrated or removed.
     */
    .patch('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, body, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const previousSummary = analysis.summaryUpdate
      const nextSummary = body.summaryUpdate.trim()
      analysis.summaryUpdate = nextSummary
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)

      const latestByFragment = await getLatestAnalysisIdsByFragment(dataDir, params.storyId)
      if (latestByFragment.get(analysis.fragmentId) === analysis.id) {
        const fragment = await getFragment(dataDir, params.storyId, analysis.fragmentId)
        if (fragment) {
          const meta = { ...fragment.meta }
          const existing = (meta._librarian ?? {}) as Record<string, unknown>
          meta._librarian = { ...existing, summary: nextSummary, analysisId: analysis.id }
          await updateFragment(dataDir, params.storyId, {
            ...fragment,
            meta,
          })
        }
      }

      // Legacy no-op: story.summary is no longer read by production code.
      // The replace runs only if story.summary still holds migration-stale content.
      if (previousSummary !== nextSummary && previousSummary && story.summary.includes(previousSummary)) {
        await updateStory(dataDir, {
          ...story,
          summary: story.summary.replace(previousSummary, nextSummary),
          updatedAt: new Date().toISOString(),
        })
      }

      return analysis
    }, {
      body: t.Object({
        summaryUpdate: t.String(),
      }),
      detail: { summary: 'Update an analysis summary (deprecated — edit the linked summary fragment instead)' },
    })

    .post('/stories/:storyId/librarian/analyses/:analysisId/suggestions/:index/accept', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentSuggestions.length) {
        set.status = 422
        return { error: 'Invalid suggestion index' }
      }

      const result = await applyFragmentSuggestion({
        dataDir,
        storyId: params.storyId,
        analysis,
        suggestionIndex: index,
        reason: 'manual-accept',
      })

      analysis.fragmentSuggestions[index].accepted = true
      analysis.fragmentSuggestions[index].autoApplied = false
      analysis.fragmentSuggestions[index].createdFragmentId = result.fragmentId
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return {
        analysis,
        createdFragmentId: result.fragmentId,
      }
    }, { detail: { summary: 'Accept a fragment suggestion' } })

    .post('/stories/:storyId/librarian/analyses/:analysisId/suggestions/:index/dismiss', async ({ params, set }) => {
      const analysis = await getLibrarianAnalysis(dataDir, params.storyId, params.analysisId)
      if (!analysis) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      const index = parseInt(params.index, 10)
      if (isNaN(index) || index < 0 || index >= analysis.fragmentSuggestions.length) {
        set.status = 422
        return { error: 'Invalid suggestion index' }
      }

      analysis.fragmentSuggestions[index].dismissed = true
      await saveLibrarianAnalysis(dataDir, params.storyId, analysis)
      return { analysis }
    }, { detail: { summary: 'Dismiss a fragment suggestion' } })

    .delete('/stories/:storyId/librarian/analyses/:analysisId', async ({ params, set }) => {
      const { deleteAnalysis } = await import('../librarian/storage')
      const deleted = await deleteAnalysis(dataDir, params.storyId, params.analysisId)
      if (!deleted) {
        set.status = 404
        return { error: 'Analysis not found' }
      }
      return { ok: true }
    }, { detail: { summary: 'Delete an analysis' } })

    // --- Librarian Refine ---
    .post('/stories/:storyId/librarian/refine', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Refinement request started', { fragmentId: body.fragmentId })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type === 'prose') {
        set.status = 422
        return { error: 'Cannot refine prose fragments. Use the generation refine mode instead.' }
      }

      let agent: ReturnType<typeof createAgentInstance> | undefined
      try {
        agent = createAgentInstance('librarian.refine', { dataDir, storyId: params.storyId })
        const { eventStream, completion } = await agent.execute({
          fragmentId: body.fragmentId,
          instructions: body.instructions,
          maxSteps: story.settings.maxSteps ?? 5,
        })

        completion.then((result) => {
          requestLogger.info('Refinement completed', {
            fragmentId: body.fragmentId,
            stepCount: result.stepCount,
            finishReason: result.finishReason,
            toolCallCount: result.toolCalls.length,
          })
        }).catch((err) => {
          requestLogger.error('Refinement completion error', { error: err instanceof Error ? err.message : String(err) })
        })

        return new Response(encodeStream(eventStream), {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        })
      } catch (err) {
        // Runner threw before producing a stream — record the failure and free
        // the active-agent registration instead of leaking it.
        agent?.fail(err)
        requestLogger.error('Refinement failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Refinement failed' }
      }
    }, {
      body: t.Object({
        fragmentId: t.String(),
        instructions: t.Optional(t.String()),
      }),
      detail: { summary: 'Refine a non-prose fragment (streaming NDJSON)' },
    })

    // --- Librarian Prose Transform ---
    .post('/stories/:storyId/librarian/prose-transform', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Prose transform request started', {
        fragmentId: body.fragmentId,
        operation: body.operation,
      })

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const fragment = await getFragment(dataDir, params.storyId, body.fragmentId)
      if (!fragment) {
        set.status = 404
        return { error: 'Fragment not found' }
      }

      if (fragment.type !== 'prose') {
        set.status = 422
        return { error: 'Only prose fragments support selection transforms.' }
      }

      let agent: ReturnType<typeof createAgentInstance> | undefined
      try {
        agent = createAgentInstance('librarian.prose-transform', { dataDir, storyId: params.storyId })
        const { eventStream, completion } = await agent.execute({
          fragmentId: body.fragmentId,
          selectedText: body.selectedText,
          operation: body.operation,
          instruction: body.instruction,
          sourceContent: body.sourceContent,
          contextBefore: body.contextBefore,
          contextAfter: body.contextAfter,
        })

        completion.then((result) => {
          requestLogger.info('Prose transform completed', {
            fragmentId: body.fragmentId,
            operation: body.operation,
            stepCount: result.stepCount,
            finishReason: result.finishReason,
            outputLength: result.text.trim().length,
            reasoningLength: result.reasoning.trim().length,
          })
        }).catch((err) => {
          requestLogger.error('Prose transform completion error', {
            error: err instanceof Error ? err.message : String(err),
          })
        })

        return new Response(encodeStream(eventStream), {
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        })
      } catch (err) {
        agent?.fail(err)
        requestLogger.error('Prose transform failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 500
        return { error: err instanceof Error ? err.message : 'Prose transform failed' }
      }
    }, {
      body: t.Object({
        fragmentId: t.String(),
        selectedText: t.String({ minLength: 1 }),
        operation: t.Union([t.Literal('rewrite'), t.Literal('expand'), t.Literal('compress'), t.Literal('custom')]),
        instruction: t.Optional(t.String()),
        sourceContent: t.Optional(t.String()),
        contextBefore: t.Optional(t.String()),
        contextAfter: t.Optional(t.String()),
      }),
      detail: { summary: 'Transform a prose selection (streaming NDJSON)' },
    })

    // --- Server-owned Librarian Chat Runs ---
    .get('/stories/:storyId/librarian/chat-state', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      try {
        return await getLibrarianChatSnapshot(dataDir, params.storyId, branchId, null)
      } catch (err) {
        return chatErrorResponse(set, err)
      }
    }, { detail: { summary: 'Get the full librarian chat snapshot for the default chat' } })

    .get('/stories/:storyId/librarian/conversations/:conversationId/chat-state', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        try {
          return await getLibrarianChatSnapshot(
            dataDir,
            params.storyId,
            branchId,
            params.conversationId,
          )
        } catch (err) {
          return chatErrorResponse(set, err)
        }
      }, branchId)
    }, { detail: { summary: 'Get the full librarian chat snapshot for a conversation' } })

    .post('/stories/:storyId/librarian/chat-runs', async ({ params, body, query, set }) => {
      const input = body as LibrarianChatStartInput
      const branchId = await resolveBranchId(params.storyId, input.branchId)
      if (!branchId || branchId !== input.branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      const queriedBranch = requestedBranchId(query)
      if (queriedBranch && queriedBranch !== branchId) {
        set.status = 422
        return { error: 'branchId query does not match request branchId' }
      }
      try {
        const result = await startLibrarianChatRun(dataDir, params.storyId, null, input)
        return result.snapshot
      } catch (err) {
        return chatErrorResponse(set, err)
      }
    }, {
      body: t.Object({
        runId: t.String({ minLength: 1, maxLength: 128 }),
        prompt: t.String({ minLength: 1, maxLength: 100_000 }),
        branchId: t.String({ minLength: 1, maxLength: 128 }),
        expectedRevision: t.Integer({ minimum: 0 }),
        maxSteps: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      }),
      detail: { summary: 'Submit a librarian chat run for the default chat' },
    })

    .post('/stories/:storyId/librarian/conversations/:conversationId/chat-runs', async ({ params, body, query, set }) => {
      const input = body as LibrarianChatStartInput
      const branchId = await resolveBranchId(params.storyId, input.branchId)
      if (!branchId || branchId !== input.branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      const queriedBranch = requestedBranchId(query)
      if (queriedBranch && queriedBranch !== branchId) {
        set.status = 422
        return { error: 'branchId query does not match request branchId' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        try {
          const result = await startLibrarianChatRun(
            dataDir,
            params.storyId,
            params.conversationId,
            input,
          )
          return result.snapshot
        } catch (err) {
          return chatErrorResponse(set, err)
        }
      }, branchId)
    }, {
      body: t.Object({
        runId: t.String({ minLength: 1, maxLength: 128 }),
        prompt: t.String({ minLength: 1, maxLength: 100_000 }),
        branchId: t.String({ minLength: 1, maxLength: 128 }),
        expectedRevision: t.Integer({ minimum: 0 }),
        maxSteps: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
      }),
      detail: { summary: 'Submit a librarian chat run for a conversation' },
    })

    .post('/stories/:storyId/librarian/chat-runs/:runId/cancel', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      try {
        return await cancelLibrarianChatRun(
          dataDir,
          params.storyId,
          branchId,
          null,
          params.runId,
        )
      } catch (err) {
        return chatErrorResponse(set, err)
      }
    }, { detail: { summary: 'Cancel a librarian chat run for the default chat' } })

    .post('/stories/:storyId/librarian/conversations/:conversationId/chat-runs/:runId/cancel', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        try {
          return await cancelLibrarianChatRun(
            dataDir,
            params.storyId,
            branchId,
            params.conversationId,
            params.runId,
          )
        } catch (err) {
          return chatErrorResponse(set, err)
        }
      }, branchId)
    }, { detail: { summary: 'Cancel a librarian chat run for a conversation' } })

    // --- Librarian Chat (legacy streaming endpoints) ---
    .get('/stories/:storyId/librarian/chat', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, () => getLibrarianChatHistory(dataDir, params.storyId), branchId)
    }, { detail: { summary: 'Get chat history' } })

    .delete('/stories/:storyId/librarian/chat', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        const snapshot = await getLibrarianChatSnapshot(dataDir, params.storyId, branchId, null)
        if (snapshot.activeRun) {
          set.status = 409
          return { error: 'Cannot clear chat history while a run is active' }
        }
        try {
          // Storage re-checks activeRun under the same lock run acceptance
          // uses, closing the snapshot-check/clear race.
          await clearLibrarianChatHistory(dataDir, params.storyId)
        } catch (err) {
          if (err instanceof ChatHistoryConflictError) {
            set.status = 409
            return { error: err.message }
          }
          throw err
        }
        return { ok: true }
      }, branchId)
    }, { detail: { summary: 'Clear chat history' } })

    .post('/stories/:storyId/librarian/chat', async ({ params, body, query, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Librarian chat request', { messageCount: body.messages.length })

      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story not found' }
      }

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      if (!body.messages.length) {
        set.status = 422
        return { error: 'At least one message is required' }
      }

      return withBranch(dataDir, params.storyId, async () => {
        const snapshot = await getLibrarianChatSnapshot(dataDir, params.storyId, branchId, null)
        if (snapshot.activeRun) {
          set.status = 409
          return { error: 'Cannot use the legacy streaming chat while a run is active' }
        }
        // A late legacy completion may only write if no newer turn committed.
        const legacyExpectedRevision = snapshot.revision

        let agent: ReturnType<typeof createAgentInstance> | undefined
        try {
          agent = createAgentInstance('librarian.chat', { dataDir, storyId: params.storyId })
          const { eventStream, completion } = await agent.execute({
            messages: body.messages,
            maxSteps: story.settings.maxSteps ?? 10,
          })

          // Persist chat history after completion (in background)
          completion.then(async (result) => {
            requestLogger.info('Librarian chat completed', {
              stepCount: result.stepCount,
              finishReason: result.finishReason,
              toolCallCount: result.toolCalls.length,
            })
            const fullHistory = [
              ...body.messages,
              {
                role: 'assistant' as const,
                content: result.text,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
              },
            ]
            const saved = await withBranch(
              dataDir,
              params.storyId,
              () => saveLibrarianChatHistory(dataDir, params.storyId, fullHistory, {
                expectedRevision: legacyExpectedRevision,
              }),
              branchId,
            )
            if (!saved) {
              requestLogger.warn('Discarded stale legacy librarian chat completion')
            }
          }).catch((err) => {
            requestLogger.error('Librarian chat completion error', { error: err instanceof Error ? err.message : String(err) })
          })

          return new Response(encodeStream(eventStream), {
            headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
          })
        } catch (err) {
          agent?.fail(err)
          requestLogger.error('Librarian chat failed', { error: err instanceof Error ? err.message : String(err) })
          set.status = 500
          return { error: err instanceof Error ? err.message : 'Chat failed' }
        }
      }, branchId)
    }, {
      body: t.Object({
        messages: t.Array(t.Object({
          role: t.Union([t.Literal('user'), t.Literal('assistant')]),
          content: t.String(),
        })),
      }),
      detail: { summary: 'Chat with the librarian (streaming NDJSON)' },
    })

    // --- Conversations ---
    .get('/stories/:storyId/librarian/conversations', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, () => listConversations(dataDir, params.storyId), branchId)
    }, { detail: { summary: 'List chat conversations' } })

    .post('/stories/:storyId/librarian/conversations', async ({ params, body, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(
        dataDir,
        params.storyId,
        () => createConversation(dataDir, params.storyId, body.title ?? 'New chat'),
        branchId,
      )
    }, {
      body: t.Object({ title: t.Optional(t.String()) }),
      detail: { summary: 'Create a chat conversation' },
    })

    .delete('/stories/:storyId/librarian/conversations/:conversationId', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        const snapshot = await getLibrarianChatSnapshot(
          dataDir,
          params.storyId,
          branchId,
          params.conversationId,
        )
        if (snapshot.activeRun) {
          set.status = 409
          return { error: 'Cannot delete a conversation while a run is active' }
        }
        try {
          // Storage re-checks activeRun under the acceptance lock so a run
          // accepted after the snapshot above cannot be deleted mid-flight.
          const ok = await deleteConversation(dataDir, params.storyId, params.conversationId)
          if (!ok) { set.status = 404; return { error: 'Conversation not found' } }
          return { ok: true }
        } catch (err) {
          if (err instanceof ChatHistoryConflictError) {
            set.status = 409
            return { error: err.message }
          }
          throw err
        }
      }, branchId)
    }, { detail: { summary: 'Delete a conversation' } })

    .get('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params, query, set }) => {
      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) {
        set.status = 404
        return { error: 'Story or branch not found' }
      }
      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        return getConversationHistory(dataDir, params.storyId, params.conversationId)
      }, branchId)
    }, { detail: { summary: 'Get conversation chat history' } })

    .post('/stories/:storyId/librarian/conversations/:conversationId/chat', async ({ params, body, query, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId, extra: { conversationId: params.conversationId } })
      requestLogger.info('Conversation chat request', { messageCount: body.messages.length })

      const branchId = await resolveBranchId(params.storyId, requestedBranchId(query))
      if (!branchId) { set.status = 404; return { error: 'Story not found' } }

      const story = await getStory(dataDir, params.storyId)
      if (!story) { set.status = 404; return { error: 'Story not found' } }
      if (!body.messages.length) { set.status = 422; return { error: 'At least one message is required' } }

      return withBranch(dataDir, params.storyId, async () => {
        if (!(await conversationExists(dataDir, params.storyId, params.conversationId))) {
          set.status = 404
          return { error: 'Conversation not found' }
        }
        const snapshot = await getLibrarianChatSnapshot(
          dataDir,
          params.storyId,
          branchId,
          params.conversationId,
        )
        if (snapshot.activeRun) {
          set.status = 409
          return { error: 'Cannot use the legacy streaming chat while a run is active' }
        }
        const legacyExpectedRevision = snapshot.revision

        let agent: ReturnType<typeof createAgentInstance> | undefined
        try {
          agent = createAgentInstance('librarian.chat', { dataDir, storyId: params.storyId })
          const { eventStream, completion } = await agent.execute({
            messages: body.messages,
            maxSteps: story.settings.maxSteps ?? 10,
          })

          completion.then(async (result) => {
            requestLogger.info('Conversation chat completed', {
              stepCount: result.stepCount,
              finishReason: result.finishReason,
              toolCallCount: result.toolCalls.length,
            })
            const fullHistory = [
              ...body.messages,
              {
                role: 'assistant' as const,
                content: result.text,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
              },
            ]
            const saved = await withBranch(
              dataDir,
              params.storyId,
              () => saveConversationHistory(dataDir, params.storyId, params.conversationId, fullHistory, {
                expectedRevision: legacyExpectedRevision,
              }),
              branchId,
            )
            if (!saved) {
              requestLogger.warn('Discarded stale legacy conversation completion')
            }
          }).catch((err) => {
            requestLogger.error('Conversation chat completion error', { error: err instanceof Error ? err.message : String(err) })
          })

          return new Response(encodeStream(eventStream), {
            headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
          })
        } catch (err) {
          agent?.fail(err)
          requestLogger.error('Conversation chat failed', { error: err instanceof Error ? err.message : String(err) })
          set.status = 500
          return { error: err instanceof Error ? err.message : 'Chat failed' }
        }
      }, branchId)
    }, {
      body: t.Object({
        messages: t.Array(t.Object({
          role: t.Union([t.Literal('user'), t.Literal('assistant')]),
          content: t.String(),
        })),
      }),
      detail: { summary: 'Chat in a conversation (streaming NDJSON)' },
    })
}
