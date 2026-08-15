#!/usr/bin/env python3
"""
volcengine.py — 火山引擎流式语音封装（X-Api-Key 鉴权）。

复用 doubao-speech 的二进制协议实现，仅把鉴权头切换为官方 TTS 2.0 / bigmodel
ASR 文档所用的单 `X-Api-Key` 形式（不再用旧的 App ID + Access Token）。

API Key 可运行时传入（`api_key` 参数），未传时回退到环境变量 `VOLCENGINE_API_KEY`。
"""
from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import doubao_speech._ws_client as _wsc

_ENV_KEY = os.environ.get('VOLCENGINE_API_KEY', '')
_API_KEY = _ENV_KEY


def set_api_key(key: str | None) -> None:
    """覆盖当前进程使用的 API Key（None 还原为环境变量）。"""
    global _API_KEY
    _API_KEY = key or _ENV_KEY


def _headers(app_id: str, access_token: str, resource_id: str, request_id: str | None = None) -> dict:
    return {
        'X-Api-Key': _API_KEY,
        'X-Api-Resource-Id': resource_id,
        'X-Api-Connect-Id': str(uuid.uuid4()),
        'X-Api-Request-Id': request_id or str(uuid.uuid4()),
    }


# 覆写鉴权头构造（doubao-speech 的协议流会调用它）。
_wsc._build_headers = _headers  # type: ignore[attr-defined]

from doubao_speech import synthesize_async, transcribe_async  # noqa: E402

SAMPLE_RATE = 16000


async def tts_synthesize(text: str, voice: str, api_key: str | None = None) -> bytes:
    """文本 -> 一段完整 mp3（seed-tts-2.0 流式合成后聚合）。"""
    if not text.strip():
        return b''
    if api_key:
        set_api_key(api_key)
    with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
        out = f.name
    try:
        await synthesize_async(
            text, out,
            app_id='x', access_token='x',  # 占位，鉴权实际走 X-Api-Key
            voice=voice, audio_format='mp3',
        )
        return Path(out).read_bytes()
    finally:
        Path(out).unlink(missing_ok=True)


async def asr_transcribe(pcm: bytes, api_key: str | None = None) -> str:
    """16kHz Int16 单声道 PCM -> 文本（bigmodel 大模型识别）。"""
    if len(pcm) < SAMPLE_RATE * 2 // 10:  # 不足 0.1s 忽略
        return ''
    if api_key:
        set_api_key(api_key)
    text = await transcribe_async(
        pcm,
        app_id='x', access_token='x',  # 占位
        codec='raw', sample_rate=SAMPLE_RATE, bits=16, channel=1,
        enable_itn=True, enable_punc=True, enable_ddc=True,
        timeout=15,
    )
    return (text or '').strip()
