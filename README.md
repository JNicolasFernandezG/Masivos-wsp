# Masivos-wsp

Sistema autoalojado para **recepción de mensajes en tiempo real** y **envío controlado de lotes pequeños (~25 mensajes)** en WhatsApp usando **WAHA** (`devlikeapro/waha`, motor **GOWS** sin navegador) y un backend + worker en **Node.js / TypeScript (Fastify + SQLite)**.

> **Advertencia sobre Términos de Servicio:** Al utilizar un puente no oficial de WhatsApp (dispositivo vinculado vía `whatsmeow`/GOWS), el riesgo de suspensión nunca es cero. Este proyecto implementa cola secuencial, jitter aleatorio (20–60 s), personalización por variables y límites de lote, pero depende también de usar una línea dedicada y previamente calentada.

## Arquitectura

- **`waha` (`devlikeapro/waha` con `WHATSAPP_DEFAULT_ENGINE=GOWS`)**: emula un dispositivo vinculado sin Chromium/Puppeteer, persiste sesión en volumen Docker (`waha_sessions`) y envía webhooks (`message`, `message.any`, `session.status`) hacia el backend.
- **`app` (Fastify + Worker + Panel Web)**:
  - **Panel web (`/`)**: vinculación QR / código telefónico, carga de Excel (`.xlsx`) o `.csv` (plantilla `telefono`, `nombre`, `observacion`), previsualización con normalización automática de teléfonos argentinos y monitor en tiempo real (SSE) de lotes y bandeja de mensajes entrantes.
  - **Cola SQLite (`node:sqlite` con WAL)**: almacena lotes (`batches`), mensajes salientes con número de tanda (`outbound_messages`), estado persistente del worker (`worker_state`), historial de mensajes/conversaciones (`messages`) y caché `@lid -> @c.us` (`lid_mappings`).
  - **Worker desacoplado (`BatchWorker`) — Perfil Moderado**:
    - Procesa **1 mensaje por vez** con jitter aleatorio de **20 a 60 s**.
    - Subdivide automáticamente archivos grandes en **tandas de 25** (`WORKER_CHUNK_SIZE=25`) con pausa de **45 a 60 min** entre tandas (`WORKER_CHUNK_PAUSE_MIN_MS`–`MAX_MS`).
    - Aplica **tope máximo diario de 125 envíos** (`WORKER_DAILY_LIMIT=125`).
    - **Prohíbe enviar fuera del horario comercial** (`09:00` a `19:00`, lunes a sábado en `America/Argentina/Buenos_Aires`).
  - **Normalización telefónica y JID**: limpia `tel:`, espacios, `0` inicial, `15` interno y errores comunes como `01111...` a `549...@c.us`; en webhooks convierte `@s.whatsapp.net` (incluidos sufijos `:0`) a `@c.us` y resuelve `@lid` vía `/api/{session}/lids/{lid}` de WAHA.

## Requisitos

- **Con Docker (recomendado para Windows Docker Desktop y VPS Linux):** Docker + Docker Compose.
- **Desarrollo local sin Docker:** Node.js `>= 24` (usa `node:sqlite` nativo).

## Puesta en marcha rápida (Docker Compose)

1. Copia el archivo de variables de entorno y edita las claves:

```bash
cp .env.example .env
```

En PowerShell (Windows):

```powershell
Copy-Item .env.example .env
```

Configura al menos `WAHA_API_KEY`, `WAHA_DASHBOARD_PASSWORD` y `WAHA_WEBHOOK_HMAC_KEY`. Si vas a exponer el panel en un VPS, define también `ADMIN_API_TOKEN`.

2. Levanta los servicios:

```bash
docker compose up -d --build
```

3. Abre el panel web en `http://localhost:8084` (o el puerto configurado en `APP_PORT`):
   - Ve a **Conexión WAHA / QR**, inicia la sesión si no arrancó sola y escanea el QR (o solicita código por teléfono).
   - Una vez que el estado sea `WORKING`, carga un lote desde **Nuevo Lote** o vía API REST.

Los datos persisten en:
- Volumen Docker `waha_sessions` (credenciales de WhatsApp sobre filesystem Linux nativo para evitar bloqueos SQLite en Windows)
- `./data/app/masivos.db` (base de datos SQLite)

## Desarrollo local y pruebas

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Si ejecutas solo la API sin worker embebido (`WORKER_ENABLED=false`), puedes correr el worker en otro proceso:

```bash
npm run build
npm run worker
```

## API REST principal

Si `ADMIN_API_TOKEN` está definido en `.env`, el panel web solicita esa clave en la pantalla de login (`POST /api/auth/login`, sesión por cookie `HttpOnly` de 12 h) y las integraciones externas pueden enviar `X-Admin-Token: <clave>` o `Authorization: Bearer <clave>` en `/api/*` (excepto `/api/health`, `/api/auth/*` y `/api/webhooks/waha`, que valida `X-Webhook-Hmac` con SHA-512).

- `GET /api/health` — Estado de DB, conectividad con WAHA y estado del worker.
- `GET /api/waha/session` / `POST /api/waha/session/start` / `GET /api/waha/qr` — Control de sesión y QR.
- `POST /api/batches/parse-file` — Parsea `.xlsx` o `.csv` (multipart `file`).
- `POST /api/batches/preview` — Valida teléfonos, renderiza plantilla y calcula duración estimada.
- `POST /api/batches` — Encola un lote nuevo. Ejemplo JSON para integración externa:

```json
{
  "name": "Deudas Asistodo",
  "template": "Usted, {{nombre}} registra deuda con Asistodo, regularice enviando un mensaje de whatsapp al 1176560109",
  "defaultCountryCode": "549",
  "messages": [
    {
      "to": "01144045549",
      "variables": {
        "nombre": "Ana Pérez",
        "observacion": "Aviso 1"
      }
    }
  ]
}
```

- `GET /api/batches/sample.xlsx` — Descarga de plantilla modelo vacía (`telefono`, `nombre`, `observacion`).
- `GET /api/batches` / `GET /api/batches/:id` — Listado y detalle de envíos.
- `POST /api/batches/:id/{pause|resume|cancel|retry-failed}` — Control operativo del lote.
- `DELETE /api/batches/history` — Limpia lotes finalizados (`COMPLETADO`, `COMPLETADO_CON_ERRORES`, `CANCELADO`) preservando la cuota diaria anti-baneo y compactando SQLite (`VACUUM`).
- `GET /api/conversations` / `GET /api/messages` — Historial de mensajes recibidos y enviados.
- `DELETE /api/messages/history` — Limpia el historial de mensajes/conversaciones almacenados y compacta SQLite (`VACUUM`).
- `POST /api/messages/reply` — Envía respuesta puntual `{ "chatId": "5491112345678@c.us", "text": "..." }`.
- `POST /api/webhooks/waha` — Receptor de eventos WAHA (`message`, `message.any`, `session.status`).
- `GET /api/events` — Stream SSE para actualizaciones en tiempo real.

## Reglas anti-baneo activas

1. **Jitter entre mensajes:** 20–60 s (`WORKER_MIN_DELAY_MS=20000`, `WORKER_MAX_DELAY_MS=60000`).
2. **Tandas automáticas:** 25 mensajes por tanda con pausa de 45–60 min entre tandas (`WORKER_CHUNK_SIZE=25`).
3. **Tope diario y horario comercial:** máximo 125 envíos/día (`WORKER_DAILY_LIMIT=125`) y prohibido enviar fuera de `09:00–19:00` (`BUSINESS_HOURS_ENABLED=true`).
4. Usa un número dedicado (nunca el principal de la empresa) y realiza calentamiento gradual durante 1–2 semanas antes de enviar lotes.

## Despliegue detrás de tu Nginx existente (puerto `8084` directo en `app`)

1. `masivos-waha` no expone puertos al host; únicamente `masivos-app` publica `APP_PORT` (`8084` por defecto, mapeado al puerto interno `4000`).
2. En el `.env` / `ENV_PROD` del servidor Linux:
   - `APP_PORT=8084` (o `APP_BIND_HOST=127.0.0.1` si Nginx corre en el mismo servidor).
   - `AUTH_REQUIRED=true` y un `ADMIN_API_TOKEN` seguro.
3. En tu Nginx ya existente, apunta el `proxy_pass` hacia `http://127.0.0.1:8084` (desactivando `proxy_buffering off` en `/api/events` para SSE y reenviando `X-Forwarded-For` + `X-Forwarded-Proto`).

## CI/CD con GitHub Actions

- **Pipeline unificado ([.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml)):**
  - Job **`verify` (`ubuntu-latest`):** corre `npm ci`, `typecheck`, `test`, `build`, validación de `docker-compose.yml` y build de las imágenes Docker (`app` y `waha`).
  - Job **`deploy` (`self-hosted`):** corre después de que pase `verify` en `push` a `main` o manualmente desde **Run workflow** (`workflow_dispatch`):
    - Crea el secreto `ENV_PROD` en *Settings → Secrets and variables → Actions → Secrets* con todo el contenido de tu `.env` de producción.
    - Opcionalmente define la variable `DEPLOY_PATH` en *Variables* (por defecto `/opt/masivos-wsp`).
    - El workflow actualiza el código (`git fetch` + `git reset --hard origin/main`), genera `.env` temporal (`chmod 600`), ejecuta `docker compose up -d --build --remove-orphans`, borra `.env` del disco inmediatamente (`rm -f .env`) y limpia imágenes obsoletas (`docker image prune -f`).
