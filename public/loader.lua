-- ===========================================================
-- Luasec Bootstrap + Anti (Signal-based + T-RAWSET)
-- Anti-Save ตามไฟล์ X 100%
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
        'loadstring(game:HttpGet("' .. BASE_URL .. '/loadc.lua"))()'
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

local LuasecSignal = getgenv().LuasecSignal
if type(LuasecSignal) ~= "table"
    or type(LuasecSignal.OnDetect) ~= "table"
    or type(LuasecSignal.OnKick) ~= "table" then
    LuasecSignal = {
        OnDetect = createSignal(),
        OnKick = createSignal(),
        OnLog = createSignal(),
        OnHookDetected = createSignal(),
    }
    getgenv().LuasecSignal = LuasecSignal
end

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
        local trustedWriteMonitor = name == "writefile"
            and RealGetGenv().LuasecWriteMonitor == fn
        if ok and hooked and not trustedWriteMonitor then return false, "hooked" end
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

-- A loadstring hook installed before this loader starts can make a C-closure
-- check pass. Probe it with a temporary writefile interceptor: source-saving
-- wrappers (including the common `writefile(..., chunk)` pattern) will attempt
-- to write the probe and are rejected before the payload is fetched.
local function loadstringWritesSource()
    if type(SafeLoadstring) ~= "function" or type(RealWriteFile) ~= "function" then
        return false
    end

    local env = SafeGetGenv()
    if type(env) ~= "table" or env.writefile ~= RealWriteFile then
        return false
    end

    local originalWrite = env.writefile
    local wroteDuringProbe = false
    local interceptor = function(...)
        wroteDuringProbe = true
        -- Do not create the probe file. The wrapper only needs a successful
        -- return value to continue, then the loader can terminate safely.
        return true
    end

    local installed = pcall(function()
        env.writefile = interceptor
    end) and env.writefile == interceptor
    if not installed then
        pcall(function() env.writefile = originalWrite end)
        return false
    end

    local compiledOk, compiled = pcall(SafeLoadstring, "-- Luasec source-save probe\nreturn true")
    pcall(function() env.writefile = originalWrite end)

    -- Leave the existing T13 checks to report a broken loadstring implementation.
    if not compiledOk or type(compiled) ~= "function" then
        return false
    end
    return wroteDuringProbe
end

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
    if loadstringWritesSource() then
        return Players.LocalPlayer:Kick("[Luasec] T13: loadstring attempted to save source")
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
            local trustedWriteMonitor = SafeGetGenv().LuasecWriteMonitor == RealWriteFile
            if ok and hooked and not trustedWriteMonitor then
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

-- ═══ T-HTTP: capture and audit the request implementation ═══
-- A C-closure result is only supplemental: newcclosure can make a wrapper look
-- native. Prefer the earliest request reference, reject detectable hooks, and
-- use that same captured reference for every later request.
local RealHttpRequest = nil
local RequestAudit = nil
do
    local candidates, seen = {}, {}
    local function addCandidate(label, fn)
        if type(fn) == "function" and not seen[fn] then
            seen[fn] = true
            table.insert(candidates, { label = label, fn = fn })
        end
    end

    local env = RealGetGenv()
    local envHttp = type(env.http) == "table" and env.http or nil
    local globalHttp = type(http) == "table" and http or nil
    addCandidate("getgenv.http.request", envHttp and envHttp.request)
    addCandidate("http.request", globalHttp and globalHttp.request)
    addCandidate("getgenv.request", env.request)
    addCandidate("request", request)
    addCandidate("getgenv.http_request", env.http_request)
    addCandidate("http_request", http_request)
    local envSyn = type(env.syn) == "table" and env.syn or nil
    local globalSyn = type(syn) == "table" and syn or nil
    addCandidate("getgenv.syn.request", envSyn and envSyn.request)
    addCandidate("syn.request", globalSyn and globalSyn.request)

    for _, candidate in ipairs(candidates) do
        local audit = { label = candidate.label, cClosure = nil, hookChecked = false }
        local usable = true
        if type(RealDebugGetInfo) == "function" then
            local ok, info = pcall(RealDebugGetInfo, candidate.fn)
            if ok and info then audit.cClosure = info.what == "C" end
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, candidate.fn)
            audit.hookChecked = ok
            if ok and hooked then usable = false end
        end
        if usable then
            RealHttpRequest, RequestAudit = candidate.fn, audit
            break
        end
    end

    if not RealHttpRequest then
        return Players.LocalPlayer:Kick("[Luasec] No trusted HTTP request")
    end
end

local HttpRequest = RealHttpRequest
getgenv().LuasecRequest = RealHttpRequest
getgenv().LuasecRequestAudit = RequestAudit

-- ═══ Stage 3: Anti checks ═══
-- Stage 2 (savecheck.lua) completed its filesystem scan and installed the
-- trusted Signal.new write monitor.

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
    LuasecWriteMonitor = getgenv().LuasecWriteMonitor,
    LuasecRequest = getgenv().LuasecRequest,
    LuasecLoaderProof = getgenv().LuasecLoaderProof,
    LuasecLoaderMarker = getgenv().LuasecLoaderMarker,
    LuasecLoaderTime = getgenv().LuasecLoaderTime,
}

local function checkLuasecFlags()
    if getgenv().LuasecSignal ~= LuasecFlagSnapshot.LuasecSignal then
        return false, "LuasecSignal replaced"
    end
    if getgenv().LuasecWriteMonitor ~= LuasecFlagSnapshot.LuasecWriteMonitor
        or LuasecFlagSnapshot.LuasecWriteMonitor ~= RealWriteFile then
        return false, "write monitor replaced"
    end
    if getgenv().LuasecRequest ~= LuasecFlagSnapshot.LuasecRequest
        or LuasecFlagSnapshot.LuasecRequest ~= RealHttpRequest then
        return false, "request replaced"
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

-- ═══ โหลด payload ═══
print("[Luasec] Fetching payload...")
local ok, response = pcall(HttpRequest, {
    Url = BASE_URL .. "/payload.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Players.LocalPlayer:Kick("[Luasec] Payload fetch failed")
end

local payloadSrc = response.Body or ""
if #payloadSrc < 100 then
    return Players.LocalPlayer:Kick("[Luasec] Invalid payload")
end

print("[Luasec] Payload received, running...")

local fn = SafeLoadstring(payloadSrc)
if not fn then return Players.LocalPlayer:Kick("[Luasec] Load failed") end
local runOk = pcall(fn)
if not runOk then return Players.LocalPlayer:Kick("[Luasec] Runtime error") end
