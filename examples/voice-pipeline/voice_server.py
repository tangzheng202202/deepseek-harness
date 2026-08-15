#!/usr/bin/env python3
"""
voice_server.py — 本地实时语音管线（WebSocket）。

ASR / TTS 后端可插拔，自动选择：
  - 火山引擎（需 VOLCENGINE_APP_ID + VOLCENGINE_ACCESS_TOKEN）：
      ASR = doubao-speech transcribe_async（豆包 bigmodel 大模型识别）
      TTS = doubao-speech synthesize_async（seed-tts-2.0 流式合成）
  - 无火山凭证时回退：faster-whisper（ASR）+ edge-tts（TTS）

浏览器 <-> 服务端协议（单 WebSocket /ws）：
  浏览器 -> 服务端:
    <binary>                         16kHz Int16 单声道麦克风 PCM
    {"type":"tts_push","text":"..."} 追加要朗读的文本（可多次增量）
    {"type":"tts_flush"}             结束本回合：合成剩余文本
    {"type":"asr_end"}               强制结束当前语音段并转写
  服务端 -> 浏览器:
    {"type":"ready","asr","tts","voice","model"}
    {"type":"asr_final","text":"..."}  一句完整转写
    {"type":"tts_start","text":"..."}  开始朗读一句
    <binary>                         该句 mp3 音频
    {"type":"tts_done"}               该句朗读结束

运行:
  voice-pipeline/.venv/bin/python voice_server.py --port 3081
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import struct
import time
from pathlib import Path
from typing import Optional

import numpy as np


def _load_dotenv() -> None:
    env = Path(__file__).resolve().parent / '.env'
    if not env.exists():
        return
    for line in env.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

SAMPLE_RATE = 16000
_SENT_RE = re.compile(r'^([^。！？!?.\n]+[。！？!?.\n]+)([\s\S]*)$')


def pop_sentence(text: str) -> tuple[Optional[str], str]:
    m = _SENT_RE.match(text.lstrip())
    if m:
        return m.group(1).strip(), m.group(2)
    return None, text


class EnergyVAD:
    def __init__(self, threshold: float = 300.0, max_silence: float = 0.6) -> None:
        self.threshold = threshold
        self.max_silence = max_silence
        self._last_voice = 0.0
        self._started = False

    def feed(self, pcm: bytes, now: Optional[float] = None) -> str:
        now = time.time() if now is None else now
        n = len(pcm) // 2
        speech = n > 0 and (sum(s * s for s in struct.unpack(f"<{n}h", pcm)) / n) ** 0.5 > self.threshold
        if speech:
            self._last_voice = now
            if not self._started:
                self._started = True
                return 'start'
            return 'continue'
        if self._started and (now - self._last_voice) > self.max_silence:
            self._started = False
            return 'end'
        return 'silence'


# --------------------------------------------------------------------------- #
# ASR 后端
# --------------------------------------------------------------------------- #
class ASRBackend:
    async def transcribe(self, pcm: bytes, api_key: str | None) -> str:
        raise NotImplementedError


class WhisperASR(ASRBackend):
    def __init__(self, model_size: str) -> None:
        from faster_whisper import WhisperModel
        self._model = WhisperModel(model_size, device='cpu', compute_type='int8')

    async def transcribe(self, pcm: bytes, api_key: str | None) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._transcribe, pcm)

    def _transcribe(self, pcm: bytes) -> str:
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = self._model.transcribe(audio, language='zh', beam_size=5, vad_filter=True)
        return ''.join(seg.text for seg in segments).strip()


class VolcanoASR(ASRBackend):
    async def transcribe(self, pcm: bytes, api_key: str | None) -> str:
        from volcengine import asr_transcribe
        return await asr_transcribe(pcm, api_key)


class MockASR(ASRBackend):
    async def transcribe(self, pcm: bytes, api_key: str | None) -> str:
        return f'（离线 mock 识别 {(len(pcm) / 2) / SAMPLE_RATE:.1f}s）'


# --------------------------------------------------------------------------- #
# TTS 后端
# --------------------------------------------------------------------------- #
class TTSBackend:
    async def synthesize(self, text: str, voice: str, api_key: str | None) -> bytes:
        raise NotImplementedError


class EdgeTTS(TTSBackend):
    def __init__(self, voice: str) -> None:
        self.voice = voice

    async def synthesize(self, text: str, voice: str, api_key: str | None) -> bytes:
        import edge_tts
        buf = bytearray()
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                buf += chunk['data']
        return bytes(buf)


class VolcanoTTS(TTSBackend):
    def __init__(self, voice: str) -> None:
        self.voice = voice

    async def synthesize(self, text: str, voice: str, api_key: str | None) -> bytes:
        from volcengine import tts_synthesize
        return await tts_synthesize(text, voice, api_key)


class MockTTS(TTSBackend):
    async def synthesize(self, text: str, voice: str, api_key: str | None) -> bytes:
        return b''


EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'
VOLC_VOICE = 'zh_female_vv_uranus_bigtts'


def build_backends(args) -> tuple[ASRBackend, TTSBackend, str]:
    has_volc = bool(os.environ.get('VOLCENGINE_API_KEY', ''))

    asr_choice = args.asr or ('volcano' if has_volc else ('mock' if args.mock else 'whisper'))
    tts_choice = args.tts or ('volcano' if has_volc else ('mock' if args.mock else 'edge'))

    if asr_choice == 'volcano':
        asr: ASRBackend = VolcanoASR()
    elif asr_choice == 'whisper':
        asr = WhisperASR(args.model)
    else:
        asr = MockASR()

    if tts_choice == 'volcano':
        tts: TTSBackend = VolcanoTTS(args.voice or VOLC_VOICE)
        voice = args.voice or VOLC_VOICE
    elif tts_choice == 'edge':
        tts = EdgeTTS(args.voice or EDGE_VOICE)
        voice = args.voice or EDGE_VOICE
    else:
        tts = MockTTS()
        voice = 'mock'

    return asr, tts, voice


class Session:
    def __init__(self, ws, asr: ASRBackend, tts: TTSBackend, voice: str, api_key: str) -> None:
        self.ws = ws
        self.asr = asr
        self.tts = tts
        self.voice = voice
        self.api_key = api_key
        self.vad = EnergyVAD()
        self.asr_buf = bytearray()
        self.tts_buf = ''

    async def feed_audio(self, pcm: bytes) -> None:
        self.asr_buf += pcm
        if self.vad.feed(pcm) == 'end':
            await self.finalize_asr()

    async def finalize_asr(self) -> None:
        if not self.asr_buf:
            return
        pcm = bytes(self.asr_buf)
        self.asr_buf = bytearray()
        text = await self.asr.transcribe(pcm, self.api_key or None)
        if text:
            await self.ws.send(json.dumps({'type': 'asr_final', 'text': text}, ensure_ascii=False))

    async def _speak(self, text: str, voice: str | None) -> None:
        await self.ws.send(json.dumps({'type': 'tts_start', 'text': text}, ensure_ascii=False))
        audio = await self.tts.synthesize(text, voice or self.voice, self.api_key or None)
        if audio:
            await self.ws.send(audio)
        await self.ws.send(json.dumps({'type': 'tts_done'}))

    async def push_tts(self, text: str, voice: str | None) -> None:
        self.tts_buf += text
        while True:
            sentence, rest = pop_sentence(self.tts_buf)
            if sentence is None:
                break
            self.tts_buf = rest
            await self._speak(sentence, voice)

    async def flush_tts(self, voice: str | None) -> None:
        tail = self.tts_buf.strip()
        self.tts_buf = ''
        if tail:
            await self._speak(tail, voice)


async def handle(ws, args) -> None:
    asr, tts, voice = build_backends(args)
    api_key = os.environ.get('VOLCENGINE_API_KEY', '')
    await ws.send(json.dumps({
        'type': 'ready',
        'asr': 'volcano' if isinstance(asr, VolcanoASR) else ('whisper' if isinstance(asr, WhisperASR) else 'mock'),
        'tts': 'volcano' if isinstance(tts, VolcanoTTS) else ('edge' if isinstance(tts, EdgeTTS) else 'mock'),
        'voice': voice,
    }))
    session = Session(ws, asr, tts, voice, api_key)
    async for message in ws:
        if isinstance(message, (bytes, bytearray)):
            await session.feed_audio(bytes(message))
            continue
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            continue
        kind = data.get('type')
        if kind == 'config':
            if data.get('api_key'):
                session.api_key = data['api_key']
            if data.get('voice'):
                session.voice = data['voice']
            provider = data.get('provider')
            if provider == 'local':
                session.asr = WhisperASR(args.model)
                session.tts = EdgeTTS(EDGE_VOICE)
            elif provider == 'volcengine':
                session.asr = VolcanoASR()
                session.tts = VolcanoTTS(args.voice or VOLC_VOICE)
        elif kind == 'tts_push':
            await session.push_tts(data.get('text', ''), data.get('voice'))
        elif kind == 'tts_flush':
            await session.flush_tts(data.get('voice'))
        elif kind == 'asr_end':
            await session.finalize_asr()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=3081)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--asr', choices=['volcano', 'whisper', 'mock'], default=None)
    parser.add_argument('--tts', choices=['volcano', 'edge', 'mock'], default=None)
    parser.add_argument('--model', default='base', help='faster-whisper 模型（--asr whisper 时）')
    parser.add_argument('--voice', default=None, help='TTS 音色（不填按后端取默认）')
    parser.add_argument('--mock', action='store_true', help='用 mock ASR/TTS（协议测试，无网络）')
    args = parser.parse_args()

    import websockets
    asr, tts, voice = build_backends(args)
    print(f'voice-pipeline: ws://{args.host}:{args.port}  asr={type(asr).__name__}  tts={type(tts).__name__}  voice={voice}')
    async with websockets.serve(lambda ws: handle(ws, args), args.host, args.port, max_size=None):
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
