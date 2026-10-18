


local function Abort(reason)
    local message = "[999MS] " .. tostring(reason or "verification aborted")
    if type(warn) == "function" then warn(message) else print(message) end
    return false
end

local HttpService = game:GetService("HttpService")
local ExpectedScript = "${SCRIPTID}"
local CHAIN_VERSION = "999MS-chain-v1"
local A, B, C, D, E, F, G, H, I, J, K = ...

if A ~= true then return Abort("[999MS] Must run via loader") end
local Context = K
local Chain = J
if type(Context) ~= "table"
    or type(Chain) ~= "table"
    or Context.chain ~= Chain
    or Chain.Version ~= CHAIN_VERSION
    or type(Chain.Id) ~= "string"
    or Chain.Stage ~= "script"
    or Chain.Script ~= ExpectedScript
    or type(Chain.UpdatedAt) ~= "number"
    or tick() - Chain.UpdatedAt < 0
    or tick() - Chain.UpdatedAt > 20 then
    return Abort("[999MS] Chain rejected: run loadc.lua")
end

local RuntimeSecret = D
local Ticket = B
local ScriptToken = C
local MS999Script = F
local LoadTime = G

if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
    return Abort("[999MS] Missing runtime secret")
end
if type(Ticket) ~= "string" or Ticket == ""
    or type(ScriptToken) ~= "string" or ScriptToken == "" then
    return Abort("[999MS] Invalid session")
end
if MS999Script ~= ExpectedScript then
    return Abort("[999MS] Script mismatch")
end

if type(LoadTime) ~= "number" or tick() - LoadTime < 0 or (tick() - LoadTime) > 60 then
    return Abort("[999MS] Session expired")
end

local HWID = H
if type(HWID) ~= "string" or #HWID < 4 or #HWID > 512 then
    return Abort("[999MS] Device context invalid")
end

local req = I
if type(req) ~= "function" then return Abort("[999MS] HTTP not supported") end
local BASE_URL = "https://loader999mss.vercel.app"

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/script-verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json", ["x-ms999-hwid"] = HWID },
    Body = HttpService:JSONEncode({
        ticket = Ticket,
        hwid = HWID,
        scriptToken = ScriptToken,
        runtimeSecret = RuntimeSecret,
        scriptName = ExpectedScript,
        hop = E or "",
    }),
})

if not ok or type(res) ~= "table" then
    return Abort("[999MS] Verification failed")
end
if type(res.Body) ~= "string" or #res.Body > 2 * 1024 * 1024 then
    return Abort("[999MS] Invalid verification response")
end

local decoded
pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
if not decoded or decoded.valid ~= true then



    local diagnostic = decoded and decoded.diagnostic
    if type(diagnostic) ~= "string" or not diagnostic:match("^D2_[A-Z0-9_]+$") then
        diagnostic = "D2_RESPONSE_INVALID"
    end
    return Abort("[999MS] " .. diagnostic)
end
if Context.chain == Chain then
    Context.chain = nil
end
