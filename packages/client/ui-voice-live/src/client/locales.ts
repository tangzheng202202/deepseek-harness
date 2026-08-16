/** Voice namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'voice'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'voice.nav': '语音交互',
  'voice.heading': '语音交互',
  'voice.provider': '服务商',
  'voice.apiKey': 'API Key',
  'voice.apiKeyPlaceholder': '粘贴你的 API Key',
  'voice.voice': '音色',
  'voice.hint': '音色用于朗读回答；API Key 用于所选服务商的语音识别与合成。',
  'voice.preview': '试听',
  'voice.mic': '实时语音',
  'voice.micActive': '实时语音对话中（点击结束）',
  'voice.backendKeyHint': 'API Key 由后端提供（~/.dsh/api-key.env 中的 VOLCENGINE_API_KEY），无需在此填写。',
  'voice.replyFirst': '先响应后思考（说完先回应一句，再让助手去查）',
  'voice.aecProbe': '回声消除检测（受控测试：扬声器/耳机对比用）',
  'voice.aecProbeAction': '检测',
  'voice.aecOn': '浏览器已对麦克风应用回声消除（AEC 生效）',
  'voice.aecOff': '浏览器未应用回声消除（AEC 未生效）',
  'voice.aecUnavailable': '无法访问麦克风（检查浏览器权限）',
  'voice.wakeEnable': '语音唤醒（说唤醒词自动开始对话，会持续占用麦克风）',
  'voice.wakeWord': '唤醒词',
  'voice.wakeProbe': '检测唤醒可用性',
  'voice.wakeProbeBusy': '检测中…',
  'voice.wakeOk': '浏览器语音识别可用',
  'voice.wakeUnsupported': '当前浏览器不支持 Web Speech 语音识别（建议 Chrome 或 Safari）',
  'voice.wakeUnavailable': '语音识别无法启动',
  'voice.wakeError': '语音识别出错',
  'voice.wakeNetworkHint': 'Chrome 的语音识别依赖可访问的 Google 语音服务；当前网络不可达时无法唤醒。',
}

/** English dictionary. */
export const en = {
  'voice.nav': 'Voice',
  'voice.heading': 'Voice Interaction',
  'voice.provider': 'Provider',
  'voice.apiKey': 'API Key',
  'voice.apiKeyPlaceholder': 'Paste your API key',
  'voice.voice': 'Voice',
  'voice.hint': 'The voice reads replies aloud; the API key powers the selected provider\'s ASR and TTS.',
  'voice.preview': 'Preview',
  'voice.mic': 'Real-time voice',
  'voice.micActive': 'Real-time voice on (click to end)',
  'voice.backendKeyHint': 'The API key is provided by the backend (VOLCENGINE_API_KEY in ~/.dsh/api-key.env).',
  'voice.replyFirst': 'Reply first, then think (acknowledge the request before the assistant goes to look it up)',
  'voice.aecProbe': 'Echo-cancellation probe (controlled test: speaker vs headphone)',
  'voice.aecProbeAction': 'Probe',
  'voice.aecOn': 'The browser applied AEC to the mic track',
  'voice.aecOff': 'The browser did not apply AEC to the mic track',
  'voice.aecUnavailable': 'Mic unavailable (check browser permission)',
  'voice.wakeEnable': 'Wake word (speak the keyword to start; keeps the mic on)',
  'voice.wakeWord': 'Wake word',
  'voice.wakeProbe': 'Probe wake availability',
  'voice.wakeProbeBusy': 'Probing…',
  'voice.wakeOk': 'Browser speech recognition is available',
  'voice.wakeUnsupported': 'This browser does not support the Web Speech API (Chrome or Safari recommended)',
  'voice.wakeUnavailable': 'Speech recognition failed to start',
  'voice.wakeError': 'Speech recognition error',
  'voice.wakeNetworkHint': 'Chrome speech recognition relies on the Google speech service; it cannot wake when that service is unreachable.',
}

export type VoiceKey = keyof typeof zh
