-- ===========================================================
-- Luasec Bootstrap + Anti (Signal + T-RAWSET)
-- T0, T2-T6, T13-T16, T-RAWSET1-4, T-HTTP, T-HTTP2, T-LOG
-- ===========================================================
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local BASE_URL = "https://keysytemdemo.vercel.app"

-- ═══ T0: require getgenv().script ═══
local userScript = getgenv().script or _G.script
if userScript == nil then
    return Players.LocalPlayer:Kick(
        "[Luasec] Set getgenv().script first:\n\n" ..
        'getgenv().script = "scriptname"\n' ..
        'loadstring(game:HttpGet("' .. BASE_URL .. '/loader.lua"))()'
    )
end
if type(userScript) ~= "string" then
    return Players.LocalPlayer:Kick("[Luasec] getgenv().script must be string")
end
if #userScript < 1 or #userScript > 64 then
    return Players.LocalPlayer:Kick("[Luasec] getgenv().script must be 1-64 chars")
end
if not userScript:match("^[%w_%-]+$") then
    return Players.LocalPlayer:Kick("[Luasec] getgenv().script invalid format")
end

local SCRIPT_NAME = userScript
local SCRIPT_NAME_LOCKED = SCRIPT_NAME

print("[Luasec] Bootstrap started")

-- ═══ Create Signal bus ═══
local function createSignal()
    local signal = {}
    local connections = {}
    local nextId = 0

    function signal:Connect(fn)
        if type(fn) ~= "function" then return { Disconnect = function() end } end
        nextId = nextId + 1
        local id = nextId
        connections[id] = fn
        return { Disconnect = function() connections[id] = nil end }
    end

    function signal:Fire(...)
        for _, fn in pairs(connections) do
            pcall(fn, ...)
        end
    end

    return signal
end

local LuasecSignal = {
    OnDetect = createSignal(),
    OnKick = createSignal(),
    OnLog = createSignal(),
    OnHookDetected = createSignal(),
}
getgenv().LuasecSignal = LuasecSignal

-- ═══ Subscribers ═══
LuasecSignal.OnKick:Connect(function(reason)
    print("[Luasec] KICK:", reason)
    pcall(function()
        Players.LocalPlayer:Kick("[Luasec] " .. reason)
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

LuasecSignal.OnLog:Connect(function(type, data)
    print("[Luasec][LOG]", type, data and data.path or data or "")
end)

LuasecSignal.OnDetect:Connect(function(event)
    LuasecSignal.OnLog:Fire("detect", event)
    if event.type == "payload_save" then
        LuasecSignal.OnKick:Fire("Payload save detected: " .. tostring(event.path))
    end
end)

LuasecSignal.OnHookDetected:Connect(function(event)
    LuasecSignal.OnLog:Fire("hook_detected", event.name .. " - " .. event.reason)
    LuasecSignal.OnKick:Fire("Hook detected: " .. event.name)
end)

-- ═══ Capture real functions ═══
local RealLoadstring = loadstring
local RealWriteFile = writefile
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile
local RealListFiles = listfiles
local RealGetGenv = getgenv
local RealIsHooked = isfunctionhooked
local RealDebugGetInfo = debug.getinfo
local RealHookFunction = hookfunction
local RealNewCClosure = newcclosure
local RealRawset = rawset
local RealRawget = rawget

-- ═══ Helper ═══
local function checkFunction(fn, name)
    if type(fn) ~= "function" then return false, "missing" end
    local info = RealDebugGetInfo(fn)
    if not info or info.what ~= "C" then return false, "not C function" end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, fn)
        if ok and hooked then return false, "hooked" end
    end
    if RealGetGenv()[name] and RealGetGenv()[name] ~= fn then
        return false, "getgenv replaced"
    end
    return true
end

local function guard(name, fn)
    local ok, reason = checkFunction(fn, name)
    if not ok then
        LuasecSignal.OnHookDetected:Fire({ name = name, reason = reason })
    end
end

-- ═══ T2: Studio check ═══
if game:GetService("RunService"):IsStudio() then
    return Players.LocalPlayer:Kick("[Luasec] T2: Studio detected")
end

-- ═══ T3: pcall anti-hook ═══
do
    local ok, err = pcall(pcall)
    if ok or err ~= "missing argument #1" then
        return Players.LocalPlayer:Kick("[Luasec] T3: pcall hooked")
    end
end

-- ═══ T4: check important functions ═══
guard("loadstring", RealLoadstring)
guard("writefile", RealWriteFile)
guard("readfile", RealReadFile)
guard("isfile", RealIsFile)
guard("hookfunction", RealHookFunction)
guard("rawset", RealRawset)
guard("rawget", RealRawget)

-- ═══ T5: math.random behavior ═══
do
    if math.random(1, 2) == math.random(3, 4) then
        return Players.LocalPlayer:Kick("[Luasec] T5: math.random hooked")
    end
    local Same, Last = 0, 0
    for _ = 1, 100 do
        local Cur = math.random(1, 3569)
        if Cur == Last then Same = Same + 1 end
        Last = Cur
    end
    if Same > 10 then
        return Players.LocalPlayer:Kick("[Luasec] T5: math.random broken")
    end
end

-- ═══ T6: getgenv integrity ═══
do
    local test = {}
    getgenv().__luasec_test = test
    if getgenv().__luasec_test ~= test then
        return Players.LocalPlayer:Kick("[Luasec] T6: getgenv tampered")
    end
    getgenv().__luasec_test = nil
end

-- ═══ T13: loadstring protection ═══
local SafeLoadstring = RealLoadstring
local SafeGetGenv = RealGetGenv

do
    if type(SafeLoadstring) ~= "function" then
        return Players.LocalPlayer:Kick("[Luasec] T13: loadstring missing")
    end
    local info = RealDebugGetInfo(SafeLoadstring)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] T13: loadstring wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, SafeLoadstring)
        if ok and hooked then
            return Players.LocalPlayer:Kick("[Luasec] T13: loadstring hooked")
        end
    end
    if SafeGetGenv().loadstring ~= SafeLoadstring then
        return Players.LocalPlayer:Kick("[Luasec] T13: getgenv().loadstring replaced")
    end
    local ok, fn = pcall(SafeLoadstring, "return 1 + 1")
    if not ok or type(fn) ~= "function" then
        return Players.LocalPlayer:Kick("[Luasec] T13: loadstring broken")
    end
    local ok2, result = pcall(fn)
    if not ok2 or result ~= 2 then
        return Players.LocalPlayer:Kick("[Luasec] T13: loadstring malfunction")
    end
end

-- ═══ T14: writefile protection ═══
do
    if type(RealWriteFile) == "function" then
        local info = RealDebugGetInfo(RealWriteFile)
        if not info or info.what ~= "C" then
            return Players.LocalPlayer:Kick("[Luasec] T14: writefile wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealWriteFile)
            if ok and hooked then
                return Players.LocalPlayer:Kick("[Luasec] T14: writefile hooked")
            end
        end
        if SafeGetGenv().writefile and SafeGetGenv().writefile ~= RealWriteFile then
            return Players.LocalPlayer:Kick("[Luasec] T14: writefile replaced")
        end
    end
end

-- ═══ T16: hookfunction protection ═══
do
    if type(RealHookFunction) == "function" then
        local info = RealDebugGetInfo(RealHookFunction)
        if not info or info.what ~= "C" then
            return Players.LocalPlayer:Kick("[Luasec] T16: hookfunction wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealHookFunction)
            if ok and hooked then
                return Players.LocalPlayer:Kick("[Luasec] T16: hookfunction hooked")
            end
        end
    end
end

-- ═══ T-RAWSET1: rawset protection ═══
do
    if type(RealRawset) ~= "function" then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET1: rawset missing")
    end
    local info = RealDebugGetInfo(RealRawset)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET1: rawset wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawset)
        if ok and hooked then
            return Players.LocalPlayer:Kick("[Luasec] T-RAWSET1: rawset hooked")
        end
    end
    local t = {}
    pcall(RealRawset, t, "test", 12345)
    if t.test ~= 12345 then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET1: rawset broken")
    end
end

-- ═══ T-RAWSET2: rawget protection ═══
do
    if type(RealRawget) ~= "function" then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET2: rawget missing")
    end
    local info = RealDebugGetInfo(RealRawget)
    if not info or info.what ~= "C" then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET2: rawget wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawget)
        if ok and hooked then
            return Players.LocalPlayer:Kick("[Luasec] T-RAWSET2: rawget hooked")
        end
    end
    local t = { test = 999 }
    if RealRawget(t, "test") ~= 999 then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET2: rawget broken")
    end
end

-- ═══ T-RAWSET3: getgenv integrity ═══
local function checkGenvIntegrity()
    if getgenv().loadstring and getgenv().loadstring ~= RealLoadstring then
        return false, "loadstring changed"
    end
    if type(RealWriteFile) == "function" and getgenv().writefile 
       and getgenv().writefile ~= RealWriteFile then
        return false, "writefile changed"
    end
    if type(RealHookFunction) == "function" and getgenv().hookfunction 
       and getgenv().hookfunction ~= RealHookFunction then
        return false, "hookfunction changed"
    end
    if type(RealIsHooked) == "function" and getgenv().isfunctionhooked 
       and getgenv().isfunctionhooked ~= RealIsHooked then
        return false, "isfunctionhooked changed"
    end
    if type(RealRawset) == "function" and getgenv().rawset 
       and getgenv().rawset ~= RealRawset then
        return false, "rawset changed"
    end
    if type(RealRawget) == "function" and getgenv().rawget 
       and getgenv().rawget ~= RealRawget then
        return false, "rawget changed"
    end
    return true
end

do
    local ok, reason = checkGenvIntegrity()
    if not ok then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET3: " .. reason)
    end
end

-- ═══ T-HTTP: http.request protection ═══
local RealHttpRequest = nil
do
    if http and type(http.request) == "function" then
        RealHttpRequest = http.request
    elseif type(http_request) == "function" then
        RealHttpRequest = http_request
    elseif type(request) == "function" then
        RealHttpRequest = request
    elseif syn and type(syn.request) == "function" then
        RealHttpRequest = syn.request
    end

    if not RealHttpRequest then
        return Players.LocalPlayer:Kick("[Luasec] No HTTP function")
    end

    guard("http.request", RealHttpRequest)
end

local HttpRequest = RealHttpRequest

-- ═══ Anti-Save: Signal-based (Size only) ═══
local SIZE_THRESHOLD = 15000

local ALLOWLIST_PATTERNS = {
    "clientsettings", "rbx", "config",
    "user", "settings", "preferences",
}

local function isAllowlisted(path)
    if type(path) ~= "string" then return false end
    local lower = path:lower()
    if #lower < 3 then return true end
    for _, pat in ipairs(ALLOWLIST_PATTERNS) do
        if lower:find(pat, 1, true) then return true end
    end
    if lower:match("%.log$") then return true end
    if lower:match("%.cfg$") then return true end
    if lower:match("%.ini$") then return true end
    return false
end

-- ═══ Signal-based writefile hook ═══
if type(RealWriteFile) == "function"
   and type(RealHookFunction) == "function"
   and type(RealNewCClosure) == "function" then

    local saved = getgenv().Signal and getgenv().Signal.new and getgenv().Signal.new() or {
        Connect = function() end,
        Fire = function() end,
    }

    saved:Connect(function(event)
        if isAllowlisted(event.path) then return end

        local size = event.bytes or 0
        if size >= SIZE_THRESHOLD then
            if type(RealIsFile) == "function" and type(RealDelfile) == "function" then
                pcall(function()
                    if RealIsFile(event.path) then RealDelfile(event.path) end
                end)
            end

            LuasecSignal.OnDetect:Fire({
                type = "payload_save",
                path = event.path,
                size = size,
            })
        end
    end)

    pcall(function()
        RealHookFunction(RealWriteFile, RealNewCClosure(function(path, contents, ...)
            local result = table.pack(pcall(RealWriteFile, path, contents, ...))
            local success = result[1] and result[2] ~= false

            if success then
                saved:Fire({
                    api = "writefile",
                    path = tostring(path),
                    bytes = typeof(contents) == "string" and #contents or nil,
                })
            end

            if not result[1] then
                error(result[2], 0)
            end
            return table.unpack(result, 2, result.n)
        end))
    end)
end

-- ═══ Scan existing files ═══
local function scanAndKill()
    if type(RealListFiles) ~= "function"
       or type(RealReadFile) ~= "function"
       or type(RealDelfile) ~= "function" then
        return false
    end

    local ok, files = pcall(RealListFiles, ".")
    if not ok or type(files) ~= "table" then return false end

    for _, file in ipairs(files) do
        if not file:match("^luasec_") and not isAllowlisted(file) then
            local readOk, content = pcall(RealReadFile, file)
            if readOk and type(content) == "string" and #content >= SIZE_THRESHOLD then
                pcall(RealDelfile, file)
                LuasecSignal.OnDetect:Fire({
                    type = "payload_save",
                    path = file,
                    size = #content,
                })
                return true
            end
        end
    end
    return false
end

task.spawn(function()
    task.wait(0.3)
    scanAndKill()
end)

-- ═══ สร้าง Loader Proof ═══
do
    local dynamicPart = ""
    for _ = 1, 32 do
        dynamicPart = dynamicPart .. string.char(math.random(97, 122))
    end
    getgenv().LuasecLoaderProof = "luasec_loader_v1:" .. dynamicPart
    getgenv().LuasecLoaderTime = tick()
    getgenv().LuasecLoaderMarker = "LSE_" .. tostring(math.random(100000, 999999))
end

-- ═══ T-RAWSET4: Luasec flags integrity snapshot ═══
local LuasecFlagSnapshot = {
    LuasecSignal = getgenv().LuasecSignal,
    LuasecLoaderProof = getgenv().LuasecLoaderProof,
    LuasecLoaderMarker = getgenv().LuasecLoaderMarker,
    LuasecLoaderTime = getgenv().LuasecLoaderTime,
}

local function checkLuasecFlags()
    if getgenv().LuasecSignal ~= LuasecFlagSnapshot.LuasecSignal then
        return false, "LuasecSignal replaced"
    end
    if getgenv().LuasecLoaderProof ~= LuasecFlagSnapshot.LuasecLoaderProof then
        return false, "LuasecLoaderProof replaced"
    end
    if getgenv().LuasecLoaderMarker ~= LuasecFlagSnapshot.LuasecLoaderMarker then
        return false, "LuasecLoaderMarker replaced"
    end
    if getgenv().LuasecLoaderTime ~= LuasecFlagSnapshot.LuasecLoaderTime then
        return false, "LuasecLoaderTime replaced"
    end
    return true
end

do
    local ok, reason = checkLuasecFlags()
    if not ok then
        return Players.LocalPlayer:Kick("[Luasec] T-RAWSET4: " .. reason)
    end
end

print("[Luasec] Anti-checks passed")

-- ═══ T-HTTP2: ping test ═══
do
    local pingOk, pingRes = pcall(HttpRequest, {
        Url = BASE_URL .. "/api/ping",
        Method = "GET",
    })
    if not pingOk or type(pingRes) ~= "table" then
        return Players.LocalPlayer:Kick("[Luasec] T-HTTP2: ping failed")
    end
    local body = pingRes.Body or ""
    if not body:find("luasec_pong_v1", 1, true) then
        return Players.LocalPlayer:Kick("[Luasec] T-HTTP2: URL tampered")
    end
end

-- ═══ โหลด payload ═══
print("[Luasec] Fetching payload...")

local ok, res = pcall(HttpRequest, {
    Url = BASE_URL .. "/payload.lua",
    Method = "GET",
})

if not ok or type(res) ~= "table" or res.StatusCode ~= 200 then
    return Players.LocalPlayer:Kick("[Luasec] Payload fetch failed")
end

local payloadSrc = res.Body or ""
if #payloadSrc < 100 then
    return Players.LocalPlayer:Kick("[Luasec] Invalid payload")
end

print("[Luasec] Payload received, running...")

local fn = SafeLoadstring(payloadSrc)
if not fn then return Players.LocalPlayer:Kick("[Luasec] Load failed") end
local runOk = pcall(fn)
if not runOk then return Players.LocalPlayer:Kick("[Luasec] Runtime error") end