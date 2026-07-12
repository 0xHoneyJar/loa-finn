# The cg engine is Linux x86-64 native (libcg.so) — python:3.12 (Debian) runs it as Kaggle does.
FROM python:3.12
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
