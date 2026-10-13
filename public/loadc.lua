local Players = game:GetService("Players")
local BASE_URL = "https://keysytemdemo.vercel.app"
local requestFn = (syn and syn.request) or (http and http.request) or request or http_request

if type(requestFn) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] HTTP not supported")
end

local ok, response = pcall(requestFn, {
    Url = BASE_URL .. "/savecheck.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Players.LocalPlayer:Kick("[Luasec] Check fetch failed")
end

local chunk = loadstring(response.Body or "")
if type(chunk) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] Check compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return Players.LocalPlayer:Kick("[Luasec] Check runtime error")
end
