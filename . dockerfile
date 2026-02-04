FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
  ghostscript \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server.py .

CMD ["python3", "server.py"]
