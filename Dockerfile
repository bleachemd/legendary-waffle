FROM python:3.11-slim

# System deps for audio (PortAudio) and building native extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    portaudio19-dev \
    libsndfile1 \
    pulseaudio-utils \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so layer is cached when only code changes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download the sentence-transformers embedding model at build time
# so the first startup is instant (no network needed at runtime)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

COPY python/ ./python/

WORKDIR /app/python

ENV WS_MODE=true
ENV WS_HOST=0.0.0.0
ENV WS_PORT=8765
ENV PYTHONUNBUFFERED=1

EXPOSE 8765

CMD ["python3", "main.py"]
