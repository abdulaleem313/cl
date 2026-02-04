FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    ghostscript \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server.py .

ENV PORT=8080

CMD ["python3", "server.py"]
