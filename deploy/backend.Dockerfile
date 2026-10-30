FROM python:3.13-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends antiword && rm -rf /var/lib/apt/lists/*
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir uv==0.12.13
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/medvisit ./medvisit
COPY backend/migrations ./migrations
RUN useradd --uid 10001 --user-group --create-home app && install -d -m 0700 -o app -g app /app/data/sessions
USER app
EXPOSE 8000
CMD ["uvicorn", "medvisit.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws-max-size", "4096", "--ws-max-queue", "16", "--timeout-graceful-shutdown", "45", "--no-access-log"]
