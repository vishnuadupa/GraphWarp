FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8001
# Shell form (not exec form) so $PORT expands — Railway injects its own port,
# local docker-compose leaves it unset and falls back to 8001.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8001}
