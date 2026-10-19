-- ===========================================================
-- 999MS Payload — UI + server-backed authentication
-- ===========================================================
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ctx

local function Abort(reason)
    local stop = type(ctx) == "table" and ctx.stopChecks or nil
    if type(stop) == "function" then pcall(stop) end
    local message = "[999MS] " .. tostring(reason or "stage aborted")
    if type(warn) == "function" then warn(message) else print(message) end
    return false
end

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 60
local CHAIN_SESSION_TTL = 30 * 60

ctx = ...
if type(ctx) ~= "table" then return Abort("[999MS] Context missing") end
local Chain = ctx.chain
local ChainId = type(Chain) == "table" and Chain.Id or nil
local function chainIs(stage, maxAge)
    local current = ctx.chain
    return current == Chain
        and type(current) == "table"
        and current.Version == CHAIN_VERSION
        and type(current.Id) == "string"
        and current.Id == ChainId
        and current.Stage == stage
        and type(current.UpdatedAt) == "number"
        and tick() - current.UpdatedAt >= 0
        and tick() - current.UpdatedAt <= maxAge
end

if not chainIs("loader", CHAIN_TTL) then
    return Abort("[999MS] Chain rejected: run loadc.lua")
end
if ctx.sourceSaved then return Abort("source marker was saved") end
if not chainIs("loader", 60) then
    return Abort("[999MS] Chain interrupted before payload")
end
Chain.Stage = "payload"
Chain.UpdatedAt = tick()

-- ═══ Essential hand-off APIs ═══
local RealLoadstring = loadstring or load
local HttpRequest = ctx.request
if type(RealLoadstring) ~= "function" then return Abort("loadstring API unavailable") end
if type(HttpRequest) ~= "function" then return Abort("HTTP request API unavailable") end

-- ===========================================================
-- Anti-Save
--
-- Stage 2 owns an optional, marker-only write monitor. Auth and chain
-- validation remain server-backed; no executor-internal hook checks run here.
-- ===========================================================

-- ═══ Locals ═══
local SCRIPT_NAME = ctx.scriptName or "main"
local SCRIPT_NAME_LOCKED = SCRIPT_NAME
local USER_KEY = type(ctx.key) == "string" and ctx.key or ""
local StartupError = ""
-- The key arrived as a local positional argument; discard it from the context
-- as soon as this stage has captured its private copy.
ctx.key = nil

local Char = ("").char
local Byte = ("").byte
local Gmatch = ("").gmatch

local ServerId = ""
local XORKey = ""
local Ticket = ""
local ChecksActive = true

-- ═══ Helpers ═══
-- Stop post-load monitoring without disconnecting or suspending the client.
local function StopChecks(keepStageHooks)
    if not ChecksActive then return end
    ChecksActive = false
    Ticket = ""
    ServerId = ""
    XORKey = ""

    if ctx.chain == Chain and type(Chain) == "table" and Chain.Id == ChainId then
        ctx.chain = nil
    end
    local stopStageTwo = ctx.stopChecks
    if not keepStageHooks and type(stopStageTwo) == "function" then pcall(stopStageTwo) end
    ctx.request = nil
    ctx.writeMonitor = nil
    ctx.key = nil
    ctx.running = nil
end


local function Split(str, sep)
    local out = {}
    for p in Gmatch(str, "([^" .. sep .. "]+)") do
        table.insert(out, p)
    end
    return out
end

local function GetHWID()
    -- Match Luasec's primary getter order, then accept common executor aliases.
    -- A getter must be present; do not substitute an executor fingerprint header
    -- or Roblox's ClientId for this client-supplied device identifier.
    local fs = {}
    local function add(fn)
        if type(fn) == "function" then fs[#fs + 1] = fn end
    end
    add(gethwid)
    add(get_exwid)
    if type(syn) == "table" then add(syn.get_hwid) end
    add(get_hwid)
    for _, fn in ipairs(fs) do
        local ok, value = pcall(fn)
        if ok and type(value) == "string" and #value >= 4 and #value <= 512 then
            return value
        end
    end
    return nil
end

local SafeLoadstring = RealLoadstring
if not chainIs("payload", CHAIN_SESSION_TTL) then
    return Abort("[999MS] Chain expired before authentication")
end

print("[999MS] Runtime APIs ready")

-- ═══ Crypto ═══
local Charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function Xor(data, key)
    local out = ""
    for i = 1, #data do
        out = out .. Char(bit32.bxor(data:byte(i), key:byte((i - 1) % #key + 1)))
    end
    return out
end

local function Base64(str)
    local out = ""
    for i = 1, #str, 3 do
        local a, b, c = str:byte(i, i + 2)
        a, b, c = a or 0, b or 0, c or 0
        local n = bit32.lshift(a, 16) + bit32.lshift(b, 8) + c
        local s1 = bit32.rshift(n, 18) % 64
        local s2 = bit32.rshift(n, 12) % 64
        local s3 = bit32.rshift(n, 6) % 64
        local s4 = n % 64
        out = out .. Charset:sub(s1 + 1, s1 + 1) .. Charset:sub(s2 + 1, s2 + 1)
        if i + 1 > #str then
            out = out .. "=="
        elseif i + 2 > #str then
            out = out .. Charset:sub(s3 + 1, s3 + 1) .. "="
        else
            out = out .. Charset:sub(s3 + 1, s3 + 1) .. Charset:sub(s4 + 1, s4 + 1)
        end
    end
    return out
end

local function Base64Decode(str)
    str = str:gsub("-", "+"):gsub("_", "/")
    while #str % 4 ~= 0 do str = str .. "=" end
    local out = ""
    local buffer, bits = 0, 0
    for i = 1, #str do
        local c = str:sub(i, i)
        if c ~= "=" then
            local v = Charset:find(c, 1, true)
            if v then
                buffer = bit32.lshift(buffer, 6) + (v - 1)
                bits = bits + 6
                if bits >= 8 then
                    bits = bits - 8
                    out = out .. Char(bit32.rshift(buffer, bits) % 256)
                end
            end
        end
    end
    return out
end

-- ═══ RNG ═══
local function Floor(n)
    if n >= 0 then return n - (n % 1) end
    if n % 1 == 0 then return n end
    return n - (n % 1) - 1
end
local function Abs(n) return n < 0 and -n or n end

local function Equate(X)
    X = X + 73
    local Y = (X % 11) ^ 3 + (X % 5) * 97 + Floor(X / 3)
    if X ~= 0 then Y = Y + (X * 37) - ((X % 9) ^ 2)
    else Y = Abs(Y) + 137 end
    return (Y * 7919 + 1234567) % 100000000000003
end

local ChallengeMultipliers = { 2, 5, 3, 7, 11 }
local ChallengeOffsets = { -32, 256, -17, 19, -101 }
local function RestoreChallenge(index, value)
    if type(value) ~= "number" then return nil end
    local restored = (value - ChallengeOffsets[index]) / ChallengeMultipliers[index]
    if restored % 1 ~= 0 then return nil end
    return restored
end
local function GetRngSeed() return math.random(1, 1000000) end

local function E1() return tonumber(#game:GetService("Workspace"):GetChildren()) end
local function E2() return tonumber(#game:GetChildren()) end
local function E3() return tonumber(#game:GetService("Players"):GetPlayers()) end
local function E4()
    local player = Players.LocalPlayer
    return player and tonumber(player.UserId) or 0
end
local function E5() return tonumber(game.PlaceId) end
local function E6()
    local s = (game.JobId or ""):gsub("-", "")
    return tonumber(s:sub(1, 15), 16) or 0
end

local function R1()
    local b = GetRngSeed() + GetRngSeed() + E1() + E2()
    local r1, r2 = math.random(1, 1000), math.random(1, 1000)
    return Equate(((r1 ~= 0) and (b * r1) or b) + r2 + (E1() % (r2 + 1)))
end
local function R2()
    local b = GetRngSeed() + GetRngSeed() + E3() + E4()
    local r3, r4 = math.random(1, 1000), math.random(1, 1000)
    local c = (r3 % 2 == 0) and (b + r3) or (b - (r3 % 256))
    return Equate(((r4 ~= 0) and (c * r4) or c) + E3())
end
local function R3()
    local b = GetRngSeed() + GetRngSeed() + E5() + E6()
    local r5, r6 = math.random(1, 1000), math.random(1, 1000)
    local sh = bit32.lshift(b % 2^20, (r5 % 8))
    return Equate(((r6 > 0) and (sh % (r6 + 1)) or sh) + r5 + E5())
end
local function R4()
    local b = GetRngSeed() + GetRngSeed() + E4() + E5()
    local r7, r8 = math.random(1, 1000), math.random(1, 1000)
    local x = bit32.bxor(b % 2^20, r7)
    return Equate(((r8 ~= 0) and (x * (r8 % 100)) or x) + E4() + r7)
end
local function R5()
    local b = GetRngSeed() + GetRngSeed() + E6() + E4()
    local r9, r10 = math.random(1, 1000), math.random(1, 1000)
    local m = (r10 > 0) and (b % r10) or b
    return Equate(((r9 ~= 0) and (m * r9) or m) + E6() + r10)
end

-- Use Roblox's JSON decoder after bounding the response size.
local function JsonDecode(text)
    if type(text) ~= "string" or #text == 0 or #text > 2 * 1024 * 1024 then return nil end
    local ok, value = pcall(function() return HttpService:JSONDecode(text) end)
    return ok and value or nil
end

local function EncodeJson(value)
    local kind = type(value)
    if kind == "nil" then return "null" end
    if kind == "boolean" then return tostring(value) end
    if kind == "number" then
        -- tostring() truncates at 14 significant digits, which would round the
        -- challenge values (they run up to 1e14). Emit integers exactly.
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        if value % 1 == 0 and Abs(value) < 2 ^ 53 then return string.format("%.0f", value) end
        return string.format("%.17g", value)
    end
    if kind == "string" then
        return '"' .. value:gsub('[%z\1-\31\\"]', function(ch)
            local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
            return map[ch] or string.format("\\u%04x", ch:byte())
        end) .. '"'
    end
    if kind == "table" then
        if #value > 0 then
            local parts = {}
            for index = 1, #value do parts[index] = EncodeJson(value[index]) end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        local parts = {}
        for key, item in pairs(value) do
            parts[#parts + 1] = EncodeJson(tostring(key)) .. ":" .. EncodeJson(item)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    return "null"
end

-- Wire-entry scaffold from the proposal. It is intentionally not connected to
-- the live request format until __stWireMask and wireKey derivation are defined.
local function pack(...)
    return { n = select("#", ...), ... }
end

local function buildEntries(items, clearCount, wireKey)
    if type(items) ~= "table" then return nil, "Invalid items" end
    if type(clearCount) ~= "number" or clearCount < 0 then return nil, "Invalid clearCount" end

    local entries = {}
    local total = 0
    for index = 1, items.n or #items do
        local item = items[index]
        if type(item) ~= "table" then return nil, "Invalid item" end

        local kind, text = item[1], item[2]
        if type(kind) ~= "number" then return nil, "Invalid kind" end
        if type(text) ~= "string" then return nil, "Invalid text" end

        if index - 1 > clearCount and #text > 0 then
            if type(__stWireMask) ~= "function" then return nil, "Mask function unavailable" end
            local ok, masked = pcall(__stWireMask, text, wireKey, index - 1)
            if not ok or type(masked) ~= "string" then return nil, "Mask failed" end
            text = masked
        end

        if #text > 65535 then return nil, "Text too long" end
        entries[#entries + 1] = { kind, text }
        total = total + 3 + #text
    end
    return entries, total
end

-- ═══ POST ═══
local function AddDeviceParts(out, hwid)
    local value = string.lower((hwid:match("^%s*(.-)%s*$")))
    local encoded = Base64(value)
    local length = #encoded
    for index = 1, 5 do
        local first = math.floor((index - 1) * length / 5) + 1
        local last = math.floor(index * length / 5)
        out[string.char(97 + index)] = encoded:sub(first, last)
    end
end

local function PackRequest(path, payload, hwid)
    local out = {}
    if path == "/api/verify" then
        out.p, out.a = "q7", payload.key
        AddDeviceParts(out, hwid)
        out.g, out.h = payload.scriptName, payload.userId
        out.i, out.j, out.k = payload.Rng1, payload.Rng2, payload.Rng3
        out.l, out.m, out.n = payload.Rng4, payload.Rng5, payload.RngFloat
    elseif path == "/api/script" then
        out.p, out.a = "m2", payload.ticket
        AddDeviceParts(out, hwid)
        out.g, out.o = payload.scriptName, payload.Data
        out.q, out.r = payload.hop, payload.eq
    elseif path == "/api/script-verify" then
        out.p, out.a = "x9", payload.ticket
        AddDeviceParts(out, hwid)
        out.g, out.q = payload.scriptName, payload.hop
        out.s, out.t = payload.runtimeSecret, payload.scriptToken
    elseif path == "/api/heartbeat" then
        out.p, out.a = "v4", payload.ticket
        AddDeviceParts(out, hwid)
        out.o = payload.Data
    elseif path == "/api/start" then
        out.p = "k8"
        AddDeviceParts(out, hwid)
    else
        return nil
    end
    -- `u` carries the raw getter value as a decoy; the server ignores it.
    out.u = hwid
    return out
end

local function postJSON(path, payload, hwid)
    -- Reuse the same getter value. Its canonical Base64 form is split into
    -- five identity fields; PackRequest also adds raw `u` as an ignored decoy.
    if type(hwid) ~= "string" or #hwid < 4 or #hwid > 512 then
        return nil, "Executor HWID getter unavailable"
    end
    local packed = PackRequest(path, payload, hwid)
    if type(packed) ~= "table" then return nil, "Unsupported request" end
    local headers = { ["Content-Type"] = "application/json" }
    local ok, res = pcall(HttpRequest, {
        Url = BASE_URL .. "/api/q",
        Method = "POST",
        Headers = headers,
        Body = EncodeJson(packed),
    })
    if not ok or type(res) ~= "table" then return nil, "Connection failed" end
    local status = tonumber(res.StatusCode or res.Status)
    local responseBody = res.Body
    if type(status) ~= "number" or type(responseBody) ~= "string" then
        return nil, "Malformed response"
    end
    if #responseBody > 2 * 1024 * 1024 then return nil, "Response too large" end
    local decoded = JsonDecode(responseBody)
    if type(decoded) ~= "table" then return nil, "Invalid response" end
    return { status = status, data = decoded, body = responseBody }, nil
end

local function EncodeBody(tbl)
    local json = EncodeJson(tbl)
    local encrypted = Xor(json, XORKey)
    local b64 = Base64(encrypted)
    local full = XORKey .. b64
    local bytes = {}
    for i = 1, #full do table.insert(bytes, Byte(full, i)) end
    return { Data = bytes }
end

-- ═══ Load & Run ═══
local MS999_UI = nil

local function LoadScript(d, h)
    if not ChecksActive then return end
    if not chainIs("payload", CHAIN_SESSION_TTL) then
        return Abort("[999MS] Chain expired before script")
    end
    if type(h) ~= "string" or #h < 4 or #h > 512 then
        return Abort("Invalid device context")
    end
    Chain.Stage = "script"
    Chain.Script = SCRIPT_NAME_LOCKED
    Chain.UpdatedAt = tick()

    local r = d.RuntimeSecret or ""
    local s = d.ScriptToken or ""
    local p = d.hop or ""
    local q = Ticket
    if type(r) ~= "string" or #r ~= 64 then
        return Abort("Invalid runtime secret")
    end
    if type(q) ~= "string" or q == ""
        or type(s) ~= "string" or s == ""
        or type(p) ~= "string" or p == "" then
        return Abort("Invalid session context")
    end

    ServerId = d.ServerId or ""

    if MS999_UI then pcall(function() MS999_UI:Destroy() end); MS999_UI = nil end

    print("[999MS] Loading main script...")

    local compileOk, chunk = pcall(SafeLoadstring, d.Body)
    if not compileOk or type(chunk) ~= "function" then return Abort("Load failed") end
    local ok, result = pcall(chunk, true, q, s, r, p, SCRIPT_NAME_LOCKED, tick(), h, HttpRequest, Chain, ctx)
    if not ok or result == false then return Abort("Run failed") end

    print("[999MS] Main script loaded")

    -- Clear auth/session secrets after launch but retain Stage 2's marker
    -- output guard for the lifetime of the running script.
    StopChecks(true)
end

local function KickBadHwid(reason, deviceMismatch)
    local kickReason
    if reason == "BAD HWID : ]" then
        kickReason = reason
    elseif deviceMismatch == true then
        kickReason = "invalid Hwid"
    else
        return
    end

    local CoreGui = game:GetService("CoreGui")
    local Players = game:GetService("Players")
    local LocalPlayer = Players.LocalPlayer
    local customTitle = "[ 999MS ]"
    local customMessage = "You have been kicked by this experience or its moderators. Moderation message:\n\n" .. kickReason

    local function patchErrorPrompt()
        local success, result = pcall(function()
            local root = CoreGui:FindFirstChild("RobloxPromptGui")
            if not root then return false end
            local overlay = root:FindFirstChild("promptOverlay")
            if not overlay then return false end
            local prompt = overlay:FindFirstChild("ErrorPrompt")
            if not prompt then return false end
            local titleFrame = prompt:FindFirstChild("TitleFrame")
            local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
            local messageArea = prompt:FindFirstChild("MessageArea")
            local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
            local label = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
            if not title or not label then return false end
            title.Text = customTitle
            label.Text = customMessage
            return true
        end)
        return success and result
    end

    pcall(function()
        CoreGui.ChildAdded:Connect(function(child)
            if child.Name == "RobloxPromptGui" then
                task.wait(0.01)
                patchErrorPrompt()
            end
        end)
    end)
    task.spawn(function()
        for index = 1, 50 do
            if patchErrorPrompt() then break end
            task.wait(0.01)
        end
    end)

    if LocalPlayer then
        pcall(function()
            if type(replicatesignal) == "function" then
                replicatesignal(LocalPlayer.StatsAvailable, "Kick")
            end
        end)
        pcall(function() LocalPlayer:Kick(kickReason) end)
    end
end

local function FetchAndLoad(key, sname)
  if not ChecksActive then return nil, "Cancelled" end
    if not chainIs("payload", CHAIN_SESSION_TTL) then
        Abort("[999MS] Chain expired")
        return nil, "Chain expired"
    end
    local hwid = GetHWID()
    local player = Players.LocalPlayer
    if not player then return nil, "Player context unavailable" end
    local userId = tostring(player.UserId)

    -- Generate the challenge before the first call: the server transforms these
    -- values and we invert the transform to prove the response is genuine.
    local rng = {
        Rng1 = Floor(R1()), Rng2 = Floor(R2()), Rng3 = Floor(R3()),
        Rng4 = Floor(R4()), Rng5 = Floor(R5()),
        RngFloat = math.random(1, 1000000) + math.random(),
    }

    print("[999MS] Verifying key...")

    local r1, err = postJSON("/api/verify", {
        key = key, c = hwid, userId = userId, scriptName = sname,
        Rng1 = rng.Rng1, Rng2 = rng.Rng2, Rng3 = rng.Rng3,
        Rng4 = rng.Rng4, Rng5 = rng.Rng5, RngFloat = rng.RngFloat,
    }, hwid)

    if not r1 then return nil, err or "Connection failed" end
    if r1.status == 429 then return nil, "Rate limited" end
    if r1.status == 403 then
        local message = r1.data.message or r1.data.error or "Banned"
        KickBadHwid(message, r1.data.deviceMismatch == true)
        return nil, message
    end
    if r1.status ~= 200 or r1.data.valid ~= true then
        local message = r1.data.message or r1.data.error or "Invalid key"
        KickBadHwid(message, r1.data.deviceMismatch == true)
        return nil, message
    end
    if not ChecksActive then return nil, "Cancelled" end

    Ticket = r1.data.ticket
    XORKey = r1.data.k or ""

    -- Invert the server-side transforms and compare them with this request's
    -- challenge values before accepting the response.
    if type(r1.data.check) == "string" then
        local parts = Split(r1.data.check, "|")
        if #parts ~= 5 then return nil, "Bad challenge" end
        for index = 1, 5 do
            local restored = RestoreChallenge(index, tonumber(parts[index]))
            if restored ~= ({ rng.Rng1, rng.Rng2, rng.Rng3, rng.Rng4, rng.Rng5 })[index] then
                return nil, "Challenge mismatch"
            end
        end
    else
        return nil, "Missing challenge"
    end

    -- Equation: A = 2x - 32 and B = 5x + 256 are two views of the same secret.
    local fromA = (tonumber(r1.data.A) + 32) / 2
    local fromB = (tonumber(r1.data.B) - 256) / 5
    if type(fromA) ~= "number" or fromA ~= fromB or fromA % 1 ~= 0 then
        return nil, "Equation mismatch"
    end
    local equationAnswer = Equate(fromA)

    print("[999MS] Key verified")

    local body = EncodeBody(rng)
    body.ticket = Ticket
    body.scriptName = sname
    body.hop = r1.data.hop
    body.eq = equationAnswer

    local r2, err2 = postJSON("/api/script", body, hwid)
    if not r2 then return nil, err2 or "Script fetch failed" end
    if r2.status ~= 200 then
        local message = r2.data.reason or r2.data.error or r2.body or "Script fetch failed"
        KickBadHwid(message, r2.data.deviceMismatch == true)
        return nil, message
    end
    if not ChecksActive then return nil, "Cancelled" end

    local resp = r2.data
    if not resp or not resp.Data then return nil, "Invalid response" end

    local okDec, decrypted = pcall(function()
        local raw = ""
        for _, b in ipairs(resp.Data) do raw = raw .. Char(b) end
        local b64 = raw:sub(#XORKey + 1)
        return JsonDecode(Xor(Base64Decode(b64), XORKey))
    end)

    if not okDec or type(decrypted) ~= "table" then return nil, "Decode failed" end
    if decrypted.Valid ~= true then return nil, decrypted.reason or "Server rejected" end

    if type(decrypted.check) ~= "string" then return nil, "RNG challenge missing" end
    local parts = Split(decrypted.check, "|")
    if #parts ~= 5 then return nil, "RNG challenge malformed" end

    local rngOriginals = { rng.Rng1, rng.Rng2, rng.Rng3, rng.Rng4, rng.Rng5 }
    for index = 1, 5 do
        local restored = RestoreChallenge(index, tonumber(parts[index]))
        if restored == nil or restored ~= rngOriginals[index] then
            return nil, "RNG check failed"
        end
    end

    return decrypted, hwid
end

-- ═══ UI ═══
local function MakeUI()
    if MS999_UI then pcall(function() MS999_UI:Destroy() end) end

    local gui = Instance.new("ScreenGui")
    gui.Name = "999MSUI"
    gui.ResetOnSpawn = false
    gui.IgnoreGuiInset = true
    pcall(function() gui.Parent = game:GetService("CoreGui") end)
    if not gui.Parent then
        local player = Players.LocalPlayer
        local playerGui = player and player:FindFirstChildOfClass("PlayerGui")
        if playerGui then gui.Parent = playerGui end
    end
    MS999_UI = gui

    local frame = Instance.new("Frame")
    frame.Size = UDim2.new(0, 340, 0, 300)
    frame.Position = UDim2.new(0.5, -170, 0.5, -150)
    frame.BackgroundColor3 = Color3.fromRGB(18, 18, 24)
    frame.BorderSizePixel = 0
    frame.Active = true
        frame.Draggable = true
    frame.Parent = gui

    local c1 = Instance.new("UICorner")
    c1.CornerRadius = UDim.new(0, 12)
    c1.Parent = frame

    local s1 = Instance.new("UIStroke")
    s1.Color = Color3.fromRGB(60, 60, 80)
    s1.Parent = frame

    local grad = Instance.new("Frame")
    grad.Size = UDim2.new(1, 0, 0, 4)
    grad.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
    grad.BorderSizePixel = 0
    grad.Parent = frame

    local cg = Instance.new("UICorner")
    cg.CornerRadius = UDim.new(0, 12)
    cg.Parent = grad

    local title = Instance.new("TextLabel")
    title.Size = UDim2.new(1, -40, 0, 30)
    title.Position = UDim2.new(0, 20, 0, 15)
    title.BackgroundTransparency = 1
    title.Font = Enum.Font.GothamBold
    title.TextSize = 20
    title.Text = "999MS"
    title.TextColor3 = Color3.fromRGB(255, 255, 255)
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Parent = frame

    local close = Instance.new("TextButton")
    close.Size = UDim2.new(0, 26, 0, 26)
    close.Position = UDim2.new(1, -35, 0, 17)
    close.BackgroundColor3 = Color3.fromRGB(40, 40, 50)
    close.BorderSizePixel = 0
    close.Text = "x"
    close.Font = Enum.Font.GothamBold
    close.TextSize = 18
    close.TextColor3 = Color3.fromRGB(200, 200, 210)
    close.Parent = frame

    local cc = Instance.new("UICorner")
    cc.CornerRadius = UDim.new(0, 6)
    cc.Parent = close

    close.MouseButton1Click:Connect(function()
        gui:Destroy()
        MS999_UI = nil
        StopChecks()
    end)

    local sub = Instance.new("TextLabel")
    sub.Size = UDim2.new(1, -40, 0, 18)
    sub.Position = UDim2.new(0, 20, 0, 48)
    sub.BackgroundTransparency = 1
    sub.Font = Enum.Font.Gotham
    sub.TextSize = 12
    sub.Text = "Enter your key to start"
    sub.TextColor3 = Color3.fromRGB(140, 140, 160)
    sub.TextXAlignment = Enum.TextXAlignment.Left
    sub.Parent = frame

    local boxHolder = Instance.new("Frame")
    boxHolder.Size = UDim2.new(1, -40, 0, 40)
    boxHolder.Position = UDim2.new(0, 20, 0, 75)
    boxHolder.BackgroundColor3 = Color3.fromRGB(28, 28, 36)
    boxHolder.BorderSizePixel = 0
    boxHolder.Parent = frame

    local bc = Instance.new("UICorner")
    bc.CornerRadius = UDim.new(0, 8)
    bc.Parent = boxHolder

    local bs = Instance.new("UIStroke")
    bs.Color = Color3.fromRGB(60, 60, 80)
    bs.Parent = boxHolder

    local input = Instance.new("TextBox")
    input.Size = UDim2.new(1, -20, 1, 0)
    input.Position = UDim2.new(0, 10, 0, 0)
    input.BackgroundTransparency = 1
    input.Font = Enum.Font.Code
    input.TextSize = 14
    input.Text = USER_KEY ~= "" and USER_KEY or ""
    input.PlaceholderText = "KEY_xxxxxxxxxxxxx"
    input.PlaceholderColor3 = Color3.fromRGB(90, 90, 110)
    input.TextColor3 = Color3.fromRGB(255, 255, 255)
    input.TextXAlignment = Enum.TextXAlignment.Left
    input.ClearTextOnFocus = false
    input.Parent = boxHolder

    local scriptLabel = Instance.new("TextLabel")
    scriptLabel.Size = UDim2.new(1, -40, 0, 14)
    scriptLabel.Position = UDim2.new(0, 20, 0, 122)
    scriptLabel.BackgroundTransparency = 1
    scriptLabel.Font = Enum.Font.Gotham
    scriptLabel.TextSize = 11
    scriptLabel.Text = "Script: " .. SCRIPT_NAME_LOCKED
    scriptLabel.TextColor3 = Color3.fromRGB(140, 140, 160)
    scriptLabel.TextXAlignment = Enum.TextXAlignment.Left
    scriptLabel.Parent = frame

    local status = Instance.new("TextLabel")
    status.Size = UDim2.new(1, -40, 0, 16)
    status.Position = UDim2.new(0, 20, 0, 145)
    status.BackgroundTransparency = 1
    status.Font = Enum.Font.Gotham
    status.TextSize = 11
    status.Text = ""
    status.TextColor3 = Color3.fromRGB(255, 100, 100)
    status.TextXAlignment = Enum.TextXAlignment.Left
    status.Parent = frame

    local btn = Instance.new("TextButton")
    btn.Size = UDim2.new(1, -40, 0, 40)
    btn.Position = UDim2.new(0, 20, 0, 170)
    btn.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
    btn.BorderSizePixel = 0
    btn.Text = "Verify Key"
    btn.Font = Enum.Font.GothamBold
    btn.TextSize = 14
    btn.TextColor3 = Color3.fromRGB(255, 255, 255)
    btn.Parent = frame

    local bcc = Instance.new("UICorner")
    bcc.CornerRadius = UDim.new(0, 8)
    bcc.Parent = btn

    local buyBtn = Instance.new("TextButton")
    buyBtn.Size = UDim2.new(1, -40, 0, 34)
    buyBtn.Position = UDim2.new(0, 20, 0, 220)
    buyBtn.BackgroundColor3 = Color3.fromRGB(35, 35, 45)
    buyBtn.BorderSizePixel = 0
    buyBtn.Text = "Buy Key"
    buyBtn.Font = Enum.Font.GothamMedium
    buyBtn.TextSize = 13
    buyBtn.TextColor3 = Color3.fromRGB(200, 200, 220)
    buyBtn.Parent = frame

    local buc = Instance.new("UICorner")
    buc.CornerRadius = UDim.new(0, 8)
    buc.Parent = buyBtn

    local busy = false
    local function setStatus(msg, color)
        status.Text = type(msg) == "string" and msg or ""
        status.TextColor3 = color or Color3.fromRGB(255, 100, 100)
    end
    if StartupError ~= "" then setStatus(StartupError) end
    local function setBusy(isBusy)
        busy = isBusy
        btn.Text = isBusy and "Checking..." or "Verify Key"
        btn.BackgroundColor3 = isBusy and Color3.fromRGB(60, 70, 160) or Color3.fromRGB(88, 101, 242)
        input.TextEditable = not isBusy
    end

    btn.MouseButton1Click:Connect(function()
        if busy then return end
        local key = input.Text
        if type(key) ~= "string" or key:match("^%s*$") then
            setStatus("Enter a key"); return
        end
        setBusy(true)
        setStatus("Verifying...", Color3.fromRGB(200, 200, 120))
        task.spawn(function()
            local decrypted, result = FetchAndLoad(key, SCRIPT_NAME_LOCKED)
            if not ChecksActive then return end
            if not decrypted then setStatus(result or "Error"); setBusy(false); return end
            setStatus("Success!", Color3.fromRGB(100, 255, 100))
            task.wait(0.3)
            if ChecksActive then LoadScript(decrypted, result) end
        end)
    end)

    buyBtn.MouseButton1Click:Connect(function()
        task.spawn(function()
            local hwid = GetHWID()
            local r, err = postJSON("/api/start", { c = hwid }, hwid)
            if not ChecksActive then return end
            if not r then setStatus(err or "Cannot open link"); return end
            if r.status ~= 200 or not r.data.url then
                local message = r.data.error or "Cannot open link"
                KickBadHwid(message)
                setStatus(message)
                return
            end
            local url = r.data.url
            if SafeSetClipboard then
                pcall(SafeSetClipboard, url)
                setStatus("Link copied!", Color3.fromRGB(100, 200, 255))
            else
                setStatus("Link: " .. url:sub(1, 40), Color3.fromRGB(100, 200, 255))
            end
        end)
    end)
end

-- ===========================================================
-- MAIN
-- ===========================================================
if USER_KEY == "" then
    print("[999MS] No key, opening UI")
    MakeUI()
    return
end

task.spawn(function()
    local decrypted, result = FetchAndLoad(USER_KEY, SCRIPT_NAME_LOCKED)
    if not decrypted then
        StartupError = result or "Invalid key"
        print("[999MS] Auto-load failed:", StartupError)
        MakeUI()
        return
    end
    LoadScript(decrypted, result)
end)
