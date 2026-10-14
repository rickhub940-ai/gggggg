local c = {
    "https://keysytemdemo.vercel.app",
    "/savecheck.lua",
    "stage-two",
    "sha256",
    true,
}
local u = "https://keysytemdemo.vercel.app/savecheck.lua"
local d = "5a8bf980304d2a5652a05a00560c5d5d54231d18572a0de3b5e6ea0e4f762d8b"

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
