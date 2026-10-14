import { type MutableRefObject, useCallback, useRef, useState } from 'react'

import { setTerminalFontFamilyFromConfig } from '@/app/right-sidebar/terminal/terminal-font'
import { getHermesConfig, getHermesConfigDefaults } from '@/hermes'
import { BUILTIN_PERSONALITIES, normalizePersonalityValue, personalityNamesFromConfig } from '@/lib/chat-runtime'
import { composerServiceTier } from '@/lib/model-status-label'
import { persistString, storedString } from '@/lib/storage'
import { normalize } from '@/lib/text'
import { setDisplayTimestampsFromConfig } from '@/store/display-timestamps'
import { setShowReasoningFromConfig } from '@/store/reasoning-disclosure'
import {
  getComposerSelectionGeneration,
  getCurrentModelSource,
  setAvailablePersonalities,
  setCurrentFastMode,
  setCurrentPersonality,
  setCurrentReasoningEffort,
  setCurrentServiceTier,
  setDefaultReasoningEffort,
  setIntroPersonality
} from '@/store/session'
import { setShowToolActivityFromConfig } from '@/store/tool-activity'
import { refreshVoiceLiveStatus } from '@/store/voice-live'
import {
  applyAutoSpeakFromConfig,
  applyBargeInEnabledFromConfig,
  applyBargeInThresholdFromConfig,
  applyThinkingSoundFromConfig,
  applyVoiceSilenceMsFromConfig,
  applyVoiceStopPhraseFromConfig
} from '@/store/voice-prefs'
import { setChatFontFamilyFromConfig } from '@/themes/chat-font'

const DEFAULT_VOICE_SECONDS = 120

// Dictation hard ceiling — use-voice-recorder.ts clamps to the same value, so
// a config value above it cannot promise a take the recorder would cut off.
const MAX_RECORDING_SECONDS = 1800

// The last limit a backend resolved. The renderer only learns the configured
// limit from /api/config, and that request can time out or be cancelled on
// boot (SSH backends, profile switches) — without a remembered value every
// such miss silently re-arms the 120 s fallback and cuts long dictation off.
const VOICE_LIMIT_KEY = 'hermes.desktop.voiceMaxRecordingSeconds.v1'

function recordingLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_VOICE_SECONDS
  }

  return Math.min(value, MAX_RECORDING_SECONDS)
}

/** Seed for the first render: the last persisted limit, else the documented default. */
function storedRecordingLimit(): number {
  const raw = storedString(VOICE_LIMIT_KEY)

  return raw === null ? DEFAULT_VOICE_SECONDS : recordingLimit(Number(raw))
}

/** config.yaml hands back whatever the user wrote — `reasoning_effort: false`
 *  (or `off`/`no`, which YAML also parses to boolean false) means thinking
 *  disabled, and a bare boolean must not throw on `.trim()`. */
function normalizeConfigEffort(value: unknown): string {
  if (value === false) {
    return 'none'
  }

  if (typeof value !== 'string') {
    return ''
  }

  const effort = normalize(value)

  return effort === 'false' || effort === 'disabled' ? 'none' : effort
}

interface HermesConfigOptions {
  activeSessionIdRef: MutableRefObject<string | null>
}

export function useHermesConfig({ activeSessionIdRef }: HermesConfigOptions) {
  const [voiceMaxRecordingSeconds, setVoiceMaxRecordingSeconds] = useState(storedRecordingLimit)
  const [sttEnabled, setSttEnabled] = useState(true)
  const profileRefreshEpochRef = useRef(0)

  const refreshHermesConfig = useCallback(
    async (force = false, shouldPublish: () => boolean = () => true) => {
      if (force) {
        profileRefreshEpochRef.current += 1
      }

      const profileRefreshEpoch = profileRefreshEpochRef.current
      const selectionGeneration = getComposerSelectionGeneration()

      try {
        const [config, defaults] = await Promise.all([getHermesConfig(), getHermesConfigDefaults().catch(() => ({}))])

        const canPublish = () => profileRefreshEpochRef.current === profileRefreshEpoch && shouldPublish()

        if (!canPublish()) {
          return
        }

        const personality = normalizePersonalityValue(
          typeof config.display?.personality === 'string' ? config.display.personality : ''
        )

        if (!canPublish()) {
          return
        }

        setIntroPersonality(personality)
        // Active sessions keep their per-session value; standalone falls back to config.
        setCurrentPersonality(prev => (activeSessionIdRef.current ? prev || personality : personality))
        setAvailablePersonalities([
          ...new Set([
            'none',
            ...BUILTIN_PERSONALITIES,
            ...personalityNamesFromConfig(defaults),
            ...personalityNamesFromConfig(config)
          ])
        ])

        const reasoning = normalizeConfigEffort(config.agent?.reasoning_effort)
        const tier = composerServiceTier(config.agent?.service_tier)

        // Publish the profile default regardless of whether the composer is
        // reseeded below: picker rows and preset application resolve "the
        // default" from here, so a manual model pick must not leave them
        // rendering/applying Hermes' built-in medium over the user's config.
        if (!canPublish()) {
          return
        }

        setDefaultReasoningEffort(reasoning)

        const shouldSeedComposer =
          !activeSessionIdRef.current &&
          getComposerSelectionGeneration() === selectionGeneration &&
          (force || getCurrentModelSource() !== 'manual')

        if (shouldSeedComposer) {
          if (!canPublish()) {
            return
          }

          setCurrentReasoningEffort(reasoning)
          setCurrentFastMode(tier === 'priority' || tier === 'ultrafast')
          setCurrentServiceTier(tier)
        }

        if (!canPublish()) {
          return
        }

        if (!canPublish()) {
          return
        }

        const limit = recordingLimit(config.voice?.max_recording_seconds)
        setVoiceMaxRecordingSeconds(limit)
        persistString(VOICE_LIMIT_KEY, String(limit))
        setSttEnabled(config.stt?.enabled !== false)

        if (!canPublish()) {
          return
        }

        setDisplayTimestampsFromConfig(config.display?.timestamps)
        setShowReasoningFromConfig(config.display?.show_reasoning)
        setShowToolActivityFromConfig(config.display?.tool_progress)
        setTerminalFontFamilyFromConfig(config.terminal?.font_family)
        setChatFontFamilyFromConfig(config.desktop?.font_family)

        if (!canPublish()) {
          return
        }

        applyAutoSpeakFromConfig(config)
        applyVoiceStopPhraseFromConfig(config, defaults)
        applyBargeInEnabledFromConfig(config)
        applyBargeInThresholdFromConfig(config)
        applyThinkingSoundFromConfig(config)
        applyVoiceSilenceMsFromConfig(config, defaults)
        // Resolved server-side (mode + whether a key resolves); non-critical.
        void refreshVoiceLiveStatus().catch(() => undefined)
      } catch {
        // Config is nice-to-have; chat still works without it.
      }
    },
    [activeSessionIdRef]
  )

  return { refreshHermesConfig, sttEnabled, voiceMaxRecordingSeconds }
}
