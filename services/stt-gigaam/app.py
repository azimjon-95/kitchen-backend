"""
Clean Kitchen — сервис распознавания речи на GigaAM (Sber, MIT).
POST /transcribe  — тело audio/wav (PCM16 моно, любая частота 8–48 кГц, ≤ 25 c) → {"text", "ms"}
GET  /health      — {"ok", "model", "device"}
Модель загружается один раз при старте и прогревается; распознавание идёт прямо из памяти (без ffmpeg и временных файлов).
"""
import io, os, time, threading, logging
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import JSONResponse

log = logging.getLogger("stt")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

MODEL_NAME = os.getenv("GIGAAM_MODEL", "v3_e2e_rnnt")       # v3_e2e_ctc — быстрее, v3_e2e_rnnt — точнее
DEVICE = os.getenv("GIGAAM_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
TOKEN = os.getenv("STT_SERVICE_TOKEN", "")                  # общий секрет с backend (заголовок X-STT-Token)
THREADS = int(os.getenv("TORCH_THREADS", "0")) or max(1, os.cpu_count() or 1)
SR = 16000
MAX_SEC = 25.0

torch.set_num_threads(THREADS)
_lock = threading.Lock()   # одна модель — один поток инференса; запросы ждут очереди (они короткие)
_model = None


def load():
    global _model
    if os.getenv("GIGAAM_FAKE") == "1":   # для тестов без весов
        class Fake:
            _device = torch.device("cpu"); _dtype = torch.float32
            def forward(self, wav, length): return wav, length
            def _decode(self, enc, enc_len, wav_len, ts=False): return [(f"тест {enc.shape[-1] / SR:.1f}", None)]
        _model = Fake(); return
    import gigaam
    t = time.time()
    _model = gigaam.load_model(MODEL_NAME, device=DEVICE, download_root=os.getenv("GIGAAM_CACHE"))
    log.info("model %s loaded on %s in %.1fs (threads=%d)", MODEL_NAME, DEVICE, time.time() - t, THREADS)
    _infer(np.zeros(SR, dtype=np.float32))   # прогрев: первый запрос пользователя не платит за JIT/аллокации


def _to_mono16k(data: np.ndarray, sr: int) -> np.ndarray:
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != SR:   # линейная передискретизация — клиент и так шлёт 16 кГц
        n = int(round(len(data) * SR / sr))
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data)
    return data.astype(np.float32)


def _infer(pcm: np.ndarray) -> str:
    m = _model
    wav = torch.from_numpy(pcm).to(m._device).to(m._dtype).unsqueeze(0)
    length = torch.full([1], wav.shape[-1], device=m._device)
    with _lock, torch.inference_mode():
        enc, enc_len = m.forward(wav, length)
        return m._decode(enc, enc_len, length)[0][0].strip()


app = FastAPI(title="clean-kitchen-stt")


@app.on_event("startup")
def _startup():
    load()


@app.get("/health")
def health():
    return {"ok": _model is not None, "model": MODEL_NAME, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(request: Request, x_stt_token: str = Header(default="")):
    if TOKEN and x_stt_token != TOKEN:
        raise HTTPException(401, "bad token")
    if _model is None:
        raise HTTPException(503, "model not loaded")
    body = await request.body()
    if not body or len(body) > 2_000_000:
        raise HTTPException(400, "empty or too large")
    try:
        data, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=False)
    except Exception:
        raise HTTPException(400, "WAV expected")
    if not 8000 <= sr <= 48000:
        raise HTTPException(400, "bad sample rate")
    pcm = _to_mono16k(data, sr)
    sec = len(pcm) / SR
    if sec < 0.3:
        return {"text": "", "ms": 0, "reason": "too-short"}
    if sec > MAX_SEC:
        raise HTTPException(413, "audio longer than 25 s")
    t = time.perf_counter()
    try:
        text = _infer(pcm)
    except Exception as e:  # noqa: BLE001
        log.exception("inference failed")
        raise HTTPException(500, f"inference failed: {e}")
    ms = int((time.perf_counter() - t) * 1000)
    log.info("%.1fs audio → %d ms: %s", sec, ms, text[:80])
    return JSONResponse({"text": text, "ms": ms, "seconds": round(sec, 2)})
