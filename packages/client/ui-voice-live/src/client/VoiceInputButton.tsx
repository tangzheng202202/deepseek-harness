/**
 * Composer mic control, registered on `conversation.input.left` (the additive
 * left tool-row seat). Framework-injected `inputActions` writes the transcript
 * into the draft and submits; no private InputBar keyboard face is touched.
 *
 * 生命周期交给 VoiceController（React 外部状态机），组件只读状态、转发
 * start/stop 动作，不再扫描 DOM、不再持有播放队列。
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { VoiceController, type VoiceState } from './VoiceController.ts'
import css from './VoiceInputButton.module.css'

export type VoiceInputButtonProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'>

const ACTIVE_STATES: ReadonlySet<VoiceState> = new Set([
  'acquiring', 'connecting', 'listening', 'recognizing', 'thinking',
  'synthesizing', 'playing', 'interrupting', 'reconnecting',
])

export function VoiceInputButton({ inputActions, t }: VoiceInputButtonProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<VoiceController | null>(null)

  const controller = (): VoiceController => {
    if (controllerRef.current === null) {
      controllerRef.current = new VoiceController({
        onState: setState,
        onPartial: (text) => { inputActions.setDraft(text) },
        onFinal: (text) => {
          inputActions.setDraft(text)
          inputActions.submit()
        },
        onError: message => setError(message),
      })
    }
    return controllerRef.current
  }

  const active = ACTIVE_STATES.has(state)
  const tooltip = error ?? (active ? t('voice.micActive') : t('voice.mic'))

  useEffect(() => () => {
    controllerRef.current?.cancel()
  }, [])

  return (
    <Tooltip label={tooltip} side="top" delayMs={500}>
      <button
        type="button"
        className={clsx(css.mic, active && css.active, error && css.error)}
        aria-label={error ?? t('voice.mic')}
        aria-pressed={active}
        onClick={() => {
          setError(null)
          const c = controller()
          if (c.isActive) c.stop()
          else void c.start()
        }}
      >
        {active ? (
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
