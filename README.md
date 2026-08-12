# Procura

Procurement management system — a Go rewrite of a Google Apps Script + Python hybrid, deployable as a single binary.

## Features

- **Inventory** — items CRUD, search, pagination, item history, anchor fields, ROP tracking
- **Suppliers** — CRUD, performance scorecards
- **Purchase orders** — PO + line items, workflow approvals (no email)
- **Stock movement** — movements with automatic reorder-point recalculation
- **Planning** — what-to-buy recommendations
- **RFQ** — draft creation and history
- **Reports & analytics** — metric reports, item history, weekly report, executive dashboard with frozen baselines
- **Tasks** — simple task tracking
- **Catalogue** — supplier catalogue import, deal parsing, search
- **UOM normalization** — supplier→standard unit mapping, item-level usage
- **Excel import** — workbook upload (items, suppliers, POs, movements)
- **Auth** — PIN + JWT, roles (ADMIN / EDITOR / VIEWER), read-only demo login

## Tech stack

- Go 1.22+ stdlib (`net/http`, `html/template`, `database/sql`, `embed`)
- `modernc.org/sqlite` — pure-Go SQLite (no CGO)
- `excelize` — Excel import
- `bcrypt` + `jwt/v5` — auth

## Run

```sh
go build -o procura .
./procura            # listens on :8082 (env PORT to change)
```

First run bootstraps an admin user (email from `PROCURA_ADMIN_EMAIL`, default `admin@procura.local`) and prints a one-time PIN.

Environment variables:

| Var | Purpose |
|-----|---------|
| `PROCURA_SECRET` | JWT signing secret (required in production) |
| `PROCURA_ADMIN_EMAIL` | Email for the bootstrapped admin user |
| `PORT` | HTTP listen port (default 8082) |

Data lives in `data/procura.sqlite` (relative to working directory).

## Deployment

Single binary + SQLite file. Example systemd unit:

```ini
[Service]
Environment=PROCURA_SECRET=<random hex>
WorkingDirectory=/home/procura
ExecStart=/usr/local/bin/procura
Restart=on-failure
```

## License

MIT
