import express, { Router } from "express";
import { Recipe } from "../models/Recipe.js";
import { cached } from "../services/cache.js";

/**
 * Серверное распознавание речи (Whisper-совместимый API: Groq, OpenAI или свой сервер).
 *  STT_API_KEY   — ключ (без него распознавание отключено, клиент использует системное)
 *  STT_API_URL   — по умолчанию Groq: https://api.groq.com/openai/v1/audio/transcriptions
 *  STT_MODEL     — по умолчанию whisper-large-v3 (OpenAI: gpt-4o-transcribe или whisper-1)
 * Точность повышается словарём: в prompt передаются реальные названия блюд.
 */
const router = Router();
const KEY = process.env.STT_API_KEY;
const URL_ = process.env.STT_API_URL ?? "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = process.env.STT_MODEL ?? "whisper-large-v3";
/** GigaAM (services/stt-gigaam): основной движок для русского, если задан. Whisper — запасной. */
const GIGAAM_RAW = process.env.GIGAAM_URL?.trim().replace(/\/$/, "");
// Render отдаёт адрес приватного сервиса как host:port — добавляем схему
const GIGAAM_URL = GIGAAM_RAW ? (/^https?:\/\//.test(GIGAAM_RAW) ? GIGAAM_RAW : `http://${GIGAAM_RAW}`) : undefined;
const GIGAAM_TOKEN = process.env.STT_SERVICE_TOKEN ?? "";
const ENABLED = !!GIGAAM_URL || !!KEY;

router.get("/status", (_req, res) => res.json({ enabled: ENABLED, model: GIGAAM_URL ? "gigaam" : KEY ? MODEL : null, fallback: !!(GIGAAM_URL && KEY) }));

async function viaGigaAM(buf: Buffer): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(`${GIGAAM_URL}/transcribe`, { method: "POST", headers: { "Content-Type": "audio/wav", "X-STT-Token": GIGAAM_TOKEN }, body: new Uint8Array(buf), signal: ctrl.signal });
    if (!r.ok) throw new Error(`gigaam ${r.status}`);
    const j: any = await r.json();
    return String(j.text ?? "").trim();
  } finally { clearTimeout(t); }
}

/** Типичные «галлюцинации» Whisper на тишине/шуме — отбрасываем */
const HALLUCINATIONS = [
  /субтитр/i, /продолжение следует/i, /спасибо за просмотр/i, /подписывайтесь/i, /редактор субтитров/i,
  /корректор/i, /dimatorzok/i, /диматорзок/i, /до новых встреч/i, /thanks for watching/i, /amara\.org/i
];

function wavInfo(buf: Buffer): { ok: boolean; rate: number; samples: number } {
  if (buf.length < 64 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return { ok: false, rate: 0, samples: 0 };
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16 || rate < 8000 || rate > 48000) return { ok: false, rate, samples: 0 };
  return { ok: true, rate, samples: (buf.length - 44) / 2 };
}
function rmsDb(buf: Buffer): number {
  let s = 0; const n = Math.floor((buf.length - 44) / 2);
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(44 + i * 2) / 32768; s += v * v; }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
}

async function vocabulary(): Promise<string> {
  const { value } = await cached("voice:vocab", 600, async () => {
    const rows = await Recipe.find({ status: "published" }).select("name").limit(400).lean<any[]>();
    const names = rows.map((r) => String(r.name).replace(/^п\/ф\s*/i, "").trim());
    let out = "Кулинарные карточки ресторана. Названия блюд: ";
    for (const n of names) { if ((out + n).length > 700) break; out += n + ", "; }
    return out.replace(/, $/, ".");
  });
  return value;
}

router.post("/transcribe", express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "2mb" }), async (req, res) => {
  if (!ENABLED) return res.status(503).json({ error: "Серверное распознавание не настроено" });
  const buf = req.body as Buffer;
  const info = Buffer.isBuffer(buf) ? wavInfo(buf) : { ok: false, rate: 0, samples: 0 };
  if (!info.ok) return res.status(400).json({ error: "Нужен WAV PCM16 моно" });
  const seconds = info.samples / info.rate;
  if (seconds < 0.3) return res.json({ text: "", reason: "too-short" });
  if (seconds > 15) return res.status(413).json({ error: "Слишком длинная запись" });
  // тишина/шум без речи не отправляется провайдеру — так не появляются выдуманные фразы
  if (rmsDb(buf) < -55) return res.json({ text: "", reason: "silence" });

  const lang = String(req.query.lang ?? "ru").slice(0, 2);
  // GigaAM обучен на русском: используем его для ru, при сбое — Whisper (если задан ключ)
  if (GIGAAM_URL && lang !== "uz") {
    try {
      const text = await viaGigaAM(buf);
      return res.json({ text, alternatives: [], engine: "gigaam", reason: text ? undefined : "no-speech" });
    } catch (e: any) {
      console.error("voice/gigaam", e?.message);
      if (!KEY) return res.status(502).json({ error: "Сервис распознавания недоступен" });
    }
  }
  if (!KEY) return res.status(503).json({ error: "Распознавание для этого языка не настроено" });
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), "voice.wav");
    form.append("model", MODEL);
    form.append("language", lang === "uz" ? "uz" : "ru");
    form.append("temperature", "0");
    form.append("response_format", "verbose_json");
    form.append("prompt", await vocabulary());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: form, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      console.error("STT provider", r.status, (await r.text()).slice(0, 200));
      return res.status(502).json({ error: "Сервис распознавания недоступен" });
    }
    const j: any = await r.json();
    let text = String(j.text ?? "").trim();
    // сегменты с высокой вероятностью «не речи» — выбрасываем
    const segs: any[] = Array.isArray(j.segments) ? j.segments : [];
    if (segs.length && segs.every((s) => (s.no_speech_prob ?? 0) > 0.6)) text = "";
    if (HALLUCINATIONS.some((re) => re.test(text))) text = "";
    res.json({ text, alternatives: [], engine: "whisper", reason: text ? undefined : "no-speech" });
  } catch (e: any) {
    console.error("voice/transcribe", e?.message);
    res.status(502).json({ error: "Не удалось распознать" });
  }
});

export default router;
