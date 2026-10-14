-- Stage 1 is the only public entry point. It starts a short-lived chain mark
-- that Stage 2, Stage 3, payload, and the protected script must consume in
-- order. Authorization ticket issuance remains after key verification.
local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer

-- Display an opaque local reference rather than exposing a human-readable
-- client-side check reason in Roblox's error prompt.
local function makeKickCode(reason)
    local text = tostring(reason or "unknown")
    local hash = 5381
    for index = 1, #text do
        hash = (hash * 33 + text:byte(index) + index) % 2147483647
    end
    return string.format("MS9-%08X", hash)
end

local function patchErrorPrompt(code)
    local success, changed = pcall(function()
        local root = CoreGui:FindFirstChild("RobloxPromptGui")
        local overlay = root and root:FindFirstChild("promptOverlay")
        local prompt = overlay and overlay:FindFirstChild("ErrorPrompt")
        local titleFrame = prompt and prompt:FindFirstChild("TitleFrame")
        local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
        local messageArea = prompt and prompt:FindFirstChild("MessageArea")
        local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
        local label = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
        if not title or not label then return false end
        title.Text = "[999MS]"
        label.Text = "Session terminated.\nReference: " .. code
        return true
    end)
    return success and changed
end

local function Kick(reason)
    local code = makeKickCode(reason)
    pcall(function()
        CoreGui.ChildAdded:Connect(function(child)
            if child.Name == "RobloxPromptGui" then
                task.spawn(function()
                    task.wait(0.01)
                    patchErrorPrompt(code)
                end)
            end
        end)
    end)
    task.spawn(function()
        for _ = 1, 50 do
            if patchErrorPrompt(code) then break end
            task.wait(0.01)
        end
    end)
    -- Best-effort executor signal trigger requested for compatible executors.
    -- It is not a portable disconnect primitive, so LocalPlayer:Kick remains
    -- the fail-closed fallback that actually enforces the disconnect.
    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local BASE_URL = "https://keysytemdemo.vercel.app"
local STAGE2_PATH = "/savecheck.lua"
local STAGE2_URL = BASE_URL .. STAGE2_PATH
local HASH_ALGORITHM = "sha256"
local STAGE2_SHA256 = "e52b42e8c3ab1129798721cbe68ab034d7fe944a9f296fc385ca51a316b707c0"
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
    return Kick("stage1-artifact-unavailable")
end

local cryptApi = environment and environment.crypt
if type(cryptApi) ~= "table" and type(_G) == "table" then
    cryptApi = _G.crypt
end
local hash = type(cryptApi) == "table" and cryptApi.hash or nil
if type(hash) ~= "function" then
    environment.MS999Chain = nil
    return Kick("stage1-integrity-support-unavailable")
end

local hashed, digest = pcall(hash, source, HASH_ALGORITHM)
if not hashed or type(digest) ~= "string" or string.lower(digest) ~= STAGE2_SHA256 then
    environment.MS999Chain = nil
    return Kick("stage1-artifact-integrity-failed")
end

local compile = loadstring or load
if type(compile) ~= "function" then
    environment.MS999Chain = nil
    return Kick("stage1-compiler-unavailable")
end

local stage2, compileError = compile(source)
if type(stage2) ~= "function" then
    environment.MS999Chain = nil
    return Kick("stage1-artifact-compile-failed:" .. tostring(compileError or "unknown"))
end

return stage2()
