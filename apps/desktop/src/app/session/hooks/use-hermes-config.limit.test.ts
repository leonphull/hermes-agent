// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getHermesConfig } from '@/hermes'
import { persistString, storedString } from '@/lib/storage'
import { $voiceMaxRecordingSeconds } from '@/store/voice-recording-limit'

import { useHermesConfig } from './use-hermes-config'

// Leon's 30-minute dictation: the recorder cap lives in use-voice-recorder.ts;
// this hook feeds it. A config value above the 1800 s ceiling must be clamped
// here so the composer never promises a take the recorder would cut off, and
// the invalid/missing fallback stays 120 s.

vi.mock('@/hermes', () => ({
  getHermesConfig: vi.fn(),
  getHermesConfigDefaults: vi.fn().mockResolvedValue({})
}))

const mockConfig = (config: Record<string, unknown>) =>
  vi.mocked(getHermesConfig).mockResolvedValue(config as Awaited<ReturnType<typeof getHermesConfig>>)

const VOICE_LIMIT_KEY = 'hermes.desktop.voiceMaxRecordingSeconds.v1'

describe('useHermesConfig voice.max_recording_seconds clamping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistString(VOICE_LIMIT_KEY, null)
    $voiceMaxRecordingSeconds.set(120)
  })

  async function renderedLimit(config: Record<string, unknown>): Promise<number> {
    mockConfig(config)
    const { result } = renderHook(() => useHermesConfig({ activeSessionIdRef: { current: null } }))

    await act(async () => {
      await result.current.refreshHermesConfig()
    })

    return result.current.voiceMaxRecordingSeconds
  }

  it('passes a 1800 s config through unchanged', async () => {
    expect(await renderedLimit({ voice: { max_recording_seconds: 1800 } })).toBe(1800)
  })

  it('clamps a config above the 1800 s ceiling', async () => {
    expect(await renderedLimit({ voice: { max_recording_seconds: 7200 } })).toBe(1800)
  })

  it('keeps the documented 120 s default when the key is missing', async () => {
    expect(await renderedLimit({})).toBe(120)
  })

  it('keeps the documented 120 s default for invalid values', async () => {
    expect(await renderedLimit({ voice: { max_recording_seconds: 'abc' } })).toBe(120)
  })

  it('keeps a small custom value', async () => {
    expect(await renderedLimit({ voice: { max_recording_seconds: 30 } })).toBe(30)
  })

  // A backend that answers slowly (SSH, profile switch) used to leave the
  // renderer on the 120 s fallback until the next successful refresh — every
  // long take in between was cut off at two minutes.
  it('persists the resolved limit for the next boot', async () => {
    expect(await renderedLimit({ voice: { max_recording_seconds: 1800 } })).toBe(1800)
    expect(storedString(VOICE_LIMIT_KEY)).toBe('1800')
  })

  // The boot seed from the persisted value is covered in
  // src/store/voice-recording-limit.test.ts (module-load behaviour).
  it('reports the store value before /api/config answers', () => {
    $voiceMaxRecordingSeconds.set(1800)
    mockConfig({})
    const { result } = renderHook(() => useHermesConfig({ activeSessionIdRef: { current: null } }))

    expect(result.current.voiceMaxRecordingSeconds).toBe(1800)
  })

  it('keeps the remembered limit when the config request fails', async () => {
    $voiceMaxRecordingSeconds.set(1800)
    vi.mocked(getHermesConfig).mockRejectedValue(new Error('Timed out connecting to Hermes backend'))
    const { result } = renderHook(() => useHermesConfig({ activeSessionIdRef: { current: null } }))

    await act(async () => {
      await result.current.refreshHermesConfig()
    })

    expect(result.current.voiceMaxRecordingSeconds).toBe(1800)
  })
})
