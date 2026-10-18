-- ===========================================================
-- Stage 3: anti-checks, then the hand-off to Stage 4.
local gamaramam = {
    "@NEXT@"
}
-- ═══ BODY ═══ everything below is compacted at build time.
-- 999MS Bootstrap + Anti (Signal-based + T-RAWSET)
-- Anti-Save ตามไฟล์ X 100%
-- ===========================================================
local ctx = ...
if type(ctx) ~= "table" then error("MS999:CHAIN_CONTEXT_MISSING", 0) end
local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer

-- Display an opaque local reference rather than exposing a human-readable
-- client-side check reason in Roblox's error prompt.
local function makeKickCode(reason)
    local text = tostring(reason or "unknown")
    local hash = 5381
    for index = 1, #text do
        hash = (hash * 33 + text:byte(index) + index) % 2147483647
    end
    return string.format("MS9-%08X", hash)
end

local function patchErrorPrompt(code, diagnostic)
    local success, changed = pcall(function()
        local root = CoreGui:FindFirstChild("RobloxPromptGui")
        local overlay = root and root:FindFirstChild("promptOverlay")
        local prompt = overlay and overlay:FindFirstChild("ErrorPrompt")
        local titleFrame = prompt and prompt:FindFirstChild("TitleFrame")
        local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
        local messageArea = prompt and prompt:FindFirstChild("MessageArea")
        local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
        local label = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
        if not title or not label then return false end
        title.Text = "[999MS]"
        local text = "Session terminated.\nReference: " .. code
        if type(diagnostic) == "string" and diagnostic ~= "" then
            text = text .. "\nDiagnostic: " .. diagnostic
        end
        label.Text = text
        return true
    end)
    return success and changed
end

local function Kick(reason, diagnostic)
    local code = makeKickCode(reason)
    pcall(function()
        CoreGui.ChildAdded:Connect(function(child)
            if child.Name == "RobloxPromptGui" then
                task.spawn(function()
                    task.wait(0.01)
                    patchErrorPrompt(code)
                end)
            end
        end)
    end)
    task.spawn(function()
        for _ = 1, 50 do
            if patchErrorPrompt(code, diagnostic) then break end
            task.wait(0.01)
        end
    end)
    -- Best-effort executor signal trigger requested for compatible executors.
    -- It is not a portable disconnect primitive, so LocalPlayer:Kick remains
    -- the fail-closed fallback that actually enforces the disconnect.
    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local HttpService = game:GetService("HttpService")

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 20

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

if not chainIs("stage2", CHAIN_TTL) then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

-- The script name arrived as a positional local from Stage 1.
local userScript = ctx.scriptName
if type(userScript) ~= "string" or #userScript < 1 or #userScript > 64
    or not userScript:match("^[%w_%-]+$") then
    return Kick("[999MS] Invalid script argument")
end

local SCRIPT_NAME = userScript
local SCRIPT_NAME_LOCKED = SCRIPT_NAME

print("[999MS] Bootstrap started")

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

local MS999Signal = {
    OnDetect = createSignal(),
    OnKick = createSignal(),
    OnLog = createSignal(),
    OnHookDetected = createSignal(),
}
ctx.signal = MS999Signal

-- ═══ Subscribers ═══
MS999Signal.OnKick:Connect(function(reason)
    local detail = "signal:" .. tostring(reason)
    print("[999MS] KICK:", makeKickCode(detail))
    pcall(function()
        Kick(detail)
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

MS999Signal.OnLog:Connect(function(kind, data)
    local detail = tostring(kind) .. ":" .. tostring(data and data.path or data or "")
    print("[999MS][LOG]", makeKickCode(detail))
end)

MS999Signal.OnDetect:Connect(function(event)
    MS999Signal.OnLog:Fire("detect", event)
    if event.type == "payload_save" then
        MS999Signal.OnKick:Fire("Payload save detected: " .. tostring(event.path))
    end
end)

MS999Signal.OnHookDetected:Connect(function(event)
    MS999Signal.OnLog:Fire("hook_detected", event.name .. " - " .. event.reason)
    MS999Signal.OnKick:Fire("Hook detected: " .. event.name)
end)

-- ═══ Capture real functions ═══
local RealLoadstring = loadstring
local RealGlobalWriteFile = writefile
-- Stage 2 passes its writefile monitor through the local context. Keep the
-- direct global alias snapshot separately for compatibility with split aliases.
local Stage2WriteMonitor = ctx.writeMonitor
local RealWriteFile = type(Stage2WriteMonitor) == "function" and Stage2WriteMonitor or RealGlobalWriteFile
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile
local RealListFiles = listfiles
local RealIsHooked = isfunctionhooked
local RealDebugGetInfo = debug.getinfo
local RealHookFunction = hookfunction
local RealNewCClosure = newcclosure
local RealRawset = rawset
local RealRawget = rawget

-- ═══ Helper ═══
local function checkFunction(fn, name)
    if type(fn) ~= "function" then return false, "missing" end
    local current
    if name == "loadstring" then current = loadstring
    elseif name == "writefile" then current = writefile
    elseif name == "readfile" then current = readfile
    elseif name == "isfile" then current = isfile
    elseif name == "hookfunction" then current = hookfunction
    elseif name == "rawset" then current = rawset
    elseif name == "rawget" then current = rawget
    end
    local expected = name == "writefile" and RealGlobalWriteFile or fn
    if current and expected and current ~= expected then return false, "reference changed" end
    local info = RealDebugGetInfo(fn)
    if not info or info.what ~= "C" then return false, "not C function" end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, fn)
        local trustedWriteMonitor = name == "writefile" and ctx.writeMonitor == fn
        if ok and hooked and not trustedWriteMonitor then return false, "hooked" end
    end
    return true
end

local function guard(name, fn)
    local ok, reason = checkFunction(fn, name)
    if not ok then
        MS999Signal.OnHookDetected:Fire({ name = name, reason = reason })
    end
end

-- ═══ T2: Studio check ═══
if game:GetService("RunService"):IsStudio() then
    return Kick("[999MS] T2: Studio detected")
end

-- ═══ T3: pcall anti-hook ═══
do
    -- Check ordinary protected execution, not an invalid-call edge case that
    -- differs across executor runtimes.
    local ok, value = pcall(function() return 3569 end)
    if not ok or value ~= 3569 then
        return Kick("[999MS] T3: pcall hooked")
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
        return Kick("[999MS] T5: math.random hooked")
    end
    local Same, Last = 0, 0
    for _ = 1, 100 do
        local Cur = math.random(1, 3569)
        if Cur == Last then Same = Same + 1 end
        Last = Cur
    end
    if Same > 10 then
        return Kick("[999MS] T5: math.random broken")
    end
end

-- ═══ T6: positional context integrity ═══
do
    local test = {}
    ctx.test = test
    if ctx.test ~= test then
        return Kick("[999MS] T6: local context tampered")
    end
    ctx.test = nil
end

-- ═══ T13: loadstring protection ═══
local SafeLoadstring = RealLoadstring


do
    if type(SafeLoadstring) ~= "function" then
        return Kick("[999MS] T13: loadstring missing")
    end
    local info = RealDebugGetInfo(SafeLoadstring)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T13: loadstring wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, SafeLoadstring)
        if ok and hooked then
            return Kick("[999MS] T13: loadstring hooked")
        end
    end
    if loadstring ~= SafeLoadstring then
        return Kick("[999MS] T13: loadstring reference changed")
    end
    local ok, fn = pcall(SafeLoadstring, "return 1 + 1")
    if not ok or type(fn) ~= "function" then
        return Kick("[999MS] T13: loadstring broken")
    end
    local ok2, result = pcall(fn)
    if not ok2 or result ~= 2 then
        return Kick("[999MS] T13: loadstring malfunction")
    end
end

-- ═══ T14: writefile protection ═══
do
    if type(RealWriteFile) == "function" then
        local info = RealDebugGetInfo(RealWriteFile)
        if not info or info.what ~= "C" then
            return Kick("[999MS] T14: writefile wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealWriteFile)
            local trustedWriteMonitor = ctx.writeMonitor == RealWriteFile
            if ok and hooked and not trustedWriteMonitor then
                return Kick("[999MS] T14: writefile hooked")
            end
        end
        if RealGlobalWriteFile and writefile ~= RealGlobalWriteFile then
            return Kick("[999MS] T14: writefile replaced")
        end
    end
end

-- ═══ T16: hookfunction protection ═══
do
    if type(RealHookFunction) == "function" then
        local info = RealDebugGetInfo(RealHookFunction)
        if not info or info.what ~= "C" then
            return Kick("[999MS] T16: hookfunction wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealHookFunction)
            if ok and hooked then
                return Kick("[999MS] T16: hookfunction hooked")
            end
        end
    end
end

-- ═══ T-RAWSET1: rawset protection ═══
do
    if type(RealRawset) ~= "function" then
        return Kick("[999MS] T-RAWSET1: rawset missing")
    end
    local info = RealDebugGetInfo(RealRawset)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T-RAWSET1: rawset wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawset)
        if ok and hooked then
            return Kick("[999MS] T-RAWSET1: rawset hooked")
        end
    end
    local t = {}
    pcall(RealRawset, t, "test", 12345)
    if t.test ~= 12345 then
        return Kick("[999MS] T-RAWSET1: rawset broken")
    end
end

-- ═══ T-RAWSET2: rawget protection ═══
do
    if type(RealRawget) ~= "function" then
        return Kick("[999MS] T-RAWSET2: rawget missing")
    end
    local info = RealDebugGetInfo(RealRawget)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T-RAWSET2: rawget wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawget)
        if ok and hooked then
            return Kick("[999MS] T-RAWSET2: rawget hooked")
        end
    end
    local t = { test = 999 }
    if RealRawget(t, "test") ~= 999 then
        return Kick("[999MS] T-RAWSET2: rawget broken")
    end
end

-- ═══ T-RAWSET3: direct executor API reference integrity ═══
-- Compare the standard API aliases captured as locals with their current
-- direct globals; the loader no longer consults an executor environment table.
local function checkExecutorApiIntegrity()
    local expected = {
        loadstring = RealLoadstring,
        writefile = RealGlobalWriteFile,
        readfile = RealReadFile,
        isfile = RealIsFile,
        delfile = RealDelfile,
        listfiles = RealListFiles,
        isfunctionhooked = RealIsHooked,
        hookfunction = RealHookFunction,
        newcclosure = RealNewCClosure,
        rawset = RealRawset,
        rawget = RealRawget,
        getinfo = RealDebugGetInfo,
    }
    local current = {
        loadstring = loadstring,
        writefile = writefile,
        readfile = readfile,
        isfile = isfile,
        delfile = delfile,
        listfiles = listfiles,
        isfunctionhooked = isfunctionhooked,
        hookfunction = hookfunction,
        newcclosure = newcclosure,
        rawset = rawset,
        rawget = rawget,
        getinfo = debug.getinfo,
    }
    for name, original in pairs(expected) do
        if type(original) == "function" and current[name] ~= original then
            return false, name .. " changed"
        end
    end
    return true
end

do
    local ok, reason = checkExecutorApiIntegrity()
    if not ok then
        return Kick("[999MS] T-RAWSET3: " .. reason)
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

    local globalHttp = type(http) == "table" and http or nil
    local globalSyn = type(syn) == "table" and syn or nil
    addCandidate("http.request", globalHttp and globalHttp.request)
    addCandidate("request", request)
    addCandidate("http_request", http_request)
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
        return Kick("[999MS] No trusted HTTP request")
    end
end

local HttpRequest = RealHttpRequest
ctx.request = RealHttpRequest
ctx.requestAudit = RequestAudit

-- ═══ Stage 3: Anti checks ═══
-- Stage 2 (savecheck.lua) completed its filesystem scan and installed the
-- trusted Signal.new write monitor.

-- ═══ สร้าง Loader Proof ═══
do
    local dynamicPart = ""
    for _ = 1, 32 do
        dynamicPart = dynamicPart .. string.char(math.random(97, 122))
    end
    ctx.loaderProof = "999MS_loader_v1:" .. dynamicPart
    ctx.loaderTime = tick()
    ctx.loaderMarker = "LSE_" .. tostring(math.random(100000, 999999))
end

-- ═══ T-RAWSET4: 999MS flags integrity snapshot ═══
local MS999FlagSnapshot = {
    MS999Signal = ctx.signal,
    MS999WriteMonitor = ctx.writeMonitor,
    MS999Request = ctx.request,
    MS999LoaderProof = ctx.loaderProof,
    MS999LoaderMarker = ctx.loaderMarker,
    MS999LoaderTime = ctx.loaderTime,
}

local function checkMS999Flags()
    if ctx.signal ~= MS999FlagSnapshot.MS999Signal then
        return false, "999MS signal replaced"
    end
    if ctx.writeMonitor ~= MS999FlagSnapshot.MS999WriteMonitor
        or MS999FlagSnapshot.MS999WriteMonitor ~= RealWriteFile then
        return false, "write monitor replaced"
    end
    if ctx.request ~= MS999FlagSnapshot.MS999Request
        or MS999FlagSnapshot.MS999Request ~= RealHttpRequest then
        return false, "request replaced"
    end
    if ctx.loaderProof ~= MS999FlagSnapshot.MS999LoaderProof then
        return false, "999MS loader proof replaced"
    end
    if ctx.loaderMarker ~= MS999FlagSnapshot.MS999LoaderMarker then
        return false, "999MS loader marker replaced"
    end
    if ctx.loaderTime ~= MS999FlagSnapshot.MS999LoaderTime then
        return false, "999MS loader time replaced"
    end
    return true
end

do
    local ok, reason = checkMS999Flags()
    if not ok then
        return Kick("[999MS] T-RAWSET4: " .. reason)
    end
end

if not chainIs("stage2", 45) then
    return Kick("[999MS] Chain interrupted before payload")
end
Chain.Stage = "loader"
Chain.UpdatedAt = tick()

print("[999MS] Anti-checks passed")

-- ═══ โหลด payload ═══
print("[999MS] Fetching payload...")
-- Stage 4 link: minted by the server while serving this stage, held in the
-- header table so the marker and the hand-off live in one place.
local nextSha = "@NEXT_SHA@"
local nextNonce = "@NONCE@"
local nextUrl = gamaramam[1]
-- "NEXT@" without the leading "@" so this guard is never itself replaced.
if type(nextUrl) ~= "string" or #nextUrl < 40 or nextUrl:find("NEXT@", 1, true) then
    return Kick("[999MS] Stage link unavailable")
end

local cryptTable = (syn and syn.crypt) or crypt
local hasher = type(cryptTable) == "table" and cryptTable.hash or nil
if type(hasher) ~= "function" then
    return Kick("[999MS] Payload hash unavailable")
end

-- The last link only opens for this stage's own proof, not for a plain fetch.
local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nextNonce .. "|" .. nextUrl, "sha256")
if not okProof or type(proof) ~= "string" then
    return Kick("[999MS] Stage proof unavailable")
end

local ok, response = pcall(HttpRequest, {
    Url = nextUrl,
    Method = "POST",
    Headers = { ["content-type"] = "application/json" },
    Body = '{"p":"' .. proof .. '"}',
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Kick("[999MS] Payload fetch failed")
end

local payloadSrc = response.Body or ""
if #payloadSrc < 100 then
    return Kick("[999MS] Invalid payload")
end
local okHash, digest = pcall(hasher, payloadSrc, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= nextSha then
    return Kick("[999MS] Payload integrity check failed")
end

print("[999MS] Payload received, running...")

local fn = SafeLoadstring(payloadSrc)
if not fn then return Kick("[999MS] Load failed") end
local runOk, runErr = pcall(fn, ctx)
if not runOk then
    -- Preserve the reference code and show a redacted short error so an
    -- executor-specific startup failure can be diagnosed without exposing keys.
    local detail = tostring(runErr):gsub("[%c]", " ")
    detail = detail:gsub("[%w_%-]+", function(token)
        return #token >= 16 and "[redacted]" or token
    end):sub(1, 120)
    pcall(function()
        if type(warn) == "function" then
            warn("[999MS] Payload startup error: " .. detail)
        else
            print("[999MS] Payload startup error: " .. detail)
        end
    end)
    return Kick("[999MS] Runtime error", detail)
end
