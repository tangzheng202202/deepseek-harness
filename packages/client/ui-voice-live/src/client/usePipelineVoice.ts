/**
 * 语音插件的配置与试听工具（生命周期交给 VoiceController）。
 * API key 由后端环境变量提供，前端不持有、不读写任何 key。
 */

const WS_URL = `${window.location.protocol === 'https:' ? 'wss://' : 'ws://'}${window.location.host}/voice`

/** 可选音色（30 个，均经 seed-tts-2.0 实测通过）。 */
export const VOICE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'zh_female_vv_uranus_bigtts', label: '温暖女声' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '温柔女声' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '清纯甜美女声' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', label: '软甜女声' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快女声' },
  { id: 'zh_female_peiqi_uranus_bigtts', label: '童声' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩' },
  { id: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', label: '清澈童声' },
  { id: 'zh_female_mizai_uranus_bigtts', label: '俏皮女声' },
  { id: 'zh_female_jitangnv_uranus_bigtts', label: '治愈女声' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', label: '温柔女友声' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', label: '教学女声' },
  { id: 'zh_female_cancan_uranus_bigtts', label: '知性女声' },
  { id: 'zh_male_m191_uranus_bigtts', label: '沉稳男声' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '活力青年男声' },
  { id: 'zh_male_liufei_uranus_bigtts', label: '活力男声' },
  { id: 'zh_male_sophie_uranus_bigtts', label: '温柔男声' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年音' },
  { id: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥（活泼男声）' },
  { id: 'zh_male_dayi_uranus_bigtts', label: '浑厚男声' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅男声' },
  { id: 'saturn_zh_female_keainvsheng_tob', label: '可爱女生' },
  { id: 'saturn_zh_female_tiaopigongzhu_tob', label: '调皮公主' },
  { id: 'saturn_zh_male_shuanglangshaonian_tob', label: '爽朗少年' },
  { id: 'saturn_zh_male_tiancaitongzhuo_tob', label: '天才同桌' },
  { id: 'saturn_zh_female_cancan_tob', label: '知性灿灿' },
]
export const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts'

let activeVoice = (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice') : null) ?? DEFAULT_VOICE

export function setActiveVoice(voice: string): void {
  activeVoice = voice
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice', voice)
}

export function getActiveVoice(): string {
  return activeVoice
}

/** 服务商（实际仅火山后端可用）。 */
export const PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'volcengine', label: '火山引擎（豆包）' },
]

let activeProvider = (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice-provider') : null) ?? 'volcengine'

export function getActiveProvider(): string {
  return activeProvider
}

export function setActiveProvider(provider: string): void {
  activeProvider = provider
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice-provider', provider)
}

/** 试听结果。 */
export interface PreviewResult { ok: boolean; message: string }

/** 试听：连接后端合成一句示例并播放。key 由后端环境变量提供，前端不传。 */
export async function previewVoice(voice: string): Promise<PreviewResult> {
  try {
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    const chunks: Uint8Array[] = []
    let hasKey = false
    let errorMsg = ''
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      ws.onopen = () => { clearTimeout(timer); resolve(true) }
      ws.onerror = () => { clearTimeout(timer); resolve(false) }
    })
    if (!opened) { ws.close(); return { ok: false, message: '无法连接语音服务（后端未启动）' } }

    // 完成由事件驱动：tts_done → 播放 → audio ended → 返回。
    // 全程无固定 sleep；超时兜底 15s。
    const done = new Promise<PreviewResult>((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve({ ok: false, message: '试听超时' }) }, 15000)
      const finish = (r: PreviewResult): void => { clearTimeout(timeout); ws.close(); resolve(r) }
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data) as { type: string; hasKey?: boolean; message?: string }
          if (msg.type === 'ready') {
            hasKey = Boolean(msg.hasKey)
            if (!hasKey) finish({ ok: false, message: '后端未配置 VOLCENGINE_API_KEY' })
          } else if (msg.type === 'tts_done') {
            const audio = playOnce(chunks.splice(0))
            if (audio === null) finish({ ok: false, message: '未收到合成音频' })
            else audio.onended = () => finish({ ok: true, message: '试听成功' })
          } else if (msg.type === 'error') {
            errorMsg = msg.message ?? '语音接口错误'
          }
        } else if (e.data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(e.data))
        }
      }
    })
    ws.send(JSON.stringify({ type: 'config', provider: 'volcengine', voice }))
    ws.send(JSON.stringify({ type: 'tts_push', text: '你好，这是你选择的音色，听起来还满意吗？' }))
    ws.send(JSON.stringify({ type: 'tts_flush' }))
    const r = await done
    if (r.ok && errorMsg) return { ok: false, message: errorMsg }
    return r
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

/** 播放一段 mp3，返回 audio 元素（供调用方挂 onended）；无音频返回 null。 */
function playOnce(chunks: Uint8Array[]): HTMLAudioElement | null {
  if (chunks.length === 0) return null
  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.onended = () => URL.revokeObjectURL(url)
  void audio.play()
  return audio
}
