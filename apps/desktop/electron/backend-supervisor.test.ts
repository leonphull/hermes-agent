import { describe, expect, it, vi } from 'vitest'

import {
  createBackendSupervisor,
  isSupervisionAuthError,
  isSupervisionTransientError
} from './backend-supervisor'

function makeHarness(overrides: Partial<Parameters<typeof createBackendSupervisor>[0]> = {}) {
  let tickFn: (() => void) | null = null
  const setIntervalFn = vi.fn((fn: () => void) => {
    tickFn = fn

    return 1 as unknown as ReturnType<typeof setInterval>
  })
  const clearIntervalFn = vi.fn()
  const onUnresponsive = vi.fn()
  const onGaveUp = vi.fn()
  let currentTime = 0
  const now = () => currentTime

  const probeResults: Array<'ok' | Error> = []
  const probe = vi.fn(async () => {
    const result = probeResults.shift() ?? 'ok'

    if (result instanceof Error) {
      throw result
    }
  })

  const supervisor = createBackendSupervisor({
    probe,
    onUnresponsive,
    onGaveUp,
    intervalMs: 1000,
    failureThreshold: 3,
    maxRestarts: 3,
    restartWindowMs: 10_000,
    setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    now,
    ...overrides
  })

  // Ticks are async; run one full probe cycle.
  const tick = async () => {
    tickFn?.()
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    // let the async tick body settle
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  return {
    supervisor,
    probe,
    probeResults,
    onUnresponsive,
    onGaveUp,
    setIntervalFn,
    clearIntervalFn,
    tick,
    advance: (ms: number) => {
      currentTime += ms
    }
  }
}

describe('error classification', () => {
  it('recognizes hard auth rejections', () => {
    expect(isSupervisionAuthError(new Error('401: unauthorized'))).toBe(true)
    expect(isSupervisionAuthError(new Error('403: forbidden'))).toBe(true)
    expect(isSupervisionAuthError(new Error('timeout'))).toBe(false)
    expect(isSupervisionAuthError(new Error('404: missing'))).toBe(false)
  })

  it('recognizes transient server moods', () => {
    expect(isSupervisionTransientError(new Error('429: slow down'))).toBe(true)
    expect(isSupervisionTransientError(new Error('503: unavailable'))).toBe(true)
    expect(isSupervisionTransientError(new Error('timeout'))).toBe(false)
    expect(isSupervisionTransientError(new Error('401: unauthorized'))).toBe(false)
  })
})

describe('createBackendSupervisor', () => {
  it('fires onUnresponsive only after N consecutive liveness failures', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(new Error('timeout'), new Error('timeout'))
    await h.tick()
    await h.tick()
    expect(h.onUnresponsive).not.toHaveBeenCalled()

    h.probeResults.push(new Error('timeout'))
    await h.tick()
    expect(h.onUnresponsive).toHaveBeenCalledTimes(1)
    expect(h.onUnresponsive).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 3 })
    )
  })

  it('a healthy probe resets the failure streak', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(new Error('timeout'), new Error('timeout'), 'ok', new Error('timeout'))
    await h.tick()
    await h.tick()
    await h.tick()
    await h.tick()

    expect(h.supervisor.consecutiveFailures).toBe(1)
    expect(h.onUnresponsive).not.toHaveBeenCalled()
  })

  it('auth rejections do not count toward unresponsiveness', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(new Error('401: unauthorized'), new Error('401: unauthorized'), new Error('401: unauthorized'))
    await h.tick()
    await h.tick()
    await h.tick()

    expect(h.onUnresponsive).not.toHaveBeenCalled()
    expect(h.supervisor.consecutiveFailures).toBe(0)
  })

  it('transient 429/5xx neither count nor reset', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(new Error('timeout'), new Error('timeout'), new Error('503: unavailable'), new Error('timeout'))
    await h.tick()
    await h.tick()
    await h.tick()
    await h.tick()

    expect(h.onUnresponsive).toHaveBeenCalledTimes(1)
  })

  it('does not fire onUnresponsive twice for the same outage', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(
      new Error('timeout'), new Error('timeout'), new Error('timeout'),
      new Error('timeout'), new Error('timeout')
    )
    for (let i = 0; i < 5; i++) {
      await h.tick()
    }

    expect(h.onUnresponsive).toHaveBeenCalledTimes(1)
  })

  it('fires again for a new outage after recovery', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(
      new Error('timeout'), new Error('timeout'), new Error('timeout'),
      'ok',
      new Error('timeout'), new Error('timeout'), new Error('timeout')
    )
    for (let i = 0; i < 7; i++) {
      await h.tick()
    }

    expect(h.onUnresponsive).toHaveBeenCalledTimes(2)
  })

  it('recordRestart resets the streak and consumes budget', () => {
    const h = makeHarness()

    expect(h.supervisor.recordRestart()).toBe(true)
    h.advance(1000)
    expect(h.supervisor.recordRestart()).toBe(true)
    h.advance(1000)
    expect(h.supervisor.recordRestart()).toBe(true)
    h.advance(1000)

    // Fourth restart within the window: budget exhausted.
    expect(h.supervisor.recordRestart()).toBe(false)
    expect(h.supervisor.gaveUp).toBe(true)
    expect(h.onGaveUp).toHaveBeenCalledTimes(1)
  })

  it('the restart budget window is rolling', () => {
    const h = makeHarness()

    expect(h.supervisor.recordRestart()).toBe(true)
    expect(h.supervisor.recordRestart()).toBe(true)
    expect(h.supervisor.recordRestart()).toBe(true)

    // Outside the 10s window the old restarts age out.
    h.advance(11_000)
    expect(h.supervisor.recordRestart()).toBe(true)
    expect(h.supervisor.gaveUp).toBe(false)
  })

  it('start after gave-up is a no-op', () => {
    const h = makeHarness()

    h.supervisor.recordRestart()
    h.supervisor.recordRestart()
    h.supervisor.recordRestart()
    h.supervisor.recordRestart() // exhausts budget

    h.supervisor.start()
    expect(h.setIntervalFn).not.toHaveBeenCalled()
  })

  it('stop clears the timer and failure state', async () => {
    const h = makeHarness()
    h.supervisor.start()

    h.probeResults.push(new Error('timeout'))
    await h.tick()
    expect(h.supervisor.consecutiveFailures).toBe(1)

    h.supervisor.stop()
    expect(h.clearIntervalFn).toHaveBeenCalled()
    expect(h.supervisor.consecutiveFailures).toBe(0)
  })

  it('start is idempotent (no double timers)', () => {
    const h = makeHarness()

    h.supervisor.start()
    h.supervisor.start()
    expect(h.setIntervalFn).toHaveBeenCalledTimes(1)
  })

  it('does not stack probes while one is in flight', async () => {
    let resolveProbe: (() => void) | null = null
    const probe = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveProbe = resolve
        })
    )
    let tickFn: (() => void) | null = null
    const supervisor = createBackendSupervisor({
      probe,
      onUnresponsive: vi.fn(),
      setIntervalFn: ((fn: () => void) => {
        tickFn = fn

        return 1 as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval
    })

    supervisor.start()
    tickFn?.()
    tickFn?.()
    tickFn?.()

    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe?.()
  })
})
