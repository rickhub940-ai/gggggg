# 999MS SDK

โปรเจกต์นี้มี SDK สองฝั่งที่ใช้ protocol เดียวกับ `/api/auth`:

- **Server SDK:** `lib/999MS-server-sdk.js`
- **Client SDK:** `artifacts/999MS-sdk.lua` — เมื่อ deploy แล้วใช้ได้ที่ `https://keysytemdemo.vercel.app/999MS-sdk.lua`

SDK นี้ไม่ใช้ database และไม่แทนที่ Platoboost; server application ยังคงเป็นผู้ตรวจ key, ออก signed ticket, สร้าง runtime credential และตัดสินสิทธิ์จริง

> Client source และ reversible RNG transform มองเห็นได้โดยผู้ใช้เสมอ จึงเป็น tamper friction เท่านั้น ไม่ใช่ authorization secret หรือข้อพิสูจน์ว่า HTTP function เป็นของแท้

## Server SDK

`lib/999MS-server-sdk.js` แยก protocol ที่ใช้ร่วมกันออกจาก handler เพื่อใช้ซ้ำได้:

- `validateClientChallenge(clientData)` ตรวจ RNG 5 ค่าและ `RngFloat` ที่เป็น non-integer
- `createChallengeResponse(values)` สร้าง reversible response ด้วย transform คนละแบบต่อ component
- `encodeProtectedPayload(data, xorKey)` / `decodeProtectedPayload(body, xorKey)` ทำ wire envelope `{ Data: [...] }`
- `createRuntimeCredentials()` สร้าง `ScriptToken` และ `RuntimeSecret` อายุสั้น
- `verifyRuntimeProof(...)` ตรวจ token, secret, HWID hash, script name, expiry และ one-time state
- `isValidScriptName(value)` ตรวจชื่อ script ที่ปลอดภัยสำหรับ lookup ไฟล์

`api/auth.js` ใช้ SDK นี้อยู่แล้วสำหรับ challenge, protected payload, script-name validation และ runtime-proof validation ดังนั้น protocol production กับ SDK จะไม่แยกกัน

ตัวอย่างสำหรับ handler ใหม่:

```js
const {
  validateClientChallenge,
  createChallengeResponse,
  encodeProtectedPayload,
} = require('./lib/999MS-server-sdk');

const rng = validateClientChallenge(clientData);
if (!rng.ok) {
  return res.status(200).json(encodeProtectedPayload(
    { Valid: false, reason: 'RNG challenge rejected' },
    process.env.PAYLOAD_XOR_KEY,
  ));
}

const check = createChallengeResponse(rng.values);
```

Ticket signing, key verification, revocation/rate limiting และ storage policy ต้องอยู่ใน server application ของคุณ ไม่ควรย้ายไป client SDK

## Client SDK

Client SDK เป็น module Lua ที่ไม่สร้าง UI และไม่ทำ anti-save/hook detection เอง เพื่อให้ใช้กับ UI/loader ของคุณได้หลายแบบ ตัว loader ของโปรเจกต์นี้ยังคงเป็นตัวที่รับผิดชอบ stage checks และจะส่ง `getgenv().MS999Request` ที่ capture ไว้เข้า SDK ได้

> `scripts/main.lua` ของโปรเจกต์ถูก lock กับ chain `loadc → savecheck → loader → payload → main` แล้ว จึงต้องเริ่มผ่าน `loadc.lua` เท่านั้น ไม่ควรใช้ Client SDK รัน `main` โดยตรง. Client SDK ยังเหมาะสำหรับ custom body ที่คุณออกแบบ chain/runtime check ของมันเอง.

```lua
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

-- ใช้ request ที่ loader capture ไว้ หากมี
local requestFn = getgenv().MS999Request
if type(requestFn) ~= "function" then
    error("A request function is required")
end

local SDK = loadstring(game:HttpGet(
    "https://keysytemdemo.vercel.app/999MS-sdk.lua"
))()

local client, err = SDK.new({
    baseUrl = "https://keysytemdemo.vercel.app",
    httpService = HttpService,
    request = requestFn,
    getHwid = function()
        if type(gethwid) == "function" then return gethwid() end
        local player = Players.LocalPlayer
        return tostring(player.UserId) .. "|" .. tostring(player.AccountAge) .. "|" .. tostring(game.PlaceId)
    end,
    getUserId = function()
        return Players.LocalPlayer.UserId
    end,
})
assert(client, err)

-- ใช้ชื่อ custom body ที่มีอยู่บน server ของคุณเท่านั้น
-- `main` ของโปรเจกต์นี้ต้องเริ่มผ่าน loadc.lua
local session, authErr = client:authenticate({
    key = "YOUR_KEY",
    scriptName = "custom-script",
})
assert(session, authErr)

local ran, runErr = client:run(session, "YOUR_KEY")
assert(ran, runErr)
```

หาก protected body ของคุณ **ไม่มี** runtime validation อยู่เอง ให้เรียก `client:verifyRuntime(session)` หนึ่งครั้งก่อน `client:run(...)` เพื่อใช้ one-time proof:

```lua
local verified, verifyErr = client:verifyRuntime(session)
assert(verified, verifyErr)
```

### Client API

| Method | หน้าที่ |
|---|---|
| `SDK.new(options)` | สร้าง client; ต้องมี `baseUrl`, `httpService`, `request` |
| `client:makeRngChallenge()` | สร้าง RNG request challenge ที่ valid |
| `client:authenticate({ key, scriptName, hwid?, userId?, rng? })` | ตรวจ key, ขอ body, ตรวจ encrypted response และ challenge |
| `client:verifyChallenge(rng, check)` | ตรวจ challenge response แยกต่างหาก |
| `client:verifyRuntime(session?)` | ทำ one-time runtime proof กับ server |
| `client:prepareRuntime(session?, key)` | เขียน runtime values ที่ body มาตรฐานต้องใช้ |
| `client:run(session?, key)` | compile/run protected body หลัง prepare runtime |
| `client:clear(clearRuntime?)` | ล้าง ticket, key และ session ใน SDK; `true` ล้าง runtime globals เพิ่ม |
| `client:close()` | ล้าง runtime state และปิด client instance |

## Lifecycle ที่ใช้กับ loader ปัจจุบัน

`artifacts/payload.lua` ยังเป็น UI/loader production หลัก เพราะคง three-stage loader, UI cleanup และ anti-save lifecycle ที่กำหนดไว้แล้วไว้ครบ การเพิ่ม SDK ไม่ได้เปลี่ยน loader เป็น dynamic fetch ใหม่หรือทำให้ Stage 1 SHA pin เปลี่ยน

ใช้ Client SDK เมื่อต้องการสร้าง UI หรือ loader อื่นที่คุยกับ API เดียวกัน ส่วน API เดิมใช้ Server SDK ภายในแล้ว
