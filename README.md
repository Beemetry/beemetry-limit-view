# Sistema de Monitoreo BEEMETRY

Aplicacion web para visualizar lecturas de fibra optica, configurar umbrales de alerta y publicar alarmas por Modbus TCP.

## Requisitos

- Node.js instalado
- PowerShell
- Acceso a la carpeta de datos de fibra
- Opcional: `cloudflared` para publicar el sistema online

## Instalacion

Desde la carpeta del proyecto:

```powershell
npm install
```

## Configuracion

Crear o revisar el archivo `.env` en la raiz del proyecto.

Ejemplo base:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
FIBER_MONITOR_PORT=4174
VITE_CH1_API=http://localhost:4174
FIBER_LENGTH_DM=800
FIBER_SPATIAL_RES_CM_X10=52
FIBER_TOTAL_POINTS=30770
MODBUS_ENABLED=true
MODBUS_HOST=0.0.0.0
MODBUS_PORT=502
MODBUS_UNIT_ID=1
MODBUS_IGNORE_UNIT_ID=true
MODBUS_MAX_PENDING_BATCHES=200
MODBUS_EVENT_RANGE_SNAPSHOT_LIMIT=80
MODBUS_EVENT_PEAK_SNAPSHOT_LIMIT=80
```

Si los datos no estan en la ruta por defecto `src/Fibra Exportada`, agregar:

```env
FIBER_MONITOR_DATA_ROOT=C:\ruta\a\la\carpeta\de\datos
```

## Ejecutar Localmente

Usar dos terminales.

Terminal 1, backend/API/Modbus:

```powershell
node server.js
```

Terminal 2, frontend:

```powershell
npm run dev
```

Abrir la URL que indique Vite, normalmente:

```text
http://localhost:5173
```

## Verificar Estado

Estado general:

```powershell
powershell -Command "(Invoke-RestMethod http://localhost:4174/api/monitor-state) | ConvertTo-Json -Depth 4"
```

Estado Modbus:

```powershell
powershell -Command "(Invoke-RestMethod http://localhost:4174/api/monitor-state).modbus | Select-Object started,online,lastError,connectedClients,pendingBatches,totalActiveAlarms,newDataReady"
```

Puerto Modbus `502`:

```powershell
netstat -ano | findstr :502
```

Procesos Node activos:

```powershell
tasklist | findstr node
```

## Publicar Online con Cloudflare Tunnel

Instalar `cloudflared`:

```powershell
winget install --id Cloudflare.cloudflared
```

Cerrar y abrir PowerShell nuevamente. Verificar:

```powershell
cloudflared --version
```

Si PowerShell no reconoce el comando, usar:

```powershell
& "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe" --version
```

### 1. Levantar Backend

Terminal 1:

```powershell
node server.js
```

### 2. Publicar Backend

Terminal 2:

```powershell
cloudflared tunnel --url http://localhost:4174
```

Cloudflare entregara un link similar a:

```text
https://backend-ejemplo.trycloudflare.com
```

Actualizar `.env` reemplazando:

```env
VITE_CH1_API=http://localhost:4174
```

por el link del backend:

```env
VITE_CH1_API=https://backend-ejemplo.trycloudflare.com
```

### 3. Levantar Frontend

Terminal 3:

```powershell
npm run dev
```

### 4. Publicar Frontend

Terminal 4:

```powershell
cloudflared tunnel --url http://localhost:5173
```

Cloudflare entregara otro link similar a:

```text
https://frontend-ejemplo.trycloudflare.com
```

Ese es el link que se comparte para acceder a la web.

## Importante Sobre Cloudflare

- Mantener abiertas las ventanas de PowerShell donde corren los tuneles.
- Si se cierra el tunel del backend, el frontend mostrara `Failed to fetch`.
- Si Cloudflare genera un nuevo link para el backend, actualizar `VITE_CH1_API` y reiniciar `npm run dev`.
- Si solo se publica el frontend, otros usuarios no podran consultar la API porque `localhost` apuntaria a sus propias PCs.

## Reinicio Rapido

Detener procesos Node:

```powershell
taskkill /IM node.exe /F
```

Volver a levantar:

```powershell
node server.js
```

```powershell
npm run dev
```

## Build

Para generar la version de produccion:

```powershell
npm run build
```
