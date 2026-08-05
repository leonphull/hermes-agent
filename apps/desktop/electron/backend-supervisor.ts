/**
 * backend-supervisor.ts
 *
 * Runtime supervision for the desktop's managed backend after it becomes
 * ready. Startup readiness (backend-health.ts / backend-ready.ts) proves the
 * backend came up; nothing previously watched it *stay* up. A degraded-but-
 * alive backend — hung event loop, FD exhaustion (see the EMFILE incident
 * behind #78873), stalled /api/health — left the UI broken with no recovery
 * affordance beyond quitting the app.
 *
 * The supervisor runs a periodic credentialed health probe and classifies
 * outcomes shape-based (mirroring backend-health.ts): timeouts and connection
 * failures count toward unresponsiveness; 401/403 are auth problems for the
 * existing reauth path, NOT liveness failures; 429/5xx are transient server
 * moods and reset nothing.
 *
 * On N consecutive liveness failures it asks the owner (main.ts) to restart
 * the backend through the normal spawn path. Restarts are rate-limited: more
 * than `maxRestarts` within `restartWindowMs` stops supervision and surfaces
 * a terminal callback so the UI can show a real recovery affordance instead
 * of a silent hot loop (per the "observable ladder" invariant: retries are
 * bounded and end in a real recovery affordance).
 *
 * Dependency-free (no electron import) so the loop, classification, and
 * rate-limit branches are directly assertable with fake timers and probes.
 */

export interface BackendSupervisorOptions {
  /** Credentialed liveness probe; resolves on healthy, rejects on failure. */
  probe: () => Promise<unknown>
  /** Called when consecutive failures cross the threshold. Should restart the backend. */
  onUnresponsive: (details: { consecutiveFailures: number; lastError: string }) => void
  /** Called when the restart budget is exhausted; supervision has stopped. */
  onGaveUp?: (details: { restarts: number; windowMs: number }) => void
  /** Probe interval. Default 30s. */
  intervalMs?: number
  /** Consecutive failures before declaring unresponsive. Default 3. */
  failureThreshold?: number
  /** Restart budget within the window. Default 3. */
  maxRestarts?: number
  /** Rolling window for the restart budget. Default 10 minutes. */
  restartWindowMs?: number
  /** Injectable timer functions for tests. */
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  now?: () => number
  /** Optional structured logging sink. */
  log?: (message: string) => void
}

/**
 * True for a hard auth rejection (401/403). Mirrors backend-health.ts
 * isAuthRejectionError: auth problems route to reauth, not to restart —
 * restarting a backend that rejects our token would loop forever without
 * fixing anything.
 */
export function isSupervisionAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')

  return /^40[13]:/.test(message)
}

/**
 * True for a transient server-side mood (throttle / 5xx) that proves the
 * process is alive enough to answer HTTP. Alive-but-busy must not count
 * toward the unresponsiveness threshold or we'd kill a backend that is
 * merely under load.
 */
export function isSupervisionTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')

  return /^(429|5\d\d):/.test(message)
}

export interface BackendSupervisor {
  /** Begin probing. Idempotent. */
  start: () => void
  /** Stop probing and forget failure state. Idempotent, safe after gave-up. */
  stop: () => void
  /**
   * Owner notification that a supervised restart was performed. Counts
   * against the rolling restart budget and resets the failure streak.
   * Returns false when the budget is exhausted (owner should NOT restart;
   * onGaveUp has fired).
   */
  recordRestart: () => boolean
  /** Current consecutive-failure count (for tests / diagnostics). */
  readonly consecutiveFailures: number
  /** Whether supervision has permanently stopped after budget exhaustion. */
  readonly gaveUp: boolean
}

export function createBackendSupervisor(options: BackendSupervisorOptions): BackendSupervisor {
  const {
    probe,
    onUnresponsive,
    onGaveUp,
    intervalMs = 30_000,
    failureThreshold = 3,
    maxRestarts = 3,
    restartWindowMs = 600_000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
    log = () => {}
  } = options

  let timer: ReturnType<typeof setInterval> | null = null
  let failures = 0
  let probing = false
  let unresponsiveReported = false
  let gaveUp = false
  let restartTimestamps: number[] = []

  const stop = () => {
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
    failures = 0
    probing = false
    unresponsiveReported = false
  }

  const tick = async () => {
    // A slow probe must not stack a second in-flight probe behind it — the
    // stall would burn through the threshold with a single hang.
    if (probing || gaveUp) {
      return
    }
    probing = true
    try {
      await probe()
      failures = 0
      unresponsiveReported = false
    } catch (error) {
      if (isSupervisionAuthError(error)) {
        // Reauth territory (existing paths own it); a restart can't fix auth.
        failures = 0
      } else if (isSupervisionTransientError(error)) {
        // Alive but busy/throttled — not a liveness failure.
      } else {
        failures += 1
        const message = error instanceof Error ? error.message : String(error)
        log(`Backend supervision probe failed (${failures}/${failureThreshold}): ${message}`)

        if (failures >= failureThreshold && !unresponsiveReported) {
          // Latch until the owner restarts (recordRestart resets the streak)
          // or the backend recovers on its own — repeated callbacks for the
          // same outage would trigger overlapping restarts.
          unresponsiveReported = true
          onUnresponsive({ consecutiveFailures: failures, lastError: message })
        }
      }
    } finally {
      probing = false
    }
  }

  return {
    start: () => {
      if (timer !== null || gaveUp) {
        return
      }
      timer = setIntervalFn(() => void tick(), intervalMs)
      // Never keep the app alive just to probe it (Node timers hold the loop).
      if (typeof (timer as NodeJS.Timeout).unref === 'function') {
        ;(timer as NodeJS.Timeout).unref()
      }
    },
    stop,
    recordRestart: () => {
      const current = now()
      restartTimestamps = restartTimestamps.filter(ts => current - ts < restartWindowMs)
      if (restartTimestamps.length >= maxRestarts) {
        gaveUp = true
        stop()
        log(`Backend supervision gave up: ${restartTimestamps.length} restarts within ${restartWindowMs}ms`)
        onGaveUp?.({ restarts: restartTimestamps.length, windowMs: restartWindowMs })

        return false
      }
      restartTimestamps.push(current)
      failures = 0
      unresponsiveReported = false

      return true
    },
    get consecutiveFailures() {
      return failures
    },
    get gaveUp() {
      return gaveUp
    }
  }
}
