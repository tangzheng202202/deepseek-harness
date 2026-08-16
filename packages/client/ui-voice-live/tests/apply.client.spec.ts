// @vitest-environment jsdom
/** Browser composition: both voice surfaces register only under live declarations and dispose cleanly. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/apply.ts'
import { VoiceInputButton } from '../src/client/VoiceInputButton.tsx'
import { VoiceSettingsSection } from '../src/client/VoiceSettingsSection.tsx'

usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots: ctx.slots }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-voice-live browser apply', () => {
  it('declares only the services it owns', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers mic + settings with locale copy and removes both on teardown', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const mic = slots.entries('conversation.input.left')[0]!
    expect(mic.component).toBe(VoiceInputButton)
    expect(mic.options).toMatchObject({ id: 'voice', order: 0 })
    expect(mic.locale).toBe('voice')

    const settings = slots.entries('settings.section')[0]!
    expect(settings.component).toBe(VoiceSettingsSection)
    expect(settings.options).toMatchObject({ id: 'voice', order: 100 })
    expect(resolveSlotLabel(settings.options.label)).toBe('语音交互')

    await fiber.dispose()
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('waits for declarations that arrive after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
    declare(slots)
    await Promise.resolve()
    expect(slots.entries('conversation.input.left')[0]?.component).toBe(VoiceInputButton)
    expect(slots.entries('settings.section')[0]?.component).toBe(VoiceSettingsSection)
  })
})
