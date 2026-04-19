/**
 * Одноразовая инициализация SQLite: создание таблиц, индексов и учётной записи администратора.
 * Запускается отдельно от server.js (например, npm run init) до первого старта приложения.
 */

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");

const dbDir = __dirname;
const dbPath = path.join(dbDir, "database.sqlite");

// Гарантирует наличие каталога db/ перед созданием файла БД.
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Promise-обёртка для db.run — используется при создании схемы и вставке админа.
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

// Promise-обёртка для db.get — проверка существования администратора по логину перед INSERT.
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/**
 * Создание схемы БД: пользователи (роли admin/employee) и записи учёта времени с внешним ключом на users.
 * Индексы ускоряют выборки по user_id и date, которые часто использует server.js.
 */
async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'employee')),
      full_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('work', 'method', 'sick', 'vacation')),
      hours REAL,
      days REAL,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_records_user_id ON records(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)`);

  // Первичный администратор из переменных окружения (или значения по умолчанию), только если логин ещё не занят.
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const adminFullName = process.env.ADMIN_FULL_NAME || "Administrator";

  const existingAdmin = await get(
    "SELECT id FROM users WHERE username = ?",
    [adminUsername]
  );

  if (!existingAdmin) {
    const hashed = await bcrypt.hash(adminPassword, 10);
    await run(
      "INSERT INTO users (username, password, role, full_name) VALUES (?, ?, 'admin', ?)",
      [adminUsername, hashed, adminFullName]
    );
    console.log(`Admin created: ${adminUsername}`);
  } else {
    console.log(`Admin already exists: ${adminUsername}`);
  }
}

// Завершение процесса после успешной инициализации или с кодом ошибки при сбое.
init()
  .then(() => {
    db.close();
    console.log("Database initialized.");
  })
  .catch((err) => {
    db.close();
    console.error("DB init error:", err);
    process.exit(1);
  });
