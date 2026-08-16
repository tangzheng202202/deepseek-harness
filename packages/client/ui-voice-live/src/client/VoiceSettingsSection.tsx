/**
 * "语音交互" settings section: provider + voice + preview。
 * API Key 由后端环境变量提供（阶段 A 起），不再在此填写。
 * Persists through localStorage helpers with no module-global lifecycle state.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  getActiveProvider, getActiveVoice, getReplyFirst, getWakeWord, getWakeWordEnabled,
  previewVoice, type PreviewResult, PROVIDERS, setActiveProvider, setActiveVoice,
  setReplyFirst, setWakeWord, setWakeWordEnabled, VOICE_OPTIONS,
} from './usePipelineVoice.ts'
import { isSpeechRecognitionAvailable, WebSpeechWakeWord } from './wake-word.ts'
import css from './VoiceSettingsSection.module.css'

export type VoiceSettingsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'voice'>

export function VoiceSettingsSection({ t }: VoiceSettingsSectionProps) {
  const [provider, setProvider] = useState(getActiveProvider())
  const [voice, setVoice] = useState(getActiveVoice())
  const [replyFirst, setReplyFirstState] = useState(getReplyFirst())
  const [wakeEnabled, setWakeEnabledState] = useState(getWakeWordEnabled())
  const [wakeWord, setWakeWordState] = useState(getWakeWord())
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  /** echo 受控测试探针：浏览器是否真的对麦克风应用了 AEC。 */
  const [aecState, setAecState] = useState<string | null>(null)
  const [aecProbing, setAecProbing] = useState(false)
  /** 唤醒可用性诊断：浏览器是否真的能跑 Web Speech 识别（Chrome 国内网络常见 network 失败）。 */
  const [wakeDiag, setWakeDiag] = useState<string | null>(null)
  const [wakeProbing, setWakeProbing] = useState(false)

  const preview = (): void => {
    setPreviewing(true)
    setPreviewResult(null)
    void previewVoice(voice).then((r) => { setPreviewResult(r) }).finally(() => { setPreviewing(false) })
  }

  /** 请求一次麦克风并读取浏览器实际应用的约束（受控回声测试的探针）。 */
  const probeAec = async (): Promise<void> => {
    setAecProbing(true)
    setAecState(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const track = stream.getAudioTracks()[0]
      const applied = track?.getSettings().echoCancellation === true
      track?.stop()
      setAecState(applied ? t('voice.aecOn') : t('voice.aecOff'))
    } catch {
      setAecState(t('voice.aecUnavailable'))
    } finally {
      setAecProbing(false)
    }
  }

  /** 唤醒可用性探针：短暂启动一次识别并读取失败原因（不长期占用麦克风）。 */
  const probeWake = async (): Promise<void> => {
    setWakeProbing(true)
    setWakeDiag(null)
    try {
      if (!isSpeechRecognitionAvailable()) {
        setWakeDiag(t('voice.wakeUnsupported'))
        return
      }
      const det = new WebSpeechWakeWord(getWakeWord(), () => {})
      const ok = await det.start()
      if (!ok) {
        setWakeDiag(det.lastError || t('voice.wakeUnavailable'))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
      if (det.lastError) {
        setWakeDiag(`${t('voice.wakeError')}: ${det.lastError}`)
      } else {
        setWakeDiag(t('voice.wakeOk'))
      }
      det.stop()
    } finally {
      setWakeProbing(false)
    }
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

      <label className={css.field}>
        <span className={css.label}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={replyFirst}
            onChange={(e) => { setReplyFirstState(e.target.checked); setReplyFirst(e.target.checked) }}
          />
          {t('voice.replyFirst')}
        </span>
      </label>

      <label className={css.field}>
        <span className={css.label}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={wakeEnabled}
            onChange={(e) => { setWakeEnabledState(e.target.checked); setWakeWordEnabled(e.target.checked) }}
          />
          {t('voice.wakeEnable')}
        </span>
      </label>
      {wakeEnabled && (
        <div className={css.field}>
          <span className={css.label}>{t('voice.wakeWord')}</span>
          <input
            className={css.input}
            type="text"
            value={wakeWord}
            maxLength={20}
            onChange={(e) => { setWakeWordState(e.target.value); setWakeWord(e.target.value) }}
          />
        </div>
      )}
      {wakeEnabled && (
        <div className={css.field}>
          <span className={css.label}>{t('voice.wakeProbe')}</span>
          <div className={css.voiceRow}>
            <button
              type="button"
              className={css.previewButton}
              disabled={wakeProbing}
              onClick={() => { void probeWake() }}
            >
              {wakeProbing ? t('voice.wakeProbeBusy') : t('voice.wakeProbe')}
            </button>
            {wakeDiag !== null && <span className={css.aecResult}>{wakeDiag}</span>}
          </div>
          <p className={css.hint}>{t('voice.wakeNetworkHint')}</p>
        </div>
      )}

      <div className={css.field}>
        <span className={css.label}>{t('voice.aecProbe')}</span>
        <div className={css.voiceRow}>
          <button
            type="button"
            className={css.previewButton}
            disabled={aecProbing}
            onClick={() => { void probeAec() }}
          >
            {aecProbing ? '…' : t('voice.aecProbeAction')}
          </button>
          {aecState !== null && <span className={css.aecResult}>{aecState}</span>}
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
