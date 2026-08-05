-- ============================================================================
-- Esquema de base de datos - Plataforma de gestión integral para restaurantes
-- Fase MVP: autenticación/roles, menú, salón/mesas, POS/pedidos, cocina (KDS).
-- Diseñado para poder ampliarse en fases siguientes con inventario, clientes,
-- delivery, caja y reportes sin romper esta estructura base.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- para gen_random_uuid() en cualquier versión de PG

-- Tipos enumerados ----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE role_name AS ENUM ('ADMIN','DUENIO','ENCARGADO','CAJERO','MOZO','COCINA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE table_status AS ENUM ('LIBRE','OCUPADA','RESERVADA','PENDIENTE_PAGO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_type AS ENUM ('SALON','RETIRO','DELIVERY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('ABIERTO','CERRADO','CANCELADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kitchen_status AS ENUM ('PENDIENTE','EN_PREPARACION','LISTO','ENTREGADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('EFECTIVO','TARJETA','TRANSFERENCIA','DIGITAL','OTRO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM ('ENTRADA','SALIDA','AJUSTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Sucursales ------------------------------------------------------------------
-- Además de los datos básicos, cada sucursal guarda sus datos fiscales (para
-- emitir facturas) y su configuración de envío de mail (SMTP), para que cada
-- local pueda tener su propia razón social/NIT si la app se usa para varias
-- sucursales o incluso varios negocios distintos.
CREATE TABLE IF NOT EXISTS branches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  address    TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE branches ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS tax_id TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS fiscal_address TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'ARS';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NOT NULL DEFAULT 'A';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS next_invoice_number INT NOT NULL DEFAULT 1;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS smtp_port INT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS smtp_pass TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS smtp_from TEXT;
-- IVA / sales tax configurable: cada sucursal puede definir una alícuota y
-- si se aplica de forma "aditiva" (se suma al precio, como un sales tax) o
-- "inclusiva" (ya viene incluida en los precios cargados, solo se discrimina
-- en la factura) o directamente no aplicarla ('NONE'), para poder adaptarse
-- a la legislación de cada país sin tocar código.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE branches ADD COLUMN IF NOT EXISTS tax_label TEXT NOT NULL DEFAULT 'IVA';
-- Envío de mail alternativo por API HTTP (Resend), para hostings gratuitos
-- (como el free tier de Render) que desde fines de 2025 bloquean el tráfico
-- saliente a los puertos de SMTP (25/465/587): si hay una API key configurada
-- acá, se usa esto en vez de SMTP para enviar las facturas por mail.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS resend_api_key TEXT;
-- Idioma de la interfaz para todo el personal de la sucursal (es/fr/en/pt/it).
ALTER TABLE branches ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'es';
-- Símbolo de moneda a mostrar junto a cada monto en toda la interfaz (POS,
-- ticket, caja, factura). Antes estaba fijo en "$" en el código; ahora es un
-- parámetro más de la sucursal, editable desde Administración → Parámetros.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS currency_symbol TEXT NOT NULL DEFAULT '$';

-- Usuarios ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          role_name NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  branch_id     UUID REFERENCES branches(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);

-- Menú: categorías, estaciones, productos, variantes, modificadores --------
CREATE TABLE IF NOT EXISTS categories (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  "order"   INT NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  branch_id UUID REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS stations (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  branch_id UUID REFERENCES branches(id),
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  category_id  UUID NOT NULL REFERENCES categories(id),
  station_id   UUID REFERENCES stations(id),
  base_price   NUMERIC(10,2) NOT NULL,
  is_composite BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La categoría de un producto ahora es opcional: un producto sin categoría
-- de menú asignada no aparece en la carta ni en el POS, pero sigue visible y
-- editable desde Administración → Productos (copia el modelo de Fudo para
-- productos que no están pensados para venderse por el menú normal).
ALTER TABLE products ALTER COLUMN category_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS product_variants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      NUMERIC(10,2) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS modifier_groups (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name     TEXT NOT NULL,
  min      INT NOT NULL DEFAULT 0,
  max      INT NOT NULL DEFAULT 1,
  required BOOLEAN NOT NULL DEFAULT FALSE
);

-- Grupo "de reparto" (ej. sabores de empanadas): en vez de elegir una o
-- varias opciones sueltas, la cantidad total del ítem se reparte entre las
-- opciones del grupo (4 J&Q + 2 carne + 6 verdura y queso = 12). Se aplica a
-- cualquier producto que tenga asociado un grupo con split_mode = true.
ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS split_mode BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS modifiers (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  price    NUMERIC(10,2) NOT NULL DEFAULT 0,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, modifier_group_id)
);

-- Salón y mesas --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  branch_id UUID REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS tables (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id  UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  capacity INT NOT NULL DEFAULT 4,
  pos_x    INT NOT NULL DEFAULT 0,
  pos_y    INT NOT NULL DEFAULT 0,
  status   table_status NOT NULL DEFAULT 'LIBRE'
);

-- Forma y tamaño de la mesa en el editor de salón: se puede redimensionar
-- arrastrando una esquina y elegir si se dibuja como rectángulo o círculo,
-- en vez de tener siempre el mismo tamaño/forma fija para todas las mesas.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS width INT NOT NULL DEFAULT 108;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS height INT NOT NULL DEFAULT 88;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS shape TEXT NOT NULL DEFAULT 'RECT';

-- Pedidos (POS) ---------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS orders_code_seq;

CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             INT NOT NULL DEFAULT nextval('orders_code_seq'),
  type             order_type NOT NULL,
  status           order_status NOT NULL DEFAULT 'ABIERTO',
  branch_id        UUID REFERENCES branches(id),
  table_id         UUID REFERENCES tables(id),
  waiter_id        UUID REFERENCES users(id),
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_address TEXT,
  notes            TEXT,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  discount_reason  TEXT,
  subtotal         NUMERIC(10,2) NOT NULL DEFAULT 0,
  total            NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id),
  variant_id     UUID REFERENCES product_variants(id),
  station_id     UUID REFERENCES stations(id),
  quantity       INT NOT NULL DEFAULT 1,
  unit_price     NUMERIC(10,2) NOT NULL,
  notes          TEXT,
  kitchen_status kitchen_status NOT NULL DEFAULT 'PENDIENTE',
  canceled       BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_by_id UUID REFERENCES users(id),
  cancel_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  ready_at       TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_station ON order_items(station_id, kitchen_status);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id   UUID NOT NULL REFERENCES modifiers(id),
  price         NUMERIC(10,2) NOT NULL
);

-- Para modificadores de un grupo "split_mode": cuántas unidades de la
-- cantidad total del ítem corresponden a esa opción (ver modifier_groups
-- arriba). Para modificadores normales (no split) queda en 1 y no se usa.
ALTER TABLE order_item_modifiers ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1;

-- Pagos -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method         payment_method NOT NULL,
  amount         NUMERIC(10,2) NOT NULL,
  received_by_id UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Permisos configurables ------------------------------------------------------
-- Guarda únicamente las excepciones a la matriz de permisos por defecto
-- (backend/src/lib/permissions.js). Si un rol+permiso no tiene fila acá, se
-- usa el valor por defecto del código. ADMIN siempre tiene todos los permisos
-- sin importar lo que haya acá, para que nunca se pueda perder el acceso.
CREATE TABLE IF NOT EXISTS role_permissions (
  role       role_name NOT NULL,
  permission TEXT NOT NULL,
  allowed    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission)
);

-- Inventario ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingredients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'unidad',
  stock         NUMERIC(12,3) NOT NULL DEFAULT 0,
  min_stock     NUMERIC(12,3) NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(12,2) NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  branch_id     UUID REFERENCES branches(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Receta: cuánta cantidad de cada insumo consume una unidad vendida de un
-- producto (a nivel de producto base; no distingue por variante en esta fase).
CREATE TABLE IF NOT EXISTS product_ingredients (
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity      NUMERIC(12,3) NOT NULL,
  PRIMARY KEY (product_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  type          stock_movement_type NOT NULL,
  quantity      NUMERIC(12,3) NOT NULL,
  reason        TEXT,
  order_id      UUID REFERENCES orders(id),
  user_id       UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient ON stock_movements(ingredient_id, created_at);

-- Facturación -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID REFERENCES orders(id),
  branch_id        UUID REFERENCES branches(id),
  number           TEXT NOT NULL,
  customer_name    TEXT,
  customer_tax_id  TEXT,
  customer_email   TEXT,
  subtotal         NUMERIC(10,2) NOT NULL,
  total            NUMERIC(10,2) NOT NULL,
  issued_by_id     UUID REFERENCES users(id),
  emailed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);

-- Plantillas de factura: "editor básico" para poder cambiar el logo, textos
-- de encabezado/pie y un preset de estilo, sin tocar código. Puede haber
-- varias por sucursal (varios "modelos de ejemplares"); una se marca como
-- predeterminada (is_default) y es la que se usa al emitir si no se elige
-- otra explícitamente.
CREATE TABLE IF NOT EXISTS invoice_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID REFERENCES branches(id),
  name         TEXT NOT NULL,
  logo_base64  TEXT,
  header_text  TEXT,
  footer_text  TEXT,
  accent_color TEXT NOT NULL DEFAULT '#2F5233',
  layout       TEXT NOT NULL DEFAULT 'CLASICO',
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_templates_branch ON invoice_templates(branch_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES invoice_templates(id) ON DELETE SET NULL;

-- Snapshot del IVA/tax aplicado al momento de emitir la factura (no
-- recalcular con la configuración actual de la sucursal, que puede cambiar
-- después). tax_mode: NONE | INCLUSIVE | ADDITIVE.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_label TEXT NOT NULL DEFAULT 'IVA';

-- Cierre de caja: resumen simple del período transcurrido desde el cierre
-- anterior (o desde el principio, si es el primero) hasta el momento en que
-- se cierra: cantidad de pedidos, ventas totales y desglose por medio de
-- pago. No modifica ni bloquea nada operativo; es solo un registro/checkpoint
-- para el resumen del día.
CREATE TABLE IF NOT EXISTS cash_closures (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        UUID REFERENCES branches(id),
  closed_by_id     UUID REFERENCES users(id),
  period_from      TIMESTAMPTZ NOT NULL,
  period_to        TIMESTAMPTZ NOT NULL,
  order_count      INT NOT NULL DEFAULT 0,
  total_sales      NUMERIC(10,2) NOT NULL DEFAULT 0,
  totals_by_method JSONB NOT NULL DEFAULT '{}',
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_closures_branch ON cash_closures(branch_id, period_to);
-- Cuenta de propinas (como en Fudo): lo que se paga de más sobre el total de
-- un pedido (por ejemplo, pagar $1000 por una cuenta de $950) se acredita
-- automáticamente acá en vez de perderse, y también se puede agregar una
-- propina manualmente en cualquier momento. El saldo es la suma de todos los
-- movimientos; "reiniciar" (backoffice, gerentes) no borra el historial, sólo
-- agrega un movimiento negativo que lleva el saldo a $0, para mantener
-- trazabilidad de a quién/cuándo se reinició.
DO $$ BEGIN
  CREATE TYPE tip_transaction_type AS ENUM ('AUTO_OVERPAYMENT', 'MANUAL_ADD', 'RESET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tip_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID REFERENCES branches(id),
  order_id      UUID REFERENCES orders(id),
  type          tip_transaction_type NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  notes         TEXT,
  created_by_id UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tip_transactions_branch ON tip_transactions(branch_id, created_at);

-- Factura libre (no ligada a un pedido): ítems cargados manualmente.
ALTER TABLE invoices ALTER COLUMN order_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS invoice_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity    NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0
);

-- ============================================================================
-- Medios de pago configurables (antes era una lista fija en el código:
-- EFECTIVO/TARJETA/TRANSFERENCIA/DIGITAL/OTRO). `code` es el valor que se
-- guarda en payments.method (ver más abajo, ahora TEXT en vez de un enum
-- cerrado) y `label` es el nombre que ve el usuario; se pueden desactivar o
-- agregar nuevos (ej. "Mercado Pago") sin tocar código. Los 5 de siempre se
-- siembran una sola vez por sucursal para no romper los pagos ya existentes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_methods (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID REFERENCES branches(id),
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  "order"    INT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_branch_code
  ON payment_methods (COALESCE(branch_id::text, ''), code);

DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM branches LOOP
    INSERT INTO payment_methods (branch_id, code, label, "order")
    SELECT b.id, v.code, v.label, v.ord
    FROM (VALUES
      ('EFECTIVO', 'Efectivo', 1),
      ('TARJETA', 'Tarjeta', 2),
      ('TRANSFERENCIA', 'Transferencia', 3),
      ('DIGITAL', 'Pago digital', 4),
      ('OTRO', 'Otro', 5)
    ) AS v(code, label, ord)
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_methods pm WHERE pm.branch_id = b.id AND pm.code = v.code
    );
  END LOOP;
  -- Cubre también el caso (poco común, pero posible en este MVP de una sola
  -- sucursal) de que todavía no exista ninguna fila en `branches`.
  INSERT INTO payment_methods (branch_id, code, label, "order")
  SELECT NULL, v.code, v.label, v.ord
  FROM (VALUES
    ('EFECTIVO', 'Efectivo', 1),
    ('TARJETA', 'Tarjeta', 2),
    ('TRANSFERENCIA', 'Transferencia', 3),
    ('DIGITAL', 'Pago digital', 4),
    ('OTRO', 'Otro', 5)
  ) AS v(code, label, ord)
  WHERE NOT EXISTS (SELECT 1 FROM branches)
    AND NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.branch_id IS NULL AND pm.code = v.code);
END $$;

-- payments.method pasa de un enum cerrado a TEXT libre, para poder guardar
-- cualquier código definido en payment_methods (incluidos los que agregue el
-- usuario). Los valores ya grabados (EFECTIVO, TARJETA, etc.) son compatibles
-- porque coinciden con los `code` sembrados arriba.
ALTER TABLE payments ALTER COLUMN method TYPE TEXT USING method::TEXT;

-- ============================================================================
-- Motivos de descuento configurables: catálogo simple para agilizar el POS.
-- orders.discount_reason sigue siendo texto libre (no se referencia por id),
-- así que el motivo elegido del catálogo se guarda igual que uno tipeado a
-- mano; la opción "Otro" en el POS sigue permitiendo texto libre siempre.
-- ============================================================================
CREATE TABLE IF NOT EXISTS discount_reasons (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID REFERENCES branches(id),
  label      TEXT NOT NULL,
  "order"    INT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discount_reasons_branch ON discount_reasons(branch_id, "order");

DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM branches LOOP
    INSERT INTO discount_reasons (branch_id, label, "order")
    SELECT b.id, v.label, v.ord
    FROM (VALUES ('Empleados', 1), ('Cliente frecuente', 2), ('Cortesía', 3))
      AS v(label, ord)
    WHERE NOT EXISTS (SELECT 1 FROM discount_reasons dr WHERE dr.branch_id = b.id);
  END LOOP;
END $$;

-- ============================================================================
-- Movimientos de caja manuales: ingresos/egresos de efectivo que no son una
-- venta (ej. un retiro para comprar algo en el momento, un aporte de fondo).
-- No modifican ni bloquean nada operativo, igual que cash_closures: son solo
-- un registro que se suma al resumen del período (ver routes/cashClosures.js).
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE cash_movement_type AS ENUM ('INGRESO', 'EGRESO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cash_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID REFERENCES branches(id),
  type          cash_movement_type NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  reason        TEXT,
  created_by_id UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_branch ON cash_movements(branch_id, created_at);

-- Neto de movimientos manuales incluido en el período de cada cierre, para
-- que el historial de cierres no pierda ese dato aunque cambien los
-- movimientos futuros.
ALTER TABLE cash_closures ADD COLUMN IF NOT EXISTS manual_movements_total NUMERIC(10,2) NOT NULL DEFAULT 0;
