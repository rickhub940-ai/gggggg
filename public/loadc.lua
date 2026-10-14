-- Stage 1 is the only public entry point. It starts a short-lived chain mark
-- that Stage 2, Stage 3, payload, and the protected script must consume in
-- order. Authorization ticket issuance remains after key verification.
local BASE_URL = "https://keysytemdemo.vercel.app"
local STAGE2_PATH = "/savecheck.lua"
local STAGE2_URL = BASE_URL .. STAGE2_PATH
local HASH_ALGORITHM = "sha256"
local STAGE2_SHA256 = "fd62bbf265173dc10e477f7e72ffe422d5776b2c12ca7b0bc1e4fe6d15434c57"
local CHAIN_VERSION = "999MS-chain-v1"

if not game:IsLoaded() then game.Loaded:Wait() end

local environment = (getgenv and getgenv()) or _G
local chainId = ""
for _ = 1, 32 do
    chainId = chainId .. string.char(math.random(97, 122))
end
local now = tick()
environment.MS999Chain = {
    Version = CHAIN_VERSION,
    Id = chainId,
    Stage = "stage1",
    UpdatedAt = now,
}

local fetched, source = pcall(function()
    return game:HttpGet(STAGE2_URL)
end)
if not fetched or type(source) ~= "string" or source == "" then
    environment.MS999Chain = nil
    error("Stage 2 artifact unavailable", 0)
end

local cryptApi = environment and environment.crypt
if type(cryptApi) ~= "table" and type(_G) == "table" then
    cryptApi = _G.crypt
end
local hash = type(cryptApi) == "table" and cryptApi.hash or nil
if type(hash) ~= "function" then
    environment.MS999Chain = nil
    error("Stage 2 integrity support unavailable", 0)
end

local hashed, digest = pcall(hash, source, HASH_ALGORITHM)
if not hashed or type(digest) ~= "string" or string.lower(digest) ~= STAGE2_SHA256 then
    environment.MS999Chain = nil
    error("Stage 2 artifact integrity failed", 0)
end

local compile = loadstring or load
if type(compile) ~= "function" then
    environment.MS999Chain = nil
    error("Stage 2 compiler unavailable", 0)
end

local stage2, compileError = compile(source)
if type(stage2) ~= "function" then
    environment.MS999Chain = nil
    error(compileError or "Stage 2 artifact compile failed", 0)
end

return stage2()
