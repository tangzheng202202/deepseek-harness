/**
 * "语音交互" settings section: provider + voice + preview。
 * API Key 由后端环境变量提供（阶段 A 起），不再在此填写。
 * Persists through the module-level helpers (localStorage), consumed by the
 * composer's realtime-voice hook.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  getActiveProvider, getActiveVoice,
  previewVoice, type PreviewResult, PROVIDERS, setActiveProvider, setActiveVoice, VOICE_OPTIONS,
} from './usePipelineVoice.ts'
import css from './VoiceSettingsSection.module.css'

export type VoiceSettingsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'voice'>

export function VoiceSettingsSection({ t }: VoiceSettingsSectionProps) {
  const [provider, setProvider] = useState(getActiveProvider())
  const [voice, setVoice] = useState(getActiveVoice())
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)

  const preview = (): void => {
    setPreviewing(true)
    setPreviewResult(null)
    void previewVoice(voice).then((r) => { setPreviewResult(r) }).finally(() => { setPreviewing(false) })
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

      {previewResult !== null && (
        <p className={previewResult.ok ? css.okHint : css.errHint}>{previewResult.message}</p>
      )}

      <p className={css.hint}>{t('voice.hint')}</p>
      <p className={css.hint}>{t('voice.backendKeyHint')}</p>
    </div>
  )
}
