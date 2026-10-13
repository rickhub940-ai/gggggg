--// ═══════════════════════════════════════════════════════════
--// Luasec Script — Blox Fruits
--// ═══════════════════════════════════════════════════════════
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

if not getgenv().LuasecLoader then
    return Players.LocalPlayer:Kick("[Luasec] Must run via loader")
end

local RuntimeSecret = getgenv().LuasecSecret
local Ticket = getgenv().LuasecTicket
local ScriptToken = getgenv().LuasecToken
local LuasecScript = getgenv().LuasecScript

if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
    return Players.LocalPlayer:Kick("[Luasec] Missing runtime secret")
end
if not Ticket or not ScriptToken then
    return Players.LocalPlayer:Kick("[Luasec] Invalid session")
end
if LuasecScript ~= "bloxfruits" then
    return Players.LocalPlayer:Kick("[Luasec] Script mismatch")
end

local LoadTime = getgenv().LuasecLoadTime
if not LoadTime or (tick() - LoadTime) > 60 then
    return Players.LocalPlayer:Kick("[Luasec] Session expired")
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
    return (syn and syn.request) or (http and http.request) or request or http_request
end

local BASE_URL = "https://keysytemdemo.vercel.app"
local req = getRequest()
if not req then return Players.LocalPlayer:Kick("[Luasec] HTTP not supported") end

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/script-verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = HttpService:JSONEncode({
        ticket = Ticket,
        hwid = getHWID(),
        scriptToken = ScriptToken,
        runtimeSecret = RuntimeSecret,
        scriptName = "main",
    }),
})

if not ok or type(res) ~= "table" then
    return Players.LocalPlayer:Kick("[Luasec] Verification failed")
end

local decoded
pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
if not decoded or decoded.valid ~= true then
    return Players.LocalPlayer:Kick("[Luasec] " .. ((decoded and decoded.reason) or "Unauthorized"))
end

--// ═══════════════════════════════════════════════════════════
--// โค้ด Blox Fruits ของคุณเริ่มตรงนี้
--// ═══════════════════════════════════════════════════════════

print("[Luasec] Blox Fruits loaded!")
print("[Luasec] Session: ${SERVERID}")

-- โค้ดของคุ
