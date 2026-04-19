/**
 * Серверное приложение учёта рабочего времени (Express + SQLite).
 * Предоставляет REST API для авторизации, записей, пользователей, профиля и выгрузки отчётов;
 * отдаёт статику из public/ и для SPA-маршрутов — index.html.
 */

const path = require("path");
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");

// Порт HTTP и путь к файлу БД (используется всеми обработчиками и инициализацией через db/init.js).
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db", "database.sqlite");

const db = new sqlite3.Database(DB_PATH);
db.run("PRAGMA foreign_keys = ON");

const app = express();

// CORS, JSON, сессии (cookie для req.session.user) и раздача фронтенда из каталога public/.
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "very-secret-mvp-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

// Обёртки над sqlite3 в Promise — упрощают async/await во всех маршрутах (INSERT/UPDATE/SELECT).
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Доступ к API только для авторизованных пользователей (есть req.session.user).
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

// Ограничение маршрутов только для роли admin (управление пользователями, сводный экспорт).
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Тарифные константы и расчёт взвешенных часов по диапазону «с–до» (логика согласована с public/app.js).
 * Используется в POST/PUT /api/records при передаче range_start и range_end.
 * Окно обычного тарифа: 08:30–18:30; вне окна минуты учитываются с коэффициентом ×2.
 */
const TARIFF_DAY_START_MIN = 8 * 60 + 30;
const TARIFF_DAY_END_EXC = 18 * 60 + 31;
const TARIFF_LATE_START_MIN = 18 * 60 + 31;

function parseTimeToMinutes(value) {
  if (!value || typeof value !== "string" || !value.includes(":")) return null;
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * До 08:30 и после 18:30 — коэффициент ×2 к минутам; внутри [08:30, 18:30] — ×1.
 * Интервал смены [start, end) в минутах от полуночи.
 */
function computeWeightedShiftFromRange(startStr, endStr) {
  const s = parseTimeToMinutes(startStr);
  const e = parseTimeToMinutes(endStr);
  if (s === null || e === null || e <= s) return null;

  const NS = TARIFF_DAY_START_MIN;
  const NE_EXC = TARIFF_DAY_END_EXC;
  const LS = TARIFF_LATE_START_MIN;

  const earlyX2 = Math.max(0, Math.min(e, NS) - s);
  const normal = Math.max(0, Math.min(e, NE_EXC) - Math.max(s, NS));
  const lateX2 = Math.max(0, e - Math.max(s, LS));
  const x2Minutes = earlyX2 + lateX2;
  const weightedHours = (normal + 2 * x2Minutes) / 60;

  return {
    weightedHours,
    x2Minutes,
    normalMinutes: normal,
    earlyX2Minutes: earlyX2,
    lateX2Minutes: lateX2,
    rawMinutes: e - s,
  };
}

// Определяет user_id для выборки/создания записей: админ может указать сотрудника, иначе — только свои данные.
function recordOwnerFilter(req, requestedUserId) {
  if (req.session.user.role === "admin") {
    return requestedUserId || req.session.user.id;
  }
  return req.session.user.id;
}

// --- Аутентификация: вход, выход, проверка сессии (вызывается из app.js при загрузке и после логина). ---
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    const user = await get(
      "SELECT id, username, password, role, full_name FROM users WHERE username = ?",
      [username]
    );
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
    };
    return res.json({ user: req.session.user });
  } catch (err) {
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  return res.json({ user: req.session.user });
});

// --- Учётные записи (таблица records): список с фильтром по году/месяцу и владельцу. ---
app.get("/api/records", requireAuth, async (req, res) => {
  try {
    const { user_id, year, month } = req.query;
    const targetUserId = recordOwnerFilter(req, user_id ? Number(user_id) : null);
    const filters = ["user_id = ?"];
    const params = [targetUserId];

    if (year) {
      filters.push("strftime('%Y', date) = ?");
      params.push(String(year));
    }
    if (month) {
      const paddedMonth = String(month).padStart(2, "0");
      filters.push("strftime('%m', date) = ?");
      params.push(paddedMonth);
    }

    const rows = await all(
      `SELECT id, user_id, date, type, hours, days, comment, created_at, updated_at
       FROM records
       WHERE ${filters.join(" AND ")}
       ORDER BY date DESC, id DESC`,
      params
    );
    return res.json({ records: rows });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load records" });
  }
});

// Создание записи: валидация типа, часов/дней, тарифа ×2 и методических часов; админ может задать user_id.
app.post("/api/records", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { date, type, comment } = body;
    const allowedTypes = ["work", "method", "sick", "vacation"];
    if (!date || !type || !allowedTypes.includes(type)) {
      return res.status(400).json({ error: "Некорректная дата или тип записи" });
    }

    const userId =
      req.session.user.role === "admin" && body.user_id
        ? Number(body.user_id)
        : req.session.user.id;

    let hours = null;
    let days = null;

    if (type === "work" || type === "method") {
      if (body.range_start && body.range_end) {
        const calc = computeWeightedShiftFromRange(body.range_start, body.range_end);
        if (!calc) {
          return res.status(400).json({ error: "Некорректный диапазон времени" });
        }
        hours = calc.weightedHours;
        if (calc.x2Minutes > 0 && (!comment || !String(comment).trim())) {
          return res.status(400).json({
            error: "При повышенном тарифе (×2) укажите причину в комментарии",
          });
        }
      } else {
        hours = parseNumber(body.hours);
        if (hours === null) {
          return res.status(400).json({ error: "Укажите количество часов" });
        }
      }
      if (type === "method" && (!comment || !String(comment).trim())) {
        return res.status(400).json({
          error: "Комментарий обязателен при заполнении методических часов",
        });
      }
    } else {
      days = parseNumber(body.days);
      if (days === null) {
        return res.status(400).json({ error: "Укажите количество дней" });
      }
    }

    const result = await run(
      `INSERT INTO records (user_id, date, type, hours, days, comment)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, date, type, hours, days, comment || null]
    );
    const row = await get("SELECT * FROM records WHERE id = ?", [result.lastID]);
    return res.status(201).json({ record: row });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create record" });
  }
});

// Обновление записи: проверка прав (сотрудник — только свои строки), та же бизнес-логика, что при создании.
app.put("/api/records/:id", requireAuth, async (req, res) => {
  try {
    const recordId = Number(req.params.id);
    if (!recordId) return res.status(400).json({ error: "Invalid record id" });

    const existing = await get("SELECT * FROM records WHERE id = ?", [recordId]);
    if (!existing) return res.status(404).json({ error: "Record not found" });
    if (req.session.user.role !== "admin" && existing.user_id !== req.session.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const mergedPayload = {
      date: req.body.date ?? existing.date,
      type: req.body.type ?? existing.type,
      hours: req.body.hours ?? existing.hours,
      days: req.body.days ?? existing.days,
      comment: req.body.comment ?? existing.comment,
    };

    const allowedTypes = ["work", "method", "sick", "vacation"];
    if (!mergedPayload.date || !mergedPayload.type || !allowedTypes.includes(mergedPayload.type)) {
      return res.status(400).json({ error: "Некорректная дата или тип записи" });
    }

    const t = mergedPayload.type;
    let hours = null;
    let days = null;

    if (t === "work" || t === "method") {
      if (req.body.range_start && req.body.range_end) {
        const calc = computeWeightedShiftFromRange(req.body.range_start, req.body.range_end);
        if (!calc) {
          return res.status(400).json({ error: "Некорректный диапазон времени" });
        }
        hours = calc.weightedHours;
        const c = mergedPayload.comment;
        if (calc.x2Minutes > 0 && (!c || !String(c).trim())) {
          return res.status(400).json({
            error: "При повышенном тарифе (×2) укажите причину в комментарии",
          });
        }
      } else {
        hours = parseNumber(mergedPayload.hours);
        if (hours === null) {
          return res.status(400).json({ error: "Укажите количество часов" });
        }
      }
      if (t === "method" && (!mergedPayload.comment || !String(mergedPayload.comment).trim())) {
        return res.status(400).json({
          error: "Комментарий обязателен при заполнении методических часов",
        });
      }
    } else {
      days = parseNumber(mergedPayload.days);
      if (days === null) {
        return res.status(400).json({ error: "Укажите количество дней" });
      }
    }

    await run(
      `UPDATE records
       SET date = ?, type = ?, hours = ?, days = ?, comment = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [mergedPayload.date, mergedPayload.type, hours, days, mergedPayload.comment || null, recordId]
    );
    const updated = await get("SELECT * FROM records WHERE id = ?", [recordId]);
    return res.json({ record: updated });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update record" });
  }
});

// Удаление записи по id с проверкой владельца или роли admin.
app.delete("/api/records/:id", requireAuth, async (req, res) => {
  try {
    const recordId = Number(req.params.id);
    const existing = await get("SELECT * FROM records WHERE id = ?", [recordId]);
    if (!existing) return res.status(404).json({ error: "Record not found" });
    if (req.session.user.role !== "admin" && existing.user_id !== req.session.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await run("DELETE FROM records WHERE id = ?", [recordId]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete record" });
  }
});

// --- Пользователи (только admin): список для таблицы сотрудников и селектов в app.js. ---
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await all(
      "SELECT id, full_name, username, role, created_at FROM users ORDER BY full_name"
    );
    return res.json({ users });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load users" });
  }
});

// Создание сотрудника с ролью employee (форма «Создать сотрудника» в index.html).
app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, full_name, password } = req.body || {};
    if (!username || !full_name || !password) {
      return res.status(400).json({ error: "username, full_name, password required" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const result = await run(
      "INSERT INTO users (username, password, role, full_name) VALUES (?, ?, 'employee', ?)",
      [username, hashed, full_name]
    );
    const user = await get(
      "SELECT id, username, full_name, role, created_at FROM users WHERE id = ?",
      [result.lastID]
    );
    return res.status(201).json({ user });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create user" });
  }
});

// Редактирование ФИО и опционально пароля (модальное окно userModal в app.js).
app.put("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const target = await get("SELECT * FROM users WHERE id = ?", [userId]);
    if (!target) return res.status(404).json({ error: "User not found" });

    const fullName = req.body.full_name ?? target.full_name;
    const newPassword = req.body.password;
    if (newPassword) {
      const hashed = await bcrypt.hash(newPassword, 10);
      await run("UPDATE users SET full_name = ?, password = ? WHERE id = ?", [
        fullName,
        hashed,
        userId,
      ]);
    } else {
      await run("UPDATE users SET full_name = ? WHERE id = ?", [fullName, userId]);
    }

    const user = await get(
      "SELECT id, username, full_name, role, created_at FROM users WHERE id = ?",
      [userId]
    );
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// Удаление сотрудника (каскадно удаляет записи по FK); запрет удаления собственной учётной записи админа.
app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (userId === req.session.user.id) {
      return res.status(400).json({ error: "Admin cannot delete own account" });
    }
    await run("DELETE FROM users WHERE id = ?", [userId]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// --- Профиль текущего пользователя: смена пароля из модального окна profileModal. ---
app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const row = await get("SELECT id, username, full_name, role FROM users WHERE id = ?", [
      req.session.user.id,
    ]);
    return res.json({ profile: row });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// Проверка старого пароля (bcrypt) и установка нового.
app.put("/api/profile", requireAuth, async (req, res) => {
  try {
    const { old_password, password } = req.body || {};
    if (!old_password || !password) {
      return res.status(400).json({ error: "old_password and password required" });
    }

    const user = await get("SELECT id, password FROM users WHERE id = ?", [req.session.user.id]);
    const ok = await bcrypt.compare(old_password, user.password);
    if (!ok) return res.status(400).json({ error: "Old password is incorrect" });

    const hashed = await bcrypt.hash(password, 10);
    await run("UPDATE users SET password = ? WHERE id = ?", [hashed, req.session.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

// Сводная выгрузка за месяц в XLSX (кнопка «Выгрузить отчет за месяц»); опционально один сотрудник через user_id.
app.get("/api/export/month", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { year, month, user_id } = req.query;
    if (!year || !month) {
      return res.status(400).json({ error: "year and month are required" });
    }
    const paddedMonth = String(month).padStart(2, "0");

    const params = [String(year), paddedMonth];
    let userClause = "";
    if (user_id) {
      userClause = "AND u.id = ?";
      params.push(Number(user_id));
    }

    const rows = await all(
      `SELECT
        u.id as user_id,
        u.full_name,
        u.username,
        SUM(CASE WHEN r.type = 'work' THEN COALESCE(r.hours, 0) ELSE 0 END) AS work_hours,
        SUM(CASE WHEN r.type = 'method' THEN COALESCE(r.hours, 0) ELSE 0 END) AS method_hours,
        SUM(CASE WHEN r.type = 'sick' THEN COALESCE(r.days, 0) ELSE 0 END) AS sick_days,
        SUM(CASE WHEN r.type = 'vacation' THEN COALESCE(r.days, 0) ELSE 0 END) AS vacation_days
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
        AND strftime('%Y', r.date) = ?
        AND strftime('%m', r.date) = ?
      WHERE u.role = 'employee' ${userClause}
      GROUP BY u.id, u.full_name, u.username
      ORDER BY u.full_name`,
      params
    );

    const reportData = rows.map((r) => {
      const work = Number(r.work_hours || 0);
      const method = Number(r.method_hours || 0);
      return {
        "ID сотрудника": r.user_id,
        ФИО: r.full_name,
        Логин: r.username,
        "Рабочие часы": work,
        "Методические часы": method,
        "Всего (раб. + метод.), ч": Number((work + method)),
        "Больничные дни": Number(r.sick_days || 0),
        "Отпускные дни": Number(r.vacation_days || 0),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(reportData);
    XLSX.utils.book_append_sheet(wb, ws, "Сводка за месяц");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const filename = `monthly-report-${year}-${paddedMonth}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: "Failed to export report" });
  }
});

// Fallback для клиентской маршрутизации: любой не-API URL отдаёт index.html (одностраничное приложение).
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Запуск HTTP-сервера; точка входа при node server.js.
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
