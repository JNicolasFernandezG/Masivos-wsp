#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [ ! -f ".env" ]; then
  echo "[deploy] ERROR: falta el archivo .env en $APP_DIR" >&2
  exit 1
fi
chmod 600 .env

echo "[deploy] Actualizando codigo desde origin/main..."
git fetch origin main
git checkout main
git pull --ff-only origin main

echo "[deploy] Reconstruyendo y levantando contenedores..."
mkdir -p data/app
docker compose up -d --build --remove-orphans

PORT_VALUE="$(grep -E '^CADDY_PORT=' .env | cut -d '=' -f2- | tr -d '\r' || true)"
PORT_VALUE="${PORT_VALUE:-8084}"

echo "[deploy] Verificando salud en http://127.0.0.1:${PORT_VALUE}/api/health ..."
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health" >/dev/null 2>&1; then
    echo "[deploy] Despliegue exitoso y servicio healthy."
    exit 0
  fi
  sleep 3
done

echo "[deploy] ERROR: la app no respondio /api/health a tiempo." >&2
docker compose logs --tail=50 app caddy
exit 1
