# Masivos-wsp

Sistema autoalojado para **recepción de mensajes en tiempo real** y **envío controlado de lotes pequeños (~25 mensajes)** en WhatsApp usando **WAHA** (`devlikeapro/waha`, motor **GOWS** sin navegador) y un backend + worker en **Node.js / TypeScript (Fastify + SQLite)**.

> **Advertencia sobre Términos de Servicio:** Al utilizar un puente no oficial de WhatsApp (dispositivo vinculado vía `whatsmeow`/GOWS), el riesgo de suspensión nunca es cero. Este proyecto implementa cola secuencial, jitter aleatorio (20–60 s), personalización por variables y límites de lote, pero depende también de usar una línea dedicada y previamente calentada.

## Arquitectura

- **`waha` (`devlikeapro/waha` con `WHATSAPP_DEFAULT_ENGINE=GOWS`)**: emula un dispositivo vinculado sin Chromium/Puppeteer, persiste sesión en `./data/waha/sessions` y envía webhooks (`message`, `message.any`, `session.status`) hacia el backend.
- **`app` (Fastify + Worker + Panel Web)**:
  - **Panel web (`/`)**: vinculación QR / código telefónico, carga de Excel (`.xlsx`) o `.csv` con previsualización, monitor en tiempo real (SSE) de lotes y bandeja de mensajes entrantes con respuesta directa.
  - **Cola SQLite (`node:sqlite` con WAL)**: almacena lotes (`batches`) y mensajes (`outbound_messages`) como `PENDIENTE`, `PROCESANDO`, `ENVIADO`, `ERROR` o `CANCELADO`, además del historial de mensajes/conversaciones (`messages`) y caché `@lid -> @c.us` (`lid_mappings`).
  - **Worker desacoplado (`BatchWorker`)**: procesa **1 mensaje por vez**, verifica que la sesión esté en `WORKING`, aplica **jitter aleatorio de 20 a 60 segundos** entre mensajes y recupera ítems `PROCESANDO` si el proceso se reinicia.
  - **Normalización JID**: convierte `@s.whatsapp.net` (incluidos sufijos multi-dispositivo `:0`) a `@c.us` y resuelve `@lid` vía `/api/{session}/lids/{lid}` de WAHA.

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

3. Abre el panel web en `http://localhost:4000` (o el puerto configurado en `APP_PORT`):
   - Ve a **Conexión WAHA / QR**, inicia la sesión si no arrancó sola y escanea el QR (o solicita código por teléfono).
   - Una vez que el estado sea `WORKING`, carga un lote desde **Nuevo Lote (~25)** o vía API REST.

Los datos persisten en:
- `./data/waha/sessions` (credenciales de WhatsApp para no reescanear QR)
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

Si `ADMIN_API_TOKEN` está definido, envía `X-Admin-Token: <token>` o `Authorization: Bearer <token>` en `/api/*` (excepto `/api/health` y `/api/webhooks/waha`, que valida `X-Webhook-Hmac` con SHA-512).

- `GET /api/health` — Estado de DB, conectividad con WAHA y estado del worker.
- `GET /api/waha/session` / `POST /api/waha/session/start` / `GET /api/waha/qr` — Control de sesión y QR.
- `POST /api/batches/parse-file` — Parsea `.xlsx` o `.csv` (multipart `file`).
- `POST /api/batches/preview` — Valida teléfonos, renderiza plantilla y calcula duración estimada.
- `POST /api/batches` — Encola un lote nuevo. Ejemplo JSON para integración externa:

```json
{
  "name": "Cobranzas 18/11",
  "template": "Hola {{nombre}}, te recordamos la gestión {{nro_gestion}} por {{monto}}.",
  "defaultCountryCode": "549",
  "messages": [
    {
      "to": "1112345678",
      "variables": {
        "nombre": "Ana",
        "nro_gestion": "G-1042",
        "monto": "$ 45.000"
      }
    }
  ]
}
```

- `GET /api/batches` / `GET /api/batches/:id` — Listado y detalle de envíos.
- `POST /api/batches/:id/{pause|resume|cancel|retry-failed}` — Control operativo del lote.
- `GET /api/conversations` / `GET /api/messages` — Historial de mensajes recibidos y enviados.
- `POST /api/messages/reply` — Envía respuesta puntual `{ "chatId": "5491112345678@c.us", "text": "..." }`.
- `POST /api/webhooks/waha` — Receptor de eventos WAHA (`message`, `message.any`, `session.status`).
- `GET /api/events` — Stream SSE para actualizaciones en tiempo real.

## Reglas anti-baneo recomendadas

1. Mantén `WORKER_MIN_DELAY_MS=20000` y `WORKER_MAX_DELAY_MS=60000` (20–60 s entre mensajes).
2. Envía lotes pequeños (~25 mensajes) a contactos con relación previa y textos personalizados.
3. Usa un número dedicado (nunca el principal de la empresa) y realiza calentamiento gradual durante 1–2 semanas antes de enviar lotes.
