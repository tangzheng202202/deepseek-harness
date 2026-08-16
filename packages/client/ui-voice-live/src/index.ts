/**
 * Host entry: registers the `/voice` WebSocket upgrade route so the browser
 * can reach Volcengine streaming ASR/TTS through DSH itself (no separate
 * Python backend). Runs inside the DSH host process, so it starts and stops
 * with DSH.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createVoiceUpgrade } from './host/voice-server.ts'

/** Services this host plugin depends on. */
export const inject = ['webServer', 'agents']

const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts'

export function apply(ctx: Context): void {
  const upgrade = createVoiceUpgrade(
    process.env.VOLCENGINE_API_KEY ?? '',
    DEFAULT_VOICE,
    // barge-in：打断朗读时取消对应 DSH 会话的 agent 回合（用户打断）。
    (dshSessionId) => {
      if (dshSessionId === '') return
      ctx.agents.get(SessionId(dshSessionId))?.cancel({ kind: 'user' })
    },
  )
  ctx.effect(
    () => ctx.webServer.registerUpgrade({ path: '/voice', handler: upgrade.handle }),
    'ui-voice-live: /voice WebSocket route',
  )
  ctx.effect(() => upgrade.close, 'ui-voice-live: /voice socket teardown')
}
