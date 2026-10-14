// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { persistString, storedString } from '@/lib/storage'

import {
  $voiceMaxRecordingSeconds,
  applyVoiceMaxRecordingSecondsFromConfig,
  DEFAULT_VOICE_RECORDING_SECONDS,
  MAX_VOICE_RECORDING_SECONDS,
  recordingLimit
} from './voice-recording-limit'

const VOICE_LIMIT_KEY = 'hermes.desktop.voiceMaxRecordingSeconds.v1'

describe('voice recording limit store', () => {
  beforeEach(() => {
    persistString(VOICE_LIMIT_KEY, null)
    $voiceMaxRecordingSeconds.set(DEFAULT_VOICE_RECORDING_SECONDS)
  })

  it('clamps to the recorder ceiling and falls back on invalid values', () => {
    expect(recordingLimit(1800)).toBe(1800)
    expect(recordingLimit(7200)).toBe(MAX_VOICE_RECORDING_SECONDS)
    expect(recordingLimit(30)).toBe(30)
    expect(recordingLimit('abc')).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
    expect(recordingLimit(0)).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
    expect(recordingLimit(undefined)).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
  })

  it('publishes the configured limit to every composer and remembers it', () => {
    expect(applyVoiceMaxRecordingSecondsFromConfig({ voice: { max_recording_seconds: 1800 } })).toBe(1800)
    expect($voiceMaxRecordingSeconds.get()).toBe(1800)
    expect(storedString(VOICE_LIMIT_KEY)).toBe('1800')
  })

  it('returns to the documented default when the key is missing', () => {
    applyVoiceMaxRecordingSecondsFromConfig({ voice: { max_recording_seconds: 1800 } })
    applyVoiceMaxRecordingSecondsFromConfig({})
    expect($voiceMaxRecordingSeconds.get()).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
  })

  // A backend that answers slowly (SSH, profile switch) used to leave the
  // renderer on the 120 s fallback until the next successful refresh — every
  // long take in between was cut off at two minutes. The store seeds from the
  // last persisted limit at module load, before /api/config answers.
  async function seededLimit(persisted: string | null): Promise<number> {
    persistString(VOICE_LIMIT_KEY, persisted)
    vi.resetModules()
    const fresh = await import('./voice-recording-limit')

    return fresh.$voiceMaxRecordingSeconds.get()
  }

  it('seeds from the last persisted limit before /api/config answers', async () => {
    expect(await seededLimit('1800')).toBe(1800)
  })

  it('seeds the documented default when nothing was persisted', async () => {
    expect(await seededLimit(null)).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
  })

  it('clamps and falls back on a corrupt persisted value', async () => {
    expect(await seededLimit('abc')).toBe(DEFAULT_VOICE_RECORDING_SECONDS)
    expect(await seededLimit('7200')).toBe(MAX_VOICE_RECORDING_SECONDS)
  })
})
