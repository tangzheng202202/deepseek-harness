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
}

export type VoiceKey = keyof typeof zh
