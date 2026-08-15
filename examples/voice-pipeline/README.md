# voice-pipeline · 实时语音管线（后端）

给 DeepSeek Harness 页面提供**流式 ASR + 流式 TTS** 的本地 WebSocket 服务。
浏览器端采集麦克风 PCM、接收 mp3 播放；识别结果经「当前 DeepSeek 智能体」当大脑。

**默认走火山引擎（需一个 API Key）**，无 key 时自动回退到本地/免费方案。

| 后端 | ASR | TTS |
|---|---|---|
| 火山引擎（默认） | 豆包 bigmodel 大模型识别（流式） | 豆包 seed-tts-2.0（流式合成） |
| 本地回退 | faster-whisper（离线） | edge-tts（微软免费） |

## 架构

```
浏览器(DSH 页面)                         本地后端 127.0.0.1:3081
  麦克风 --PCM16 16k(二进制)---------->  火山 bigmodel ASR 逐句转写
  收到 asr_final 文本 → 填输入框/自动发送给 DeepSeek 智能体
  智能体流式回答 → 切句后 tts_push ---->  火山 seed-tts-2.0 逐句合成
  播放 mp3 音频 <----------------------  (tts_start + mp3 + tts_done)
```

## 启动

```bash
cd voice-pipeline

# 1) 建虚拟环境并安装（只需一次）
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# 2) 配置火山 API Key（单个 key 即可）
cp .env.example .env   # 或直接写 .env：
#    VOLCENGINE_API_KEY=你的key

# 3) 启动（有 key 自动走火山，无 key 自动回退 whisper+edge）
.venv/bin/python voice_server.py --port 3081

# 可选参数
#   --asr  volcano|whisper|mock
#   --tts  volcano|edge|mock
#   --voice 火山音色 id（默认 zh_female_vv_uranus_bigtts）
#   --mock  无网络协议测试
```

## 验证（已实测）

```bash
# 火山双向回环：TTS 合成一句 -> 解码成 PCM -> ASR 识别回来
.venv/bin/python - <<'PY'
import os, asyncio, io, numpy as np, av
for line in open('.env', encoding='utf-8'):
    if '=' in line and not line.startswith('#'):
        k, _, v = line.partition('='); os.environ.setdefault(k.strip(), v.strip())
from volcengine import tts_synthesize, asr_transcribe

async def main():
    mp3 = await tts_synthesize('今天天气很好，我们去公园散步吧。', 'zh_female_vv_uranus_bigtts')
    c = av.open(io.BytesIO(mp3)); r = av.AudioResampler(format='s16', layout='mono', rate=16000)
    pcm = b''.join(np.concatenate([f.to_ndarray().reshape(-1) for f in r.resample(x)]) for x in c.decode(audio=0) if True)
    print(await asr_transcribe(pcm))
asyncio.run(main())
PY
```

## 协议

单 WebSocket `/ws`（JSON 控制 + 二进制音频）：`asr_final` / `tts_push` / `tts_flush` / `asr_end`；下行 `tts_start` + mp3 二进制 + `tts_done`。详见 `voice_server.py` 头注释。

## 说明

- **凭证**：火山语音「密钥管理」里的单个 API Key，写入 `.env` 的 `VOLCENGINE_API_KEY`。
- **需开通**：语音合成（seed-tts-2.0）与语音识别（bigmodel），免费额度即可。
- 完全离线可 `--asr whisper --tts edge`（ASR 本地、TTS 仍需联网）；要全离线 TTS 可再接 CosyVoice。
