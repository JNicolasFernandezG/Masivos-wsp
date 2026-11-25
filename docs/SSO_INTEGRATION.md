# Guía de integración SSO hacia Masivos-wsp (JWT HS256)

Esta guía define todo lo que debe configurar la **aplicación de origen** para agregar un botón de acceso directo (**SSO**) hacia **Masivos-wsp** y saltear la pantalla de login de forma segura.

---

## 1. Cómo funciona el flujo

1. El usuario ya está autenticado en tu aplicación y tiene permiso para usar WhatsApp Masivo.
2. El usuario hace clic en el botón **"Abrir WhatsApp Masivo"**, que apunta a una ruta de **tu propio backend** (por ejemplo `/sso/masivos`, abierta en nueva pestaña `target="_blank"`).
3. Tu **backend** firma un **JWT `HS256`** con vigencia corta (**60 segundos**) y un `jti` único (**un solo uso**) usando la variable compartida `SSO_SECRET`, y redirige al navegador hacia `Masivos-wsp`.
4. `Masivos-wsp` valida la firma con el mismo `SSO_SECRET`, invalida ese `jti` (para que el enlace no pueda reutilizarse), emite su cookie de sesión (`masivos_session`, `HttpOnly`, `SameSite=Lax`, 12 h) y redirige a `/` ya logueado.

> **Seguridad:** Nunca pongas `SSO_SECRET` en el frontend (JS del navegador) ni lo subas a un repositorio Git. Solo debe existir en el archivo `.env` / variables de entorno del backend de ambas aplicaciones.

---

## 2. Configuración en `.env` (en ambas aplicaciones)

Ambos backends deben configurar exactamente el mismo valor en `SSO_SECRET` (te lo entregamos por canal privado; no lo commitees al repositorio):

### En tu aplicación (app de origen)
```env
SSO_SECRET=<PEGA_AQUI_EL_SSO_SECRET_COMPARTIDO>
MASIVOS_BASE_URL=https://tu-dominio-masivos
```

### En Masivos-wsp (nuestro lado, ya soportado)
```env
SSO_SECRET=<MISMO_SSO_SECRET_COMPARTIDO>
SSO_MAX_TTL_SECONDS=300
# Opcional: si queremos restringir el emisor (claim "iss")
SSO_ALLOWED_ISSUER=
```

---

## 3. Especificación exacta del token JWT (`HS256`)

El token debe ser un **JWT estándar** (`header.payload.signature`) codificado en **Base64URL** (sin padding `=`):

### Header
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```
*(Solo se acepta `HS256`; cualquier otro algoritmo es rechazado.)*

### Payload (claims)

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `sub` | `string` | **Sí** | Identificador del usuario autenticado en tu app (email, username o ID; máx. 200 caracteres). Se registra en logs de auditoría. |
| `jti` | `string` | **Sí** | Identificador **único aleatorio** generado en cada clic (ej. UUID v4; máx. 128 caracteres). Garantiza **un solo uso** (evita reutilización del enlace). |
| `exp` | `number` | **Sí** | Timestamp Unix (en **segundos**) de expiración. **Recomendado:** `ahora + 60`. Se rechazan tokens vencidos o con vigencia mayor a `SSO_MAX_TTL_SECONDS` (300 s por defecto). |
| `iat` | `number` | Recomendado | Timestamp Unix (en **segundos**) de emisión (`Math.floor(Date.now() / 1000)`). |
| `iss` | `string` | Condicional | Nombre de tu app. Obligatorio únicamente si acordamos configurar `SSO_ALLOWED_ISSUER`. |

### Firma
```text
HMAC_SHA256(key = SSO_SECRET, message = base64url(header) + "." + base64url(payload))
```
codificada en **Base64URL** sin `=`.

---

## 4. Cómo conectar el botón y redirigir

### Botón en tu frontend (HTML)
```html
<a href="/sso/masivos" target="_blank" rel="noopener">
  Abrir WhatsApp Masivo
</a>
```

### Endpoint en tu backend (`/sso/masivos`)
Valida que el usuario tenga sesión activa y permisos, firma el JWT y redirige usando una de estas dos formas (ambas soportadas por Masivos-wsp):

#### Opción 1 — Redirección `GET` (más simple)
```text
HTTP 302 Location: https://tu-dominio-masivos/api/auth/sso?token=<JWT_FIRMADO>
```
`Masivos-wsp` responde `302` hacia `/` con `Cache-Control: no-store` y `Referrer-Policy: no-referrer`, limpiando el token de la barra de direcciones.

#### Opción 2 — Formulario auto-enviado `POST` (recomendado si quieres evitar el token en logs de URL)
```html
<!DOCTYPE html>
<html>
  <body>
    <form id="sso" method="POST" action="https://tu-dominio-masivos/api/auth/sso">
      <input type="hidden" name="token" value="<JWT_FIRMADO>" />
    </form>
    <script>document.getElementById('sso').submit();</script>
  </body>
</html>
```
`Masivos-wsp` procesa `application/x-www-form-urlencoded` (y `application/json`), crea la cookie y responde `303 See Other` hacia `/`.

---

## 5. Ejemplos listos para copiar (Backend de la app de origen)

### Node.js (sin dependencias externas)

```js
import crypto from 'node:crypto';

export function buildMasivosSsoUrl(userIdentifier) {
  const secret = process.env.SSO_SECRET;
  const baseUrl = process.env.MASIVOS_BASE_URL; // ej: https://masivos.tuempresa.com
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(userIdentifier),
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 60,
      // iss: 'mi-portal', // solo si se acordó SSO_ALLOWED_ISSUER
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  const token = `${header}.${payload}.${signature}`;
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/sso?token=${encodeURIComponent(token)}`;
}

// Ejemplo Express:
// app.get('/sso/masivos', requireAuth, (req, res) => {
//   res.redirect(302, buildMasivosSsoUrl(req.user.email));
// });
```

### Node.js (con `jsonwebtoken`)

```js
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { sub: req.user.email, jti: crypto.randomUUID() },
  process.env.SSO_SECRET,
  { algorithm: 'HS256', expiresIn: '60s' }
);

res.redirect(302, `${process.env.MASIVOS_BASE_URL.replace(/\/+$/, '')}/api/auth/sso?token=${encodeURIComponent(token)}`);
```

### Python (FastAPI / Flask / Django con `PyJWT`)

```python
import os, time, uuid, jwt
from urllib.parse import urlencode

def build_masivos_sso_url(user_id: str) -> str:
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": str(user_id),
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + 60,
        },
        os.environ["SSO_SECRET"],
        algorithm="HS256",
    )
    base_url = os.environ["MASIVOS_BASE_URL"].rstrip("/")
    return f"{base_url}/api/auth/sso?{urlencode({'token': token})}"
```

### PHP (sin dependencias externas)

```php
<?php
function base64url_encode(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function buildMasivosSsoUrl(string $userId): string {
    $secret  = getenv('SSO_SECRET');
    $baseUrl = rtrim(getenv('MASIVOS_BASE_URL'), '/');
    $now     = time();
    $jti     = bin2hex(random_bytes(16));

    $header  = base64url_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload = base64url_encode(json_encode([
        'sub' => $userId,
        'jti' => $jti,
        'iat' => $now,
        'exp' => $now + 60,
    ]));

    $sig = base64url_encode(hash_hmac('sha256', "$header.$payload", $secret, true));
    $token = "$header.$payload.$sig";

    return "$baseUrl/api/auth/sso?token=" . rawurlencode($token);
}
```

### C# / .NET

```csharp
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

string BuildMasivosSsoUrl(string userId, string ssoSecret, string masivosBaseUrl)
{
    var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(ssoSecret));
    var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
    var now = DateTime.UtcNow;

    var jwt = new JwtSecurityToken(
        claims: new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, userId),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new Claim(JwtRegisteredClaimNames.Iat, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
        },
        expires: now.AddSeconds(60),
        signingCredentials: creds
    );

    var token = new JwtSecurityTokenHandler().WriteToken(jwt);
    return $"{masivosBaseUrl.TrimEnd('/')}/api/auth/sso?token={Uri.EscapeDataString(token)}";
}
```

---

## 6. Reglas importantes y solución de problemas

1. **No abrir dentro de un `<iframe>`:** Masivos-wsp envía `X-Frame-Options: DENY` y `Content-Security-Policy: frame-ancestors 'none'`, y la cookie usa `SameSite=Lax`. Usa redirección normal o nueva pestaña (`target="_blank"`).
2. **Validación previa en la app de origen:** Tu ruta `/sso/masivos` debe verificar sesión y permisos antes de firmar el token.
3. **Reloj sincronizado (NTP):** Ambos servidores deben tener hora sincronizada (la tolerancia de desfasaje en `iat` es de 30 s).
4. **HTTPS en producción:** Necesario para proteger el token en tránsito y activar el flag `Secure` en la cookie `masivos_session`.
5. **Códigos de error (`/?sso_error=...`):** Si el SSO falla, Masivos-wsp muestra el motivo en el login:
   - `expired` → El token superó su `exp` (> 60 s).
   - `used` → El `jti` ya fue utilizado (se reutilizó o recargó el mismo link).
   - `invalid` → `SSO_SECRET` distinto, firma inválida, algoritmo distinto de `HS256`, `exp` mayor a `SSO_MAX_TTL_SECONDS`, falta `sub`/`jti` o `iss` no autorizado.
   - `disabled` → Falta configurar `SSO_SECRET` en Masivos-wsp.
   - `rate_limited` → Más de 5 intentos SSO fallidos desde la misma IP en 5 minutos.
