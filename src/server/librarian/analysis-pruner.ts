import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { withKeyLock } from '../async-lock'
import {
  getActiveBranchId,
  getContentRoot,
  withBranch,
} from '../fragments/branches'
import type { Fragment } from '../fragments/schema'
import { listFragments, updateFragment } from '../fragments/storage'
import { getLibrarianRuntimeStatus, type LibrarianRuntimeStatus } from './scheduler'
import {
  deleteAnalysis,
  getAnalysisIndex,
  listAnalyses,
  rebuildAnalysisIndex,
  selectLatestAnalysesByFragment,
  withAnalysisLock,
  type LibrarianAnalysisSummary,
} from './storage'

const TTL_MS = 5 * 60 * 1000
const PRUNE_LOCK_PREFIX = 'librarian-analysis-prune'

export interface AnalysisPruneConfirmation {
  dataDir: string
  storyId: string
  branchId: string
  /** Hash over the exact analysis state (all ids + createdAt values). */
  fingerprint: string
  candidateIds: string[]
  expiresAt: number
}

export interface AnalysisPruneTokenStore {
  set(token: string, confirmation: AnalysisPruneConfirmation): void
  /** Removes and returns the record, making each token one-time-use. */
  consume(token: string): AnalysisPruneConfirmation | undefined
  clear?(): void
  readonly size?: number
}

export class InMemoryAnalysisPruneTokenStore implements AnalysisPruneTokenStore {
  private readonly confirmations = new Map<string, AnalysisPruneConfirmation>()

  get size(): number {
    return this.confirmations.size
  }

  set(token: string, confirmation: AnalysisPruneConfirmation): void {
    this.confirmations.set(token, confirmation)
  }

  consume(token: string): AnalysisPruneConfirmation | undefined {
    const confirmation = this.confirmations.get(token)
    if (confirmation) this.confirmations.delete(token)
    return confirmation
  }

  clear(): void {
    this.confirmations.clear()
  }
}

export interface AnalysisPruneOptions {
  tokenStore?: AnalysisPruneTokenStore
  now?: () => number
  tokenFactory?: () => string
  ttlMs?: number
  /** Test seam for forcing a single-record deletion failure. */
  deleteAnalysis?: (
    dataDir: string,
    storyId: string,
    analysisId: string,
  ) => Promise<boolean>
}

export interface PruneInput {
  dryRun?: boolean
  pruneToken?: string
}

export interface PruneCandidate {
  id: string
  fragmentId: string
  createdAt: string
}

export interface PruneGroup {
  fragmentId: string
  fragmentName: string
  deleteCount: number
  retainAnalysisId: string
}

export interface PreviewResult {
  ok: true
  dryRun: true
  storyId: string
  branchId: string
  pruneToken: string
  expiresAt: string
  candidateCount: number
  retainedCount: number
  protectedCandidateCount: number
  candidates: PruneCandidate[]
  groups: PruneGroup[]
  message: string
}

export interface ExecuteFailure {
  analysisId: string
  error: string
}

export interface CleanupError {
  scope: 'index' | 'summary'
  fragmentId?: string
  error: string
}

export interface ExecuteResult {
  ok: boolean
  dryRun: false
  deletedCount: number
  deletedAnalysisIds: string[]
  summaryFragmentsUpdated: number
  failed: ExecuteFailure[]
  cleanupErrors: CleanupError[]
  error?: 'partial_failure'
}

export interface RejectedResult {
  ok: false
  dryRun?: boolean
  error: 'confirmation_required' | 'librarian_busy'
  runStatus?: string
  message: string
}

export type PruneResult = PreviewResult | ExecuteResult | RejectedResult

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Code-point ordering, independent of the host locale. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function candidateComparator(
  a: LibrarianAnalysisSummary,
  b: LibrarianAnalysisSummary,
): number {
  return compareStrings(a.fragmentId, b.fragmentId)
    || compareStrings(a.createdAt, b.createdAt)
    || compareStrings(a.id, b.id)
}

function pruneFingerprint(
  dataDir: string,
  storyId: string,
  branchId: string,
  analyses: LibrarianAnalysisSummary[],
): string {
  const state = [...analyses]
    .sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.createdAt, b.createdAt))
    .map((analysis) => ({ id: analysis.id, createdAt: analysis.createdAt }))
  return createHash('sha256')
    .update(JSON.stringify({ dataDir, storyId, branchId, analyses: state }))
    .digest('hex')
}

function busyResult(
  status: LibrarianRuntimeStatus,
  dryRun: boolean,
): RejectedResult {
  return {
    ok: false,
    dryRun,
    error: 'librarian_busy',
    runStatus: status.runStatus,
    message: `Librarian is ${status.runStatus}; analysis pruning is only allowed while it is idle. Wait for the current run to finish and preview again.`,
  }
}

function confirmationRequired(message: string): RejectedResult {
  return {
    ok: false,
    dryRun: false,
    error: 'confirmation_required',
    message,
  }
}

interface CandidateScan {
  summaries: LibrarianAnalysisSummary[]
  latest: Map<string, LibrarianAnalysisSummary>
  candidates: LibrarianAnalysisSummary[]
  protectedCandidateCount: number
}

async function scanCandidates(
  dataDir: string,
  storyId: string,
): Promise<CandidateScan> {
  const summaries = await listAnalyses(dataDir, storyId)
  const latest = selectLatestAnalysesByFragment(summaries)
  const index = await getAnalysisIndex(dataDir, storyId)

  const protectedIds = new Set<string>(index?.appliedSummarySequence ?? [])
  for (const entry of Object.values(index?.latestByFragmentId ?? {})) {
    if (entry?.analysisId) protectedIds.add(entry.analysisId)
  }

  const superseded = summaries.filter(
    (summary) => latest.get(summary.fragmentId)?.id !== summary.id,
  )
  const candidates = superseded
    .filter((summary) => !protectedIds.has(summary.id))
    .sort(candidateComparator)

  return {
    summaries,
    latest,
    candidates,
    protectedCandidateCount: superseded.length - candidates.length,
  }
}

async function buildGroups(
  dataDir: string,
  storyId: string,
  latest: Map<string, LibrarianAnalysisSummary>,
  candidates: LibrarianAnalysisSummary[],
): Promise<PruneGroup[]> {
  const allFragments = await listFragments(
    dataDir,
    storyId,
    undefined,
    { includeArchived: true },
  )
  const names = new Map(allFragments.map((fragment) => [fragment.id, fragment.name]))
  const deletedByFragment = new Map<string, number>()
  for (const candidate of candidates) {
    deletedByFragment.set(
      candidate.fragmentId,
      (deletedByFragment.get(candidate.fragmentId) ?? 0) + 1,
    )
  }

  return [...latest.values()]
    .map((retained) => ({
      fragmentId: retained.fragmentId,
      fragmentName: names.get(retained.fragmentId) ?? retained.fragmentId,
      deleteCount: deletedByFragment.get(retained.fragmentId) ?? 0,
      retainAnalysisId: retained.id,
    }))
    .filter((group) => group.deleteCount > 0)
    .sort((a, b) => compareStrings(a.fragmentId, b.fragmentId))
}

export function createAnalysisPruner(options: AnalysisPruneOptions = {}) {
  const tokenStore = options.tokenStore ?? new InMemoryAnalysisPruneTokenStore()
  const now = options.now ?? (() => Date.now())
  const tokenFactory = options.tokenFactory ?? (() => randomUUID())
  const ttlMs = options.ttlMs ?? TTL_MS

  async function pruneAnalyses(
    dataDir: string,
    storyId: string,
    input: PruneInput = {},
  ): Promise<PruneResult> {
    const dryRun = input.dryRun !== false
    const activeBranchId = await getActiveBranchId(dataDir, storyId)

    // Pin the branch for the entire operation. If a caller already has a branch
    // scope (e.g. a librarian chat turn), withBranch inherits it; read the
    // content root inside the scope to record the branch actually used.
    return withBranch(dataDir, storyId, async () => {
      const branchId = basename(await getContentRoot(dataDir, storyId))

      return withKeyLock(
        `${PRUNE_LOCK_PREFIX}:${dataDir}:${storyId}`,
        () => withAnalysisLock(dataDir, storyId, async () => {
          const status = getLibrarianRuntimeStatus(storyId)
          if (status.runStatus !== 'idle') return busyResult(status, dryRun)

          const scan = await scanCandidates(dataDir, storyId)
          const fingerprint = pruneFingerprint(
            dataDir,
            storyId,
            branchId,
            scan.summaries,
          )

          if (dryRun) {
            const token = tokenFactory()
            const expiresAt = now() + ttlMs
            const groups = await buildGroups(
              dataDir,
              storyId,
              scan.latest,
              scan.candidates,
            )
            tokenStore.set(token, {
              dataDir,
              storyId,
              branchId,
              fingerprint,
              candidateIds: scan.candidates.map((candidate) => candidate.id),
              expiresAt,
            })

            return {
              ok: true,
              dryRun: true,
              storyId,
              branchId,
              pruneToken: token,
              expiresAt: new Date(expiresAt).toISOString(),
              candidateCount: scan.candidates.length,
              retainedCount: scan.summaries.length - scan.candidates.length,
              protectedCandidateCount: scan.protectedCandidateCount,
              candidates: scan.candidates.map(({ id, fragmentId, createdAt }) => ({
                id,
                fragmentId,
                createdAt,
              })),
              groups,
              message: scan.candidates.length
                ? 'Preview only. Confirm this exact prune token to delete the listed superseded analyses.'
                : 'No superseded analyses need pruning.',
            } satisfies PreviewResult
          }

          const pruneToken = input.pruneToken
          if (!pruneToken) {
            return confirmationRequired(
              'A pruneToken from a matching preview is required to delete analyses.',
            )
          }
          const confirmation = tokenStore.consume(pruneToken)
          if (
            !confirmation
            || confirmation.expiresAt <= now()
            || confirmation.dataDir !== dataDir
            || confirmation.storyId !== storyId
            || confirmation.branchId !== branchId
          ) {
            return confirmationRequired(
              'The prune token is missing, expired, already used, or belongs to another story/branch. Preview again.',
            )
          }
          if (confirmation.fingerprint !== fingerprint) {
            return confirmationRequired(
              'The analysis set changed since the preview; preview again before deleting.',
            )
          }

          // Re-check immediately before mutating. This is best-effort in-process
          // protection, not a transaction against a run that starts mid-prune.
          const executeStatus = getLibrarianRuntimeStatus(storyId)
          if (executeStatus.runStatus !== 'idle') {
            return busyResult(executeStatus, false)
          }

          const failed: ExecuteFailure[] = []
          const deleted: string[] = []
          const removeAnalysis = options.deleteAnalysis ?? deleteAnalysis

          for (const candidate of scan.candidates) {
            try {
              if (await removeAnalysis(dataDir, storyId, candidate.id)) {
                deleted.push(candidate.id)
              } else {
                failed.push({ analysisId: candidate.id, error: 'analysis_not_found' })
              }
            } catch (error) {
              failed.push({ analysisId: candidate.id, error: errorMessage(error) })
            }
          }

          const cleanupErrors: CleanupError[] = []

          if (deleted.length > 0 || failed.length > 0) {
            try {
              // rebuildAnalysisIndex shares withAnalysisLock (reentrant here) and
              // preserves appliedSummarySequence metadata.
              await rebuildAnalysisIndex(dataDir, storyId)
            } catch (error) {
              cleanupErrors.push({ scope: 'index', error: errorMessage(error) })
            }
          }

          const deletedIds = new Set(deleted)
          let summaryFragmentsUpdated = 0
          if (deletedIds.size > 0) {
            let summaries: Fragment[] = []
            try {
              summaries = await listFragments(
                dataDir,
                storyId,
                'summary',
                { includeArchived: true },
              )
            } catch (error) {
              cleanupErrors.push({ scope: 'summary', error: errorMessage(error) })
            }

            for (const fragment of summaries) {
              const oldIds = fragment.meta?.analysisIds
              if (!Array.isArray(oldIds)) continue
              const nextIds = oldIds.filter(
                (id) => typeof id !== 'string' || !deletedIds.has(id),
              )
              if (nextIds.length === oldIds.length) continue

              try {
                await updateFragment(dataDir, storyId, {
                  ...fragment,
                  meta: { ...fragment.meta, analysisIds: nextIds },
                  updatedAt: new Date().toISOString(),
                })
                summaryFragmentsUpdated++
              } catch (error) {
                cleanupErrors.push({
                  scope: 'summary',
                  fragmentId: fragment.id,
                  error: errorMessage(error),
                })
              }
            }
          }

          const ok = failed.length === 0 && cleanupErrors.length === 0
          return {
            ok,
            dryRun: false,
            deletedCount: deleted.length,
            deletedAnalysisIds: deleted,
            summaryFragmentsUpdated,
            failed,
            cleanupErrors,
            ...(ok ? {} : { error: 'partial_failure' as const }),
          } satisfies ExecuteResult
        }),
      )
    }, activeBranchId)
  }

  return { pruneAnalyses }
}

const defaultPruner = createAnalysisPruner()

/** Built-in two-phase pruner used by the Librarian Chat tool. */
export const pruneAnalyses = defaultPruner.pruneAnalyses
