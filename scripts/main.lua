--// ═══════════════════════════════════════════════════════════
--// 999MS Script — Blox Fruits
--// ═══════════════════════════════════════════════════════════
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

if not getgenv().MS999Loader then
    return Players.LocalPlayer:Kick("[999MS] Must run via loader")
end

local RuntimeSecret = getgenv().MS999Secret
local Ticket = getgenv().MS999Ticket
local ScriptToken = getgenv().MS999Token
local MS999Script = getgenv().MS999Script
local ExpectedScript = "${SCRIPTID}"

if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
    return Players.LocalPlayer:Kick("[999MS] Missing runtime secret")
end
if not Ticket or not ScriptToken then
    return Players.LocalPlayer:Kick("[999MS] Invalid session")
end
if MS999Script ~= ExpectedScript then
    return Players.LocalPlayer:Kick("[999MS] Script mismatch")
end

local LoadTime = getgenv().MS999LoadTime
if not LoadTime or (tick() - LoadTime) > 60 then
    return Players.LocalPlayer:Kick("[999MS] Session expired")
end

local function getHWID()
    if type(gethwid) == "function" then
        local ok, v = pcall(gethwid)
        if ok and type(v) == "string" and #v > 0 then return v end
    end
    local lp = Players.LocalPlayer
    return tostring(lp.UserId) .. "|" .. tostring(lp.AccountAge) .. "|" .. tostring(game.PlaceId or 0)
end

local function getRequest()
    local captured = getgenv().MS999Request
    if type(captured) == "function" then return captured end
    return (syn and syn.request) or (http and http.request) or request or http_request
end

local BASE_URL = "https://keysytemdemo.vercel.app"
local req = getRequest()
if not req then return Players.LocalPlayer:Kick("[999MS] HTTP not supported") end

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/script-verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = HttpService:JSONEncode({
        ticket = Ticket,
        hwid = getHWID(),
        scriptToken = ScriptToken,
        runtimeSecret = RuntimeSecret,
        scriptName = ExpectedScript,
    }),
})

if not ok or type(res) ~= "table" then
    return Players.LocalPlayer:Kick("[999MS] Verification failed")
end

local decoded
pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
if not decoded or decoded.valid ~= true then
    return Players.LocalPlayer:Kick("[999MS] " .. ((decoded and decoded.reason) or "Unauthorized"))
end

--// ═══════════════════════════════════════════════════════════
--// โค้ด Blox Fruits ของคุณเริ่มตรงนี้
--// ═══════════════════════════════════════════════════════════

print("[999MS] Blox Fruits loaded!")
print("[999MS] Session: ${SERVERID}")

-- โค้ดของคุ
