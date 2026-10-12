// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getHermesConfig } from '@/hermes'

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

describe('useHermesConfig voice.max_recording_seconds clamping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
