import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

// `voice.max_recording_seconds` — the dictation auto-stop. One store, read by
// every composer: the main chat's ChatBar AND the session-tile ChatBars, which
// mount their own ChatView without the main window's prop plumbing and used to
// fall back to the 120 s default no matter what the config said.

/** Backend default (hermes_cli/config_defaults.py) and the renderer's fallback. */
export const DEFAULT_VOICE_RECORDING_SECONDS = 120

// Dictation hard ceiling — use-voice-recorder.ts clamps to the same value, so
// a config value above it cannot promise a take the recorder would cut off.
export const MAX_VOICE_RECORDING_SECONDS = 1800

// The last limit a backend resolved. The renderer only learns the configured
// limit from /api/config, and that request can time out or be cancelled on
// boot (SSH backends, profile switches) — without a remembered value every
// such miss silently re-arms the 120 s fallback and cuts long dictation off.
const VOICE_LIMIT_KEY = 'hermes.desktop.voiceMaxRecordingSeconds.v1'

/** A config/stored value → usable seconds: invalid → default, oversized → ceiling. */
export function recordingLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_VOICE_RECORDING_SECONDS
  }

  return Math.min(value, MAX_VOICE_RECORDING_SECONDS)
}

/** Seed for the first render: the last persisted limit, else the documented default. */
function storedRecordingLimit(): number {
  const raw = storedString(VOICE_LIMIT_KEY)

  return raw === null ? DEFAULT_VOICE_RECORDING_SECONDS : recordingLimit(Number(raw))
}

export const $voiceMaxRecordingSeconds = atom<number>(storedRecordingLimit())

type ConfigPayload = { voice?: { max_recording_seconds?: unknown } | null } | null | undefined

/** Seed the dictation limit from a loaded config payload (mount / refresh) and remember it. */
export function applyVoiceMaxRecordingSecondsFromConfig(config: ConfigPayload): number {
  const limit = recordingLimit(config?.voice?.max_recording_seconds)
  $voiceMaxRecordingSeconds.set(limit)
  persistString(VOICE_LIMIT_KEY, String(limit))

  return limit
}
