import { describe, it, expect, vi } from 'vitest'
import { generation } from '@/lib/api/generation'
import { startResumableGenerationRun } from '@/lib/api/generation-run'
import type { ChatEvent } from '@/lib/api/types'

const encoder = new TextEncoder()

function line(event: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A response body that emits the supplied chunks one per pull and then either
 * fails (simulating a dropped socket) or closes (simulating an unexpected EOF).
 */
function chunkStream(chunks: Uint8Array[], failAfter?: Error): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index])
        index += 1
        return
      }
      if (failAfter) controller.error(failAfter)
      else controller.close()
    },
  })
}

function ndjsonResponse(chunks: Uint8Array[], failAfter?: Error): Response {
  return new Response(chunkStream(chunks, failAfter), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

async function collect(stream: ReadableStream<ChatEvent>): Promise<ChatEvent[]> {
  const reader = stream.getReader()
  const events: ChatEvent[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) return events
    events.push(value)
  }
}

const testOptions = {
  reconnectBaseDelayMs: 1,
  reconnectMaxDelayMs: 5,
  reconnectMaxAttempts: 5,
  startMaxAttempts: 3,
}

describe('generation run client stream', () => {
  it('reconnects after a mid-stream failure with after=lastSeq and no duplicates', async () => {
    const calls: Array<{ method: string; url: string }> = []
    let eventConnections = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ method, url })

        if (method === 'POST' && url.endsWith('/generation-runs')) {
          return jsonResponse({ runId: 'run-test' })
        }

        if (method === 'GET' && url.includes('/generation-runs/run-test/events')) {
          eventConnections += 1
          if (eventConnections === 1) {
            return ndjsonResponse(
              [
                line({ seq: 1, event: { type: 'text', text: 'Hello ' } }),
                line({ seq: 2, event: { type: 'text', text: 'world' } }),
              ],
              new Error('socket closed'),
            )
          }
          return ndjsonResponse([
            // Replayed duplicates must be ignored.
            line({ seq: 1, event: { type: 'text', text: 'Hello ' } }),
            line({ seq: 2, event: { type: 'text', text: 'world' } }),
            line({ seq: 3, event: { type: 'text', text: '!' } }),
            line({ seq: 4, event: { type: 'run-done' } }),
          ])
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`)
      }),
    )

    const stream = await startResumableGenerationRun(
      'story-1',
      { input: 'hi', saveResult: false },
      undefined,
      testOptions,
    )
    const events = await collect(stream)

    expect(events).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'text', text: '!' },
    ])
    expect(eventConnections).toBe(2)

    const eventUrls = calls.filter((call) => call.method === 'GET' && call.url.includes('/events'))
    expect(eventUrls).toHaveLength(2)
    expect(eventUrls[0].url).toContain('after=0')
    expect(eventUrls[1].url).toContain('after=2')
  })

  it('parses a half line split across chunks and reconnects after unexpected EOF', async () => {
    let eventConnections = 0
    const calls: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push(url)
        if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/generation-runs')) {
          return jsonResponse({ runId: 'run-eof-test' })
        }

        eventConnections += 1
        if (eventConnections === 1) {
          // The JSON line is split across two chunks and the connection ends
          // without run-done.
          return ndjsonResponse([
            encoder.encode('{"seq":1,"event":{"type":"text","text":"Hel'),
            encoder.encode('lo"}}\n'),
          ])
        }
        return ndjsonResponse([
          line({ seq: 2, event: { type: 'text', text: '!' } }),
          line({ seq: 3, event: { type: 'run-done' } }),
        ])
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    const events = await collect(stream)

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: '!' },
    ])
    expect(eventConnections).toBe(2)
    const eventUrls = calls.filter((url) => url.includes('/events'))
    expect(eventUrls[0]).toContain('after=0')
    expect(eventUrls[1]).toContain('after=1')
  })

  it('closes the stream on run-done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/generation-runs')) {
          return jsonResponse({ runId: 'run-done-test' })
        }
        return ndjsonResponse([
          line({ seq: 1, event: { type: 'text', text: 'done' } }),
          line({ seq: 2, event: { type: 'run-done' } }),
        ])
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    const events = await collect(stream)
    expect(events).toEqual([{ type: 'text', text: 'done' }])
  })

  it('fails the stream on run-error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/generation-runs')) {
          return jsonResponse({ runId: 'run-error-test' })
        }
        return ndjsonResponse([
          line({ seq: 1, event: { type: 'text', text: 'partial' } }),
          line({ seq: 2, event: { type: 'run-error', error: 'provider exploded' } }),
        ])
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    const reader = stream.getReader()

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: 'text', text: 'partial' },
    })
    await expect(reader.read()).rejects.toThrow('provider exploded')
  })

  it('aborts the fetch, calls cancel, and does not reconnect', async () => {
    let eventConnections = 0
    let cancelCalls = 0
    const pendingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line({ seq: 1, event: { type: 'text', text: 'start' } }))
        // Deliberately never closes; abort must take us out of the read.
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'POST' && url.endsWith('/generation-runs')) {
          return jsonResponse({ runId: 'run-abort-test' })
        }
        if (method === 'POST' && url.endsWith('/cancel')) {
          cancelCalls += 1
          return jsonResponse({ ok: true })
        }
        eventConnections += 1
        return new Response(pendingBody, { status: 200 })
      }),
    )

    const controller = new AbortController()
    const stream = await startResumableGenerationRun(
      'story-1',
      { input: 'hi' },
      controller.signal,
      testOptions,
    )
    const reader = stream.getReader()

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: 'text', text: 'start' },
    })

    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelCalls).toBe(1)
    expect(eventConnections).toBe(1)
  })

  it('recovers a lost start response by querying the known run id', async () => {
    let startCalls = 0
    let statusCalls = 0
    let eventConnections = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'POST' && url.endsWith('/generation-runs')) {
          startCalls += 1
          throw new TypeError('fetch failed')
        }
        if (method === 'GET' && url.includes('/events')) {
          eventConnections += 1
          return ndjsonResponse([line({ seq: 1, event: { type: 'run-done' } })])
        }
        statusCalls += 1
        return jsonResponse({ runId: 'run-status-test', status: 'running', lastSeq: 0 })
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    await collect(stream)

    expect(startCalls).toBe(1)
    expect(statusCalls).toBe(1)
    expect(eventConnections).toBe(1)
  })

  it('retries the start with the same runId when the status lookup returns 404', async () => {
    const startRunIds: string[] = []
    let statusCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'POST' && url.endsWith('/generation-runs')) {
          const body = JSON.parse(String(init?.body)) as { runId: string }
          startRunIds.push(body.runId)
          if (startRunIds.length === 1) throw new TypeError('fetch failed')
          return jsonResponse({ runId: body.runId })
        }
        if (method === 'GET' && url.includes('/events')) {
          return ndjsonResponse([
            line({ seq: 1, event: { type: 'text', text: 'recovered' } }),
            line({ seq: 2, event: { type: 'run-done' } }),
          ])
        }

        statusCalls += 1
        return jsonResponse({ error: 'Generation run not found' }, 404)
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    const events = await collect(stream)

    expect(events).toEqual([{ type: 'text', text: 'recovered' }])
    expect(statusCalls).toBe(1)
    expect(startRunIds).toHaveLength(2)
    expect(startRunIds[0]).toBe(startRunIds[1])
  })

  it('does not treat a malformed status response as an existing run', async () => {
    const startRunIds: string[] = []
    let statusCalls = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'POST' && url.endsWith('/generation-runs')) {
          const body = JSON.parse(String(init?.body)) as { runId: string }
          startRunIds.push(body.runId)
          if (startRunIds.length === 1) throw new TypeError('fetch failed')
          return jsonResponse({ runId: body.runId })
        }
        if (method === 'GET' && url.includes('/events')) {
          return ndjsonResponse([line({ seq: 1, event: { type: 'run-done' } })])
        }

        statusCalls += 1
        return new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )

    const stream = await startResumableGenerationRun('story-1', { input: 'hi' }, undefined, testOptions)
    await collect(stream)

    expect(statusCalls).toBe(1)
    expect(startRunIds).toHaveLength(2)
    expect(startRunIds[0]).toBe(startRunIds[1])
  })

  it('generation.stream uses the generation-runs endpoint and keeps its signature', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/generation-runs')) {
        return jsonResponse({ runId: 'server-run' })
      }
      return ndjsonResponse([
        line({ seq: 1, event: { type: 'text', text: 'Hi' } }),
        line({ seq: 2, event: { type: 'run-done' } }),
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const stream = await generation.stream('story-9', 'prompt')
    const events = await collect(stream)

    expect(events).toEqual([{ type: 'text', text: 'Hi' }])

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/generation-runs') && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(String(postCall?.[0])).toBe('/api/stories/story-9/generation-runs')
    const body = JSON.parse(String((postCall?.[1] as RequestInit).body))
    expect(body).toMatchObject({ input: 'prompt', saveResult: false })
    expect(typeof body.runId).toBe('string')
    expect(body.runId.length).toBeGreaterThan(0)
  })
})
