# Agent Note: Rebuild real-time voice as a DSH host/client plugin

Status: implemented

English | [中文](2026-08-16-voice-plugin-rebuild.zh.md)

## Problem

DSH's real-time voice interaction was an ad-hoc Python sidecar plus a DOM-scanning
frontend hook. It broke on DSH restarts, could not stream reliably (early attempts
produced fragmented or out-of-order transcripts), and had no trust boundary: the
`/voice` route was open to any origin, and the frontend held an API key in
`localStorage`. The rebuild had to stay a DSH plugin, keep Volcengine's binary
framing, stream frame-by-frame, and never reset or rewrite user files.

## Decision

The plugin (`@deepseek-ai/dsh-client-ui-voice-live`) is a split package:

- **Host half** registers a `/voice` WebSocket upgrade inside the DSH host
  process. One connection = one `VoiceSession`; the session feeds mic PCM into
  Volcengine streaming ASR and assistant reply text into Volcengine streaming
  TTS. The upgrade is gated by a loopback-Host + same-origin trust fence
  (`isTrustedVoiceRequest`, 403 otherwise). The API key comes only from
  `process.env.VOLCENGINE_API_KEY`; the browser never holds a key.
- **Client half** renders the composer mic control and a Voice settings
  section. A per-session `VoiceController` state machine
  (`idle→acquiring→connecting→listening→…`) is the single owner of every
  resource: `AudioCapture` (MediaStream/AudioContext/AudioWorklet),
  `VoiceTransport` (WebSocket + generation counter), `PlaybackQueue`. Stale or
  late messages are rejected by generation and by `voiceSessionId` on the wire.

Key decisions:

- **Server-side endpointing.** End-of-sentence is decided by Volcengine, not by
  a client VAD: the ASR request runs on the optimized bidirectional endpoint
  `bigmodel_async` with `enable_nonstream: true`, which emits definite finals
  after the `end_window_size` silence window. Plain `bigmodel` only returns
  partials and never finalizes on its own (verified live). Low-energy mic
  frames are passed through unchanged — the server VAD hears real silence once
  ambient noise stops masking it, and each definite final clears the current
  utterance so consecutive turns keep working.
- **Stop vs cancel.** `stop()` sends `asr_end` and awaits the final
  (exactly-once submission); `cancel()` sends `asr_cancel` and discards. After
  submission the connection enters *reply mode*: it stays open, streams the
  assistant's text into TTS sentence-by-sentence, plays only after each
  `tts_done` completion event, and closes when the turn ends and playback is
  idle (or after an idle timeout).
- **Barge-in.** Speaking again mid-reply stops playback, cancels TTS, cancels
  the in-flight agent turn through DSH's agents service
  (`ctx.agents.get(SessionId(sessionId)).cancel({ kind: 'user' })`, where the
  browser reports its DSH session id in the `config` frame), invalidates the
  old generation, and starts new recognition.
- **Half-duplex echo posture.** Chrome AEC3 only cancels WebRTC-track audio,
  not `new Audio()` playback (Chromium bug 687574), and a server-side AEC3
  (Rust/WebRTC C++) was abandoned on macOS. The loop stays half-duplex: mic
  frames are gated while TTS plays (`ttsActive` hard gate), and barge-in stops
  playback before new recognition. `VoiceController.getMicAec()` reports the
  browser-applied AEC for the controlled echo test (speaker vs headphone,
  AEC on/off).
- **Reply-first.** When enabled (default), the voice acknowledges with "好的，
  我去查一下。" immediately after submission, then queues the real answer on
  the same serial playback channel.
- **Resilience.** A dropped connection while listening auto-reconnects with a
  single reconnecter (exponential backoff, max 5 attempts); stop/cancel never
  reconnect. `bigmodel_async` + `enable_nonstream` was the root cause of
  "says nothing after I finish" — without it no definite final ever arrives.
  The reply-narration gap (agent reply never read aloud) came from the stage-1
  rewrite dropping the DOM-scanned reply reader; it is now driven by the
  session's `partial` output (text blocks only, reasoning/tool blocks skipped)
  with an incremental spoken watermark.

## Alternatives considered

- **豆包 RealtimeAPI / 火山实时对话式 AI** — rejected (user decision B): they
  drive bare models and lose DSH's agent tool abilities; we keep the DeepSeek
  agent brain and add Volcengine ASR/TTS around it.
- **Server-side AEC3** (`webrtc-audio-processing`) — rejected: the Rust crate
  needs a WebRTC C++ compile, abandoned on macOS.
- **Semantic fallback for echo** and **VAD-threshold / extra-boolean patches**
  — explicitly forbidden by the task order; endpointing stays server-owned.
- **DOM-scanned reply reader** — rejected in the rewrite in favor of the
  session snapshot's `partial` stream.

## Verification

- 130 vitest tests in the package at 100% per-file coverage (protocol, trust
  fence, controller state machine, ABA resource accounting, auto endpointing
  zeroing, reconnect, reply-first, wake word, captions, AEC probe, interrupt
  sync-pause, error/defensive branches), plus the repo gates: `test:gui`,
  full-repo typecheck, `verify-package-invariants`, staged lint, golden replay
  (`DSH_SNAPSHOT=replay`).
- Coverage hardening surfaced one protocol bug, fixed and pinned by a test: a
  failed TTS synthesis used to emit `tts_done` right after `tts_error`;
  playback is keyed on done events, so a failure now emits `tts_error` only.
  `/* v8 ignore */` comments carry reasons and are limited to genuinely
  unreachable defensive code (old-ws RawData union, pump shift guard,
  cross-line arrow-declaration count).
- Live smoke against real Volcengine: TTS synthesis over `/voice`, and
  auto-endpointing verified with macOS `say` speech PCM — a definite final
  arrives after ~1.5 s of silence with no `asr_end`.
- Known limitation: the package's `*.host.spec.ts` files are excluded from the
  repository host aggregate's typecheck (TS6307 tripped by the aggregate
  excluding `packages/client/*/src/**`); they run under vitest and the host
  half builds through the package `tsc -b`. The node-environment wake-word
  spec lives under the `*.client.spec.ts` suffix so it type-checks in the
  client aggregate.
