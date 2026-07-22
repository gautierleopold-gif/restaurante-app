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

-- Sucursales ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  address    TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
