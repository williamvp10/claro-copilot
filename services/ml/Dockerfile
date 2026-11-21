FROM python:3.12-slim
WORKDIR /srv/ml
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.7.12 && uv sync --frozen --no-dev --no-install-project
COPY app ./app
ENV PATH="/srv/ml/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
