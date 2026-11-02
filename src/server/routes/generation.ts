import { Elysia, t } from 'elysia'
import { getStory } from '../fragments/storage'
import { invokeAgent } from '../agents/runner'
import { createLogger } from '../logging'
import {
  executePreparedGeneration,
  prepareGeneration,
  resolveGenerationRequest,
  GenerationRequestError,
  type GenerationRunBody,
} from '../generation/executor'
import { GenerationRunManager } from '../generation/run-manager'
import type { SuggestDirectionsResult } from '../directions/suggest'

const generationBodySchema = t.Object({
  input: t.String(),
  saveResult: t.Optional(t.Boolean()),
  mode: t.Optional(t.Union([t.Literal('generate'), t.Literal('regenerate'), t.Literal('refine')])),
  fragmentId: t.Optional(t.String()),
  clarifications: t.Optional(t.Array(t.Object({ question: t.String(), answer: t.String() }))),
  clarifyRound: t.Optional(t.Number()),
})

export function generationRoutes(dataDir: string) {
  const logger = createLogger('api:generation', { dataDir })
  const runManager = new GenerationRunManager(dataDir)

  return new Elysia({ detail: { tags: ['Generation'] } })
    .post('/stories/:storyId/suggest-directions', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Suggest directions request')

      const story = await getStory(dataDir, params.storyId)
      if (!story) {
        set.status = 404
        return { error: 'Story not found' }
      }

      try {
        const { output } = await invokeAgent<SuggestDirectionsResult>({
          dataDir,
          storyId: params.storyId,
          agentName: 'directions.suggest',
          input: { count: body.count },
        })
        return { suggestions: output.suggestions }
      } catch (err) {
        requestLogger.error('Suggest directions failed', { error: err instanceof Error ? err.message : String(err) })
        set.status = 502
        return { error: err instanceof Error ? err.message : 'Failed to generate suggestions' }
      }
    }, {
      body: t.Object({
        count: t.Optional(t.Number()),
      }),
      detail: { summary: 'Get AI-generated story direction suggestions' },
    })
    // Legacy streaming endpoint. Request/response shape is unchanged: NDJSON
    // ChatEvent lines, and a client disconnect still aborts the generation.
    .post('/stories/:storyId/generate', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      requestLogger.info('Generation request started', { mode: body.mode ?? 'generate', saveResult: body.saveResult ?? false })

      let resolved
      try {
        resolved = await resolveGenerationRequest(dataDir, params.storyId, body as GenerationRunBody)
      } catch (err) {
        if (err instanceof GenerationRequestError) {
          requestLogger.warn('Generation request rejected', { error: err.message, status: err.status })
          set.status = err.status
          return { error: err.message }
        }
        throw err
      }

      const abortController = new AbortController()
      const encoder = new TextEncoder()

      // Prepare before returning the response so behavior/timing matches the
      // original endpoint (context is built before NDJSON streaming starts).
      const prepared = await prepareGeneration({
        dataDir,
        storyId: params.storyId,
        body: body as GenerationRunBody,
        resolved,
        logger: requestLogger,
      })

      const eventStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const outcome = await executePreparedGeneration(prepared, {
            emit: (event) => {
              try {
                controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
              } catch {
                // Client already disconnected; the abort signal will stop the stream.
              }
            },
            signal: abortController.signal,
            onStreamError: (err) => {
              try {
                controller.error(err)
              } catch {
                // Stream may already be closed.
              }
            },
          })

          if (!outcome.streamFailed) {
            try {
              controller.close()
            } catch {
              // Stream may already be closed.
            }
          }
        },
        cancel() {
          abortController.abort()
        },
      })

      requestLogger.info('Streaming NDJSON response', { saveResult: body.saveResult ?? false })
      return new Response(eventStream, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }, {
      body: generationBodySchema,
      detail: { summary: 'Generate prose via streaming NDJSON' },
    })
    // Start (or idempotently reuse) a background generation run.
    .post('/stories/:storyId/generation-runs', async ({ params, body, set }) => {
      const requestLogger = logger.child({ storyId: params.storyId })
      const startBody = body as GenerationRunBody & { runId?: string }

      // Idempotent replay: same story + runId returns the existing run without
      // touching the LLM, even before we validate the (duplicate) request.
      if (startBody.runId) {
        const existing = runManager.getSnapshot(params.storyId, startBody.runId)
        if (existing) {
          requestLogger.info('Generation run already exists; returning it', { runId: existing.runId })
          return { runId: existing.runId }
        }
      }

      let resolved
      try {
        resolved = await resolveGenerationRequest(dataDir, params.storyId, startBody)
      } catch (err) {
        if (err instanceof GenerationRequestError) {
          requestLogger.warn('Generation run rejected', { error: err.message, status: err.status })
          set.status = err.status
          return { error: err.message }
        }
        throw err
      }

      const started = runManager.startRun(params.storyId, startBody, {
        runId: startBody.runId,
        resolved,
      })
      requestLogger.info('Generation run started', { runId: started.runId, existing: started.existing })
      return { runId: started.runId }
    }, {
      body: t.Composite([generationBodySchema, t.Object({ runId: t.Optional(t.String()) })]),
      detail: { summary: 'Start a background generation run' },
    })
    .get('/stories/:storyId/generation-runs/:runId/events', async ({ params, query, set }) => {
      const after = Number.parseInt(query?.after ?? '0', 10)
      const stream = runManager.createEventStream(
        params.storyId,
        params.runId,
        Number.isFinite(after) ? after : 0,
      )

      if (!stream) {
        set.status = 404
        return { error: 'Generation run not found' }
      }

      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      })
    }, {
      query: t.Optional(t.Object({ after: t.Optional(t.String()) })),
      detail: { summary: 'Replay and follow a generation run event stream' },
    })
    .get('/stories/:storyId/generation-runs/:runId', async ({ params, set }) => {
      const snapshot = runManager.getSnapshot(params.storyId, params.runId)
      if (!snapshot) {
        set.status = 404
        return { error: 'Generation run not found' }
      }
      return snapshot
    }, {
      detail: { summary: 'Get generation run status' },
    })
    .post('/stories/:storyId/generation-runs/:runId/cancel', async ({ params, set }) => {
      const result = runManager.cancel(params.storyId, params.runId)
      if (!result) {
        set.status = 404
        return { error: 'Generation run not found' }
      }
      return result
    }, {
      detail: { summary: 'Explicitly cancel a generation run' },
    })
}
