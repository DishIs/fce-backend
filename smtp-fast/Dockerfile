# Haraka Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    sed \
    supervisor \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /maildrop

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY src ./src
COPY entrypoint.sh stop-supervisor.sh .
RUN chmod +x ./entrypoint.sh ./stop-supervisor.sh

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

RUN useradd --system --no-create-home smtp \
 && chown -R smtp:smtp /maildrop

EXPOSE 25 465 587
ENTRYPOINT ["./entrypoint.sh"]
