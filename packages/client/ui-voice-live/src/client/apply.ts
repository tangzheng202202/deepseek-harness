/** Registers the voice-live slots: composer mic control + settings section. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only Context merges: make ctx.slots / ctx.locale and the target slot
// declarations visible (settings.section, conversation.input.left, the
// SessionStandardProps useInput/inputActions merge).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { VoiceInputButton } from './VoiceInputButton.tsx'
import { VoiceSettingsSection } from './VoiceSettingsSection.tsx'
import { en, NS, zh, type VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Voice-live plugin dictionaries. */
    voice: VoiceKey
  }
}

/** Services required by this plugin. */
export const inject = ['slots', 'locale']

/**
 * Register the voice dictionaries, the composer mic control, and the settings
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-live: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice',
    order: 0,
    locale: NS,
  }, VoiceInputButton))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'voice',
    order: 100,
    label: () => t('voice.nav'),
    locale: NS,
  }, VoiceSettingsSection))
}
