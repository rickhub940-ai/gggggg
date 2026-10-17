# 999MS — key system + loader + control panel

เว็บหลัก: **https://loader999mss.vercel.app**
แดชบอร์ดควบคุม client: **https://loader999mss.vercel.app/control**

## Routes

| Path | ทำงานอะไร |
|---|---|
| `GET /` | หน้าเว็บหลัก (landing) |
| `GET /control` | แดชบอร์ดแอดมิน (ต้องใส่ `ADMIN_TOKEN`) |
| `GET /api/health` | สถานะระบบ (ไม่ต้อง auth) |
| `GET /loadc.lua` | stage 1 สร้างใหม่ทุก request + obfuscate |
| `GET /loada.lua/<d>/<n>` | stage 2 (ต้องมี capability อายุ 20 วิ) |
| `POST /api/verify` | ตรวจคีย์ Platoboost + HWID → ออก ticket |
| `POST /api/script` | แลก ticket → body ของสคริปต์ + runtime credentials |
| `POST /api/script-verify` | ตรวจ runtime proof (stateless, TTL 60 วิ) |
| `POST /api/heartbeat` | รับคำสั่ง/ตัด session |
| `POST /api/start` | สร้างลิงก์แลกคีย์จาก Platoboost |
| `POST /api/admin/ban` | แบน hwid / hwidHash / user / ip (ต้อง `x-admin-token`) |
| `POST /api/control/sessions` | รายชื่อ client ที่ออนไลน์ (proxy ไป realtime gateway) |
| `POST /api/control/command` | ส่ง `notice` / `reauth` / `disconnect` ถึง client |
| `POST /api/control/bans` | สรุปและรายการที่แบนอยู่ |

## Control panel

เปิด `/control` → ใส่ `ADMIN_TOKEN` (ดูได้ที่ Vercel → Project → Settings → Environment Variables)
token ถูกเก็บใน `sessionStorage` ของแท็บนั้นเท่านั้น

ฟีเจอร์: ดู client ที่เชื่อมต่อ (jti, สคริปต์, HWID hash, เวลาต่อ), ส่ง notice/reauth/kick รายคน,
broadcast ถึงทุกคน, kick ทั้งหมด, แบน HWID จากแถว client ได้โดยตรง, แบบฟอร์มแบนเอง, รีเฟรชอัตโนมัติ 15 วิ

### การเชื่อมกับ realtime gateway

`/api/control/*` จะ proxy ไปที่ `REALTIME_WS_URL` (แปลง `wss://host/realtime` → `https://host`)
โดยส่ง token ที่ derive จาก `REALTIME_TICKET_SECRET` (`HMAC-SHA256(secret, "999MS socket admin v1")`)
หรือ `SOCKET_ADMIN_TOKEN` ถ้าตั้งไว้ — ไม่ต้องคัดลอก secret เพิ่มระหว่าง Vercel กับ Render
และ browser ไม่เคยเห็น secret ตัวนี้

## Environment

| Key | ใช้ทำอะไร |
|---|---|
| `TICKET_SECRET` | ลงนาม ticket (≥32 chars) |
| `PAYLOAD_XOR_KEY` | XOR envelope ของ payload |
| `RUNTIME_CREDENTIAL_SECRET` | HMAC ของ runtime proof (fallback เป็น TICKET_SECRET) |
| `PLATO_SERVICE_ID` / `PLATO_SECRET` | Platoboost |
| `ADMIN_TOKEN` | token ของแดชบอร์ด + `/api/admin/ban` |
| `REALTIME_WS_URL` | `wss://.../realtime` ของ gateway |
| `REALTIME_TICKET_SECRET` | ใช้ derive admin token ของ gateway (ต้องตรงกับฝั่ง Render) |
| `SOCKET_ADMIN_TOKEN` | ไม่บังคับ — ถ้าตั้ง จะใช้แทน derived token |
| `ENFORCE_SCRIPT_HWID` | `1` = บังคับให้ `/api/script` ตรวจ hwid กับ ticket (ต้องให้ client ส่ง `hwid` มาด้วย) |

## Test

```bash
npm run test:sdk
```
