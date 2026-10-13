-- ===========================================================
-- Luasec LoadC — write monitor before loading loader.lua
-- ===========================================================
local Players = game:GetService("Players")

local BASE_URL = "https://keysytemdemo.vercel.app"

local function createSignal()
    local signal = {}
    local connections = {}
    local nextId = 0

    function signal:Connect(fn)
        if type(fn) ~= "function" then return { Disconnect = function() end } end
        nextId = nextId + 1
        local id = nextId
        connections[id] = fn
        return { Disconnect = function() connections[id] = nil end }
    end

    function signal:Fire(...)
        for _, fn in pairs(connections) do
            pcall(fn, ...)
        end
    end

    return signal
end

local LuasecSignal = {
    OnDetect = createSignal(),
    OnKick = createSignal(),
    OnLog = createSignal(),
    OnHookDetected = createSignal(),
}
getgenv().LuasecSignal = LuasecSignal

local function terminate(reason)
    pcall(function()
        Players.LocalPlayer:Kick("[Luasec] " .. tostring(reason))
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end

LuasecSignal.OnDetect:Connect(function(event)
    if event.type ~= "payload_save" then return end

    -- The monitor is called before the original writefile. This cleanup also
    -- removes an older file if the attempted path already exists.
    if type(delfile) == "function" and type(event.path) == "string" then
        pcall(delfile, event.path)
    end
    terminate("Source save blocked: " .. tostring(event.path))
end)

local RealWriteFile = writefile
local RealHookFunction = hookfunction
local RealNewCClosure = newcclosure
if type(RealWriteFile) ~= "function"
    or type(RealHookFunction) ~= "function"
    or type(RealNewCClosure) ~= "function" then
    return terminate("Write monitor unavailable")
end

local originalWrite
local installed = pcall(function()
    originalWrite = RealHookFunction(RealWriteFile, RealNewCClosure(function(path, contents, ...)
        LuasecSignal.OnDetect:Fire({
            type = "payload_save",
            api = "writefile",
            path = tostring(path),
            size = typeof(contents) == "string" and #contents or nil,
        })
        error("[Luasec] writefile blocked", 0)
    end))
end) and type(originalWrite) == "function"

if not installed then
    return terminate("Write monitor installation failed")
end

-- The loader and payload recognize this monitor as the one installed by LoadC.
getgenv().LuasecWriteMonitor = RealWriteFile

local requestFn = (syn and syn.request) or (http and http.request) or request or http_request
if type(requestFn) ~= "function" then
    return terminate("HTTP not supported")
end

local ok, response = pcall(requestFn, {
    Url = BASE_URL .. "/loader.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return terminate("Loader fetch failed")
end

local source = response.Body or ""
if #source < 100 then
    return terminate("Invalid loader")
end

local chunk = loadstring(source)
if type(chunk) ~= "function" then
    return terminate("Loader compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return terminate("Loader runtime error")
end
