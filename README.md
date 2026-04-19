# MVP: Учет времени сотрудников

<!--
  Пояснения к архитектуре и блокам кода вынесены в комментарии в исходниках:
  server.js (API), db/init.js (схема БД), public/app.js (клиент), public/index.html и public/style.css.
-->

Простой веб-сервис для учета рабочих часов, методических часов, больничных и отпусков.

## Технологии

- Backend: Node.js, Express, SQLite
- Frontend: HTML/CSS/JS, Bootstrap 5
- Auth: express-session
- Export: SheetJS (XLSX)

## Установка и запуск

1. Установите Node.js (рекомендуется LTS 18+).
2. В корне проекта выполните:

```bash
npm install
npm run init-db
npm start
```

3. Откройте [http://localhost:3000](http://localhost:3000).

## Стартовый админ

- Логин: `admin`
- Пароль: `admin123`

Можно переопределить через переменные окружения перед `npm run init-db`:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_FULL_NAME`

## Основные возможности

- Авторизация (сессии)
- CRUD записей с ролями `employee/admin`
- Фильтр по году/месяцу
- Сводка за месяц
- Комментарии для всех типов записей
- `updated_at` отображается в таблице
- Админ-управление сотрудниками (создать/редактировать/удалить каскадно)
- Экспорт текущей таблицы сотрудника в Excel (frontend)
- Экспорт месячной сводки по всем сотрудникам (backend endpoint)

## Важные правила из текущей реализации

- Для `work/method` обязательны `hours`
- Для `sick/vacation` обязательны `days`
- Для `method` комментарий обязателен
- Сотрудник в профиле может менять только пароль (через старый пароль)

## API кратко

- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Records: `GET/POST /api/records`, `PUT/DELETE /api/records/:id`
- Users (admin): `GET/POST /api/users`, `PUT/DELETE /api/users/:id`
- Profile: `GET /api/profile`, `PUT /api/profile`
- Export (admin): `GET /api/export/month?year=YYYY&month=MM[&user_id=ID]`
