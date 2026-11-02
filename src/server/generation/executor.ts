// Shared generation execution used by both the legacy streaming endpoint and
// the background "generation run" endpoint. The latter buffers emitted NDJSON
// events and keeps running independently of HTTP subscribers.
//
// Preparation (context building, model/tool resolution) is split from the
// streaming phase so the legacy endpoint can keep assembling its context before
// it starts writing the NDJSON response, exactly as it did before.
import {
  getStory,
  createFragment,
  getFragment,
  deleteFragment,
} from '../fragments/storage'
import {
  addProseSection,
  addProseVariation,
  findSectionIndex,
} from '../fragments/prose-chain'
import { generateFragmentId } from '@/lib/fragment-ids'
import {
  buildContextState,
  createDefaultBlocks,
  compileBlocks,
  addCacheBreakpoints,
  expandMessagesFragmentTags,
} from '../llm/context-builder'
import { applyBlockConfig } from '../blocks/apply'
import { createScriptHelpers } from '../blocks/script-context'
import { createFragmentTools } from '../llm/tools'
import { getModel, buildProviderOptions } from '../llm/client'
import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai'
import { runPrewriter, createWriterBriefBlocks } from '../llm/prewriter'
import {
  saveGenerationLog,
  type GenerationLog,
  type ToolCallLog,
} from '../llm/generation-logs'
import { pluginRegistry } from '../plugins/registry'
import {
  runBeforeContext,
  runBeforeBlocks,
  runBeforeGeneration,
  runAfterGeneration,
  runAfterSave,
} from '../plugins/hooks'
import { collectPluginToolsWithOrigin } from '../plugins/tools'
import { triggerLibrarian } from '../librarian/scheduler'
import { getAgentBlockConfig } from '../agents/agent-block-storage'
import { registerActiveAgent, unregisterActiveAgent } from '../agents/active-registry'
import { reportUsage } from '../llm/token-tracker'
import { normalizeTokenUsage } from '../llm/usage-normalizer'
import type { Logger } from '../logging'
import type { AgentBlockConfig } from '../agents/agent-block-storage'
import type { ContextBuildState, ContextMessage } from '../llm/context-builder'
import type { Fragment, StoryMeta } from '../fragments/schema'
import type { ModelMessage } from 'ai'
import type { WritingPlugin } from '../plugins/types'

export type GenerationMode = 'generate' | 'regenerate' | 'refine'

export interface GenerationRunBody {
  input: string
  saveResult?: boolean
  mode?: GenerationMode
  fragmentId?: string
  clarifications?: Array<{ question: string; answer: string }>
  clarifyRound?: number
}

export interface ResolvedGenerationRequest {
  story: StoryMeta
  existingFragment: Fragment | null
  mode: GenerationMode
  effectiveInput: string
}

/** A request-level validation failure that maps directly to an HTTP status. */
export class GenerationRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GenerationRequestError'
    this.status = status
  }
}

/**
 * Validate a generation request and resolve the pieces both execution paths
 * need. Throws {@link GenerationRequestError} with an HTTP status on failure.
 */
export async function resolveGenerationRequest(
  dataDir: string,
  storyId: string,
  body: GenerationRunBody,
): Promise<ResolvedGenerationRequest> {
  const story = await getStory(dataDir, storyId)
  if (!story) {
    throw new GenerationRequestError(404, 'Story not found')
  }

  if (!body.input || body.input.trim() === '') {
    throw new GenerationRequestError(422, 'Input is required')
  }

  const mode: GenerationMode = body.mode ?? 'generate'

  let existingFragment: Fragment | null = null
  if (mode === 'regenerate' || mode === 'refine') {
    if (!body.fragmentId) {
      throw new GenerationRequestError(422, 'fragmentId is required for regenerate/refine modes')
    }
    existingFragment = await getFragment(dataDir, storyId, body.fragmentId)
    if (!existingFragment) {
      throw new GenerationRequestError(404, 'Fragment not found')
    }
  }

  let effectiveInput = body.input
  if (mode === 'refine' && existingFragment) {
    effectiveInput = `Here is an existing prose passage (fragment ${existingFragment.id}):\n---\n${existingFragment.content}\n---\nRefine this passage: ${body.input}\nOutput only the rewritten prose.`
  }

  return { story, existingFragment, mode, effectiveInput }
}

export type GenerationEvent = Record<string, unknown>

export interface PrepareGenerationOptions {
  dataDir: string
  storyId: string
  body: GenerationRunBody
  resolved: ResolvedGenerationRequest
  logger: Logger
}

export interface PreparedGeneration {
  dataDir: string
  storyId: string
  body: GenerationRunBody
  resolved: ResolvedGenerationRequest
  logger: Logger
  story: StoryMeta
  existingFragment: Fragment | null
  mode: GenerationMode
  effectiveInput: string
  disableLibrarianAutoAnalysis: boolean
  providerOptions: ReturnType<typeof buildProviderOptions>
  proseFragmentName: string
  startTime: number
  enabledPlugins: WritingPlugin[]
  ctxState: ContextBuildState
  agentConfig: AgentBlockConfig
  scriptContext: Record<string, unknown>
  messages: ContextMessage[]
  modelMessages: ModelMessage[]
  isPrewriterMode: boolean
  clarifyEnabled: boolean
  clarifications: Array<{ question: string; answer: string }>
  clarifyRound: number
  resolvedModelId: string
  temperature: number | undefined
  model: Awaited<ReturnType<typeof getModel>>['model']
  tools: Record<string, ToolSet[string]>
  toolLinesList: string[]
}

/**
 * Build context, resolve the model/tools and compile messages. Kept separate
 * from streaming so callers can await it before producing a response.
 */
export async function prepareGeneration(
  opts: PrepareGenerationOptions,
): Promise<PreparedGeneration> {
  const { dataDir, storyId, body, resolved, logger: requestLogger } = opts
  const { story, existingFragment, mode, effectiveInput } = resolved

  const librarianConfig = await getAgentBlockConfig(dataDir, storyId, 'librarian.analyze')
  const disableLibrarianAutoAnalysis = (story.settings.disableLibrarianAutoAnalysis ?? false) || (librarianConfig.disableAutoAnalysis ?? false)
  const disableThinking = story.settings.disableThinking ?? false
  const providerOptions = buildProviderOptions(disableThinking)
  const modeLabel = mode === 'regenerate'
    ? 'Regenerate'
    : mode === 'refine'
      ? 'Refine'
      : 'Continuation'
  const proseFragmentName = `[${modeLabel}] ${body.input.trim()}`.slice(0, 100)

  const startTime = Date.now()

  // Get enabled plugins
  const enabledPlugins = pluginRegistry.getEnabled(
    story.settings.enabledPlugins,
  )
  requestLogger.info('Plugins enabled', { pluginCount: enabledPlugins.length, plugins: enabledPlugins.map(p => p.manifest.name) })

  // Build context with plugin hooks
  // When regenerating/refining, exclude the fragment being replaced from context
  requestLogger.info('Building context...')
  const buildContextOpts = (mode === 'regenerate' || mode === 'refine') && existingFragment
    ? {
        excludeFragmentId: existingFragment.id,
        proseBeforeFragmentId: existingFragment.id,
        summaryBeforeFragmentId: existingFragment.id,
      }
    : {}
  let ctxState = await buildContextState(dataDir, storyId, effectiveInput, buildContextOpts)
  const contextFragments = {
    proseCount: ctxState.proseFragments.length,
    stickyGuidelines: ctxState.stickyGuidelines.length,
    stickyKnowledge: ctxState.stickyKnowledge.length,
    stickyCharacters: ctxState.stickyCharacters.length,
    guidelineShortlist: ctxState.guidelineShortlist.length,
    knowledgeShortlist: ctxState.knowledgeShortlist.length,
    characterShortlist: ctxState.characterShortlist.length,
  }
  requestLogger.info('Context state built', contextFragments)

  ctxState = await runBeforeContext(enabledPlugins, ctxState)
  requestLogger.info('BeforeContext hooks completed')

  // Resolve model early so modelId is available for instruction resolution
  const { model, modelId: resolvedModelId, temperature } = await getModel(dataDir, storyId, { role: 'generation.writer' })
  requestLogger.info('Resolved model', { resolvedModelId })
  ctxState.modelId = resolvedModelId

  // Merge fragment tools + plugin tools, then filter by agent block config
  const fragmentTools = createFragmentTools(dataDir, storyId, { readOnly: true })
  const { tools: pluginTools, origins: pluginToolOrigins } = collectPluginToolsWithOrigin(enabledPlugins, dataDir, storyId)
  // Core fragment tools take precedence: a plugin must not silently shadow
  // getFragment/listFragments/etc. Colliding plugin tools are dropped + logged.
  const allTools: ToolSet = { ...fragmentTools }
  for (const [name, t] of Object.entries(pluginTools)) {
    if (name in allTools) {
      requestLogger.warn('Plugin tool name collides with a core tool; ignoring the plugin tool', { tool: name, plugin: pluginToolOrigins[name] })
      continue
    }
    allTools[name] = t
  }
  // Extract plugin tool descriptions for context (fragment tools are listed from registry)
  const extraTools = Object.entries(pluginTools).map(([name, t]) => ({
    name,
    description: (t as { description?: string }).description ?? '',
    pluginName: pluginToolOrigins[name],
  }))

  const agentConfig = await getAgentBlockConfig(dataDir, storyId, 'generation.writer')
  const disabledTools = new Set(agentConfig.disabledTools ?? [])
  const tools: Record<string, (typeof allTools)[string]> = {}
  for (const [name, t] of Object.entries(allTools)) {
    if (!disabledTools.has(name)) tools[name] = t
  }
  requestLogger.info('Tools prepared', { toolCount: Object.keys(tools).length })

  const scriptContext = { ...ctxState, ...createScriptHelpers(dataDir, storyId) }
  let blocks = createDefaultBlocks(ctxState, extraTools.length > 0 ? { extraTools } : undefined)
  blocks = await applyBlockConfig(blocks, agentConfig, scriptContext)
  blocks = await runBeforeBlocks(enabledPlugins, blocks)

  // In prewriter mode, strip writer-only blocks from the context that gets
  // dumped into the prewriter's full-context block. The prewriter has its own
  // planning-request for author direction and its own custom blocks — writer
  // custom blocks and author-input would leak through and bypass the
  // prewriter's block config.
  const isPrewriterMode = story.settings.generationMode === 'prewriter'
  // Clarify-before-generate only applies in prewriter mode.
  const clarifyEnabled = isPrewriterMode && (story.settings.clarifyBeforeGenerate ?? false)
  const clarifications = body.clarifications ?? []
  const clarifyRound = body.clarifyRound ?? 0
  if (isPrewriterMode) {
    // Strip writer-only blocks from the context dumped into the prewriter's
    // full-context: the author direction (it has its own planning-request),
    // custom blocks, and the writer's operating instructions/tool guidance
    // ("write prose directly, don't use tools to save") — which would
    // otherwise confuse the planner, whose job is the opposite.
    const WRITER_ONLY_BLOCKS = new Set(['author-input', 'instructions', 'tools'])
    blocks = blocks.filter(b => !WRITER_ONLY_BLOCKS.has(b.id) && b.source !== 'custom')
  }

  let messages = compileBlocks(blocks)
  messages = await runBeforeGeneration(enabledPlugins, messages)
  // Expand inline `<@fragment-id>` references so they don't leak literally
  // into the prompt. The prewriter writer path expands its own context
  // separately (createWriterBriefBlocks + expandMessagesFragmentTags).
  messages = await expandMessagesFragmentTags(messages, dataDir, storyId)
  requestLogger.info('BeforeGeneration hooks completed', { messageCount: messages.length })

  const modelMessages = addCacheBreakpoints(messages)

  // Build tool description lines for reuse (same logic as context-builder createDefaultBlocks)
  const toolLinesList: string[] = []
  {
    const types = (await import('../fragments/registry')).registry.listTypes()
    for (const t of types) {
      if (t.llmTools === false) continue
      const cap = t.type.charAt(0).toUpperCase() + t.type.slice(1)
      const plural = ['prose', 'knowledge'].includes(t.type) ? cap : cap + 's'
      toolLinesList.push(`- get${cap}(id): Get full content of a ${t.type} fragment`)
      toolLinesList.push(`- list${plural}(): List all ${t.type} fragments`)
    }
    toolLinesList.push('- listFragmentTypes(): List all available fragment types')
    for (const t of extraTools) {
      toolLinesList.push(`- ${t.name}: ${t.description}`)
    }
  }

  return {
    dataDir,
    storyId,
    body,
    resolved,
    logger: requestLogger,
    story,
    existingFragment,
    mode,
    effectiveInput,
    disableLibrarianAutoAnalysis,
    providerOptions,
    proseFragmentName,
    startTime,
    enabledPlugins,
    ctxState,
    agentConfig,
    scriptContext,
    messages,
    modelMessages,
    isPrewriterMode,
    clarifyEnabled,
    clarifications,
    clarifyRound,
    resolvedModelId,
    temperature,
    model,
    tools,
    toolLinesList,
  }
}

export interface ExecuteGenerationPhaseOptions {
  emit: (event: GenerationEvent) => void
  signal: AbortSignal
  /** Invoked when the underlying provider stream fails for a non-abort reason. */
  onStreamError?: (error: unknown) => void
  /** Invoked just before the save phase begins. */
  onStatus?: (status: 'saving') => void
}

export interface GenerationOutcome {
  status: 'done' | 'error'
  error?: string
  /** True when the provider stream failed (and no fragment was saved). */
  streamFailed: boolean
  aborted: boolean
  finishReason: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Stream a prepared generation and run the existing save path. Events are
 * delivered through `emit`; terminal run events (`run-done`/`run-error`) are
 * the caller's responsibility so the legacy endpoint can keep returning only
 * its original ChatEvent lines.
 */
export async function executePreparedGeneration(
  prepared: PreparedGeneration,
  opts: ExecuteGenerationPhaseOptions,
): Promise<GenerationOutcome> {
  const {
    dataDir,
    storyId,
    body,
    existingFragment,
    mode,
    disableLibrarianAutoAnalysis,
    providerOptions,
    proseFragmentName,
    startTime,
    enabledPlugins,
    ctxState,
    agentConfig,
    scriptContext,
    messages,
    modelMessages,
    isPrewriterMode,
    clarifyEnabled,
    clarifications,
    clarifyRound,
    resolvedModelId,
    temperature,
    model,
    tools,
    toolLinesList,
  } = prepared
  const requestLogger = prepared.logger
  const { emit, signal } = opts

  requestLogger.info('Starting LLM stream...')

  // Prewriter phase: if enabled, run prewriter and replace messages with stripped context
  let prewriterBrief: string | undefined
  let prewriterReasoning: string | undefined
  let prewriterDurationMs: number | undefined
  let prewriterModel: string | undefined
  let prewriterUsage: { inputTokens: number; outputTokens: number } | undefined
  let prewriterLogMessages: Array<{ role: string; content: string }> | undefined
  let prewriterDirections: Array<{ pacing: string; title: string; description: string; instruction: string }> | undefined
  let logMessages = messages // messages saved to generation log — updated to writer context in prewriter mode

  let fullText = ''
  let fullReasoning = ''
  const toolCalls: ToolCallLog[] = []
  // Correlate tool-result entries back to their tool-call args.
  const toolCallArgsById = new Map<string, Record<string, unknown>>()
  let lastFinishReason = 'unknown'
  let stepCount = 0
  let wasAborted = false
  // Set when the stream throws for a reason other than client abort, so the
  // save path knows not to persist a fragment from a failed generation.
  let streamFailed = false
  let streamError: unknown
  let saveError: unknown
  let totalUsagePromise: PromiseLike<unknown> | undefined

  const genActivityId = registerActiveAgent(storyId, 'generation.writer')

  try {
    // Run prewriter inside the stream so events are streamed live
    let writerMessages = modelMessages
    let prewriterStepCount = 0
    if (isPrewriterMode) {
      emit({ type: 'phase', phase: 'prewriting' })

      const prewriterActivityId = registerActiveAgent(storyId, 'generation.prewriter')
      try {
        const configuredMax = prepared.story.settings.maxSteps ?? 10
        const prewriterReasoningLevel = prepared.story.settings.prewriterReasoning ?? 'normal'
        // Scale the prewriter's tool-step budget by reasoning length so
        // 'short' actually runs fewer round trips (the main speed win),
        // while 'extensive' may explore the full budget.
        const half = Math.max(1, Math.floor(configuredMax / 2))
        const prewriterMaxSteps = prewriterReasoningLevel === 'short'
          ? Math.min(2, half)
          : prewriterReasoningLevel === 'extensive'
            ? configuredMax
            : half
        const prewriterResult = await runPrewriter({
          dataDir,
          storyId,
          compiledMessages: messages,
          authorInput: prepared.effectiveInput,
          mode,
          tools,
          maxSteps: prewriterMaxSteps,
          abortSignal: signal,
          providerOptions,
          clarifyEnabled,
          clarifications,
          round: clarifyRound,
          reasoning: prewriterReasoningLevel,
          onEvent: (event) => {
            if (event.type === 'text') {
              emit({ type: 'prewriter-text', text: event.text })
            } else if (event.type === 'reset') {
              // The prewriter re-wrote the brief in a new step; tell the
              // client to discard the brief streamed so far.
              emit({ type: 'prewriter-reset' })
            } else if (event.type === 'questions') {
              // Canonical clarify-questions is emitted from the result below.
            } else {
              emit(event)
            }
          },
        })

        // The prewriter chose to ask the author questions instead of
        // finalizing a brief. Surface them and end the turn — no writer,
        // no save. The client answers and re-POSTs with clarifications.
        if (prewriterResult.questions && prewriterResult.questions.length > 0) {
          // Inner finally below unregisters the prewriter activity; outer
          // finally unregisters the generation activity. Returning here
          // skips the writer and the save block entirely.
          emit({ type: 'clarify-questions', questions: prewriterResult.questions, round: clarifyRound })
          emit({ type: 'finish', finishReason: 'clarify', stepCount: prewriterResult.stepCount, stopped: true })
          return {
            status: 'done',
            streamFailed: false,
            aborted: false,
            finishReason: 'clarify',
          }
        }
        prewriterBrief = prewriterResult.brief
        prewriterReasoning = prewriterResult.reasoning || undefined
        prewriterDurationMs = prewriterResult.durationMs
        prewriterModel = prewriterResult.model
        prewriterUsage = prewriterResult.usage
        prewriterLogMessages = prewriterResult.messages
        prewriterStepCount = prewriterResult.stepCount
        if (prewriterResult.directions.length > 0) {
          prewriterDirections = prewriterResult.directions
          emit({ type: 'prewriter-directions', directions: prewriterDirections })
        }
        requestLogger.info('Prewriter completed', { briefLength: prewriterBrief.length, durationMs: prewriterDurationMs, stepCount: prewriterStepCount, directionsCount: prewriterDirections?.length ?? 0 })

        // Build stripped writer context with only prose + brief + custom blocks,
        // then apply the writer's agent block config so overrides (e.g. disabled
        // blocks like writing-brief) are respected.
        //
        // If the prewriter produced no usable brief, the stripped context
        // would leave the writer with prose but NO characters/guidelines/
        // knowledge AND no brief — strictly worse than the full context.
        // Fall back to the full context (writerMessages already === modelMessages).
        if (prewriterResult.brief.trim()) {
          const writerBlocks = createWriterBriefBlocks(ctxState.proseFragments, prewriterResult.brief, toolLinesList, resolvedModelId)
          const finalWriterBlocks = await applyBlockConfig(writerBlocks, agentConfig, scriptContext)
          let writerCompiled = compileBlocks(finalWriterBlocks)
          writerCompiled = await expandMessagesFragmentTags(writerCompiled, dataDir, storyId)
          writerMessages = addCacheBreakpoints(writerCompiled)
          logMessages = writerCompiled
        } else {
          requestLogger.warn('Prewriter produced an empty brief; falling back to full context for the writer')
        }
      } finally {
        unregisterActiveAgent(prewriterActivityId)
      }

      emit({ type: 'phase', phase: 'writing' })
    }

    const configuredMaxSteps = prepared.story.settings.maxSteps ?? 10
    const writerMaxSteps = isPrewriterMode
      ? Math.max(1, configuredMaxSteps - prewriterStepCount)
      : configuredMaxSteps
    const writerAgent = new ToolLoopAgent({
      model,
      tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(writerMaxSteps),
      temperature,
      providerOptions: providerOptions as never,
    })
    const result = await writerAgent.stream({
      messages: writerMessages,
      abortSignal: signal,
    })
    totalUsagePromise = result.totalUsage
    const fullStream = result.fullStream

    for await (const part of fullStream) {
      let event: Record<string, unknown> | null = null
      const p = part as Record<string, unknown>

      switch (part.type) {
        case 'text-delta': {
          const text = (p.text ?? '') as string
          fullText += text
          event = { type: 'text', text }
          break
        }
        case 'reasoning-delta': {
          const text = (p.text ?? '') as string
          fullReasoning += text
          event = { type: 'reasoning', text }
          break
        }
        case 'tool-call': {
          const input = (p.input ?? {}) as Record<string, unknown>
          const toolCallId = p.toolCallId as string
          toolCallArgsById.set(toolCallId, input)
          event = {
            type: 'tool-call',
            id: toolCallId,
            toolName: p.toolName as string,
            args: input,
          }
          break
        }
        case 'tool-result': {
          const toolName = (p.toolName as string) ?? ''
          const toolCallId = p.toolCallId as string
          toolCalls.push({
            toolName,
            args: toolCallArgsById.get(toolCallId) ?? {},
            result: p.output,
          })
          event = {
            type: 'tool-result',
            id: toolCallId,
            toolName,
            result: p.output,
          }
          break
        }
        // `finish-step` fires per LLM step; `finish` fires once at the end.
        case 'finish-step':
          stepCount++
          break
        case 'finish':
          lastFinishReason = (p.finishReason as string) ?? 'unknown'
          break
      }

      if (event) {
        emit(event)
      }
    }

    // Emit a final finish event
    emit({
      type: 'finish',
      finishReason: lastFinishReason,
      stepCount,
    })

  } catch (err) {
    wasAborted = signal.aborted
    if (wasAborted) {
      requestLogger.info('Generation aborted by client', { textLength: fullText.length })
      lastFinishReason = 'stop'
      emit({
        type: 'finish',
        finishReason: 'stop',
        stepCount,
        stopped: true,
      })
    } else {
      // Non-abort failure (provider/network/parse error). Do NOT persist a
      // fragment from a failed run.
      streamFailed = true
      streamError = err
      requestLogger.error('Generation stream failed', { error: errorMessage(err), textLength: fullText.length })
      opts.onStreamError?.(err)
    }
  } finally {
    unregisterActiveAgent(genActivityId)
  }

  if (body.saveResult && !streamFailed && fullText.trim()) {
    try {
      opts.onStatus?.('saving')
      const durationMs = Date.now() - startTime
      requestLogger.info('LLM generation completed', { durationMs, textLength: fullText.length })

      requestLogger.info('Tool calls extracted', { toolCallCount: toolCalls.length })

      // Run afterGeneration hooks
      const genResult = await runAfterGeneration(enabledPlugins, {
        text: fullText,
        fragmentId: (mode === 'regenerate' || mode === 'refine') ? body.fragmentId! : null,
        toolCalls,
      })
      requestLogger.info('AfterGeneration hooks completed')

      const now = new Date().toISOString()
      let savedFragmentId: string

      if ((mode === 'regenerate' || mode === 'refine') && existingFragment) {
        // Create a NEW fragment as a variation (don't overwrite)
        const id = generateFragmentId('prose')
        const fragment: Fragment = {
          id,
          type: 'prose',
          name: proseFragmentName,
          description: body.input.slice(0, 250),
          content: genResult.text,
          tags: [...existingFragment.tags],
          refs: [...existingFragment.refs],
          sticky: existingFragment.sticky,
          placement: existingFragment.placement ?? 'user',
          createdAt: now,
          updatedAt: now,
          order: existingFragment.order,
          meta: {
            ...existingFragment.meta,
            generatedFrom: body.input,
            generationMode: mode,
            previousFragmentId: existingFragment.id,
            variationOf: existingFragment.id,
          },
          version: 1,
          versions: [],
        }
        await createFragment(dataDir, storyId, fragment)
        savedFragmentId = id
        requestLogger.info('Fragment variation created', { fragmentId: savedFragmentId, mode, originalId: existingFragment.id })

        // Add to prose chain as a variation. Roll back the fragment if
        // the chain write fails, so we don't leave an unreferenced orphan.
        try {
          const sectionIndex = await findSectionIndex(dataDir, storyId, existingFragment.id)
          if (sectionIndex !== -1) {
            await addProseVariation(dataDir, storyId, sectionIndex, id)
            requestLogger.info('Added as variation to prose chain', { sectionIndex })
          } else {
            // Original isn't in the chain (e.g. it was removed): append as
            // a new section so the regenerated prose isn't lost.
            requestLogger.warn('Original fragment not found in prose chain, creating new section')
            await addProseSection(dataDir, storyId, id)
          }
        } catch (chainErr) {
          await deleteFragment(dataDir, storyId, id).catch(() => {})
          throw chainErr
        }

        // Run afterSave hooks
        await runAfterSave(enabledPlugins, fragment, storyId)
        requestLogger.info('AfterSave hooks completed')

        if (!disableLibrarianAutoAnalysis) {
          triggerLibrarian(dataDir, storyId, fragment).catch((err) => {
            requestLogger.error('triggerLibrarian failed', { error: errorMessage(err) })
          })
          requestLogger.info('Librarian analysis triggered')
        } else {
          requestLogger.info('Librarian auto analysis disabled; skipping trigger')
        }
      } else {
        // Create new fragment (default generate mode)
        const id = generateFragmentId('prose')
        const fragment: Fragment = {
          id,
          type: 'prose',
          name: proseFragmentName,
          description: body.input.slice(0, 250),
          content: genResult.text,
          tags: [],
          refs: [],
          sticky: false,
          placement: 'user',
          createdAt: now,
          updatedAt: now,
          order: 0,
          meta: { generatedFrom: body.input },
          version: 1,
          versions: [],
        }
        await createFragment(dataDir, storyId, fragment)
        savedFragmentId = id
        requestLogger.info('New fragment created', { fragmentId: savedFragmentId })

        // Add to prose chain as a new section. Roll back the fragment if
        // the chain write fails, so we don't leave an unreferenced orphan.
        try {
          await addProseSection(dataDir, storyId, id)
        } catch (chainErr) {
          await deleteFragment(dataDir, storyId, id).catch(() => {})
          throw chainErr
        }
        requestLogger.info('Added as new section to prose chain')

        // Run afterSave hooks
        await runAfterSave(enabledPlugins, fragment, storyId)
        requestLogger.info('AfterSave hooks completed')

        if (!disableLibrarianAutoAnalysis) {
          triggerLibrarian(dataDir, storyId, fragment).catch((err) => {
            requestLogger.error('triggerLibrarian failed', { error: errorMessage(err) })
          })
          requestLogger.info('Librarian analysis triggered')
        } else {
          requestLogger.info('Librarian auto analysis disabled; skipping trigger')
        }
      }

      // Capture finish reason, step count, and token usage
      const finishReason = lastFinishReason
      const configuredMaxStepsForLog = prepared.story.settings.maxSteps ?? 10
      const stepsExceeded = stepCount >= configuredMaxStepsForLog && finishReason !== 'stop'
      let totalUsage: { inputTokens: number; outputTokens: number } | undefined
      try {
        const rawUsage = await totalUsagePromise
        totalUsage = normalizeTokenUsage(rawUsage)
        if (totalUsage) {
          reportUsage(dataDir, storyId, 'generation.writer', totalUsage, resolvedModelId)
        }
      } catch {
        // Some providers may not report usage
      }

      // Persist generation log
      const logId = `gen-${Date.now().toString(36)}`
      const log: GenerationLog = {
        id: logId,
        createdAt: now,
        input: body.input,
        messages: logMessages.map((m) => ({
          role: String(m.role),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        toolCalls,
        generatedText: genResult.text,
        fragmentId: savedFragmentId,
        model: resolvedModelId,
        durationMs,
        stepCount,
        finishReason: String(finishReason),
        stepsExceeded,
        ...(totalUsage ? { totalUsage } : {}),
        ...(fullReasoning ? { reasoning: fullReasoning } : {}),
        ...(prewriterBrief ? { prewriterBrief } : {}),
        ...(prewriterReasoning ? { prewriterReasoning } : {}),
        ...(prewriterLogMessages ? { prewriterMessages: prewriterLogMessages } : {}),
        ...(prewriterDurationMs ? { prewriterDurationMs } : {}),
        ...(prewriterModel ? { prewriterModel } : {}),
        ...(prewriterUsage ? { prewriterUsage } : {}),
        ...(prewriterDirections?.length ? { prewriterDirections } : {}),
      }
      await saveGenerationLog(dataDir, storyId, log)
      requestLogger.info('Generation log saved', { logId, stepCount, finishReason, stepsExceeded })
    } catch (err) {
      saveError = err
      requestLogger.error('Error saving generation result', { error: errorMessage(err) })
    }
  }

  if (streamFailed) {
    return {
      status: 'error',
      error: errorMessage(streamError),
      streamFailed: true,
      aborted: false,
      finishReason: lastFinishReason,
    }
  }

  if (saveError) {
    return {
      status: 'error',
      error: errorMessage(saveError),
      streamFailed: false,
      aborted: wasAborted,
      finishReason: lastFinishReason,
    }
  }

  return {
    status: 'done',
    streamFailed: false,
    aborted: wasAborted,
    finishReason: lastFinishReason,
  }
}

export interface ExecuteGenerationOptions extends PrepareGenerationOptions, ExecuteGenerationPhaseOptions {}

/**
 * Convenience wrapper: prepare + stream in one call. Used by the background run
 * manager; the legacy endpoint calls the two phases separately.
 */
export async function executeGeneration(
  opts: ExecuteGenerationOptions,
): Promise<GenerationOutcome> {
  const prepared = await prepareGeneration(opts)
  return executePreparedGeneration(prepared, opts)
}
