-- ===========================================================
-- 999MS Runtime Loader
-- Minimal, executor-compatible checks. Security decisions that matter are
-- enforced by the signed chain, server ticket, and later runtime proof.
-- ===========================================================
local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer

local function makeKickCode(reason)
    local text = tostring(reason or "unknown")
    local hash = 5381
    for index = 1, #text do
        hash = (hash * 33 + text:byte(index) + index) % 2147483647
    end
    return string.format("MS9-%08X", hash)
end

local function patchErrorPrompt(code)
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
        label.Text = "Session terminated.\nReference: " .. code
        return true
    end)
    return success and changed
end

local function Kick(reason)
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
            if patchErrorPrompt(code) then break end
            task.wait(0.01)
        end
    end)
    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local BASE_URL = "https://keysytemdemo.vercel.app"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 20

local ChainEnv = getgenv()
local Chain = ChainEnv.MS999Chain
local ChainId = type(Chain) == "table" and Chain.Id or nil
local function chainIs(stage, maxAge)
    local current = ChainEnv.MS999Chain
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

local userScript = ChainEnv.script or _G.script
if type(userScript) ~= "string" or #userScript < 1 or #userScript > 64
    or not userScript:match("^[%w_%-]+$") then
    return Kick("[999MS] Invalid script selection")
end
local SCRIPT_NAME_LOCKED = userScript

local function createSignal()
    local signal, connections, nextId = {}, {}, 0
    function signal:Connect(fn)
        if type(fn) ~= "function" then return { Disconnect = function() end } end
        nextId = nextId + 1
        local id = nextId
        connections[id] = fn
        return { Disconnect = function() connections[id] = nil end }
    end
    function signal:Fire(...)
        for _, fn in pairs(connections) do pcall(fn, ...) end
    end
    return signal
end

local MS999Signal = ChainEnv.MS999Signal
if type(MS999Signal) ~= "table" then
    MS999Signal = {
        OnDetect = createSignal(),
        OnKick = createSignal(),
        OnLog = createSignal(),
        OnHookDetected = createSignal(),
    }
    ChainEnv.MS999Signal = MS999Signal
end

MS999Signal.OnKick:Connect(function(reason)
    local detail = "signal:" .. tostring(reason)
    print("[999MS] KICK:", makeKickCode(detail))
    pcall(Kick, detail)
end)

MS999Signal.OnLog:Connect(function(kind, data)
    print("[999MS][LOG]", makeKickCode(tostring(kind) .. ":" .. tostring(data and data.path or data or "")))
end)

MS999Signal.OnDetect:Connect(function(event)
    MS999Signal.OnLog:Fire("detect", event)
    if type(event) == "table" and event.type == "payload_save" then
        MS999Signal.OnKick:Fire("Payload save detected: " .. tostring(event.path))
    end
end)

-- Stage 2 is the sole owner of the hookfunction-based write monitor. Treat a
-- missing/inactive monitor as a failed chain, but do not inspect closure type,
-- call stack, debug metadata, or isfunctionhooked: those are not portable
-- across executors and are changed by many obfuscators.
local Stage2WriteMonitor = ChainEnv.MS999WriteMonitor
local HookAudit = ChainEnv.MS999HookAudit
if type(Stage2WriteMonitor) ~= "function" or ChainEnv.MS999ChecksActive == false
    or type(HookAudit) ~= "table" or HookAudit.writeMonitorInstalled ~= true then
    return Kick("[999MS] Write monitor unavailable")
end
-- C-closure / isfunctionhooked values are advisory only. Their shape can be
-- changed by an obfuscator, so they are never a stand-alone Kick condition.
if HookAudit.hookfunction and HookAudit.hookfunction.hooked == true then
    print("[999MS] Hook audit warning: hookfunction")
end

-- Keep the rawset/rawget/math.random checks, but make them functional and
-- stack-tolerant. C-closure and isfunctionhooked results are advisory only;
-- an obfuscator may change either without changing actual behavior.
local function softFunctionAudit(label, fn)
    local audit = { label = label, cClosure = nil, hooked = nil }
    local debugInfo = type(debug) == "table" and debug.getinfo or nil
    if type(debugInfo) == "function" then
        local ok, info = pcall(debugInfo, fn)
        if ok and type(info) == "table" then audit.cClosure = info.what == "C" end
    end
    if type(isfunctionhooked) == "function" then
        local ok, hooked = pcall(isfunctionhooked, fn)
        if ok and type(hooked) == "boolean" then audit.hooked = hooked end
    end
    HookAudit[label] = audit
end

local SafeRawset = rawset
local SafeRawget = rawget
local SafeRandom = type(math) == "table" and math.random or nil
softFunctionAudit("rawset", SafeRawset)
softFunctionAudit("rawget", SafeRawget)
softFunctionAudit("math.random", SafeRandom)

if type(SafeRawset) ~= "function" or type(SafeRawget) ~= "function" then
    return Kick("[999MS] Raw table primitives unavailable")
end
local rawProbe, rawMarker = {}, {}
local rawOk, rawWorks = pcall(function()
    SafeRawset(rawProbe, "__999MS_probe", rawMarker)
    return SafeRawget(rawProbe, "__999MS_probe") == rawMarker
end)
if not rawOk or rawWorks ~= true then
    return Kick("[999MS] Raw table primitives unavailable")
end

if type(SafeRandom) ~= "function" then
    return Kick("[999MS] Random unavailable")
end
local randomOk, randomValue = pcall(SafeRandom, 1, 1000000)
if not randomOk or type(randomValue) ~= "number" or randomValue % 1 ~= 0
    or randomValue < 1 or randomValue > 1000000 then
    return Kick("[999MS] Random unavailable")
end
ChainEnv.MS999PrimitiveCheck = { rawTable = true, random = true }

local SafeLoadstring = loadstring
if type(SafeLoadstring) ~= "function" then
    return Kick("[999MS] loadstring unavailable")
end

local function resolveRequest()
    local env = ChainEnv
    local envHttp = type(env.http) == "table" and env.http or nil
    local globalHttp = type(http) == "table" and http or nil
    local envSyn = type(env.syn) == "table" and env.syn or nil
    local globalSyn = type(syn) == "table" and syn or nil
    local candidates = {
        envSyn and envSyn.request,
        globalSyn and globalSyn.request,
        envHttp and envHttp.request,
        globalHttp and globalHttp.request,
        env.request,
        request,
        env.http_request,
        http_request,
    }
    for _, candidate in ipairs(candidates) do
        if type(candidate) == "function" then return candidate end
    end
    return nil
end

-- Prefer the request function captured by Stage 2. Fall back only when an
-- executor cannot expose that reference across loaded chunks.
local HttpRequest = type(ChainEnv.MS999Request) == "function"
    and ChainEnv.MS999Request or resolveRequest()
if type(HttpRequest) ~= "function" then
    return Kick("[999MS] HTTP unavailable")
end
softFunctionAudit("request", HttpRequest)
if HookAudit.request and HookAudit.request.hooked == true then
    print("[999MS] Hook audit warning: request")
end
ChainEnv.MS999Request = HttpRequest
ChainEnv.MS999RequestAudit = HookAudit.request

local proof = {}
for _ = 1, 24 do proof[#proof + 1] = string.char(math.random(97, 122)) end
ChainEnv.MS999LoaderProof = "999MS_loader_v1:" .. table.concat(proof)
ChainEnv.MS999LoaderTime = tick()
ChainEnv.MS999LoaderMarker = "LSE_" .. tostring(math.random(100000, 999999))

if not chainIs("stage2", 45) then
    return Kick("[999MS] Chain interrupted before payload")
end
Chain.Stage = "loader"
Chain.UpdatedAt = tick()

print("[999MS] Loading payload...")
local ok, response = pcall(HttpRequest, {
    Url = BASE_URL .. "/payload.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200
    or type(response.Body) ~= "string" then
    return Kick("[999MS] Payload fetch failed")
end

local payloadSrc = response.Body
if #payloadSrc < 100 then
    return Kick("[999MS] Invalid payload")
end

local compiled, fn = pcall(SafeLoadstring, payloadSrc)
if not compiled or type(fn) ~= "function" then
    return Kick("[999MS] Payload compile failed")
end
local ran = pcall(fn)
if not ran then
    return Kick("[999MS] Payload runtime error")
end
