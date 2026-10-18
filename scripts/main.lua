


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
    return Abort("[999MS] Executor HWID getter unavailable")
end

local req = I
if type(req) ~= "function" then return Abort("[999MS] HTTP not supported") end
local BASE_URL = "https://loader999mss.vercel.app"
local CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function SplitDevice(value)
    value = string.lower((value:match("^%s*(.-)%s*$")))
    local encoded = ""
    for index = 1, #value, 3 do
        local a, b, c = value:byte(index, index + 2)
        a, b, c = a or 0, b or 0, c or 0
        local number = bit32.lshift(a, 16) + bit32.lshift(b, 8) + c
        local x = bit32.rshift(number, 18) % 64
        local y = bit32.rshift(number, 12) % 64
        local z = bit32.rshift(number, 6) % 64
        local w = number % 64
        encoded = encoded .. CHARSET:sub(x + 1, x + 1) .. CHARSET:sub(y + 1, y + 1)
        if index + 1 > #value then
            encoded = encoded .. "=="
        elseif index + 2 > #value then
            encoded = encoded .. CHARSET:sub(z + 1, z + 1) .. "="
        else
            encoded = encoded .. CHARSET:sub(z + 1, z + 1) .. CHARSET:sub(w + 1, w + 1)
        end
    end
    local parts = {}
    for index = 1, 5 do
        local first = math.floor((index - 1) * #encoded / 5) + 1
        local last = math.floor(index * #encoded / 5)
        parts[string.char(97 + index)] = encoded:sub(first, last)
    end
    return parts
end
local headers = { ["Content-Type"] = "application/json" }
local body = {
    p = "x9",
    a = Ticket,
    g = ExpectedScript,
    q = E or "",
    s = RuntimeSecret,
    t = ScriptToken,
}
for key, value in pairs(SplitDevice(HWID)) do body[key] = value end

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/q",
    Method = "POST",
    Headers = headers,
    Body = HttpService:JSONEncode(body),
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
