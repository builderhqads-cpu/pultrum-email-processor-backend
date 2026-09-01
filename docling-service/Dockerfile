FROM python:3.11-slim

# System libs docling's backends expect (image handling / rendering). Minimal set.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

# Model cache lives here. Mount a volume at /models so the models (~GBs) are
# downloaded once and survive container recreates instead of re-downloading.
ENV HF_HOME=/models/hf \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
