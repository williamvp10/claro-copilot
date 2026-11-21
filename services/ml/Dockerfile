FROM python:3.12-slim AS builder
WORKDIR /srv/ml
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.13.4 && uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim AS runtime
WORKDIR /srv/ml
COPY --from=builder /srv/ml/.venv /srv/ml/.venv
COPY app ./app
ENV PATH="/srv/ml/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
