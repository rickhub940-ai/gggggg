-- ===========================================================
-- Luasec Payload — UI + Platoboost + Anti-Save (แบบไฟล์ X)
-- ===========================================================
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local BASE_URL = "https://keysytemdemo.vercel.app"

-- ═══ L1-L3: Loader Proof ═══
local LoaderProof = getgenv().LuasecLoaderProof
local LoaderTime = getgenv().LuasecLoaderTime
local LoaderMarker = getgenv().LuasecLoaderMarker

if type(LoaderProof) ~= "string" then
    return Players.LocalPlayer:Kick("[Luasec] L1: Not run via loader")
end
if not LoaderProof:match("^luasec_loader_v1:[a-z]+$") then
    return Players.LocalPlayer:Kick("[Luasec] L1: Invalid proof")
end
if not LoaderTime or (tick() - LoaderTime) > 10 then
    return Players.LocalPlayer:Kick("[Luasec] L2: Proof expired")
end
if type(LoaderMarker) ~= "string" or not LoaderMarker:match("^LSE_%d+$") then
    return Players.LocalPlayer:Kick("[Luasec] L3: Invalid marker")
end

-- ═══ Signal bus ═══
local LuasecSignal = getgenv().LuasecSignal
if type(LuasecSignal) ~= "table" then
    return Players.LocalPlayer:Kick("[Luasec] Signal bus missing")
end

-- ═══ Capture real ═══
local RealWriteFile = writefile
local RealIsHooked = isfunctionhooked
local RealDebugGetInfo = debug.getinfo
local RealHookFunction = hookfunction
local RealRawset = rawset
local RealRawget = rawget
local RealLoadstring = loadstring

-- ═══ L4-L6: hook check ═══
if type(RealWriteFile) == "function" then
    local info = RealDebugGetInfo(RealWriteFile)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] L4: writefile wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealWriteFile)
        local loaderMonitor = getgenv().LuasecWriteMonitor
        if ok and hooked and loaderMonitor ~= RealWriteFile then
            return Players.LocalPlayer:Kick("[Luasec] L4: writefile hooked")
        end
    end
end

if type(RealHookFunction) == "function" then
    local info = RealDebugGetInfo(RealHookFunction)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] L5: hookfunction wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealHookFunction)
        if ok and hooked then
            return Players.LocalPlayer:Kick("[Luasec] L5: hookfunction hooked")
        end
    end
end

if type(RealRawset) == "function" then
    local info = RealDebugGetInfo(RealRawset)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] L6: rawset wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawset)
        if ok and hooked then
            return Players.LocalPlayer:Kick("[Luasec] L6: rawset hooked")
        end
    end
end

print("[Luasec] Payload L1-L6 passed")

-- ===========================================================
-- Anti-Save
--
-- The loader owns the writefile monitor and sends detections through
-- LuasecSignal.OnDetect.  Do not install a second hook here: it would require
-- a non-standard env.Signal API and make the loader's hook look like tampering
-- during this payload's L4 preflight.
-- ===========================================================

-- ═══ Locals ═══
local SCRIPT_NAME = getgenv().script or _G.script
local SCRIPT_NAME_LOCKED = SCRIPT_NAME
local USER_KEY = getgenv().Key or _G.Key or ""

local Char = ("").char
local Byte = ("").byte
local Gmatch = ("").gmatch

local ServerId = ""
local XORKey = ""
local Ticket = ""
local HttpRequest = nil
local HeartbeatAlive = false

-- ═══ Helpers ═══
local function SecureCrash()
    if NfCrash then NfCrash() else while true do end end
end

local function KickPlayer(Reason, Code)
    print("[Luasec] Kick:", tostring(Reason))
    if Code == 0 and rawequal(Code, 0) then
        Players.LocalPlayer:Kick(tostring(Reason))
    elseif Code == 1 and rawequal(Code, 1) then
        Players.LocalPlayer:Kick(tostring(Reason))
        if math.random() == math.random() then SecureCrash() end
        task.wait(math.random(13, 28))
        SecureCrash()
    else
        Players.LocalPlayer:Kick(tostring(Reason))
    end
end

local function TamperKick(code)
    pcall(function()
        Players.LocalPlayer:Kick("[Luasec] Tamper detected (" .. code .. ")")
    end)
    task.wait(0.3)
    SecureCrash()
end

local function SecureEQ(a, b)
    local T = {}
    if a ~= b then return false end
    T[a] = 3569
    if not T[b] == 3569 then return false end
    T[b] = nil
    if not T[a] == nil then return false end
    return true
end

local function Split(str, sep)
    local out = {}
    for p in Gmatch(str, "([^" .. sep .. "]+)") do
        table.insert(out, p)
    end
    return out
end

local function GetHWID()
    if type(gethwid) == "function" then
        local ok, v = pcall(gethwid)
        if ok and type(v) == "string" and #v > 0 and #v <= 512 then return v end
    end
    if syn and type(syn.get_hwid) == "function" then
        local ok, v = pcall(syn.get_hwid)
        if ok and type(v) == "string" and #v > 0 then return v end
    end
    if type(get_hwid) == "function" then
        local ok, v = pcall(get_hwid)
        if ok and type(v) == "string" and #v > 0 then return v end
    end
    local lp = Players.LocalPlayer
    return tostring(lp.UserId) .. "|" .. tostring(lp.AccountAge) .. "|" .. tostring(game.PlaceId or 0)
end

-- ═══ T2-T19 ═══
if getgenv().Luasec and Luasec and _G.Luasec then return end
getgenv().Luasec = true
Luasec = true
_G.Luasec = true

if RunService:IsStudio() then return TamperKick("T2") end

do
    local ok, err = pcall(pcall)
    if ok or err ~= "missing argument #1" then return TamperKick("T3") end
end

local function CheckFn(name, fn)
    if type(fn) ~= "function" then TamperKick("T4:" .. name); return false end
    local ok, hooked = pcall(isfunctionhooked, fn)
    if not ok or hooked then TamperKick("T4:" .. name); return false end
    return true
end

if not CheckFn("isfunctionhooked", isfunctionhooked) then return end
if not CheckFn("debug.getinfo", debug.getinfo) then return end
if not CheckFn("loadstring", loadstring) then return end
if not CheckFn("pcall", pcall) then return end
if not CheckFn("math.random", math.random) then return end

do
    if math.random(1, 2) == math.random(3, 4) then return TamperKick("T5") end
    local Same, Last = 0, 0
    for _ = 1, 100 do
        local Cur = math.random(1, 3569)
        if Cur == Last then Same = Same + 1 end
        Last = Cur
    end
    if Same > 10 then return TamperKick("T5") end
end

do
    local test = {}
    getgenv().__luasec_test = test
    if getgenv().__luasec_test ~= test then return TamperKick("T6") end
    getgenv().__luasec_test = nil
end

local SafeLoadstring = loadstring
local SafeGetGenv = getgenv
local SafeSetClipboard = setclipboard or toclipboard

do
    if type(SafeLoadstring) ~= "function" then return TamperKick("T13") end
    local info = debug.getinfo(SafeLoadstring)
    if not info or info.what ~= "C" then return TamperKick("T13") end
    if isfunctionhooked(SafeLoadstring) then return TamperKick("T13") end
    if SafeGetGenv().loadstring ~= SafeLoadstring then return TamperKick("T13") end
    local ok, fn = pcall(SafeLoadstring, "return 1 + 1")
    if not ok or type(fn) ~= "function" then return TamperKick("T13") end
    local ok2, result = pcall(fn)
    if not ok2 or result ~= 2 then return TamperKick("T13") end
end

if type(hookfunction) == "function" and isfunctionhooked(hookfunction) then
    return TamperKick("T16")
end

-- HTTP picker
do
    local List = {}
    for _, V in pairs({ http.request, request, http_request }) do
        if V ~= nil and type(V) == "function" then List[#List + 1] = V end
    end
    if #List == 0 then return KickPlayer("Executor does not support HTTP", 0) end
    HttpRequest = List[math.random(1, #List)]
end

print("[Luasec] Payload tamper checks passed")

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

local function inverse(y) return ((y * 20) + 5) / 10 end
local function GetRngSeed() return math.random(1, 1000000) end

local function E1() return tonumber(#game:GetService("Workspace"):GetChildren()) end
local function E2() return tonumber(#game:GetChildren()) end
local function E3() return tonumber(#game:GetService("Players"):GetPlayers()) end
local function E4() return tonumber(Players.LocalPlayer.UserId) end
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

-- ═══ POST ═══
local function postJSON(path, payload)
    local ok, res = pcall(HttpRequest, {
        Url = BASE_URL .. path,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode(payload),
    })
    if not ok or type(res) ~= "table" then return nil, "Connection failed" end
    local status = res.StatusCode or res.Status
    local decoded
    local ok2 = pcall(function() decoded = HttpService:JSONDecode(res.Body or "{}") end)
    if not ok2 then return nil, "Invalid response" end
    return { status = status, data = decoded, body = res.Body or "" }, nil
end

local function EncodeBody(tbl)
    local json = HttpService:JSONEncode(tbl)
    local encrypted = Xor(json, XORKey)
    local b64 = Base64(encrypted)
    local full = XORKey .. b64
    local bytes = {}
    for i = 1, #full do table.insert(bytes, Byte(full, i)) end
    return { Data = bytes }
end

-- ═══ Load & Run ═══
local function LoadScript(decrypted, key)
    local RuntimeSecret = decrypted.RuntimeSecret or ""
    if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
        return KickPlayer("Invalid runtime secret", 0)
    end

    getgenv().LuasecLoader   = true
    getgenv().LuasecTicket   = Ticket
    getgenv().LuasecToken    = decrypted.ScriptToken or ""
    getgenv().LuasecSecret   = RuntimeSecret
    getgenv().LuasecSession  = decrypted.ServerId or ""
    getgenv().LuasecScript   = SCRIPT_NAME_LOCKED
    getgenv().LuasecLoadTime = tick()
    getgenv().Key            = key
    _G.Key                   = key

    ServerId = decrypted.ServerId or ""

    if _G.LUASEC_UI then pcall(function() _G.LUASEC_UI:Destroy() end); _G.LUASEC_UI = nil end

    print("[Luasec] Loading main script...")

    local chunk = SafeLoadstring(decrypted.Body)
    if not chunk then return KickPlayer("Load failed", 0) end
    local ok = pcall(chunk)
    if not ok then return KickPlayer("Run failed", 0) end

    print("[Luasec] Main script loaded")

    HeartbeatAlive = true
    task.spawn(function()
        while Ticket do
            task.wait(10)
            if not HeartbeatAlive then break end

            -- T13
            if SafeGetGenv().loadstring ~= SafeLoadstring then
                return KickPlayer("loadstring changed", 1)
            end
            if isfunctionhooked(SafeLoadstring) then
                return KickPlayer("loadstring hooked", 1)
            end

            -- T-RAWSET3
            local gok = true
            if getgenv().loadstring and getgenv().loadstring ~= RealLoadstring then gok = false end
            if getgenv().rawset and RealRawset and getgenv().rawset ~= RealRawset then gok = false end
            if getgenv().rawget and RealRawget and getgenv().rawget ~= RealRawget then gok = false end
            if not gok then
                return KickPlayer("T-RAWSET3: genv changed", 1)
            end

            -- T19
            local currentScript = SafeGetGenv().script or _G.script
            if currentScript ~= SCRIPT_NAME_LOCKED then
                return KickPlayer("script name changed", 1)
            end

            -- Heartbeat
            local hb = EncodeBody({ ServerId = ServerId, scriptName = SCRIPT_NAME_LOCKED })
            hb.ticket = Ticket
            local hbRes = postJSON("/api/heartbeat", hb)
            if hbRes and hbRes.status == 200 and hbRes.data and hbRes.data.Data then
                local okDec2, dec2 = pcall(function()
                    local raw = ""
                    for _, b in ipairs(hbRes.data.Data) do raw = raw .. Char(b) end
                    return HttpService:JSONDecode(Xor(Base64Decode(raw:sub(#XORKey + 1)), XORKey))
                end)
                if okDec2 and type(dec2) == "table" and dec2.kick then
                    return KickPlayer(dec2.kick, 0)
                end
            end
        end
        HeartbeatAlive = false
    end)

    task.spawn(function()
        while Ticket do
            task.wait(30)
            if not HeartbeatAlive then
                return KickPlayer("Heartbeat stopped", 1)
            end
        end
    end)
end

local function FetchAndLoad(key, sname)
    local hwid = GetHWID()
    local userId = tostring(Players.LocalPlayer.UserId)

    print("[Luasec] Verifying key...")

    local r1, err = postJSON("/api/verify", {
        key = key, hwid = hwid, userId = userId, scriptName = sname,
    })

    if not r1 then return nil, err or "Connection failed" end
    if r1.status == 429 then return nil, "Rate limited" end
    if r1.status == 403 then return nil, r1.data.message or "Banned" end
    if r1.status ~= 200 or r1.data.valid ~= true then
        return nil, r1.data.message or r1.data.error or "Invalid key"
    end

    Ticket = r1.data.ticket
    XORKey = r1.data.k or ""

    print("[Luasec] Key verified")

    local rng = {
        Rng1 = Floor(R1()), Rng2 = Floor(R2()), Rng3 = Floor(R3()),
        Rng4 = Floor(R4()), Rng5 = Floor(R5()),
    }
    local body = EncodeBody(rng)
    body.ticket = Ticket
    body.scriptName = sname

    local r2, err2 = postJSON("/api/script", body)
    if not r2 then return nil, err2 or "Script fetch failed" end
    if r2.status ~= 200 then return nil, r2.body or "Script fetch failed" end

    local resp = r2.data
    if not resp or not resp.Data then return nil, "Invalid response" end

    local okDec, decrypted = pcall(function()
        local raw = ""
        for _, b in ipairs(resp.Data) do raw = raw .. Char(b) end
        local b64 = raw:sub(#XORKey + 1)
        return HttpService:JSONDecode(Xor(Base64Decode(b64), XORKey))
    end)

    if not okDec or type(decrypted) ~= "table" then return nil, "Decode failed" end
    if decrypted.Valid ~= true then return nil, decrypted.reason or "Server rejected" end

    if decrypted.check then
        local parts = Split(decrypted.check, "|")
        if #parts >= 5 then
            local okCheck =
                SecureEQ(math.floor(inverse(tonumber(parts[1]))), rng.Rng1) and
                SecureEQ(math.floor(inverse(tonumber(parts[2]))), rng.Rng2) and
                SecureEQ(math.floor(inverse(tonumber(parts[3]))), rng.Rng3) and
                SecureEQ(math.floor(inverse(tonumber(parts[4]))), rng.Rng4) and
                SecureEQ(math.floor(inverse(tonumber(parts[5]))), rng.Rng5)
            if not okCheck then return nil, "RNG check failed" end
        end
    end

    return decrypted
end

-- ═══ UI ═══
local function MakeUI()
    if _G.LUASEC_UI then pcall(function() _G.LUASEC_UI:Destroy() end) end

    local gui = Instance.new("ScreenGui")
    gui.Name = "LuasecUI"
    gui.ResetOnSpawn = false
    gui.IgnoreGuiInset = true
    pcall(function() gui.Parent = game:GetService("CoreGui") end)
    if not gui.Parent then gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui") end
    _G.LUASEC_UI = gui

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
    title.Text = "Luasec"
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
        _G.LUASEC_UI = nil
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
        status.Text = msg or ""
        status.TextColor3 = color or Color3.fromRGB(255, 100, 100)
    end
    local function setBusy(isBusy)
        busy = isBusy
        btn.Text = isBusy and "Checking..." or "Verify Key"
        btn.BackgroundColor3 = isBusy and Color3.fromRGB(60, 70, 160) or Color3.fromRGB(88, 101, 242)
        input.TextEditable = not isBusy
    end

    btn.MouseButton1Click:Connect(function()
        if busy then return end
        local key = input.Text
        if type(key) ~= "string" or #key < 8 or #key > 256 then
            setStatus("Key must be 8-256 chars"); return
        end
        setBusy(true)
        setStatus("Verifying...", Color3.fromRGB(200, 200, 120))
        task.spawn(function()
            local decrypted, err = FetchAndLoad(key, SCRIPT_NAME_LOCKED)
            if not decrypted then setStatus(err or "Error"); setBusy(false); return end
            setStatus("Success!", Color3.fromRGB(100, 255, 100))
            task.wait(0.3)
            LoadScript(decrypted, key)
        end)
    end)

    buyBtn.MouseButton1Click:Connect(function()
        task.spawn(function()
            local hwid = GetHWID()
            local r, err = postJSON("/api/start", { hwid = hwid })
            if not r then setStatus(err or "Cannot open link"); return end
            if r.status ~= 200 or not r.data.url then
                setStatus(r.data.error or "Cannot open link"); return
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
    print("[Luasec] No key, opening UI")
    MakeUI()
    return
end

task.spawn(function()
    local decrypted, err = FetchAndLoad(USER_KEY, SCRIPT_NAME_LOCKED)
    if not decrypted then
        print("[Luasec] Auto-load failed:", err)
        MakeUI()
        return
    end
    LoadScript(decrypted, USER_KEY)
end)
