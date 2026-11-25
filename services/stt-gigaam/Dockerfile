# GigaAM STT (CPU). Образ ~2 ГБ; модель скачивается при сборке, поэтому холодный старт быстрый.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# torch CPU-сборка (без CUDA — в 4 раза меньше)
RUN pip install --no-cache-dir torch==2.6.* torchaudio==2.6.* --index-url https://download.pytorch.org/whl/cpu
# GigaAM закреплён на проверенном коммите
ARG GIGAAM_REF=7447938d791c4f3e643386ee22c33777004293a5
RUN pip install --no-cache-dir "gigaam @ git+https://github.com/salute-developers/GigaAM@${GIGAAM_REF}"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ARG GIGAAM_MODEL=v3_e2e_rnnt
ENV GIGAAM_MODEL=${GIGAAM_MODEL} GIGAAM_CACHE=/models GIGAAM_DEVICE=cpu
RUN python -c "import gigaam,os; gigaam.load_model(os.environ['GIGAAM_MODEL'], device='cpu', download_root='/models')"
COPY app.py .
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)"
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
