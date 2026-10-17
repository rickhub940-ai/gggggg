# 2026-10-17 — landing page + deploy fixes

## Why
The Vercel project (`loader999mss`) had **no web payload at all**: every non-API path
fell through to `/(.*) → action=trap` (302 to `yura.lol`), and the Lua built into the
generated stage 1 still pointed at `https://loader999ms.vercel.app`, a deployment that
no longer exists (`DEPLOYMENT_NOT_FOUND`). Result: no site to look at, and a fresh
deploy would have broken the loader chain.

## Changes

### `public/index.html` (new)
Self-contained Thai landing page (no CDN, no external fonts): hero + copyable
loadstring, 3-step usage, feature grid, FAQ, live status panel that pings
`/api/health`. Inline CSS/JS, respects `prefers-reduced-motion`, mobile layout.

### `vercel.json`
- `GET /` → `/index.html` (site is reachable; unknown paths still trap).
- `/api/health` → `action=health` (public, credential-free probe).
- `/api/admin/ban` → `action=admin-ban`. **The ban endpoint was unreachable before**:
  there was no route for `/api/auth`, so the catch-all swallowed it and returned 302.

### `api/auth.js`
- `requestOrigin(req)` derives `https://<x-forwarded-host | host>` and the generated
  stage 1 now embeds it instead of the dead host (`local $f="@BASE_URL@"`).
- `scripts/main.lua` gets `${BASEURL}` substituted per request, so `BASE_URL` matches
  whatever host the executor actually reached (works on preview URLs / renamed projects).
- New `action=health` handler: `{ ok, service, version, chain, realtime, ts }`.
- `ENFORCE_SCRIPT_HWID=1` (opt-in) makes `/api/script` require `hwid` and compare it to
  the ticket's `hwidHash` — closes the ticket-replay window from the review (H1).
  Off by default because the deployed client may not send `hwid` to this endpoint yet.
- Removed the duplicate `checkRateLimit()` inside `/api/start` (it double-counted).

### `test/sdk.test.js`
- Updated the `renderLoadcArtifact()` signature assertion.
- Added `/api/health` probe assertions and a host-templating assertion
  (`x-forwarded-host: preview.example.test` ends up inside the generated stage 1).

## Deploy
`vercel deploy --prod` → aliased to `https://loader999mss.vercel.app`.
Verified: `/` 200 HTML, `/api/health` 200 JSON, `/loadc.lua` 200 (obfuscated),
`/payload.lua` 200, `/api/verify` 400 `key required`, `/api/admin/ban` 401 (no longer
trapped), unknown path 302 → trap.

## Still open (from review)
- H1 fully only when `ENFORCE_SCRIPT_HWID=1` and the client sends `hwid`.
- H3: `userId` still comes from the client body.
- H4: ban/session state is still per-instance (needs KV).
- H5: WeAreDevs is still called on every `/loadc.lua`.

---

# 2026-10-17 (รอบ 2) — เว็บควบคุม client

## Gateway `loader999mss-realtime` → v1.1.0 (deploy อัตโนมัติบน Render แล้ว)
- `GET /admin/sessions` — รายชื่อ session ที่เชื่อมต่อ (jti, scriptName, hwidHash, connectedAt, lastActivityAt)
- `GET /admin/stats` — จำนวน session + uptime
- `/health` เพิ่ม `version` และ `uptime`
- session เก็บ `hwidHash` ไว้ เพื่อให้แบนราย client ได้จากแดชบอร์ด
- admin auth รับได้ทั้ง `SOCKET_ADMIN_TOKEN` และ token ที่ derive จาก
  `REALTIME_TICKET_SECRET` (`HMAC-SHA256(secret, "999MS socket admin v1")`)
  → Vercel กับ Render ไม่ต้องคัดลอก secret เพิ่ม และ browser ไม่เคยเห็น secret
- test เพิ่มเคส 401/200 ของ `/admin/sessions`, `/admin/stats`, derived token

## Vercel `whilstkey`
- `public/control.html` → `/control` แดชบอร์ด:
  login ด้วย ADMIN_TOKEN (เก็บใน sessionStorage), stat cards, ตาราง client,
  notice/reauth/kick รายคน, แบน HWID จากแถว client, ฟอร์มแบน hwid/hwidHash/user/ip,
  broadcast, kick ทั้งหมด, log, รีเฟรชอัตโนมัติ 15 วิ
- `POST /api/control/sessions|command|bans` — proxy ไป gateway, ตรวจ ADMIN_TOKEN แบบ timing-safe,
  trim/validate jti และ command whitelist (`notice|reauth|disconnect`)
- `lib/revoke.js`: เพิ่ม `revokeHwidHash()` + `listRevocations()` และ type `hwidHash` ใน `/api/admin/ban`
- `vercel.json`: routes `/control`, `/api/control/*`; `maxDuration` 30 วิ (รองรับ Render cold start)
- `api/auth.js`: `isAdminRequest()` รับ `x-admin-token` หรือ `Authorization: Bearer`
- landing page: เพิ่มลิงก์ Control ใน footer

## ทดสอบ E2E บน production
1. จำลอง client เชื่อม `wss://loader999mss-realtime.onrender.com/realtime` → handshake ผ่าน
2. `POST /api/control/sessions` เห็น 1 session พร้อม hwidHash
3. `POST /api/control/command` `notice` → client ได้รับ `{type:"command",command:"notice",message:"สวัสดีจากแดชบอร์ด"}` จริง
4. `POST /api/admin/ban` type `hwidHash` → 200 และ `/api/control/bans` แสดงรายการ
5. anon/bad token → 401 ทุก endpoint
