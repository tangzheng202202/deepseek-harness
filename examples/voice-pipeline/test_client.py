#!/usr/bin/env python3
"""voice-pipeline 协议自测：连 ws，验证 ASR 回传与 TTS 音频流。"""
from __future__ import annotations

import asyncio
import json
import math
import struct

import websockets


def make_pcm(seconds: float = 0.6, rate: int = 16000) -> bytes:
    n = int(rate * seconds)
    return b''.join(struct.pack('<h', int(6000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))


async def main(port: int = 3081) -> None:
    async with websockets.connect(f'ws://127.0.0.1:{port}/ws', max_size=None) as ws:
        ready = json.loads(await ws.recv())
        print('ready:', ready)

        await ws.send(make_pcm())
        await ws.send(json.dumps({'type': 'asr_end'}))
        asr = json.loads(await ws.recv())
        print('asr ->', asr)

        await ws.send(json.dumps({'type': 'tts_push', 'text': '你好，我是本地实时语音管线。这句话应该被合成出来。'}, ensure_ascii=False))
        audio_bytes = 0
        while True:
            msg = await ws.recv()
            if isinstance(msg, (bytes, bytearray)):
                audio_bytes += len(msg)
                continue
            d = json.loads(msg)
            print('tts event:', d.get('type'), d.get('text', '')[:30])
            if d.get('type') == 'tts_done':
                break
        print(f'TTS 音频字节数: {audio_bytes} ({audio_bytes / 1024:.1f} KB)')

        await ws.send(json.dumps({'type': 'tts_flush'}))
        print('OK')


if __name__ == '__main__':
    import sys
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 3081))
