-- Stage 1 is public bootstrap only. The authorization ticket is issued later
-- by /api/verify, after Platoboost has accepted the user's key.
local BASE_URL = "https://keysytemdemo.vercel.app"
local STAGE2_PATH = "/savecheck.lua"
local STAGE2_URL = BASE_URL .. STAGE2_PATH
local HASH_ALGORITHM = "sha256"
local STAGE2_SHA256 = "5a8bf980304d2a5652a05a00560c5d5d54231d18572a0de3b5e6ea0e4f762d8b"

if not game:IsLoaded() then game.Loaded:Wait() end

local fetched, source = pcall(function()
    return game:HttpGet(STAGE2_URL)
end)
if not fetched or type(source) ~= "string" or source == "" then
    error("Stage 2 artifact unavailable", 0)
end

local environment = (getgenv and getgenv()) or _G
local cryptApi = environment and environment.crypt
if type(cryptApi) ~= "table" and type(_G) == "table" then
    cryptApi = _G.crypt
end
local hash = type(cryptApi) == "table" and cryptApi.hash or nil
if type(hash) ~= "function" then
    error("Stage 2 integrity support unavailable", 0)
end

local hashed, digest = pcall(hash, source, HASH_ALGORITHM)
if not hashed or type(digest) ~= "string" or string.lower(digest) ~= STAGE2_SHA256 then
    error("Stage 2 artifact integrity failed", 0)
end

local compile = loadstring or load
if type(compile) ~= "function" then
    error("Stage 2 compiler unavailable", 0)
end

local stage2, compileError = compile(source)
if type(stage2) ~= "function" then
    error(compileError or "Stage 2 artifact compile failed", 0)
end

return stage2()
