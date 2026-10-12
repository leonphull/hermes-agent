// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MicRecording } from './use-mic-recorder'
import { useVoiceRecorder } from './use-voice-recorder'

// Leon's 30-minute dictation: the recorder must NOT stop at the old 600 s
// clamp, must auto-stop exactly at 1800 s, and manual stop/cancel must clear
// the auto-stop timer. All scheduling runs under fake timers — no wall clock.

let recording = false

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn(async () => {
    recording = true
  }),
  stop: vi.fn<() => Promise<MicRecording | null>>(async () => {
    recording = false

    return { audio: new Blob(), durationMs: 500, heardSpeech: true }
  })
}

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({
    handle: micHandle,
    level: 0,
    get recording() {
      return recording
    }
  })
}))

const syncSttLeaseSpy = vi.fn(async (..._args: unknown[]): Promise<void> => undefined)

vi.mock('@/lib/stt-lease', () => ({
  syncSttLease: (...args: unknown[]) => syncSttLeaseSpy(...args),
  VOICE_INPUT_LEASE: 'desktop:voice-input:test'
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/desktop-metrics', () => ({
  recordFeatureUse: vi.fn()
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          noSpeechDetected: 'no speech',
          recordingFailed: 'recording failed',
          transcriptionFailed: 'transcription failed',
          transcriptionUnavailable: 'unavailable',
          tryRecordingAgain: 'try again',
          unavailable: 'unavailable'
        }
      }
    }
  })
}))

vi.mock('../scope', () => ({
  useComposerScope: () => ({ connectionId: undefined, profile: undefined })
}))

vi.mock('@/hermes', () => ({
  resolveOwnerNow: () => ({ connectionId: 'gateway-a', profile: 'worker_alpha' })
}))

// Streaming is never available in these tests (no live wire): the recorded
// blob goes through onTranscribeAudio. liveTranscript's config fetch resolves
// to a null config → the hook falls back to the blob transcription.
vi.mock('@/lib/voice-client-direct', () => ({
  fetchVoiceClientConfigFor: vi.fn(async () => null)
}))

vi.mock('@/lib/voice-stream', () => ({
  openDictationStream: vi.fn()
}))

const OWNER = { connectionId: 'gateway-a', profile: 'worker_alpha' }

describe('useVoiceRecorder 30-minute dictation cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cleanup()
    recording = false
    micHandle.start.mockClear()
    micHandle.stop.mockClear()
    micHandle.stop.mockImplementation(async () => {
      recording = false

      return { audio: new Blob(), durationMs: 500, heardSpeech: true }
    })
    syncSttLeaseSpy.mockReset()
    syncSttLeaseSpy.mockImplementation(async () => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function renderRecorder(onTranscribeAudio: (audio: Blob, owner?: unknown) => Promise<string>) {
    return renderHook(() =>
      useVoiceRecorder({
        focusInput: () => undefined,
        maxRecordingSeconds: 1800,
        onTranscript: () => undefined,
        onTranscribeAudio
      })
    )
  }

  async function startRecording(hook: { result: { current: ReturnType<typeof useVoiceRecorder> } }) {
    await act(async () => {
      hook.result.current.dictate()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(micHandle.start).toHaveBeenCalledTimes(1)
    expect(hook.result.current.voiceStatus).toBe('recording')
  }

  it('keeps recording beyond the old 600 s clamp', async () => {
    const transcribe = vi.fn(async () => 'still going')
    const hook = renderRecorder(transcribe)
    await startRecording(hook)

    // 600 s and one tick past it: the old hard cap must not fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000 + 1_000)
    })
    expect(hook.result.current.voiceStatus).toBe('recording')
    expect(micHandle.stop).not.toHaveBeenCalled()
  })

  it('auto-stops at 1800 s and transcribes the take', async () => {
    const transcribe = vi.fn(async (_audio: Blob, _owner?: unknown) => 'half hour of speech')
    const hook = renderRecorder(transcribe)
    await startRecording(hook)

    // One second before the cap: still recording.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1799_000)
    })
    expect(hook.result.current.voiceStatus).toBe('recording')

    // The cap itself stops the mic and settles the transcript.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(micHandle.stop).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.voiceStatus).toBe('idle')
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    expect(transcribe.mock.calls[0][1]).toEqual(OWNER)
  })

  it('does not auto-stop after a manual stop cleared the cap timer', async () => {
    const transcribe = vi.fn(async () => 'manual take')
    const hook = renderRecorder(transcribe)
    await startRecording(hook)

    await act(async () => {
      hook.result.current.dictate() // manual stop
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(micHandle.stop).toHaveBeenCalledTimes(1)

    // The cleared auto-stop must not fire a second stop later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800_000)
    })
    expect(micHandle.stop).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
  })

  it('never transcribes a take whose mic was cancelled before the cap fires', async () => {
    const transcribe = vi.fn(async () => 'should not land')
    const hook = renderRecorder(transcribe)
    await startRecording(hook)

    // External cancel (mic torn down): stop() then returns no recording.
    await act(async () => {
      micHandle.stop.mockImplementation(async () => {
        recording = false

        return null
      })
      micHandle.cancel()
      recording = false
    })

    // The still-armed cap fires into a dead mic: no blob, no transcription.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800_000)
    })
    expect(micHandle.stop).toHaveBeenCalledTimes(1)
    expect(transcribe).not.toHaveBeenCalled()
    expect(hook.result.current.voiceStatus).toBe('idle')
  })
})
