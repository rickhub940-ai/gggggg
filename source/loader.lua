-- ===========================================================
-- Stage 3: verify the chain, then hand off to Stage 4.
local gamaramam = {
    "@NEXT@"
}
-- ═══ BODY ═══ everything below is compacted at build time.
-- 999MS Bootstrap: essential chain and payload hand-off only.
-- ===========================================================
local function Kick(reason)
    local message = tostring(reason or "[999MS] Runtime error")
    local coreGui
    pcall(function() coreGui = game:GetService("CoreGui") end)

    local function patchPrompt()
        pcall(function()
            local promptGui = coreGui and coreGui:FindFirstChild("RobloxPromptGui")
            local overlay = promptGui and promptGui:FindFirstChild("promptOverlay")
            local prompt = overlay and overlay:FindFirstChild("ErrorPrompt")
            local titleFrame = prompt and prompt:FindFirstChild("TitleFrame")
            local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
            local messageArea = prompt and prompt:FindFirstChild("MessageArea")
            local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
            local text = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
            if title and text then
                title.Text = "[ 999MS ]"
                text.Text = "You have been kicked by this experience or its moderators. Moderation message:\n\n" .. message
            end
        end)
    end

    pcall(function()
        if coreGui then
            coreGui.ChildAdded:Connect(function(child)
                if child.Name == "RobloxPromptGui" then
                    task.wait(0.01)
                    patchPrompt()
                end
            end)
        end
    end)
    pcall(function()
        task.spawn(function()
            for _ = 1, 50 do
                patchPrompt()
                task.wait(0.01)
            end
        end)
    end)

    local player
    pcall(function() player = game:GetService("Players").LocalPlayer end)
    if player then
        pcall(function()
            if type(replicatesignal) == "function" then
                replicatesignal(player.StatsAvailable, "Kick")
            end
        end)
        pcall(function() player:Kick(message) end)
    end
    return false
end

local function Run(ctx)
if type(ctx) ~= "table" then return Kick("MS999:CHAIN_CONTEXT_MISSING") end
local function Abort(reason, detail)
    local stop = type(ctx) == "table" and ctx.stopChecks or nil
    if type(stop) == "function" then pcall(stop) end
    local message = "[999MS] " .. tostring(reason or "stage aborted")
    if type(detail) == "string" and detail ~= "" then message = message .. ": " .. detail end
    pcall(Kick, reason or "stage aborted")
    if type(warn) == "function" then warn(message) else print(message) end
    return false
end

if ctx.sourceSaved then return Abort("MS_112") end

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 60

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
    return Abort("[999MS] Chain rejected: run loadc.lua")
end

-- The script name arrived as a positional local from Stage 1.
local userScript = ctx.scriptName
if type(userScript) ~= "string" or #userScript < 1 or #userScript > 64
    or not userScript:match("^[%w_%-]+$") then
    return Abort("[999MS] Invalid script argument")
end

local SCRIPT_NAME = userScript
local SCRIPT_NAME_LOCKED = SCRIPT_NAME

print("[999MS] Bootstrap started")

-- Keep only the APIs required to fetch and compile the next stage.
local SafeLoadstring = loadstring or load
if type(SafeLoadstring) ~= "function" then
    return Abort("loadstring API unavailable")
end

local requestCandidates = {
    type(syn) == "table" and syn.request or false,
    type(http) == "table" and http.request or false,
    type(request) == "function" and request or false,
    type(http_request) == "function" and http_request or false,
}
local RealHttpRequest
for _, candidate in ipairs(requestCandidates) do
    if type(candidate) == "function" then RealHttpRequest = candidate; break end
end
if not RealHttpRequest then return Abort("HTTP request API unavailable") end

local HttpRequest = RealHttpRequest
ctx.request = RealHttpRequest

if not chainIs("stage2", 60) then
    return Abort("[999MS] Chain interrupted before payload")
end
Chain.Stage = "loader"
Chain.UpdatedAt = tick()

print("[999MS] Loader ready")

-- ═══ โหลด payload ═══
print("[999MS] Fetching payload...")
-- Stage 4 link: minted by the server while serving this stage, held in the
-- header table so the marker and the hand-off live in one place.
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
    return Abort("[999MS] Payload hash unavailable")
end

-- The last link only opens for this stage's own proof, not for a plain fetch.
local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nextNonce .. "|" .. nextUrl, "sha256")
if not okProof or type(proof) ~= "string" then
    return Abort("[999MS] Stage proof unavailable")
end

local ok, response = pcall(HttpRequest, {
    Url = nextUrl,
    Method = "POST",
    Headers = { ["content-type"] = "application/json" },
    Body = '{"p":"' .. proof .. '"}',
})
local status = type(response) == "table" and tonumber(response.StatusCode or response.Status) or nil
if not ok or type(response) ~= "table" or status ~= 200 then
    return Abort("[999MS] Payload fetch failed")
end

local payloadSrc = response.Body or ""
if #payloadSrc < 100 or #payloadSrc > 512 * 1024 then
    return Abort("[999MS] Invalid payload size")
end
local okHash, digest = pcall(hasher, payloadSrc, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= nextSha then
    return Abort("[999MS] Payload integrity check failed")
end

print("[999MS] Payload received, running...")

Chain.Stage = "loader"
Chain.UpdatedAt = tick()
local compileOk, fn = pcall(SafeLoadstring, payloadSrc)
if not compileOk or type(fn) ~= "function" then return Abort("[999MS] Load failed") end
local runOk, payloadResult = pcall(fn, ctx)
if not runOk then
    -- Preserve the reference code and show a redacted short error so an
    -- executor-specific startup failure can be diagnosed without exposing keys.
    local detail = tostring(payloadResult):gsub("[%c]", " ")
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
    return Abort("[999MS] Runtime error", detail)
end
if payloadResult == false then return Abort("[999MS] Payload aborted") end
end

local ok, result = pcall(Run, ...)
if not ok then return Kick("[999MS] Runtime error") end
return result
