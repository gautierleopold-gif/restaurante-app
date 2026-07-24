/*
 * Carga datos iniciales de ejemplo: sucursal, usuarios de prueba (uno por
 * rol), estaciones de cocina, salón con mesas, categorías, productos,
 * variantes y modificadores. Sirve para poder probar la aplicación
 * inmediatamente después de instalarla.
 *
 * Las contraseñas de los usuarios de ejemplo son intencionalmente simples
 * porque son solo para desarrollo/pruebas locales. CAMBIALAS antes de
 * usar esto en producción.
 */
const bcrypt = require("bcryptjs");
const { pool, withTransaction } = require("./pool");

const DEMO_PASSWORD = "restaurante123";

async function seed() {
  // Idempotente: si ya hay usuarios cargados (por ejemplo porque este script
  // corre automáticamente en cada arranque del servicio en producción), no
  // vuelve a insertar los datos de ejemplo. Esto permite incluir
  // "npm run db:seed" de forma segura en el comando de arranque de un
  // hosting que no ofrece una consola para correrlo una sola vez a mano
  // (como el plan gratuito de Render).
  const { rows: existing } = await pool.query(`SELECT 1 FROM users LIMIT 1`);
  if (existing.length > 0) {
    console.log("Ya hay usuarios cargados en la base de datos: no se vuelven a sembrar los datos de ejemplo.");
    await pool.end();
    return;
  }

  await withTransaction(async (client) => {
    console.log("Sembrando datos de ejemplo...");

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    const { rows: branchRows } = await client.query(
      `INSERT INTO branches (name, address, legal_name, tax_id, fiscal_address, phone, currency, invoice_prefix, next_invoice_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        "Casa Matriz",
        "Av. Principal 123",
        "Restaurante Demo S.A.",
        "900123456-7",
        "Av. Principal 123",
        "+54 11 5555-5555",
        "ARS",
        "A",
        1,
      ]
    );
    const branchId = branchRows[0].id;

    const users = [
      ["Admin", "admin@restaurante.test", "ADMIN"],
      ["Dueña del local", "duenio@restaurante.test", "DUENIO"],
      ["Encargado de turno", "encargado@restaurante.test", "ENCARGADO"],
      ["Cajera", "cajero@restaurante.test", "CAJERO"],
      ["Mozo", "mozo@restaurante.test", "MOZO"],
      ["Cocinero", "cocina@restaurante.test", "COCINA"],
    ];
    for (const [name, email, role] of users) {
      await client.query(
        `INSERT INTO users (name, email, password_hash, role, branch_id) VALUES ($1,$2,$3,$4,$5)`,
        [name, email, passwordHash, role, branchId]
      );
    }

    const stationNames = ["Cocina", "Barra", "Postres"];
    const stationIds = {};
    for (const name of stationNames) {
      const { rows } = await client.query(
        `INSERT INTO stations (name, branch_id) VALUES ($1,$2) RETURNING id`,
        [name, branchId]
      );
      stationIds[name] = rows[0].id;
    }

    const { rows: roomRows } = await client.query(
      `INSERT INTO rooms (name, branch_id) VALUES ($1,$2) RETURNING id`,
      ["Salón Principal", branchId]
    );
    const roomId = roomRows[0].id;
    const { rows: terraceRows } = await client.query(
      `INSERT INTO rooms (name, branch_id) VALUES ($1,$2) RETURNING id`,
      ["Terraza", branchId]
    );
    const terraceId = terraceRows[0].id;

    // pos_x/pos_y son coordenadas libres en píxeles (no una grilla): se
    // pueden reacomodar arrastrando las mesas con el mouse desde
    // Administración → Salón y mesas.
    const tablesToCreate = [
      [roomId, "Mesa 1", 4, 20, 20],
      [roomId, "Mesa 2", 2, 170, 20],
      [roomId, "Mesa 3", 6, 320, 20],
      [roomId, "Mesa 4", 4, 20, 150],
      [roomId, "Mesa 5", 4, 170, 150],
      [terraceId, "Terraza 1", 4, 20, 20],
      [terraceId, "Terraza 2", 4, 170, 20],
    ];
    for (const [rid, name, capacity, x, y] of tablesToCreate) {
      await client.query(
        `INSERT INTO tables (room_id, name, capacity, pos_x, pos_y) VALUES ($1,$2,$3,$4,$5)`,
        [rid, name, capacity, x, y]
      );
    }

    const categories = [
      ["Entradas", 1],
      ["Platos Principales", 2],
      ["Bebidas", 3],
      ["Postres", 4],
    ];
    const categoryIds = {};
    for (const [name, order] of categories) {
      const { rows } = await client.query(
        `INSERT INTO categories (name, "order", branch_id) VALUES ($1,$2,$3) RETURNING id`,
        [name, order, branchId]
      );
      categoryIds[name] = rows[0].id;
    }

    // Grupo de modificadores reutilizable: adicionales para platos principales
    const { rows: modGroupRows } = await client.query(
      `INSERT INTO modifier_groups (name, min, max, required) VALUES ($1,$2,$3,$4) RETURNING id`,
      ["Adicionales", 0, 3, false]
    );
    const modGroupId = modGroupRows[0].id;
    const modifiers = [
      ["Extra queso", 500],
      ["Extra salsa", 300],
      ["Sin cebolla", 0],
    ];
    for (const [name, price] of modifiers) {
      await client.query(
        `INSERT INTO modifiers (group_id, name, price) VALUES ($1,$2,$3)`,
        [modGroupId, name, price]
      );
    }

    const { rows: puntoGroupRows } = await client.query(
      `INSERT INTO modifier_groups (name, min, max, required) VALUES ($1,$2,$3,$4) RETURNING id`,
      ["Punto de la carne", 1, 1, true]
    );
    const puntoGroupId = puntoGroupRows[0].id;
    for (const name of ["Jugoso", "A punto", "Bien cocido"]) {
      await client.query(`INSERT INTO modifiers (group_id, name, price) VALUES ($1,$2,0)`, [
        puntoGroupId,
        name,
      ]);
    }

    const products = [
      {
        name: "Empanadas (x3)",
        category: "Entradas",
        station: "Cocina",
        price: 3500,
        modifierGroups: [],
        variants: [],
      },
      {
        name: "Tabla de fiambres",
        category: "Entradas",
        station: "Cocina",
        price: 8500,
        modifierGroups: [],
        variants: [],
      },
      {
        name: "Bife de chorizo",
        category: "Platos Principales",
        station: "Cocina",
        price: 12000,
        modifierGroups: [modGroupId, puntoGroupId],
        variants: [],
      },
      {
        name: "Milanesa napolitana",
        category: "Platos Principales",
        station: "Cocina",
        price: 9500,
        modifierGroups: [modGroupId],
        variants: [],
      },
      {
        name: "Pizza muzzarella",
        category: "Platos Principales",
        station: "Cocina",
        price: 7000,
        modifierGroups: [modGroupId],
        variants: [
          ["Chica", 5500],
          ["Grande", 8500],
        ],
      },
      {
        name: "Gaseosa",
        category: "Bebidas",
        station: "Barra",
        price: 2200,
        modifierGroups: [],
        variants: [
          ["350ml", 1800],
          ["1.5L", 3200],
        ],
      },
      {
        name: "Agua mineral",
        category: "Bebidas",
        station: "Barra",
        price: 1800,
        modifierGroups: [],
        variants: [],
      },
      {
        name: "Copa de vino",
        category: "Bebidas",
        station: "Barra",
        price: 3000,
        modifierGroups: [],
        variants: [],
      },
      {
        name: "Flan casero",
        category: "Postres",
        station: "Postres",
        price: 2800,
        modifierGroups: [],
        variants: [],
      },
      {
        name: "Helado (2 bolas)",
        category: "Postres",
        station: "Postres",
        price: 2500,
        modifierGroups: [],
        variants: [],
      },
    ];

    const productIds = {};
    for (const p of products) {
      const { rows } = await client.query(
        `INSERT INTO products (name, category_id, station_id, base_price) VALUES ($1,$2,$3,$4) RETURNING id`,
        [p.name, categoryIds[p.category], stationIds[p.station], p.price]
      );
      const productId = rows[0].id;
      productIds[p.name] = productId;
      for (const groupId of p.modifierGroups) {
        await client.query(
          `INSERT INTO product_modifier_groups (product_id, modifier_group_id) VALUES ($1,$2)`,
          [productId, groupId]
        );
      }
      for (const [name, price] of p.variants) {
        await client.query(
          `INSERT INTO product_variants (product_id, name, price) VALUES ($1,$2,$3)`,
          [productId, name, price]
        );
      }
    }

    // Inventario de ejemplo: algunos insumos con su costo y stock mínimo, y
    // la receta de un par de productos para que se pueda ver el descuento
    // automático de stock al vender ni bien se prueba la app.
    const ingredients = [
      ["Carne de res", "kg", 40, 8, 4200],
      ["Pan para milanesa", "unidad", 60, 15, 250],
      ["Muzzarella", "kg", 15, 3, 6800],
      ["Masa de empanada", "unidad", 120, 24, 180],
    ];
    const ingredientIds = {};
    for (const [name, unit, stock, minStock, cost] of ingredients) {
      const { rows } = await client.query(
        `INSERT INTO ingredients (name, unit, stock, min_stock, cost_per_unit, branch_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [name, unit, stock, minStock, cost, branchId]
      );
      ingredientIds[name] = rows[0].id;
    }
    const recipes = [
      ["Bife de chorizo", [["Carne de res", 0.35]]],
      ["Milanesa napolitana", [["Carne de res", 0.25], ["Pan para milanesa", 1], ["Muzzarella", 0.08]]],
      ["Empanadas (x3)", [["Masa de empanada", 3]]],
      ["Pizza muzzarella", [["Muzzarella", 0.2]]],
    ];
    for (const [productName, items] of recipes) {
      for (const [ingredientName, qty] of items) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, quantity) VALUES ($1,$2,$3)`,
          [productIds[productName], ingredientIds[ingredientName], qty]
        );
      }
    }

    console.log("Datos de ejemplo cargados correctamente.");
    console.log("");
    console.log("Usuarios de prueba (todos con contraseña: " + DEMO_PASSWORD + "):");
    for (const [name, email, role] of users) {
      console.log(`  - ${role.padEnd(10)} ${email}`);
    }
  });
  await pool.end();
}

seed().catch((err) => {
  console.error("Error al sembrar datos:", err);
  process.exit(1);
});
