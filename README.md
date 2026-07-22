# Gestión Restaurante — Plataforma de gestión integral (MVP)

Aplicación web para gestionar las operaciones diarias de un restaurante: ventas y pedidos (POS), salón y mesas, cocina (KDS), menú/productos, usuarios y roles, pagos y descuentos. Está pensada como punto de partida real y funcional, con arquitectura preparada para crecer hacia las fases que todavía no están implementadas (inventario, clientes, delivery externo, caja/arqueos formales, reportes con gráficos, multi-sucursal completo).

Se probó de punta a punta (backend con pruebas de API y frontend con pruebas automatizadas de navegador) antes de la entrega: login, creación de pedidos, modificadores/variantes, envío a cocina, cambios de estado en cocina, descuentos, pagos divididos, cierre de mesa, y administración de productos/usuarios/salón, incluyendo el control de permisos por rol.

## Qué incluye esta primera versión (MVP)

- **Usuarios, roles y permisos**: Administrador, Dueño/Gerente, Encargado, Cajero, Mozo, Cocina. Cada rol tiene permisos específicos definidos en `backend/src/lib/permissions.js`. Todas las acciones relevantes (crear pedido, cancelar un ítem, aplicar descuento, cobrar, etc.) quedan registradas en una tabla de auditoría (`audit_logs`) con usuario, acción y fecha.
- **Menú y productos**: categorías, productos, variantes (tamaños), grupos de modificadores/adicionales (obligatorios u opcionales, con mínimos y máximos), estaciones de preparación (cocina, barra, postres, etc.), activar/desactivar productos.
- **Salón y mesas**: múltiples salones, mesas con posición configurable en un plano visual, estados (libre, ocupada, reservada, pendiente de pago), transferencia de pedido entre mesas.
- **Punto de venta (POS) y pedidos**: pedidos para salón, retiro o delivery; agregar/editar productos con variantes, adicionales y observaciones; envío de la comanda a cocina; descuentos con motivo; anulación de ítems y de pedidos completos (con permiso y motivo, quedando en la auditoría); múltiples medios de pago por pedido (permite dividir la cuenta); cierre de pedido que libera la mesa.
- **Cocina (KDS)**: tablero de comandas agrupado por estación, ordenado por antigüedad, con botones para avanzar el estado (pendiente → en preparación → listo → entregado) y actualización en tiempo real.
- **Tiempo real**: los cambios de pedidos, mesas y comandas se sincronizan al instante entre las pantallas de POS, salón y cocina usando WebSockets (Socket.IO), sin necesidad de recargar la página.

## Qué falta para el alcance completo de la consigna (próximas fases)

El desarrollo se hizo en fases para entregar primero un núcleo sólido y probado. Todavía no están implementados (y quedan como próximos pasos naturales sobre esta misma base de datos y arquitectura):

1. **Inventario**: registro de insumos, recetas por producto, descuento automático de stock al vender, alertas de stock mínimo, compras y proveedores.
2. **Clientes (CRM)**: ficha de cliente, historial de pedidos, frecuencia de compra, preferencias.
3. **Delivery externo**: asignación de repartidor, cálculo de costo de envío, integraciones con plataformas externas vía API.
4. **Caja formal**: apertura/cierre de caja, arqueos, ingresos y egresos manuales, control de diferencias.
5. **Reportes y estadísticas**: ventas por período/producto/categoría/empleado/medio de pago, horarios pico, rentabilidad, con gráficos y filtros por fecha.
6. **Multi-sucursal completo**: la base de datos ya tiene `branch_id` en las tablas principales, pero falta la interfaz para crear sucursales, cambiar de sucursal activa y comparar rendimiento entre ellas.

## Arquitectura técnica

- **Backend**: Node.js + Express. Acceso a base de datos con SQL directo (librería `pg`), sin ORM, para minimizar dependencias externas. WebSockets con Socket.IO para tiempo real.
- **Base de datos**: PostgreSQL. El esquema completo está en `backend/src/db/schema.sql` (tablas, tipos enumerados, índices).
- **Frontend**: HTML/CSS/JavaScript sin frameworks ni paso de compilación (fácil de leer, modificar y desplegar). El propio backend sirve estos archivos como estáticos, así que **todo el proyecto se despliega como un solo servicio**.
- **Autenticación**: JWT (JSON Web Token) con contraseñas hasheadas (bcrypt).
- **Permisos**: matriz de permisos por rol en el backend (`backend/src/lib/permissions.js`), aplicada en cada endpoint mediante middleware. El frontend también oculta acciones según el rol, pero la validación real y obligatoria ocurre siempre en el backend.

Estructura de carpetas:

```
restaurante-app/
  backend/
    src/
      db/            esquema SQL, pool de conexión, scripts de migración/seed/reset
      lib/            permisos, auditoría, helpers
      middleware/     autenticación y autorización
      routes/         auth, menu, tables (salón/mesas), orders (POS), kitchen (KDS)
      sockets/        (reservado para lógica de tiempo real adicional)
      index.js         servidor Express + Socket.IO + sirve el frontend
    package.json
    .env.example
  frontend/
    index.html         login
    pages/
      salon.html        plano visual del salón y las mesas
      pos.html           punto de venta / comanda de un pedido
      pedidos.html       listado de pedidos (útil para retiro/delivery sin mesa)
      cocina.html        tablero de cocina (KDS)
      admin.html          administración: productos, categorías, adicionales, estaciones, salón/mesas, usuarios
    css/styles.css
    js/                 cliente API, utilidades de interfaz, socket.io (vendorizado)
```

## Requisitos

- Node.js 18 o superior.
- PostgreSQL 13 o superior (local, en Docker, o un servicio administrado como Render/Railway/Supabase/Neon).

## Instalación y ejecución local

1. Instalar PostgreSQL si no lo tenés, y crear una base de datos vacía, por ejemplo `restaurante`.
2. Entrar a la carpeta del backend e instalar dependencias:

   ```bash
   cd backend
   npm install
   ```

3. Copiar `.env.example` a `.env` y completar `DATABASE_URL` con los datos de tu base de datos (usuario, contraseña, host, puerto, nombre de la base):

   ```bash
   cp .env.example .env
   ```

4. Crear las tablas:

   ```bash
   npm run db:migrate
   ```

5. Cargar datos de ejemplo (sucursal, usuarios de prueba, salón con mesas, categorías, productos, modificadores):

   ```bash
   npm run db:seed
   ```

6. Levantar el servidor:

   ```bash
   npm run start
   ```

   (para desarrollo, con reinicio automático ante cambios: `npm run dev`, requiere `nodemon` que ya está en `devDependencies`).

7. Abrir `http://localhost:4000` en el navegador. El frontend y la API viven en el mismo servidor.

### Usuarios de prueba

Todos con contraseña `restaurante123` (cambiá esto antes de usar en producción):

| Rol | Email |
|---|---|
| Administrador | admin@restaurante.test |
| Dueño/Gerente | duenio@restaurante.test |
| Encargado | encargado@restaurante.test |
| Cajero | cajero@restaurante.test |
| Mozo | mozo@restaurante.test |
| Cocina | cocina@restaurante.test |

### Scripts útiles del backend

- `npm run db:migrate` — crea las tablas si no existen (se puede correr varias veces sin romper nada).
- `npm run db:seed` — carga datos de ejemplo. Es seguro correrlo más de una vez: si detecta que ya hay usuarios cargados, no vuelve a insertar nada (esto permite incluirlo en el comando de arranque en producción, para hostings sin acceso a una consola).
- `npm run db:reset` — **borra todas las tablas y datos**. Usalo solo en desarrollo, para empezar de cero (después hay que volver a correr `db:migrate` y `db:seed`).

## Cómo gestionar las cuentas de usuario

Los usuarios se administran desde la propia aplicación, en **Administración → Usuarios** (visible solo para los roles Administrador y Dueño). Ahí se puede crear un usuario nuevo eligiendo nombre, email, contraseña y rol, y activar/desactivar cuentas existentes (desactivar es preferible a borrar, para no perder la trazabilidad de auditoría de lo que hizo ese usuario). También se puede hacer por API directamente si preferís automatizarlo (`POST /api/auth/users`, requiere estar autenticado con un usuario Administrador o Dueño).

No hay un flujo de "olvidé mi contraseña" en este MVP: si un usuario pierde su contraseña, un Administrador o Dueño debe crear una nueva cuenta o (próxima mejora natural) agregar un endpoint de cambio de contraseña.

## Cómo desplegarlo para que quede accesible por internet

Como todo el proyecto (frontend + backend) es un solo servicio Node.js con una base de datos PostgreSQL, cualquier hosting que soporte Node.js + Postgres funciona. La opción más simple para empezar es Render.com, y el repositorio ya incluye un archivo `render.yaml` (un "Blueprint") que le dice a Render cómo crear todo automáticamente.

### Paso 1: subir el código a GitHub (sin necesidad de usar `git`)

1. Entrá a [github.com](https://github.com) y creá una cuenta si no tenés una.
2. Creá un repositorio nuevo (botón "New repository"). Podés dejarlo privado.
3. Dentro del repositorio recién creado, usá la opción **"uploading an existing file"** (o "Add file" → "Upload files") y arrastrá ahí todo el contenido de la carpeta `restaurante-app/` que te pasé (las carpetas `backend/`, `frontend/`, el `README.md` y el `render.yaml`). **No subas la carpeta `node_modules` si la llegás a tener** — no hace falta, Render la genera sola.
4. Confirmá el commit desde la misma página web de GitHub.

### Paso 2: desplegar en Render con el Blueprint

1. Entrá a [render.com](https://render.com) y creá una cuenta (podés registrarte directamente con tu cuenta de GitHub, es lo más simple).
2. En el panel, elegí **New → Blueprint** y seleccioná el repositorio que acabás de subir.
3. Render va a leer el archivo `render.yaml` y va a proponerte crear automáticamente: una base de datos PostgreSQL (`restaurante-db`) y un servicio web (`restaurante-app`) ya conectado a esa base, con un `JWT_SECRET` generado automáticamente. Confirmá con **Apply**.
4. Esperá a que termine el primer despliegue (unos minutos). Al finalizar, Render te muestra la URL pública del servicio (algo como `https://restaurante-app-xxxx.onrender.com`) — esa es la dirección para abrir la app desde cualquier navegador o celular.

Si preferís no usar el Blueprint, podés crear la base de datos y el servicio web a mano desde el panel de Render; en ese caso configurá el servicio web con directorio raíz `backend`, build command `npm install`, start command `npm run db:migrate && npm run db:seed && npm run start`, y las variables de entorno `DATABASE_URL` (la que te da la base de datos), `JWT_SECRET` (un valor propio) y `CORS_ORIGIN` (`*`).

### Importante sobre el plan gratuito de Render (verificado en julio 2026)

- La base de datos PostgreSQL gratuita **expira a los 30 días** de creada, con 14 días de margen para pasarla a un plan pago antes de que Render la borre definitivamente junto con todos sus datos. Para un uso real (no solo para probar), vas a necesitar pasarla a un plan pago antes de ese plazo.
- El servicio web gratuito **se "duerme" después de 15 minutos sin recibir visitas**, y la siguiente visita demora alrededor de un minuto en responder mientras se reactiva. Además, el plan gratuito incluye 750 horas de uso por mes.
- El plan gratuito no tiene acceso a una consola/shell para correr comandos sueltos. Por eso el `startCommand` del `render.yaml` incluye `db:seed` en cada arranque: el script ya está hecho para detectar si los datos de ejemplo ya existen y no los vuelve a cargar, así que es seguro que se ejecute cada vez que el servicio arranca.

Fuentes sobre los límites del plan gratuito: [Render — Deploy for Free](https://render.com/docs/free), [Platforms with a real free tier for developers in 2026](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026), [Render Postgres 2026: Pricing, Limits & Alternatives](https://kuberns.com/blogs/render-postgres-pricing-setup-limits/).

### Alternativas a Render

Railway, Fly.io o un VPS propio (con PM2 o Docker) funcionan igual de bien: son la misma idea (una app Node.js + una base PostgreSQL accesible por `DATABASE_URL`). Si preferís Google Cloud (Cloud Run + Cloud SQL) también es totalmente compatible, solo cambia el mecanismo de despliegue, no el código.

### Antes de usarlo con datos reales del negocio, importante

- Si vas a seguir usando el plan gratuito, no dejes pasar los 30 días sin pasar la base de datos a un plan pago, o vas a perder todos los datos.
- Cambiá las contraseñas de los usuarios de demostración, o mejor: entrá una vez con el usuario Administrador de demostración, creá tus usuarios reales desde Administración → Usuarios, y después desactivá o borrá los de demostración.
- Hacé backups periódicos de la base de datos (Render los ofrece automáticamente solo en planes pagos).

## Notas de diseño relevantes

- **Anulaciones y cancelaciones**: por diseño, solo Administrador, Dueño y Encargado pueden anular un ítem o cancelar un pedido completo, y siempre se pide un motivo que queda guardado. Un Mozo puede agregar productos a un pedido pero no anularlos: si se equivocó, tiene que pedirle a un Encargado/Cajero/Dueño que anule el ítem. Esto fue una decisión deliberada para cumplir con el requisito de trazabilidad y control de anulaciones; se puede relajar editando `backend/src/lib/permissions.js` si tu operación lo necesita distinto.
- **División de cuenta**: se implementó permitiendo registrar varios pagos (de distintos montos y medios de pago) contra el mismo pedido, hasta cubrir el total. Es la forma más flexible de "dividir la cuenta entre varios clientes" sin necesitar que cada comensal tenga un pedido separado.
- **Envío a cocina**: los productos se agregan al pedido y quedan "sin enviar" hasta que el mozo aprieta "Enviar a cocina". Esto imita el flujo real de un mozo armando la comanda completa antes de mandarla, en vez de mandar cada producto individualmente a medida que lo agrega.
