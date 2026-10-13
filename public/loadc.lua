local c = {
    "https://keysytemdemo.vercel.app",
    "/savecheck.lua",
    "stage-two",
    "sha256",
    true,
}
local u = "https://keysytemdemo.vercel.app/savecheck.lua"
local d = "58960fed9542341fc1d7d1e0ef41a87fccb971c0a43bcf397bebc7ccc64acd84"

if not game:IsLoaded() then game.Loaded:Wait() end

local q, s = pcall(function()
    return game:HttpGet(u)
end)
if not q or type(s) ~= "string" or s == "" then
    error("Stage 2 artifact unavailable", 0)
end

local e = (getgenv and getgenv()) or _G
local x = e and e.crypt or crypt
local k, h = pcall(type(x) == "table" and x.hash or nil, s, "sha256")
if not k or type(h) ~= "string" or string.lower(h) ~= d then
    error("Stage 2 artifact integrity failed", 0)
end

local l = loadstring or load
local f, r = l(s)
if type(f) ~= "function" then
    error(r or "Stage 2 artifact compile failed", 0)
end

return f(c)
