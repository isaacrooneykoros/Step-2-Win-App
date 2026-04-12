# ---------------------------------------------------------------------------
# Step2Win Backend — Docker image
# Compatible with Railway, Fly.io, Koyeb, and any Docker-based host.
# ---------------------------------------------------------------------------
FROM python:3.11.9-slim

# System dependencies required by psycopg2 and Pillow
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev gcc libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directories that Django/WhiteNoise need at runtime
RUN mkdir -p staticfiles media

EXPOSE 8000

# render-start.sh runs: migrate → check --deploy → gunicorn
# PORT is injected by the hosting platform (defaults to 8000).
CMD ["bash", "render-start.sh"]
