# GiftNFT — Full Working Version (Local)

This is a complete local app (backend + frontend) for your NFT gifts marketplace.

## Features
- Multi-page frontend: Home, Market, Profile, Admin, Auth
- Auth (register/login) with JWT
- Market items with exact-price charging (no more "1" bug)
- Buy and Gift from Market (gift prompts for recipient User ID)
- Admin panel: list users with IDs and **issue gifts** to any user — charges the **recipient** exactly the current market price
- Per-NFT upgrade by **ID** only (never entire collection)
- Live updates via Socket.IO

## Quick Start
1. Install Node.js v18+
2. Unzip this folder
3. Copy `.env.example` to `.env` (edit if needed)
4. Install deps:
   ```bash
   npm i
   ```
5. Run:
   ```bash
   npm start
   ```
6. Open http://localhost:8080

### Default Accounts
- **Admin**: `admin@example.com` / `admin123`  (configurable in `.env`)
- **User** (seed): `alice@example.com` / `alice123`
- **User** (seed): `bob@example.com` / `bob123`

### API Endpoints Used by Frontend
- `POST /api/auth/register`, `POST /api/auth/login`
- `GET /api/market/items`
- `POST /api/tx/pay` with `{ itemId, mode: 'buy'|'gift', toUserId? }`
- `POST /api/nft/upgrade` with `{ id }`
- `GET /api/me`, `GET /api/me/owned`, `GET /api/me/history`
- `GET /api/admin/users` (admin), `POST /api/admin/gift` (admin)

> **Important:** All charges always use the server-side `item.price`. Client-supplied amounts are ignored for safety.

### Data Persistence
- JSON file at `./data/db.json`.
- Seeded on first run with admin, two users, and **empty market** (0 NFTs).

### Change Backend Origin
If you host backend separately, set in HTML head:
```html
<script>window.API_ORIGIN = "https://api.yourdomain.com";</script>
```

### Notes
- This local build simulates balances and ownership in the app DB (no blockchain dependency). You can later wire real TON payments, but the app is fully functional now.


## v3 — Payments System
- 1 TON = **3.5 USD** (`/api/rate`)
- New page **/payments.html** with deposit & withdraw requests
- Admin approves/rejects payments in **Admin → Payments**
- Notifications in real time (Socket.IO), plus `/api/notifications`
- Initial balances now **0 TON**
- Withdraw creates a pending payout to TON address (funds held until approved)
