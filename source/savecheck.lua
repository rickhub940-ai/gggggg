-- Stage 2: detect only marked copies and hand off without blocking the client.
-- ═══ HEADER ═══ kept verbatim and outside the compacted body.
-- The one entry is the request for the next stage link; the line it forms,
-- `local gamaramam = { "<base>/<token>" }`, is also what a dumped copy of this
-- stage starts with, so it doubles as the save marker.
local gamaramam = {
    "@NEXT@"
}
-- ═══ BODY ═══ everything below is compacted at build time.
local ctx = ...
if type(ctx) ~= "table" then error("MS999:CHAIN_CONTEXT_MISSING", 0) end
local function Abort(reason)
    local stop = type(ctx) == "table" and ctx.stopChecks or nil
    if type(stop) == "function" then pcall(stop) end
    local message = "[999MS] " .. tostring(reason or "stage aborted")
    if type(warn) == "function" then warn(message) else print(message) end
    return false
end

local function KickMarker(reason)
    if reason ~= "MS_112" then return end
    local CoreGui, LocalPlayer
    pcall(function() CoreGui = game:GetService("CoreGui") end)
    pcall(function() LocalPlayer = game:GetService("Players").LocalPlayer end)
    local customTitle = "[ 999MS ]"
    local customMessage = "Reason :  " .. reason

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
    pcall(function()
        task.spawn(function()
            for index = 1, 50 do
                if patchErrorPrompt() then break end
                task.wait(0.01)
            end
        end)
    end)

    if LocalPlayer then
        pcall(function()
            if type(replicatesignal) == "function" then
                replicatesignal(LocalPlayer.StatsAvailable, "Kick")
            end
        end)
        pcall(function() LocalPlayer:Kick(reason) end)
    end
end

local BASE_URL = "@BASE_URL@"
-- A dumped copy begins with the header line above. The token after the base
-- URL is different on every run, so the comparison stops before it.
local HEAD_LINE = 'local gamaramam = { "' .. BASE_URL .. "/"
local function isValidHandoff(savedLink)
    if type(savedLink) ~= "string" or savedLink:sub(1, #HEAD_LINE) ~= HEAD_LINE then return false end
    local token = savedLink:sub(#HEAD_LINE + 1)
    local chainId, expiresAt, signature = token:match("^([a-f0-9]+)%.(%d+)%.([a-f0-9]+)$")
    return chainId ~= nil and #chainId == 32 and #expiresAt == 13 and #signature == 32
end
local function isCopy(text)
    if type(text) ~= "string" then return false end
    -- File detection remains anchored at byte zero: an embedded marker in an
    -- unrelated file is not treated as a saved stage.
    local firstLine = text:match("^[^\r\n]*") or ""
    if firstLine:sub(1, #HEAD_LINE) ~= HEAD_LINE then return false end
    local savedLink = firstLine:match('^local gamaramam = { "([^"]+)" }')
    return isValidHandoff(savedLink)
end
local function hasMarkerInTextOnce(text)
    local searchFrom = 1
    while searchFrom <= #text do
        local markerAt = text:find(HEAD_LINE, searchFrom, true)
        if not markerAt then break end
        local savedLink = text:sub(markerAt):match('^local gamaramam = { "([^"\r\n]+)" }')
        if isValidHandoff(savedLink) then return true end
        searchFrom = markerAt + #HEAD_LINE
    end
    return false
end
local function hasMarkerInText(text)
    if type(text) ~= "string" then return false end
    if hasMarkerInTextOnce(text) then return true end
    for _ = 1, 4 do
        if not text:find("\\\"", 1, true) then return false end
        local unescaped = text:gsub("\\\"", "\"")
        if unescaped == text then return false end
        text = unescaped
        if hasMarkerInTextOnce(text) then return true end
    end
    return false
end

local packValues = table.pack or function(...) return { n = select("#", ...), ... } end
local function hasMarkerInValue(value, depth, visited, budget)
    local valueType = type(value)
    if valueType == "string" then return hasMarkerInText(value) end
    if valueType ~= "table" then return false end
    if depth > 6 or budget[1] <= 0 then return true end
    if visited[value] then return false end
    visited[value] = true
    local key, item = next(value)
    while key ~= nil and budget[1] > 0 do
        budget[1] = budget[1] - 1
        if hasMarkerInValue(key, depth + 1, visited, budget)
            or hasMarkerInValue(item, depth + 1, visited, budget) then
            return true
        end
        key, item = next(value, key)
    end
    if key ~= nil then return true end
    return false
end
local function hasMarkerInArgs(args)
    local visited = {}
    local budget = { 1024 }
    for index = 1, args.n do
        if hasMarkerInValue(args[index], 0, visited, budget) then return true end
    end
    return false
end
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 60

local chain = ctx.chain
local chainId = type(chain) == "table" and chain.Id or nil
local function chainIs(stage, maxAge)
    local current = ctx.chain
    return current == chain
        and type(current) == "table"
        and current.Version == CHAIN_VERSION
        and type(current.Id) == "string"
        and current.Id == chainId
        and current.Stage == stage
        and type(current.UpdatedAt) == "number"
        and tick() - current.UpdatedAt >= 0
        and tick() - current.UpdatedAt <= maxAge
end

if not chainIs("stage1", CHAIN_TTL) then
    return Abort("[999MS] Chain rejected: run loadc.lua")
end

local RealListFiles = listfiles
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile

local function removeMarkedFiles()
    -- Do a shallow, bounded scan only. The old recursive walk over every
    -- executor directory could stall desktop clients on large file trees.
    if type(RealListFiles) ~= "function" or type(RealReadFile) ~= "function"
        or type(RealIsFile) ~= "function" then
        return false
    end

    local listed, entries = pcall(RealListFiles, ".")
    if not listed or type(entries) ~= "table" then return false end
    local matches = {}
    local limit = math.min(#entries, 64)
    for index = 1, limit do
        local path = entries[index]
        if type(path) == "string" then
            local fileOk, isFile = pcall(RealIsFile, path)
            if fileOk and isFile then
                local readOk, content = pcall(RealReadFile, path)
                if readOk and isCopy(content) then
                    matches[#matches + 1] = path
                end
            end
        end
    end

    if type(RealDelfile) == "function" then
        for _, path in ipairs(matches) do pcall(RealDelfile, path) end
    end
    return #matches > 0
end

if removeMarkedFiles() then
    KickMarker("MS_112")
    return Abort("MS_112")
end

-- Stage-local signal; this run carries state positionally, not in an executor environment.
local handlers = {}
local saved = {}
function saved:Connect(fn)
    handlers[#handlers + 1] = fn
    return { Disconnect = function() end }
end
function saved:Fire(...)
    for _, fn in ipairs(handlers) do pcall(fn, ...) end
end
local target = type(writefile) == "function" and writefile or nil
local unpackValues = table.unpack or unpack
local oldWrite
local saveConnection
local checksActive = true
local hookInstalled = false
local outboundActive = true
local markerTriggered = false
local outboundHooks = {}
local outboundSeen = {}

local function restoreOutboundHooks()
    outboundActive = false
    if type(hookfunction) ~= "function" then return end
    for index = #outboundHooks, 1, -1 do
        local hook = outboundHooks[index]
        pcall(function() hookfunction(hook.target, hook.original) end)
    end
    outboundHooks = {}
end

local function hookOutbound(targetFunction)
    if type(targetFunction) ~= "function" or outboundSeen[targetFunction] then return end
    if type(hookfunction) ~= "function" or type(newcclosure) ~= "function" then return end
    outboundSeen[targetFunction] = true
    local original
    local hookOk, previous = pcall(function()
        return hookfunction(targetFunction, newcclosure(function(...)
            if markerTriggered then return nil end
            if not outboundActive then return original(...) end
            local arguments = packValues(...)
            local scanOk, containsMarker = pcall(hasMarkerInArgs, arguments)
            if not scanOk or containsMarker then
                markerTriggered = true
                pcall(KickMarker, "MS_112")
                return nil
            end
            if type(original) ~= "function" then return nil end
            local result = packValues(pcall(original, ...))
            if not result[1] then error(result[2], 0) end
            return unpackValues(result, 2, result.n)
        end))
    end)
    if hookOk and type(previous) == "function" then
        original = previous
        outboundHooks[#outboundHooks + 1] = { target = targetFunction, original = previous }
    end
end

local function hookOutboundApis()
    local candidates = {}
    local function add(candidate)
        if type(candidate) == "function" then candidates[#candidates + 1] = candidate end
    end
    add(print)
    add(warn)
    add(rconsoleprint)
    add(rconsolewarn)
    add(request)
    add(http_request)
    add(setclipboard)
    add(toclipboard)
    add(set_clipboard)
    if type(syn) == "table" then add(syn.request) end
    if type(http) == "table" then add(http.request) end
    for _, candidate in ipairs(candidates) do hookOutbound(candidate) end

    pcall(function()
        local service = game:GetService("HttpService")
        for _, name in ipairs({ "RequestAsync", "GetAsync", "PostAsync" }) do
            hookOutbound(service[name])
        end
    end)
    pcall(function()
        for _, name in ipairs({ "HttpGet", "HttpGetAsync", "HttpPost" }) do
            hookOutbound(game[name])
        end
    end)
end

-- File and outbound monitors are best-effort: executors without hookfunction/
-- newcclosure still run. File checks stay byte-zero anchored; outbound checks
-- require a complete marker header with a valid handoff token.
if target and type(hookfunction) == "function" and type(newcclosure) == "function" then
    local hookOk, original = pcall(function()
        return hookfunction(target, newcclosure(function(path, contents, ...)
            local result = packValues(pcall(oldWrite, path, contents, ...))
            local success = result[1] and result[2] ~= false
            if success and checksActive and isCopy(contents) then
                saved:Fire({ path = tostring(path) })
            end
            if not result[1] then error(result[2], 0) end
            return unpackValues(result, 2, result.n)
        end))
    end)
    if hookOk and type(original) == "function" then
        oldWrite = original
        hookInstalled = true
    else
        checksActive = false
    end
else
    checksActive = false
end

saveConnection = saved:Connect(function(event)
    if not checksActive then return end
    checksActive = false
    ctx.sourceSaved = true
    if type(RealIsFile) == "function" and type(RealDelfile) == "function" then
        pcall(function()
            if RealIsFile(event.path) then RealDelfile(event.path) end
        end)
    end
    KickMarker("MS_112")
    Abort("MS_112")
end)

ctx.stopChecks = function()
    checksActive = false
    if saveConnection and type(saveConnection.Disconnect) == "function" then
        pcall(function() saveConnection:Disconnect() end)
    end
    if hookInstalled and type(oldWrite) == "function" and type(hookfunction) == "function" then
        pcall(function() hookfunction(target, oldWrite) end)
        hookInstalled = false
    end
    restoreOutboundHooks()
    ctx.writeMonitor = nil
    ctx.stopChecks = nil
end

hookOutboundApis()
ctx.writeMonitor = hookInstalled and target or nil


if not chainIs("stage1", 60) then
    return Abort("[999MS] Chain interrupted before Stage 3")
end
chain.Stage = "stage2"
chain.UpdatedAt = tick()

local requestCandidates = {
    type(syn) == "table" and syn.request or false,
    type(http) == "table" and http.request or false,
    type(request) == "function" and request or false,
    type(http_request) == "function" and http_request or false,
}
local requestFn
for _, candidate in ipairs(requestCandidates) do
    if type(candidate) == "function" then requestFn = candidate; break end
end
if not requestFn then return Abort("HTTP request API unavailable") end

-- The server mints the Stage-3 link while serving this stage and writes it
-- into the header table above; it is valid for ten seconds from that moment.
local nextSha = "@NEXT_SHA@"
local nextNonce = "@NONCE@"
local nextUrl = gamaramam[1]
-- "NEXT@" without the leading "@" so this guard is never itself replaced.
if type(nextUrl) ~= "string" or #nextUrl < 40 or nextUrl:find("NEXT@", 1, true) then
    return Abort("[999MS] Stage link unavailable")
end

local cryptTable = (type(syn) == "table" and syn.crypt) or crypt
local hasher = type(cryptTable) == "table" and cryptTable.hash or nil
if type(hasher) ~= "function" then
    return Abort("[999MS] Loader hash unavailable")
end

-- Same proof the server expects: the link only opens for the stage that ran
-- before it, never for a plain fetch of the URL.
local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nextNonce .. "|" .. nextUrl, "sha256")
if not okProof or type(proof) ~= "string" then
    return Abort("[999MS] Stage proof unavailable")
end

local ok, response = pcall(requestFn, {
    Url = nextUrl,
    Method = "POST",
    Headers = { ["content-type"] = "application/json" },
    Body = '{"p":"' .. proof .. '"}',
})
local status = type(response) == "table" and tonumber(response.StatusCode or response.Status) or nil
if not ok or type(response) ~= "table" or status ~= 200 then
    return Abort("[999MS] Loader fetch failed")
end

local body = response.Body or ""
if #body > 256 * 1024 then return Abort("[999MS] Loader response too large") end
local okHash, digest = pcall(hasher, body, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= nextSha then
    return Abort("[999MS] Loader integrity check failed")
end

local compiler = loadstring or load
if type(compiler) ~= "function" then return Abort("Lua compiler API unavailable") end
local compileOk, chunk = pcall(compiler, body)
if not compileOk or type(chunk) ~= "function" then
    return Abort("[999MS] Loader compile failed")
end

local runOk = pcall(chunk, ctx)
if not runOk then
    return Abort("[999MS] Loader runtime error")
end
