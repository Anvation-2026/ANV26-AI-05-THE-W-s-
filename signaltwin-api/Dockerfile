# SignalTwin API. Not built or run in the repository's own checks (no Docker on the author's machine), see docs/DEPLOYMENT.md.
FROM python:3.11-slim AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# CPU-only PyTorch keeps the image a few hundred MB instead of several GB. Use the default index for a GPU image.
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY pyproject.toml ./
COPY src ./src
RUN pip install ".[vision]"

# Model weights: downloaded at build time so the container works offline. Replace with your own model if you have one.
RUN mkdir -p models && curl -fsSL -o models/yolo11n.pt https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.pt

RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown -R app /data /app
USER app
ENV DATA_DIR=/data DETECTOR=yolo MODEL_WEIGHTS=/app/models/yolo11n.pt
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/v1/health', timeout=4).status == 200 else 1)"
# One process: the API starts its own analysis workers. Scale by running more containers behind a queue, not --workers.
CMD ["uvicorn", "signaltwin_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
