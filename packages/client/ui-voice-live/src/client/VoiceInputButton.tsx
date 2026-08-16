/**
 * Composer mic control, registered on `conversation.input.left` (the additive
 * left tool-row seat). Framework-injected `inputActions` writes the transcript
 * into the draft and submits; no private InputBar keyboard face is touched.
 */
import { useEffect } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRealtimeVoice } from './usePipelineVoice.ts'
import css from './VoiceInputButton.module.css'

export type VoiceInputButtonProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'>

export function VoiceInputButton({ inputActions, useSession, t }: VoiceInputButtonProps) {
  const voice = useRealtimeVoice({
    onInterim: (text) => { inputActions.setDraft(text) },
    onFinal: (text) => {
      inputActions.setDraft(text)
      inputActions.submit()
    },
  })

  const running = useSession(s => s.running) ?? false
  useEffect(() => { voice.setRunning(running) }, [running, voice.setRunning])

  const tooltip = voice.error ?? (voice.active ? t('voice.micActive') : t('voice.mic'))

  return (
    <Tooltip label={tooltip} side="top" delayMs={500}>
      <button
        type="button"
        className={clsx(css.mic, voice.active && css.active, voice.error && css.error)}
        aria-label={voice.error ?? t('voice.mic')}
        aria-pressed={voice.active}
        disabled={!voice.supported}
        onClick={() => { if (voice.active) voice.stop(); else voice.start() }}
      >
        {voice.active ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 1 1-5 0v-3A2.5 2.5 0 0 1 8 1Z" fill="currentColor" />
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0h-1.5a3 3 0 0 1-6 0h-1.5Z" fill="currentColor" />
            <path d="M8 11.75a4.25 4.25 0 0 1-4.25-4.25H2.25A5.75 5.75 0 0 0 7.25 13.2V15h1.5v-1.8a5.75 5.75 0 0 0 5-5.7h-1.5A4.25 4.25 0 0 1 8 11.75Z" fill="currentColor" />
          </svg>
        )}
      </button>
    </Tooltip>
  )
}
