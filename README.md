# 999MS — loader, key API และแผงควบคุม

โปรเจกต์นี้คือ **ตัวล่าสุด** (`loader999mss-source-no-obf-txt`) ที่นำมาแทนของเดิมทั้งหมด
`loadc` เป็น stage เดียวที่ obfuscate; stages 2–4 เป็น Lua อ่านได้สำหรับตรวจและแก้ไข

## โครงสร้าง

```
api/auth.js          ตัวจัดการทุก route (Vercel function)
source/              ซอร์ส Lua ที่อ่านได้ของทุก stage + build.js
artifacts/           ผล build ที่เสิร์ฟจริง (สร้างด้วย `node source/build.js`)
scripts/main.lua     สคริปต์ปลายทางที่เสิร์ฟผ่าน /api/script
web/                 หน้าเว็บหลัก (/) และแผงควบคุม (/control)
server.js            รัน local ได้เหมือน Vercel
test/api.test.js     ทดสอบ endpoint
```

## Build + test

```bash
node source/build.js     # source/*.lua -> artifacts/*.lua
npm test                 # ทดสอบ API (ไม่ต้องมี network)
```

## รันlocal

```bash
cp .env.example .env     # เติมค่า secret
PORT=10000 node server.js
```

## Routes

| Path | หน้าที่ |
|---|---|
| `/` | หน้าเว็บหลัก (landing) |
| `/control` | แผงควบคุม client (ต้อง `ADMIN_TOKEN`) |
| `/api/health` | สถานะระบบ (ไม่ต้อง auth) |
| `/loadc.lua` | stage 1 — render จาก template ทุก request |
| `/<token>` (stage 2–4) | ใช้ token ที่ระบบออกให้ตามลำดับ stage; stages 2–4 อ่านได้ |
| `/api/verify` `/api/script` `/api/script-verify` `/api/heartbeat` | flow คีย์ → ticket → runtime proof |
| `/api/control/bans` `/api/control/events` `/api/control/traffic` `/api/link` | API ของแผงควบคุม (ต้อง `ADMIN_TOKEN`) |

## หมายเหตุ
- `@BASE_URL@` ใน source ถูกแทนด้วย host ที่ executor เรียกเข้ามาจริง (ทำงานบน preview/โดเมนใหม่ได้)
- Stage 1 pin SHA-256 ของ Stage 2 ที่ render แล้ว
- UA trap ของ artifact เป็น opt-in: `TRAP_BROWSER_ARTIFACTS=1`

---

## สถานะ production ล่าสุด (2026-10-18)

| บริการ | ที่อยู่ | สถานะ |
|---|---|---|
| เว็บ + API | https://loader999ms.vercel.app | latest confirmed: `7e05ddf` (opaque request fields; no realtime/WebSocket) |
| แผงควบคุม | https://loader999ms.vercel.app/control | HTTP only |

การเปลี่ยน HWID-only แบบ 5 ส่วน Base64 (รวม field `u` ที่ส่ง HWID ต้นฉบับเป็น decoy ซึ่ง server ไม่ใช้) ผ่าน test/build ในเครื่องแล้ว แต่ยังไม่ push/deploy; production ล่าสุดที่ยืนยันได้ยังเป็น composite HWID+fingerprint จาก `7e05ddf`.

จุดย้อนกลับ: tag `pre-source-package` และ `pre-no-websocket` ใน repo `whilstkey`

## Git → Vercel auto-deploy (เชื่อมแล้ว)

โปรเจกต์ `loader999mss` ผูกกับ repo **`rickhub940-ai/whilstkey`** สาขา `main` แล้ว
→ `git push origin main` = Vercel build + deploy production ให้เอง
(ยืนยันแล้ว: commit `7883553` ถูก build และขึ้น production โดยไม่ได้สั่ง deploy ด้วยมือ)

(Render deploy จาก repo นั้น)

## 2026-10-17 — แก้ "RNG integers rejected" ตอน Verify Key

สาเหตุ: `/api/verify` บังคับ RNG challenge แต่ payload ที่ deploy ส่ง RNG ไปกับ `/api/script`
(ฝั่งนั้นตรวจกับ `Data` envelope ที่ถอดรหัสแล้ว) → ผู้ใช้จริงเห็น error ก่อนคีย์ถูกตรวจ

แก้: gate ที่ `/api/verify` บังคับเฉพาะเมื่อคำขอมี field `Rng1..Rng5/RngFloat` จริง
(`challengeSupplied`) และตอบ `check` เฉพาะเมื่อคำนวณได้ — `/api/script` ยังตรวจ RNG เข้มเหมือนเดิม
เพิ่ม regression test ใน `test/api.test.js`

## สถานะปัจจุบัน — ไม่มี WebSocket แล้ว (2026-10-17)

ก่อนหน้านี้เคยมี realtime gateway (Render + WebSocket) ซึ่งแก้ปัญหา `MS9-41AC183F`
มาแล้ว 2 รอบ — ตอนนี้ถอดออกทั้งหมดแล้วตามคำขอ:

ระบบ realtime / WebSocket / gateway ถูกถอดออกทั้งหมด:
- client (`scripts/main.lua`) ไม่มีการต่อ socket, ไม่มี heartbeat, ไม่มี reconnect
- ไม่มี `/api/realtime-ticket`, `/api/realtime/*`, `/api/session-renew`, `/admin`
- แผงควบคุม `/control` เป็น HTTP ล้วน: health + bans + traffic
- ไม่มีบริการ Render / repo gateway ในระบบอีก

## ระบบลิงก์โหลดแบบ somtank (2026-10-17)

ลิงก์มี namespace สุ่มยาวของตัวเอง ไม่ใช้ชื่อคงที่อีกต่อไป:

```
https://<host>/x/<40 hex สุ่ม>?at=<exp base36>.<sig 32 ตัว>
```

- `POST /api/link` (ต้อง `x-admin-token`) → `{ url, line, sha256, stub, expiresAt, path, id }`
- `GET /x/<40 hex>?at=<token>` → เสิร์ฟ entry script ที่ **ไบต์คงที่ต่อลิงก์** จึง pin `sha256` ได้แบบ somtank
- token เป็น HMAC (stateless) หมดอายุตาม `hours` (1–8760) ไม่ต้องมีฐานข้อมูล
- entry script ต่อเข้า `/loadc.lua` บน host เดิม → chain เดิมทั้งหมด
- `LINK_SECRET` = ค่าสุ่มยาว 64 hex (ตั้งใน Vercel production แล้ว) ถ้าไม่มีจะใช้ `TICKET_SECRET`
- แผง `/control` มีการ์ด **สร้างลิงก์โหลด** + ปุ่มคัดลอก (ลิงก์ / บรรทัด executor / สคริปต์เต็ม)

### ส่ง key และชื่อสคริปต์แบบ positional (2026-10-18)

ไม่ใช้ `getgenv()` หรือ `_G` เป็นที่เก็บสถานะระหว่าง stage แล้ว ตัว entry รับค่าเป็นอาร์กิวเมนต์ และส่งต่อผ่าน context แบบ local จนถึง payload/main:

```lua
local key = "ABC"
local script = "Main"
loadstring(game:HttpGet("https://example.com/<generated-link>"))(key, script)
```

บรรทัดที่สร้างจาก `/control` จะใส่ `key = ""` ให้แก้เป็นคีย์จริง และตั้งชื่อสคริปต์ตามลิงก์ที่เลือกไว้ การแก้ source แล้วสร้าง artifacts ใหม่ให้ใช้ `node source/build.js` จากนั้นรัน `npm test`.

## 2026-10-18 — save marker + next-link handoff

Stage 2/3 เริ่มต้นด้วย readable marker ที่ build แล้วอยู่ byte 0:

```lua
local gamaramam = { "<base>/<token>" }
```

- token เป็น next-stage link ที่ออกใหม่ทุก run; savecheck ตรวจรูปแบบ marker และ handoff URL แต่ไม่ฝัง/เปรียบเทียบ token คงที่
- ตรวจเฉพาะไฟล์ที่เริ่มด้วย marker นี้; ไม่ flag ไฟล์อื่นจากข้อความที่ฝังอยู่ข้างใน
- scan เป็น shallow/capped ที่ 64 entries เพื่อไม่เดินทั้ง filesystem และไม่ทำ executor ค้าง
- stages 2–4 ยังคงอ่านได้; ขั้น build จะเก็บ header marker ไว้และ compact เฉพาะ body ตามข้อกำหนด source/artifact

## 2026-10-18 — HWID-only binding, 5 Base64 parts + ignored raw decoy (locally validated; pending deploy)

- Platoboost ยังเป็นผู้ตรวจสอบคีย์และอุปกรณ์ ไม่มีการเพิ่มฐานข้อมูลคีย์แยก
- Client อ่าน HWID ผ่าน `gethwid()`, `get_exwid()` และ aliases ที่รองรับ; ถ้า getter ใช้ไม่ได้จะหยุด และไม่ fallback ไป `GetClientId()` ของ Roblox
- ทุก request ไป `/api/q` จะ canonicalize HWID (ตัดช่องว่างหัวท้ายและแปลงเป็นตัวพิมพ์เล็ก), เข้ารหัส Base64 แล้วแบ่งแบบ deterministic เป็น 5 field (`b`–`f`). Server นำมาต่อและตรวจสอบ ก่อนใช้ Base64 canonical ทั้งชุดเป็น `bindingId`. มี field `u` ส่ง HWID ต้นฉบับเพิ่มเป็น decoy แต่ server ตั้งใจละทิ้งและไม่ใช้ตัดสิน identity
- Platoboost รับ identifier เดียว; `lib/platoboost.js` hash `bindingId` แบบ Base64 ที่รักษาตัวพิมพ์เล็ก/ใหญ่ตรงตามเดิมเป็น identifier ที่ส่งให้ provider ส่วน ticket และ runtime proof ใช้ hash ของ binding ID เดียวกัน Fingerprint headers ถูกละเว้นและไม่กระทบ key/ticket binding
- `/api/verify` → `/api/script` → `/api/script-verify` ตรวจ identity จาก HWID-only ต่อเนื่อง พร้อมคง ticket, RNG/equation, hop และ runtime-proof checks เดิมไว้ Legacy named routes ยังรับ field ที่มี HWID ตรง ๆ ระหว่างเปลี่ยนผ่าน
- Platoboost bindings เดิมที่สร้างจาก composite HWID+fingerprint จะไม่ตรงกับ identifier HWID-only ใหม่; หลัง rollout อาจต้อง reset/rebind คีย์เหล่านั้นใน Platoboost
- ไม่มีการเพิ่ม `getrawmetatable`, `hookmetamethod`, การ kick/crash หรือการอ้างว่า identity นี้เป็น hardware attestation

**ข้อจำกัด:** field decoy `u` เปิดเผย HWID ต้นฉบับใน request แต่ server ไม่อ่านค่านั้น; การมีค่า decoy ไม่ได้หลอกผู้ที่ตรวจ request ได้ และอาจเห็น HWID ได้ทันที. Base64, การแบ่งเป็น 5 ส่วน และชื่อ field แบบ opaque ถอดกลับได้ เป็นเพียงรูปแบบ/การพราง ไม่ใช่ encryption ผู้ใช้ executor สามารถกู้คืนหรือปลอม HWID ที่ client รายงานได้ จึงไม่ใช่ hardware attestation. `lib/999MS-server-sdk.js` เก็บ hop/replay state ไว้ใน memory ของ instance; การกระจาย request ข้าม Vercel instances อาจกระทบ one-time checks และไม่ใช่ durable store ที่แชร์ร่วมกัน.


## 2026-10-17 — ย่อทุก stage: ตัวแปร ≤ 2 ตัว, ไฟล์ละ 1 บรรทัด

`source/*.lua` ยังเป็นเวอร์ชันอ่านออกสำหรับแก้ไข แต่ `node source/build.js` จะย่อด้วย `luamin`
ก่อนเขียนลง `artifacts/`:

| stage | เดิม | ใหม่ | locals สูงสุด |
| --- | --- | --- | --- |
| loadc | 1,575 B | 1,033 B | 1 ตัว |
| loada | 8,176 B | 4,243 B | 2 ตัว |
| loader | 20,490 B | 11,188 B | 2 ตัว |
| payload | 38,102 B | 21,957 B | 2 ตัว |

ทุกไฟล์ที่เสิร์ฟเป็น **1 บรรทัด** และ local ทุกตัวยาวไม่เกิน 2 ตัวอักษร
(ชื่อ global/field ของ Roblox เช่น `game`, `GetService`, `MS999Chain` เปลี่ยนไม่ได้)

marker ยังเป็น literal ตายตัว: `local a="@BASE_URL@/x/6f2c…"` แล้วผู้ใช้ obfuscate ต่อได้ทั้งไฟล์

ตรวจว่าไม่มีการเปลี่ยนพฤติกรรม: `python3 e2e/ast_compare.py` เทียบ AST ของ source กับ artifact
(ลบชื่อ local/คอมเมนต์, canonical literal) → MATCH ทั้ง 4 ไฟล์
ส่วนต่างเดียวคือการตัดวงเล็บ `x + (v - 1)` → `x + v - 1` ซึ่งค่าตรงกัน (ทดสอบ 20k คู่)


## 2026-10-17 — 4 สแตก ลิงก์ต่อลิงก์ อายุ 10 วิ + obf WeAreDevs ทุกรอบ

```
/loadc.lua ──► /loada.lua/<token> ──► /loader.lua/<token> ──► /payload.lua/<token>
```

- ทุก request ของ `loadc` จะสร้าง **run ใหม่ 1 ชุด**: chain id + ลิงก์ 3 ใบ (loada, loader, payload)
  อายุ **10 วินาที** นับจากตอนออก และ **ใช้ได้ครั้งเดียวต่อ stage**
- โทเคนมีรูปแบบ `<chainId>.<stage>.<exp>.<hmac>` → ตรวจได้แบบ stateless
  (ยิงข้าม instance ของ Vercel ได้), ผูกกับ stage ของตัวเอง (เอา token ของ loader ไปเปิด payload ไม่ได้)
- แต่ละ stage **pin sha256 ของ stage ถัดไป** ไว้ในตัว และตรวจก่อน `loadstring`
- `loadc` ถูก **obfuscate ผ่าน API ของ wearedevs.net ทุกรอบ**
  (`POST /api/obfuscate` → โค้ดใหม่ทุกครั้ง) ถ้า API ตอบ 429 จะ retry แบบ backoff
  และถ้าล่มจริงจะ fallback ไป `lua-obfuscator` ในเครื่องเพื่อไม่ให้เชนขาด
  (ดูได้จาก header `x-999ms-obf: wearedevs|local|plain`)
- stages 2–4 ยังเป็น Lua อ่านออก บรรทัดเดียว ตัวแปร ≤2 ตัว ตามเดิม

### ไฟล์ใหม่
- `lib/chainlink.js` — ออก/ตรวจ/เผา token ของแต่ละ stage (HMAC, TTL 10 วิ, กัน replay)
- `lib/obfuscate.js` — เรียก WeAreDevs API + retry + fallback + วัดเวลาเพื่อชดเชยหน้าต่าง 10 วิ
- `source/loadc.template.lua` — รับ `__STAGE2_URL__` + `__STAGE2_SHA256__`
- `source/savecheck.lua`, `source/loader.lua` — รับ `@NEXT@` / `@NEXT_SHA@`


## 2026-10-17 — ปรับ: obf แค่ loadc, ลิงก์ทุกช่วงสร้างใหม่ตอนถูกเรียก

- `loadc` เป็น stage เดียวที่ obfuscate (ผ่าน API wearedevs ทุกรอบ ก่อนส่งให้ client)
- **ทุกช่วงของเชนสร้างลิงก์ใหม่เอง** ตอนที่ถูกเรียก ไม่พรีมิ้นต์รวดเดียว:

```
loadc  ──(สร้างลิงก์ loada ใหม่ทุก request)
loada  ──(เรียก /api/stage-pickup?want=loader  → ได้ลิงก์ loader ใหม่)
loader ──(เรียก /api/stage-pickup?want=payload → ได้ลิงก์ payload ใหม่)
```

- ลิงก์แต่ละใบ: `<chainId>.<stage>.<exp>.<hmac>` สุ่มใหม่ทุกครั้ง (ไม่ซ้ำกัน),
  อายุ 10 วินาทีนับจากเวลาที่ออก, ใช้ได้ครั้งเดียว, และผูกกับ stage ของตัวเอง
- `stage-pickup` ใช้ token ของ stage ที่เพิ่งเรียกมาได้ **ครั้งเดียว** ต่อ token
- stage 2–4 ยังเป็น Lua อ่านออก (ไม่ obfuscate)


## 2026-10-17 — ลิงก์ stage 2-4 ไม่บอกชื่อไฟล์

เดิม: `/loada.lua/<token>`, `/loader.lua/<token>`, `/payload.lua/<token>`
ใหม่: **`https://loader999mss.vercel.app/<token>`** เท่านั้น (ยกเว้น `loadc.lua` ที่เป็นทางเข้า)

- token = `<chainId 32hex>.<exp 13 หลัก>.<hmac 32hex>` — **ไม่มีชื่อ stage อยู่ข้างใน**
- เซิร์ฟเวอร์รู้ว่า token เป็นของ stage ไหนโดยไล่ตรวจลายเซ็นกับแต่ละ stage (`resolveToken`)
- อายุ 10 วินาที, ใช้ครั้งเดียว, และเอา token ของ stage 2 ไปขอ stage 4 ไม่ได้
- `/api/stage-pickup?t=<token>&want=loader|payload` ใช้ token ที่เพิ่งเรียกได้ครั้งเดียว
