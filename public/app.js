/**
 * Клиентское приложение учёта времени: вызовы REST API (server.js), отображение таблиц и форм из index.html.
 * Состояние: текущий пользователь сессии, записи за месяц, полный список пользователей для администратора.
 */

let currentUser = null;
let currentRecords = [];
let allUsers = [];

const monthInput = document.getElementById("monthInput");
const yearInput = document.getElementById("yearInput");

// Заполнение выпадающего списка месяцев (1–12) и установка текущего года/месяца по умолчанию для фильтра записей.
for (let i = 1; i <= 12; i += 1) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = String(i);
  monthInput.appendChild(option);
}

const now = new Date();
monthInput.value = String(now.getMonth() + 1);
yearInput.value = String(now.getFullYear());

// Краткое уведомление пользователю в верхней части страницы (#alertBox в index.html).
function showAlert(message, type = "success") {
  const box = document.getElementById("alertBox");
  box.innerHTML = `<div class="alert alert-${type}" role="alert">${message}</div>`;
  setTimeout(() => {
    box.innerHTML = "";
  }, 3000);
}

// Проверка типов записей, для которых вводятся часы (а не дни больничного/отпуска).
function isHoursType(type) {
  return type === "work" || type === "method";
}

function parseTimeToMinutes(value) {
  if (!value || !value.includes(":")) return null;
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Тариф и расчёт учётных часов по диапазону времени (должно совпадать с server.js при POST/PUT записей).
 * Используется в режиме «Диапазон времени» формы записи и в updateRangePreview для подсказок ×2.
 */
const TARIFF_DAY_START_MIN = 8 * 60 + 30;
const TARIFF_DAY_END_EXC = 18 * 60 + 31;
const TARIFF_LATE_START_MIN = 18 * 60 + 31;

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

// Обёртка над fetch: JSON по умолчанию, распознавание JSON/Blob ответа, единообразные ошибки с телом { error }.
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = "Request failed";
    try {
      const data = await res.json();
      msg = data.error || msg;
    } catch (e) {
      msg = "Request failed";
    }
    throw new Error(msg);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.blob();
}

// Подсказки у поля комментария: обязательность для методических часов и при тарифе ×2 (рабочие часы).
function updateCommentMethodHint() {
  const el = document.getElementById("commentRequiredMethod");
  if (!el) return;
  const type = document.getElementById("recordType").value;
  el.classList.toggle("d-none", type !== "method");
}

// Подпись к полю значения («Часы» или «Дни») и обновление подсказок при смене типа записи.
function updateRecordValueLabel() {
  const type = document.getElementById("recordType").value;
  const label = document.getElementById("valueLabel");
  label.textContent = type === "work" || type === "method" ? "Часы" : "Дни";
  updateCommentMethodHint();
  updateValueInputVisibility();
}

// Форматирование длительности в часах для превью диапазона (без лишних нулей справа).
function fmtHoursFromMinutes(min) {
  return (min / 60).toFixed(2).replace(/\.?0+$/, "");
}

// Текст под полями «С»/«До»: расчёт взвешенных часов и показ предупреждения о ×2 и необходимости комментария.
function updateRangePreview() {
  const start = document.getElementById("rangeStart").value;
  const end = document.getElementById("rangeEnd").value;
  const preview = document.getElementById("rangePreview");
  const hint = document.getElementById("tariffX2Hint");
  const commentTariff = document.getElementById("commentRequiredTariff");

  if (!hint || !commentTariff) return;

  if (!start || !end) {
    preview.textContent = "Укажите время начала и окончания";
    hint.classList.add("d-none");
    commentTariff.classList.add("d-none");
    return;
  }

  const calc = computeWeightedShiftFromRange(start, end);
  if (!calc) {
    preview.textContent = "Укажите корректный диапазон (конец позже начала)";
    hint.classList.add("d-none");
    commentTariff.classList.add("d-none");
    return;
  }

  const rawH = fmtHoursFromMinutes(calc.rawMinutes);
  const normH = fmtHoursFromMinutes(calc.normalMinutes);
  const x2H = fmtHoursFromMinutes(calc.x2Minutes);
  preview.textContent = `Смена: ${rawH} ч → в учёт: ${calc.weightedHours.toFixed(2)} ч (без ×2: ${normH} ч, с ×2: ${x2H} ч)`;

  if (calc.x2Minutes > 0) {
    hint.classList.remove("d-none");
    hint.textContent =
      "Время выходит за интервал 08:30–18:30: соответствующие минуты учитываются с коэффициентом ×2. Укажите в комментарии причину.";
    const type = document.getElementById("recordType").value;
    if (type === "work") {
      commentTariff.classList.remove("d-none");
    } else {
      commentTariff.classList.add("d-none");
    }
  } else {
    hint.classList.add("d-none");
    commentTariff.classList.add("d-none");
  }
}

// Переключение между вводом числа часов и диапазоном времени; скрытие/показ полей в зависимости от типа записи.
function updateValueInputVisibility() {
  const type = document.getElementById("recordType").value;
  const mode = document.getElementById("hoursInputMode").value;
  const hoursModeWrap = document.getElementById("hoursInputModeWrap");
  const valueInput = document.getElementById("recordValue");
  const rangeWrap = document.getElementById("timeRangeWrap");

  if (isHoursType(type)) {
    hoursModeWrap.classList.remove("d-none");
    if (mode === "range") {
      valueInput.classList.add("d-none");
      valueInput.required = false;
      rangeWrap.classList.remove("d-none");
      document.getElementById("rangeStart").required = true;
      document.getElementById("rangeEnd").required = true;
      updateRangePreview();
    } else {
      valueInput.classList.remove("d-none");
      valueInput.required = true;
      rangeWrap.classList.add("d-none");
      document.getElementById("rangeStart").required = false;
      document.getElementById("rangeEnd").required = false;
      document.getElementById("rangePreview").textContent = "";
      const hint = document.getElementById("tariffX2Hint");
      const commentTariff = document.getElementById("commentRequiredTariff");
      if (hint) hint.classList.add("d-none");
      if (commentTariff) commentTariff.classList.add("d-none");
    }
  } else {
    hoursModeWrap.classList.add("d-none");
    valueInput.classList.remove("d-none");
    valueInput.required = true;
    rangeWrap.classList.add("d-none");
    document.getElementById("rangeStart").required = false;
    document.getElementById("rangeEnd").required = false;
    document.getElementById("rangePreview").textContent = "";
    const hint = document.getElementById("tariffX2Hint");
    const commentTariff = document.getElementById("commentRequiredTariff");
    if (hint) hint.classList.add("d-none");
    if (commentTariff) commentTariff.classList.add("d-none");
  }
}

// Для админа: id сотрудника из фильтра списка записей (employeeFilter); влияет на GET /api/records и отчёт за месяц.
function getSelectedUserForRecords() {
  if (currentUser.role !== "admin") return null;
  const value = document.getElementById("employeeFilter").value;
  return value ? Number(value) : null;
}

// Для админа: для кого создаётся/редактируется запись в форме (recordEmployeeSelect); передаётся как user_id в API.
function getRecordFormUserId() {
  if (currentUser.role !== "admin") return null;
  const value = document.getElementById("recordEmployeeSelect").value;
  return value ? Number(value) : null;
}

// Отрисовка таблицы «Записи» (#recordsTableBody) из массива currentRecords после loadRecords.
function renderRecords() {
  const tbody = document.getElementById("recordsTableBody");
  tbody.innerHTML = "";

  currentRecords.forEach((record) => {
    const tr = document.createElement("tr");
    const value = record.hours != null ? record.hours : record.days;
    tr.innerHTML = `
      <td>${record.date}</td>
      <td>${record.type}</td>
      <td>${value ?? ""}</td>
      <td>${record.comment ?? ""}</td>
      <td>${record.updated_at ?? ""}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary me-1" data-edit-id="${record.id}">Ред.</button>
        <button class="btn btn-sm btn-outline-danger" data-del-id="${record.id}">Удал.</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Обновление карточек итогов (#summaryCards) по текущему списку записей за месяц.
function renderSummary() {
  const sum = { work: 0, method: 0, sick: 0, vacation: 0 };
  currentRecords.forEach((r) => {
    if (r.type === "work") sum.work += Number(r.hours || 0);
    if (r.type === "method") sum.method += Number(r.hours || 0);
    if (r.type === "sick") sum.sick += Number(r.days || 0);
    if (r.type === "vacation") sum.vacation += Number(r.days || 0);
  });
  document.getElementById("sumWork").textContent = sum.work;
  document.getElementById("sumMethod").textContent = sum.method;
  document.getElementById("sumSick").textContent = sum.sick;
  document.getElementById("sumVacation").textContent = sum.vacation;
}

// Сброс формы записи в режим «добавить» после сохранения или по кнопке «Отмена».
function resetRecordForm() {
  document.getElementById("recordId").value = "";
  document.getElementById("recordForm").reset();
  document.getElementById("recordType").value = "work";
  document.getElementById("hoursInputMode").value = "hours";
  document.getElementById("rangeStart").value = "";
  document.getElementById("rangeEnd").value = "";
  updateRecordValueLabel();
  document.getElementById("recordSubmitBtn").textContent = "Добавить";
  document.getElementById("cancelEditBtn").classList.add("d-none");
  document.getElementById("recordDate").value = now.toISOString().slice(0, 10);
}

// Загрузка списка пользователей GET /api/users (только admin): селекты фильтра/формы и таблица сотрудников.
async function loadUsers() {
  if (currentUser.role !== "admin") return;
  const data = await api("/api/users");
  allUsers = data.users;

  const filter = document.getElementById("employeeFilter");
  const recordSelect = document.getElementById("recordEmployeeSelect");
  const usersBody = document.getElementById("usersTableBody");
  const prevFilterValue = filter.value;
  const prevRecordValue = recordSelect.value;

  filter.innerHTML = "";
  recordSelect.innerHTML = "";
  usersBody.innerHTML = "";

  const allEmployeesOption = document.createElement("option");
  allEmployeesOption.value = "";
  allEmployeesOption.textContent = "Все сотрудники";
  filter.appendChild(allEmployeesOption);

  allUsers
    .filter((u) => u.role === "employee")
    .forEach((u) => {
      const opt1 = document.createElement("option");
      opt1.value = String(u.id);
      opt1.textContent = `${u.full_name} (${u.username})`;
      filter.appendChild(opt1);

      const opt2 = document.createElement("option");
      opt2.value = String(u.id);
      opt2.textContent = `${u.full_name} (${u.username})`;
      recordSelect.appendChild(opt2);
    });

  allUsers.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.full_name}</td>
      <td>${u.username}</td>
      <td>${roleLabelRu(u.role)}</td>
      <td>
        ${u.role === "employee" ? `<button class="btn btn-sm btn-outline-primary me-1" data-user-edit="${u.id}">Ред.</button>
        <button class="btn btn-sm btn-outline-danger" data-user-del="${u.id}">Удал.</button>` : ""}
      </td>
    `;
    usersBody.appendChild(tr);
  });

  if (prevFilterValue && Array.from(filter.options).some((o) => o.value === prevFilterValue)) {
    filter.value = prevFilterValue;
  } else {
    filter.value = "";
  }

  if (prevRecordValue && Array.from(recordSelect.options).some((o) => o.value === prevRecordValue)) {
    recordSelect.value = prevRecordValue;
  }
}

// Загрузка записей за выбранный год и месяц GET /api/records с опциональным user_id для администратора.
async function loadRecords() {
  const year = yearInput.value;
  const month = monthInput.value;
  const params = new URLSearchParams({ year, month });

  const selectedUser = getSelectedUserForRecords();
  if (selectedUser) params.set("user_id", String(selectedUser));

  const data = await api(`/api/records?${params.toString()}`);
  currentRecords = data.records || [];
  renderRecords();
  renderSummary();
}

// Человекочитаемые подписи типов записей для экспорта и отображения (при необходимости расширить для таблицы).
function recordTypeLabelRu(type) {
  const map = {
    work: "Рабочие часы",
    method: "Методические часы",
    sick: "Больничный",
    vacation: "Отпуск",
  };
  return map[type] || type;
}

// Отображение ролей admin/employee русскими словами в таблице пользователей и в строке userInfo.
function roleLabelRu(role) {
  const map = {
    admin: "Админ",
    employee: "Сотрудник",
  };
  return map[role] || role;
}

// Преобразование даты из БД в формат ДД.ММ.ГГГГ для экспорта в Excel (локальная таблица и итоговая строка).
function formatDateDdMmYyyy(value) {
  if (!value) return "";
  const part = String(value).trim().split("T")[0].split(" ")[0];
  const [y, m, d] = part.split("-");
  if (!y || !m || !d) return String(value);
  return `${d.padStart(2, "0")}.${m.padStart(2, "0")}.${y}`;
}

// Колонка «Обновлено» в клиентском экспорте текущей таблицы записей (кнопка «Экспорт таблицы»).
function formatUpdatedAtForExport(value) {
  if (!value) return "";
  const s = String(value).trim().replace("T", " ");
  const [datePart, timePart] = s.split(/\s+/);
  const formatted = formatDateDdMmYyyy(datePart);
  if (timePart && timePart.length >= 5) {
    return `${formatted} ${timePart.slice(0, 5)}`;
  }
  return formatted;
}

// Экспорт видимых на экране записей месяца в .xlsx через SheetJS (браузер; файл скачивается пользователю).
function exportCurrentTable() {
  const rows = currentRecords.map((r) => ({
    Дата: formatDateDdMmYyyy(r.date),
    Тип: recordTypeLabelRu(r.type),
    "Часы / дни": r.hours != null ? r.hours : r.days,
    Комментарий: r.comment || "",
    Обновлено: formatUpdatedAtForExport(r.updated_at),
  }));

  let totalWorkAndMethod = 0;
  currentRecords.forEach((r) => {
    if (r.type === "work" || r.type === "method") {
      totalWorkAndMethod += Number(r.hours || 0);
    }
  });

  rows.push({
    Дата: "",
    Тип: "Итого (рабочие + методические), ч",
    "Часы / дни": Number(totalWorkAndMethod.toFixed(2)),
    Комментарий: "",
    Обновлено: "",
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Записи");
  XLSX.writeFile(wb, `records-${yearInput.value}-${monthInput.value}.xlsx`);
}

// Скачивание сводного отчёта за месяц с сервера GET /api/export/month (blob XLSX, только admin).
async function exportMonthlyAdminReport() {
  const params = new URLSearchParams({
    year: yearInput.value,
    month: monthInput.value,
  });
  const selectedUser = getSelectedUserForRecords();
  if (selectedUser) params.set("user_id", String(selectedUser));

  const blob = await api(`/api/export/month?${params.toString()}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `monthly-report-${yearInput.value}-${monthInput.value}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// Открытие модального окна создания сотрудника (userModal, POST /api/users).
function openUserModalForCreate() {
  document.getElementById("userModalTitle").textContent = "Создать сотрудника";
  document.getElementById("userEditId").value = "";
  document.getElementById("userForm").reset();
  document.getElementById("userUsername").disabled = false;
  bootstrap.Modal.getOrCreateInstance(document.getElementById("userModal")).show();
}

// Заполнение модального окна данными сотрудника для PUT /api/users/:id.
function openUserModalForEdit(user) {
  document.getElementById("userModalTitle").textContent = "Редактировать сотрудника";
  document.getElementById("userEditId").value = String(user.id);
  document.getElementById("userUsername").value = user.username;
  document.getElementById("userFullName").value = user.full_name;
  document.getElementById("userPassword").value = "";
  document.getElementById("userUsername").disabled = true;
  bootstrap.Modal.getOrCreateInstance(document.getElementById("userModal")).show();
}

// Показ/скрытие элементов интерфейса только для администратора (фильтр сотрудников, блок пользователей, селект в форме записи).
function applyRoleVisibility() {
  const isAdmin = currentUser && currentUser.role === "admin";
  const employeeFilterWrap = document.getElementById("employeeFilterWrap");
  const recordEmployeeWrap = document.getElementById("recordEmployeeWrap");
  const adminUsersSection = document.getElementById("adminUsersSection");

  employeeFilterWrap.classList.toggle("d-none", !isAdmin);
  recordEmployeeWrap.classList.toggle("d-none", !isAdmin);
  adminUsersSection.classList.toggle("d-none", !isAdmin);

  if (!isAdmin) {
    document.getElementById("usersTableBody").innerHTML = "";
    document.getElementById("employeeFilter").innerHTML = "";
    document.getElementById("recordEmployeeSelect").innerHTML = "";
    allUsers = [];
  }
}

// Переход с экрана входа к дашборду: подпись пользователя, видимость по роли, загрузка пользователей и записей.
async function initDashboard() {
  document.getElementById("loginView").classList.add("d-none");
  document.getElementById("dashboardView").classList.remove("d-none");
  document.getElementById("userInfo").textContent = `${currentUser.full_name} (${roleLabelRu(currentUser.role)})`;
  resetRecordForm();
  applyRoleVisibility();

  if (currentUser.role === "admin") {
    await loadUsers();
  }
  await loadRecords();
}

// При загрузке страницы: если сессия действует GET /api/auth/me — открыть дашборд, иначе оставить форму входа.
async function checkSession() {
  try {
    const data = await api("/api/auth/me");
    currentUser = data.user;
    await initDashboard();
  } catch (e) {
    document.getElementById("loginView").classList.remove("d-none");
    document.getElementById("dashboardView").classList.add("d-none");
  }
}

// --- Обработчики: вход, выход, смена вида формы записи и применение фильтра по месяцу. ---
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    currentUser = data.user;
    showAlert("Вход выполнен");
    await initDashboard();
  } catch (err) {
    showAlert(err.message, "danger");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  currentUser = null;
  applyRoleVisibility();
  document.getElementById("dashboardView").classList.add("d-none");
  document.getElementById("loginView").classList.remove("d-none");
});

// Поля формы записи: переключение типа/режима ввода часов, превью диапазона, фильтр периода и экспорт текущей таблицы.
document.getElementById("recordType").addEventListener("change", updateRecordValueLabel);
document.getElementById("hoursInputMode").addEventListener("change", updateValueInputVisibility);
document.getElementById("rangeStart").addEventListener("input", updateRangePreview);
document.getElementById("rangeEnd").addEventListener("input", updateRangePreview);
document.getElementById("applyFilterBtn").addEventListener("click", () => loadRecords());
document.getElementById("exportCurrentBtn").addEventListener("click", exportCurrentTable);
document.getElementById("cancelEditBtn").addEventListener("click", resetRecordForm);
document.getElementById("profileBtn").addEventListener("click", () => {
  document.getElementById("profileForm").reset();
  bootstrap.Modal.getOrCreateInstance(document.getElementById("profileModal")).show();
});

// Отправка формы смены пароля (profileModal) на PUT /api/profile с проверкой совпадения новых полей.
document.getElementById("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const oldPassword = document.getElementById("oldPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const newPassword2 = document.getElementById("newPassword2").value;
  if (newPassword !== newPassword2) {
    showAlert("Новый пароль и подтверждение не совпадают", "danger");
    return;
  }

  try {
    await api("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ old_password: oldPassword, password: newPassword }),
    });
    bootstrap.Modal.getOrCreateInstance(document.getElementById("profileModal")).hide();
    showAlert("Пароль обновлен");
  } catch (err) {
    showAlert(err.message, "danger");
  }
});

// Создание или обновление записи POST/PUT /api/records: сбор payload, валидация комментария и тарифа ×2 на клиенте.
document.getElementById("recordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const type = document.getElementById("recordType").value;
    const mode = document.getElementById("hoursInputMode").value;
    const value = Number(document.getElementById("recordValue").value);
    const comment = document.getElementById("recordComment").value.trim();
    const payload = {
      date: document.getElementById("recordDate").value,
      type,
      comment,
    };
    if (isHoursType(type)) {
      if (mode === "range") {
        const start = document.getElementById("rangeStart").value;
        const end = document.getElementById("rangeEnd").value;
        const calc = computeWeightedShiftFromRange(start, end);
        if (!calc) {
          showAlert("Некорректный диапазон времени", "danger");
          return;
        }
        if (type === "work" && calc.x2Minutes > 0 && !comment) {
          showAlert("При тарифе ×2 укажите в комментарии причину", "danger");
          return;
        }
        payload.hours = calc.weightedHours;
        payload.range_start = start;
        payload.range_end = end;
      } else {
        payload.hours = value;
      }
    }
    if (type === "method" && !comment) {
      showAlert("Комментарий обязателен при заполнении методических часов", "danger");
      return;
    }
    if (type === "sick" || type === "vacation") payload.days = value;
    const selectedUser = getRecordFormUserId();
    if (selectedUser) payload.user_id = selectedUser;

    const recordId = document.getElementById("recordId").value;
    if (recordId) {
      await api(`/api/records/${recordId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showAlert("Запись обновлена");
    } else {
      await api("/api/records", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showAlert("Запись добавлена");
    }
    resetRecordForm();
    await loadRecords();
  } catch (err) {
    showAlert(err.message, "danger");
  }
});

// Делегирование кликов по кнопкам «Ред.»/«Удал.» в таблице записей: заполнение формы или DELETE /api/records/:id.
document.getElementById("recordsTableBody").addEventListener("click", async (e) => {
  const editId = e.target.getAttribute("data-edit-id");
  const delId = e.target.getAttribute("data-del-id");
  if (editId) {
    const record = currentRecords.find((r) => r.id === Number(editId));
    if (!record) return;
    document.getElementById("recordId").value = String(record.id);
    document.getElementById("recordDate").value = record.date;
    document.getElementById("recordType").value = record.type;
    document.getElementById("hoursInputMode").value = "hours";
    document.getElementById("rangeStart").value = "";
    document.getElementById("rangeEnd").value = "";
    document.getElementById("recordValue").value = record.hours != null ? record.hours : record.days;
    document.getElementById("recordComment").value = record.comment || "";
    updateRecordValueLabel();
    document.getElementById("recordSubmitBtn").textContent = "Сохранить";
    document.getElementById("cancelEditBtn").classList.remove("d-none");
    return;
  }
  if (delId) {
    const confirmed = window.confirm("Удалить запись?");
    if (!confirmed) return;
    await api(`/api/records/${delId}`, { method: "DELETE" });
    showAlert("Запись удалена");
    await loadRecords();
  }
});

// Админ: открытие формы нового сотрудника и вызов серверного месячного отчёта (exportMonthlyAdminReport).
document.getElementById("createUserBtn").addEventListener("click", openUserModalForCreate);
document.getElementById("exportMonthlyBtn").addEventListener("click", async () => {
  try {
    await exportMonthlyAdminReport();
  } catch (err) {
    showAlert(err.message, "danger");
  }
});

// Делегирование в таблице сотрудников: редактирование (userModal) или DELETE /api/users/:id с подтверждением.
document.getElementById("usersTableBody").addEventListener("click", async (e) => {
  const userEditId = e.target.getAttribute("data-user-edit");
  const userDelId = e.target.getAttribute("data-user-del");
  if (userEditId) {
    const user = allUsers.find((u) => u.id === Number(userEditId));
    if (user) openUserModalForEdit(user);
    return;
  }
  if (userDelId) {
    const confirmed = window.confirm("Удалить сотрудника и все его записи?");
    if (!confirmed) return;
    await api(`/api/users/${userDelId}`, { method: "DELETE" });
    showAlert("Сотрудник удален");
    await loadUsers();
    await loadRecords();
  }
});

// Сохранение формы userModal: POST при создании или PUT при редактировании сотрудника.
document.getElementById("userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("userEditId").value;
  const username = document.getElementById("userUsername").value.trim();
  const fullName = document.getElementById("userFullName").value.trim();
  const password = document.getElementById("userPassword").value;

  try {
    if (!id) {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, full_name: fullName, password }),
      });
      showAlert("Сотрудник создан");
    } else {
      const payload = { full_name: fullName };
      if (password) payload.password = password;
      await api(`/api/users/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showAlert("Сотрудник обновлен");
    }
    bootstrap.Modal.getOrCreateInstance(document.getElementById("userModal")).hide();
    await loadUsers();
    await loadRecords();
  } catch (err) {
    showAlert(err.message, "danger");
  }
});

// Точка входа: попытка восстановить сессию и показать дашборд без повторного ввода логина.
checkSession();
