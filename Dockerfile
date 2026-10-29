# VideoArtifex with everything it needs: ffmpeg, Node, and faster-whisper with a
# whisper model baked in, so transcription works offline.
#
#   docker build -t videoartifex .
#   docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" videoartifex auto demo.mp4
#   docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" -p 17211:17211 videoartifex ui --host 0.0.0.0
FROM docker.io/library/node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version && ffprobe -version

COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /usr/local/bin/
ENV HF_HOME=/opt/hf

# Install faster-whisper once into the system Python (no cache copy) and
# download the model. Override with --build-arg WHISPER_MODEL=small for better
# accuracy at the cost of a bigger image.
ARG WHISPER_MODEL=base
RUN uv pip install --system --break-system-packages --no-cache faster-whisper \
 && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', compute_type='int8')" \
 && chmod -R a+rwX /opt/hf

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src src
COPY scripts scripts
RUN npm ci && npm run build && npm prune --omit=dev

WORKDIR /work
EXPOSE 17211
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
