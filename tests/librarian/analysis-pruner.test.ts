import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDir, makeTestSettings } from '../setup'
import {
  createStory,
  createFragment,
  getFragment,
  listFragments,
} from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/server/fragments/schema'
import {
  clearMigrationCache,
  createBranch,
  getContentRootForBranch,
  switchActiveBranch,
} from '@/server/fragments/branches'
import {
  getAnalysis,
  getAnalysisIndex,
  getLatestAnalysisIdsByFragment,
  listAnalyses,
  saveAnalysis,
  type LibrarianAnalysis,
} from '@/server/librarian/storage'
import { clearPending, triggerLibrarian } from '@/server/librarian/scheduler'
import {
  createAnalysisPruner,
  InMemoryAnalysisPruneTokenStore,
  pruneAnalyses,
  type ExecuteResult,
  type PreviewResult,
  type RejectedResult,
} from '@/server/librarian/analysis-pruner'

const storyId = 'story-prune-test'

interface ToolResult {
  execute: (input: { dryRun?: boolean; pruneToken?: string }) => Promise<unknown>
}

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: storyId,
    name: 'Prune Test Story',
    description: 'Testing analysis pruning',
    coverImage: null,
    summary: '',
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeProse(id: string, name: string): Fragment {
  const now = new Date().toISOString()
  return {
    id,
    type: 'prose',
    name,
    description: '',
    content: `Prose for ${name}`,
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    archived: false,
  }
}

function makeSummary(id: string, analysisIds: string[], archived = false): Fragment {
  const now = new Date().toISOString()
  return {
    id,
    type: 'summary',
    name: `Summary ${id}`,
    description: 'Chapter summary',
    content: `Summary content ${id}`,
    tags: [],
    refs: [],
    sticky: false,
    placement: 'system',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: { analysisIds },
    archived,
  }
}

function makeAnalysis(
  id: string,
  fragmentId: string,
  createdAt: string,
  overrides: Partial<LibrarianAnalysis> = {},
): LibrarianAnalysis {
  return {
    id,
    createdAt,
    fragmentId,
    summaryUpdate: `Update ${id}`,
    mentionedCharacters: [],
    contradictions: [],
    fragmentSuggestions: [],
    timelineEvents: [],
    ...overrides,
  }
}

function at(minutes: number): string {
  return new Date(Date.UTC(2025, 0, 1, 0, minutes)).toISOString()
}

describe('librarian analysis pruner', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempDir()
    dataDir = tmp.path
    cleanup = tmp.cleanup
    clearMigrationCache()
    clearPending()
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    clearPending()
    await cleanup()
  })

  async function tool(): Promise<ToolResult> {
    return {
      execute: (input) => pruneAnalyses(dataDir, storyId, input),
    }
  }

  async function seedTwoProseWithThreeAnalyses() {
    await createFragment(dataDir, storyId, makeProse('pr-alpha', 'Alpha'))
    await createFragment(dataDir, storyId, makeProse('pr-beta', 'Beta'))

    for (const fragmentId of ['pr-alpha', 'pr-beta']) {
      for (let i = 1; i <= 3; i++) {
        await saveAnalysis(
          dataDir,
          storyId,
          makeAnalysis(`an-${fragmentId.slice(3)}-${i}`, fragmentId, at(i)),
        )
      }
    }
  }

  it('exposes the built-in two-phase pruner contract', async () => {
    await seedTwoProseWithThreeAnalyses()

    const preview = (await pruneAnalyses(dataDir, storyId)) as PreviewResult
    expect(preview.ok).toBe(true)
    expect(preview.dryRun).toBe(true)
    expect(preview.storyId).toBe(storyId)
    expect(preview.branchId).toBe('main')
    expect(typeof preview.pruneToken).toBe('string')
    expect(preview.candidateCount).toBe(4)
    expect(preview.candidates).toHaveLength(4)
    expect(preview.groups).toHaveLength(2)
    expect(preview.retainedCount).toBe(2)

    const missingToken = (await pruneAnalyses(dataDir, storyId, {
      dryRun: false,
    })) as RejectedResult
    expect(missingToken.ok).toBe(false)
    expect(missingToken.error).toBe('confirmation_required')

    const executed = (await pruneAnalyses(dataDir, storyId, {
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as ExecuteResult
    expect(executed.ok).toBe(true)
    expect(executed.dryRun).toBe(false)
    expect(executed.deletedCount).toBe(4)
  })

  it('previews only superseded analyses, keeps the newest per fragment, and writes nothing', async () => {
    await seedTwoProseWithThreeAnalyses()

    const indexBefore = await readFile(
      join(await getContentRootForBranch(dataDir, storyId, 'main'), 'librarian', 'index.json'),
      'utf8',
    )
    const analysisBefore = await readFile(
      join(
        await getContentRootForBranch(dataDir, storyId, 'main'),
        'librarian',
        'analyses',
        'an-alpha-1.json',
      ),
      'utf8',
    )

    const result = (await (await tool()).execute({})) as PreviewResult

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.branchId).toBe('main')
    expect(result.candidateCount).toBe(4)
    expect(result.retainedCount).toBe(2)
    expect(result.protectedCandidateCount).toBe(0)
    expect(result.candidates.map((c) => c.id)).toEqual([
      'an-alpha-1',
      'an-alpha-2',
      'an-beta-1',
      'an-beta-2',
    ])
    expect(result.groups).toEqual([
      {
        fragmentId: 'pr-alpha',
        fragmentName: 'Alpha',
        deleteCount: 2,
        retainAnalysisId: 'an-alpha-3',
      },
      {
        fragmentId: 'pr-beta',
        fragmentName: 'Beta',
        deleteCount: 2,
        retainAnalysisId: 'an-beta-3',
      },
    ])
    expect(result.pruneToken).toBeTruthy()

    const indexAfter = await readFile(
      join(await getContentRootForBranch(dataDir, storyId, 'main'), 'librarian', 'index.json'),
      'utf8',
    )
    const analysisAfter = await readFile(
      join(
        await getContentRootForBranch(dataDir, storyId, 'main'),
        'librarian',
        'analyses',
        'an-alpha-1.json',
      ),
      'utf8',
    )
    expect(indexAfter).toBe(indexBefore)
    expect(analysisAfter).toBe(analysisBefore)
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()
  })

  it('requires a matching token, then deletes candidates and cleans summary analysisIds including archived summaries', async () => {
    await seedTwoProseWithThreeAnalyses()
    await createFragment(
      dataDir,
      storyId,
      makeSummary('su-0001', ['an-alpha-1', 'an-alpha-2', 'an-alpha-3', 'unrelated-id']),
    )
    await createFragment(
      dataDir,
      storyId,
      makeSummary('su-0002', ['an-beta-1', 'an-beta-3'], true),
    )

    const pruneTool = await tool()
    const noToken = (await pruneTool.execute({ dryRun: false })) as RejectedResult
    expect(noToken.ok).toBe(false)
    expect(noToken.error).toBe('confirmation_required')
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()

    const preview = (await pruneTool.execute({ dryRun: true })) as PreviewResult
    const result = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as ExecuteResult

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(false)
    expect(result.deletedCount).toBe(4)
    expect(result.deletedAnalysisIds).toEqual([
      'an-alpha-1',
      'an-alpha-2',
      'an-beta-1',
      'an-beta-2',
    ])
    expect(result.failed).toEqual([])
    expect(result.cleanupErrors).toEqual([])
    expect(result.summaryFragmentsUpdated).toBe(2)

    for (const id of ['an-alpha-1', 'an-alpha-2', 'an-beta-1', 'an-beta-2']) {
      expect(await getAnalysis(dataDir, storyId, id)).toBeNull()
    }
    for (const id of ['an-alpha-3', 'an-beta-3']) {
      expect(await getAnalysis(dataDir, storyId, id)).not.toBeNull()
    }

    const activeSummary = await getFragment(dataDir, storyId, 'su-0001')
    const archivedSummary = await getFragment(dataDir, storyId, 'su-0002')
    expect(activeSummary?.content).toBe('Summary content su-0001')
    expect(activeSummary?.meta.analysisIds).toEqual(['an-alpha-3', 'unrelated-id'])
    expect(archivedSummary?.content).toBe('Summary content su-0002')
    expect(archivedSummary?.meta.analysisIds).toEqual(['an-beta-3'])
    expect(archivedSummary?.archived).toBe(true)

    const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
    expect(latest.get('pr-alpha')).toBe('an-alpha-3')
    expect(latest.get('pr-beta')).toBe('an-beta-3')

    // No prose fragment was removed.
    expect(await getFragment(dataDir, storyId, 'pr-alpha')).not.toBeNull()
    expect(await getFragment(dataDir, storyId, 'pr-beta')).not.toBeNull()
  })

  it('rejects a stale token when a new analysis changes the exact state, and tokens are one-time', async () => {
    await seedTwoProseWithThreeAnalyses()
    const pruneTool = await tool()
    const preview = (await pruneTool.execute({ dryRun: true })) as PreviewResult

    await saveAnalysis(
      dataDir,
      storyId,
      makeAnalysis('an-alpha-4', 'pr-alpha', at(4)),
    )

    const stale = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as RejectedResult
    expect(stale.ok).toBe(false)
    expect(stale.error).toBe('confirmation_required')
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()

    const fresh = (await pruneTool.execute({ dryRun: true })) as PreviewResult
    const executed = (await pruneTool.execute({
      dryRun: false,
      pruneToken: fresh.pruneToken,
    })) as ExecuteResult
    expect(executed.ok).toBe(true)

    const reused = (await pruneTool.execute({
      dryRun: false,
      pruneToken: fresh.pruneToken,
    })) as RejectedResult
    expect(reused.ok).toBe(false)
    expect(reused.error).toBe('confirmation_required')
  })

  it('expires tokens after five minutes and supports an injected token store', async () => {
    await seedTwoProseWithThreeAnalyses()
    const store = new InMemoryAnalysisPruneTokenStore()
    let now = Date.UTC(2025, 0, 1)
    const pruner = createAnalysisPruner({
      tokenStore: store,
      now: () => now,
      tokenFactory: () => 'injected-token',
    })

    const preview = (await pruner.pruneAnalyses(dataDir, storyId, {})) as PreviewResult
    expect(preview.pruneToken).toBe('injected-token')
    expect(store.size).toBe(1)
    expect(preview.expiresAt).toBe(new Date(now + 5 * 60 * 1000).toISOString())

    now += 5 * 60 * 1000 + 1
    const expired = (await pruner.pruneAnalyses(dataDir, storyId, {
      dryRun: false,
      pruneToken: 'injected-token',
    })) as RejectedResult

    expect(expired.ok).toBe(false)
    expect(expired.error).toBe('confirmation_required')
    expect(store.size).toBe(0)
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()
  })

  it('does not deduplicate same-named prose fragments and reports fragment names in groups', async () => {
    await createFragment(dataDir, storyId, makeProse('pr-one', 'Same name'))
    await createFragment(dataDir, storyId, makeProse('pr-two', 'Same name'))
    await saveAnalysis(dataDir, storyId, makeAnalysis('an-one-1', 'pr-one', at(1)))
    await saveAnalysis(dataDir, storyId, makeAnalysis('an-one-2', 'pr-one', at(2)))
    await saveAnalysis(dataDir, storyId, makeAnalysis('an-two-1', 'pr-two', at(1)))
    await saveAnalysis(dataDir, storyId, makeAnalysis('an-two-2', 'pr-two', at(2)))

    const pruneTool = await tool()
    const preview = (await pruneTool.execute({})) as PreviewResult
    expect(preview.candidateCount).toBe(2)
    expect(preview.groups).toEqual([
      {
        fragmentId: 'pr-one',
        fragmentName: 'Same name',
        deleteCount: 1,
        retainAnalysisId: 'an-one-2',
      },
      {
        fragmentId: 'pr-two',
        fragmentName: 'Same name',
        deleteCount: 1,
        retainAnalysisId: 'an-two-2',
      },
    ])

    const executed = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as ExecuteResult
    expect(executed.deletedAnalysisIds).toEqual(['an-one-1', 'an-two-1'])
    expect(await getAnalysis(dataDir, storyId, 'an-one-2')).not.toBeNull()
    expect(await getAnalysis(dataDir, storyId, 'an-two-2')).not.toBeNull()
  })

  it('protects the current index entry and appliedSummarySequence references from deletion', async () => {
    await createFragment(dataDir, storyId, makeProse('pr-alpha', 'Alpha'))
    for (let i = 1; i <= 4; i++) {
      await saveAnalysis(dataDir, storyId, makeAnalysis(`an-alpha-${i}`, 'pr-alpha', at(i)))
    }

    const root = await getContentRootForBranch(dataDir, storyId, 'main')
    const indexPath = join(root, 'librarian', 'index.json')
    const pinnedIndex = {
      version: 1,
      updatedAt: at(10),
      latestByFragmentId: {
        'pr-alpha': { analysisId: 'an-alpha-2', createdAt: at(2) },
      },
      appliedSummarySequence: ['an-alpha-1'],
    }
    await writeFile(indexPath, JSON.stringify(pinnedIndex))

    const pruneTool = await tool()
    const preview = (await pruneTool.execute({})) as PreviewResult
    expect(preview.candidateCount).toBe(1)
    expect(preview.protectedCandidateCount).toBe(2)
    expect(preview.candidates.map((c) => c.id)).toEqual(['an-alpha-3'])

    const executed = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as ExecuteResult
    expect(executed.ok).toBe(true)
    expect(executed.deletedAnalysisIds).toEqual(['an-alpha-3'])

    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-2')).not.toBeNull()
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-4')).not.toBeNull()

    const index = await getAnalysisIndex(dataDir, storyId)
    expect(index?.appliedSummarySequence).toEqual(['an-alpha-1'])
    expect(index?.latestByFragmentId['pr-alpha']?.analysisId).toBe('an-alpha-4')
  })

  it('binds tokens to the branch and does not modify other branches', async () => {
    await seedTwoProseWithThreeAnalyses()
    const pruneTool = await tool()
    const preview = (await pruneTool.execute({})) as PreviewResult

    const alt = await createBranch(dataDir, storyId, 'Alternate', 'main')
    const rejected = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as RejectedResult
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toBe('confirmation_required')

    const altRoot = await getContentRootForBranch(dataDir, storyId, alt.id)
    const altAnalyses = await listAnalyses(dataDir, storyId)
    expect(altAnalyses).toHaveLength(6)
    expect(existsSync(join(altRoot, 'librarian', 'analyses', 'an-alpha-1.json'))).toBe(true)

    // Prune main after switching back; the alternate branch keeps its copies.
    await switchActiveBranch(dataDir, storyId, 'main')
    const mainPreview = (await pruneTool.execute({})) as PreviewResult
    const executed = (await pruneTool.execute({
      dryRun: false,
      pruneToken: mainPreview.pruneToken,
    })) as ExecuteResult
    expect(executed.ok).toBe(true)
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).toBeNull()

    await switchActiveBranch(dataDir, storyId, alt.id)
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()
    expect(
      existsSync(join(altRoot, 'librarian', 'analyses', 'an-alpha-1.json')),
    ).toBe(true)
  })

  it('rejects both preview and execute while the librarian is not idle', async () => {
    await seedTwoProseWithThreeAnalyses()
    const pruneTool = await tool()
    const preview = (await pruneTool.execute({})) as PreviewResult

    const fragment = await getFragment(dataDir, storyId, 'pr-alpha')
    expect(fragment).not.toBeNull()
    await triggerLibrarian(dataDir, storyId, fragment!)

    const busyPreview = (await pruneTool.execute({})) as RejectedResult
    expect(busyPreview.ok).toBe(false)
    expect(busyPreview.error).toBe('librarian_busy')
    expect(busyPreview.runStatus).not.toBe('idle')

    const busyExecute = (await pruneTool.execute({
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as RejectedResult
    expect(busyExecute.ok).toBe(false)
    expect(busyExecute.error).toBe('librarian_busy')

    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()

    clearPending()
    const afterIdle = (await pruneTool.execute({})) as PreviewResult
    expect(afterIdle.ok).toBe(true)
  })

  it('reports partial failures instead of claiming success', async () => {
    await createFragment(dataDir, storyId, makeProse('pr-alpha', 'Alpha'))
    for (let i = 1; i <= 3; i++) {
      await saveAnalysis(dataDir, storyId, makeAnalysis(`an-alpha-${i}`, 'pr-alpha', at(i)))
    }
    await createFragment(
      dataDir,
      storyId,
      makeSummary('su-0001', ['an-alpha-1', 'an-alpha-2', 'an-alpha-3']),
    )

    const pruner = createAnalysisPruner({
      deleteAnalysis: async (_dataDir, _storyId, analysisId) => {
        if (analysisId === 'an-alpha-1') throw new Error('simulated unlink failure')
        // Delegate to the real core deletion for the other candidate.
        const { deleteAnalysis } = await import('@/server/librarian/storage')
        return deleteAnalysis(dataDir, storyId, analysisId)
      },
    })

    const preview = (await pruner.pruneAnalyses(dataDir, storyId, {})) as PreviewResult
    const result = (await pruner.pruneAnalyses(dataDir, storyId, {
      dryRun: false,
      pruneToken: preview.pruneToken,
    })) as ExecuteResult

    expect(result.ok).toBe(false)
    expect(result.error).toBe('partial_failure')
    expect(result.deletedCount).toBe(1)
    expect(result.deletedAnalysisIds).toEqual(['an-alpha-2'])
    expect(result.failed).toEqual([
      { analysisId: 'an-alpha-1', error: 'simulated unlink failure' },
    ])
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-1')).not.toBeNull()
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-2')).toBeNull()
    expect(await getAnalysis(dataDir, storyId, 'an-alpha-3')).not.toBeNull()

    const summary = await getFragment(dataDir, storyId, 'su-0001')
    expect(summary?.meta.analysisIds).toEqual(['an-alpha-1', 'an-alpha-3'])
    const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
    expect(latest.get('pr-alpha')).toBe('an-alpha-3')
  })

  it('serializes concurrent saveAnalysis calls without deadlocking or losing index entries', async () => {
    const writes = Array.from({ length: 12 }, (_, index) => {
      const fragmentId = `pr-${String(index).padStart(4, '0')}`
      return saveAnalysis(
        dataDir,
        storyId,
        makeAnalysis(`an-concurrent-${index}`, fragmentId, at(index)),
      )
    })

    await expect(Promise.all(writes)).resolves.toHaveLength(12)

    const index = await getAnalysisIndex(dataDir, storyId)
    expect(Object.keys(index?.latestByFragmentId ?? {})).toHaveLength(12)
    const latest = await getLatestAnalysisIdsByFragment(dataDir, storyId)
    for (let index = 0; index < 12; index++) {
      expect(latest.get(`pr-${String(index).padStart(4, '0')}`)).toBe(
        `an-concurrent-${index}`,
      )
    }
    expect(await listFragments(dataDir, storyId, 'summary')).toHaveLength(0)
  })
})
