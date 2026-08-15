/**
 * "语音交互" settings section: provider + API key + voice + preview.
 * Persists through the module-level helpers (localStorage), consumed by the
 * composer's realtime-voice hook.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  getActiveApiKey, getActiveProvider, getActiveVoice,
  previewVoice, PROVIDERS, setActiveApiKey, setActiveProvider, setActiveVoice, VOICE_OPTIONS,
} from '../skeleton/usePipelineVoice.ts'
import css from './VoiceSettingsSection.module.css'

export type VoiceSettingsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'conversation'>

export function VoiceSettingsSection({ t }: VoiceSettingsSectionProps) {
  const [provider, setProvider] = useState(getActiveProvider())
  const [apiKey, setApiKey] = useState(getActiveApiKey())
  const [showKey, setShowKey] = useState(false)
  const [voice, setVoice] = useState(getActiveVoice())
  const [previewing, setPreviewing] = useState(false)

  const preview = (): void => {
    setPreviewing(true)
    void previewVoice(voice, apiKey).finally(() => { setPreviewing(false) })
  }

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('voice.heading')}</h2>

      <label className={css.field}>
        <span className={css.label}>{t('voice.provider')}</span>
        <select
          className={css.input}
          value={provider}
          onChange={(e) => { setProvider(e.target.value); setActiveProvider(e.target.value) }}
        >
          {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>

      <div className={css.field}>
        <span className={css.label}>{t('voice.apiKey')}</span>
        <div className={css.keyRow}>
          <input
            className={css.input}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            placeholder={t('voice.apiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => { setApiKey(e.target.value); setActiveApiKey(e.target.value) }}
          />
          <button
            type="button"
            className={css.eyeButton}
            aria-label={showKey ? 'hide' : 'show'}
            onClick={() => { setShowKey(v => !v) }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
              stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1.5 8s2.4-3.8 6.5-3.8S14.5 8 14.5 8s-2.4 3.8-6.5 3.8S1.5 8 1.5 8Z" />
              <circle cx="8" cy="8" r="1.8" />
              {!showKey && <path d="M2.5 13.5 13.5 2.5" />}
            </svg>
          </button>
        </div>
      </div>

      <div className={css.field}>
        <span className={css.label}>{t('voice.voice')}</span>
        <div className={css.voiceRow}>
          <select
            className={css.input}
            value={voice}
            onChange={(e) => { setVoice(e.target.value); setActiveVoice(e.target.value) }}
          >
            {VOICE_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <button
            type="button"
            className={css.previewButton}
            disabled={previewing}
            onClick={preview}
          >
            {previewing ? '…' : <IconPlayOutline16 size={14} />}
          </button>
        </div>
      </div>

      <p className={css.hint}>{t('voice.hint')}</p>
    </div>
  )
}
