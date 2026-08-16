# @deepseek-ai/dsh-client-ui-voice-live

English | [中文](README.zh.md)

Real-time voice interaction for DSH: press the composer mic, speak, and the
assistant replies aloud. The package ships two halves:

- **Host half** registers the `/voice` WebSocket upgrade route inside the DSH
  host process. One connection carries a session that feeds microphone PCM to
  Volcengine streaming ASR (bigmodel_async with server-side VAD endpointing)
  and streams assistant reply text to Volcengine streaming TTS
  (seed-tts-2.0). The upgrade is gated by a loopback-Host + same-origin trust
  fence; every async operation has one lifecycle owner, audio flows through a
  bounded queue, and TTS is a single serial worker.
- **Client half** renders the composer mic control (`conversation.input.left`)
  and the Voice settings section (`settings.section`). A per-session
  `VoiceController` state machine owns all resources — `AudioCapture`
  (MediaStream/AudioContext/AudioWorklet), `VoiceTransport` (WebSocket) and
  `PlaybackQueue` (audio) — and rejects stale/late messages by generation.

The API key is read from `process.env.VOLCENGINE_API_KEY` on the host; the
browser never holds or transmits a key.

## Interaction model

- Tap the mic to start. While active the button renders a tech orb with pulse
  rings; speech is recognized incrementally into the composer draft.
- Endpointing is server-side: after ~1.5 s of silence a definite ASR final is
  emitted and submitted **without pressing stop**. `stop()` is still "send end
  and await the final"; `cancel()` discards.
- After submission the connection stays open in *reply mode*: the assistant's
  streaming text is synthesized sentence by sentence and played only after its
  `tts_done` completion event. When **reply-first** is enabled (default), the
  voice replies "好的，我去查一下。" immediately, then queues the real answer.
- Speaking again mid-reply **interrupts**: playback stops, TTS is cancelled,
  the in-flight agent turn is cancelled through DSH's agents service, old
  message ids are invalidated, and a new recognition starts.
- A dropped connection while listening auto-reconnects (single reconnecter,
  exponential backoff, max 5 attempts).

## Settings

The Voice section lets you pick a voice (30 verified Volcengine voices),
preview it, and toggle reply-first. The preview connects over the same `/voice`
route and is completion-event driven (no fixed sleep).

## Protocol (browser ↔ host, one WebSocket)

- browser → host: binary = 16 kHz Int16 mono mic PCM; control frames
  `config` (provider/voice/dshSessionId), `asr_start`, `asr_end`, `asr_cancel`,
  `tts_push`, `tts_flush`, `tts_cancel`.
- host → browser: `ready`, `asr_partial`/`asr_final` (with voiceSessionId,
  utteranceId, sequence), `tts_start` + binary audio + `tts_done`, `tts_error`,
  `tts_idle`, `error`.
- Control frames carrying a `voiceSessionId` must match the session; oversized
  frames and malformed JSON are dropped; a forged Host gets a 403.

## Model Experience

### Voice path

#### What the model sees

Nothing: the microphone stream goes to Volcengine ASR and the assistant reply text to Volcengine TTS over the host `/voice` route, and neither request composes, appends, or rewrites any LLM prompt (the assistant turn is DSH's ordinary agent loop).

#### Token effect

None: this package assembles and sends no model request, so it meters no tokens; any metering belongs entirely to the agent loop that services the submitted prompt.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Wake word** is not implemented: activation is push-to-talk via the mic
  button. A local wake-word engine (sherpa-onnx WASM) is the planned path and
  requires bundling a downloaded model; it is intentionally out of scope until
  the core loop is accepted.
- **Echo cancellation** relies on the browser's AEC (Chrome AEC3) applied to
  the WebRTC mic track. `VoiceController.getMicAec()` reports whether the
  browser actually applied AEC. `new Audio()` playback is not covered by
  Chrome's AEC (Chromium bug 687574), so the loop stays half-duplex: mic frames
  are gated while TTS plays, and barge-in stops playback before new recognition.
  The controlled echo test (speaker vs headphone, AEC on/off) is documented in
  the deliverable notes; the runtime decision is half-duplex + interrupt.
- **Live captions** surface as the incremental composer draft (asr_partial);
  there is no floating caption overlay yet.
- Server-side endpointing depends on Volcengine's optimized bidirectional
  endpoint (`bigmodel_async` + `enable_nonstream`); a plain `bigmodel` stream
  only returns partials and never finalizes on its own.
- The package's `*.host.spec.ts` tests are excluded from the repository host
  aggregate's typecheck (TS6307 tripped by the aggregate excluding
  `packages/client/*/src/**`); they run under vitest and the host half builds
  through the package `tsc -b`.
