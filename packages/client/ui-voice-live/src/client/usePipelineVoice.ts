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

export function setActiveVoice(voice: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-voice', voice)
}

export function getActiveVoice(): string {
  return (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-voice') : null) ?? DEFAULT_VOICE
}

/** 服务商（实际仅火山后端可用）。 */
export const PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'volcengine', label: '火山引擎（豆包）' },
]

export function getActiveProvider(): string {
  return 'volcengine'
}

export function setActiveProvider(provider: string): void {
  if (provider === 'volcengine' && typeof localStorage !== 'undefined') {
    localStorage.setItem('dsh-voice-provider', provider)
  }
}

/** 「先响应后思考」开场白（语音提交后立即朗读，agent 正式回复随后排队）。 */
export const REPLY_FIRST_TEXT = '好的，我去查一下。'

/** 是否开启「先响应后思考」（默认开）。 */
export function getReplyFirst(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem('dsh-voice-reply-first') !== '0'
}

export function setReplyFirst(on: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem('dsh-voice-reply-first', on ? '1' : '0')
}

/** 默认唤醒词。 */
export const DEFAULT_WAKE_WORD = '你好小戴'

/** 是否开启语音唤醒（默认关：开启会持续占用麦克风）。 */
export function getWakeWordEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('dsh-voice-wake') === '1'
}

export function setWakeWordEnabled(on: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem('dsh-voice-wake', on ? '1' : '0')
}

/** 自定义唤醒词。 */
export function getWakeWord(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_WAKE_WORD
  return localStorage.getItem('dsh-voice-wakeword') ?? DEFAULT_WAKE_WORD
}

export function setWakeWord(word: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem('dsh-voice-wakeword', word)
}

/** 试听结果。 */
export interface PreviewResult { ok: boolean; message: string }

/** 试听：连接后端合成一句示例并播放。key 由后端环境变量提供，前端不传。 */
export async function previewVoice(voice: string): Promise<PreviewResult> {
  return await new Promise<PreviewResult>((resolve) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(WS_URL)
    } catch (error) {
      resolve({ ok: false, message: (error as Error).message })
      return
    }
    ws.binaryType = 'arraybuffer'
    const chunks: Uint8Array[] = []
    let currentTtsId = ''
    let settled = false
    const timeout = setTimeout(() => { finish({ ok: false, message: '试听超时' }) }, 15000)
    const finish = (result: PreviewResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ws.close()
      resolve(result)
    }

    ws.onerror = () => { finish({ ok: false, message: '无法连接语音服务（后端未启动）' }) }
    ws.onclose = () => {
      if (!settled) finish({ ok: false, message: '语音连接已断开' })
    }
    // handler 在握手前安装，避免本机连接很快时漏掉 host 紧随 open 发出的 ready。
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(e.data)
          if (typeof parsed !== 'object' || parsed === null) return
          msg = parsed as Record<string, unknown>
        } catch {
          return
        }
        if (msg.type === 'ready') {
          if (msg.hasKey === false) {
            finish({ ok: false, message: '后端未配置 VOLCENGINE_API_KEY' })
            return
          }
          const voiceSessionId = typeof msg.voiceSessionId === 'string' ? msg.voiceSessionId : ''
          ws.send(JSON.stringify({ type: 'config', voiceSessionId, provider: 'volcengine', voice }))
          ws.send(JSON.stringify({ type: 'tts_push', voiceSessionId, text: '你好，这是你选择的音色，听起来还满意吗？' }))
          ws.send(JSON.stringify({ type: 'tts_flush', voiceSessionId }))
        } else if (msg.type === 'tts_start') {
          currentTtsId = typeof msg.ttsId === 'string' ? msg.ttsId : ''
        } else if (msg.type === 'tts_done' && msg.ttsId === currentTtsId) {
          const audio = playOnce(chunks.splice(0), finish)
          if (audio === null) finish({ ok: false, message: '未收到合成音频' })
        } else if (msg.type === 'tts_error' || msg.type === 'error') {
          finish({ ok: false, message: typeof msg.message === 'string' ? msg.message : '语音接口错误' })
        }
      } else if (e.data instanceof ArrayBuffer && currentTtsId !== '') {
        chunks.push(new Uint8Array(e.data))
      }
    }
  })
}

/** 播放一段 mp3；结束、解码失败或 autoplay 拒绝都由同一完成路径回收 URL。 */
function playOnce(
  chunks: Uint8Array[],
  finish: (result: PreviewResult) => void,
): HTMLAudioElement | null {
  if (chunks.length === 0) return null
  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  let settled = false
  const done = (result: PreviewResult): void => {
    if (settled) return
    settled = true
    URL.revokeObjectURL(url)
    finish(result)
  }
  audio.onended = () => { done({ ok: true, message: '试听成功' }) }
  audio.onerror = () => { done({ ok: false, message: '试听音频播放失败' }) }
  void audio.play().catch(() => { done({ ok: false, message: '浏览器阻止了试听播放' }) })
  return audio
}
