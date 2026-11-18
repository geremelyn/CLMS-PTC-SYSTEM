# Computer Laboratory Management System (CLMS)

React (Vite) frontend · Express backend · MySQL database.

## Requirements
Node.js 20+ (22 recommended), MySQL 8 or MariaDB 10.4+ (XAMPP works).

## 1. Database
1. Create an empty database (default name `ptc_clms`) in MySQL/phpMyAdmin.
2. Import your existing CLMS database dump if you have one.
3. **Migrations are automatic**: `server/database/ensureSchema.js` adds the new columns/tables when the server starts.
   To migrate manually instead, run `server/database/migrations/2026-10-31_clms_revisions.sql` (safe to repeat).

## 2. Configure the server
```
cd server
copy .env.example .env      (Windows)   |   cp .env.example .env   (macOS/Linux)
```
Edit `server/.env` and set `DB_PASSWORD` (and `DB_USER`, `DB_NAME` if different). **Never commit `.env`.**
The password is no longer hardcoded in the source: without `server/.env` the server connects with an empty password.

## 3. Install and run
```
cd server && npm install && npm start      # API on http://localhost:5000
cd client && npm install && npm run dev    # app on http://localhost:5173
```
Windows helper scripts `START-CLMS.bat` / `RUN-CLMS-WINDOWS.ps1` and `INSTALL-WINDOWS.md` are unchanged.

## 4. Checks
```
cd server && npm test           # backend tests (node:test)
cd client && npm run lint
cd client && npm run build
```

## Roles
MIS (Super Admin / MIS Head), Inventory Staff (shown as "MIS Staff"), Dean, Teacher, and custom roles ("Others"). Database role names are unchanged.
The Recycle Bin is MIS-only.

**Custom role ("Others")** (current behaviour since CP68/CP69):
- Stored as role `Others` plus the typed label in `users.role_other`; the label (for example "Laboratory Assistant") is what the screens show. The account is created ACTIVE and, like Dean/Teacher accounts, must change its first password.
- It has the Teacher-style **laboratory reservation** access only: Dashboard (the Teacher dashboard), Reserve Laboratory (availability, create, cancel, undo), My Reservations (own reservations only), read access to the laboratory and holiday lists, Change Password and Logout.
- It does **not** have Reports, Report Issue, Maintenance, Computers, Equipments, User Management, Audit Log, Holidays management or the Recycle Bin, and it is not in any admin `requireRole` list.
- It is not the same as Teacher: it never receives Teacher-only or admin routes beyond the list above.

## Project status
The current implemented / needs-verification / needs-decision summary is in `CURRENT_REVISION_STATUS_CP79.md`. Older audit files are historical.
