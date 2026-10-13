-- ===========================================================
-- Luasec LoadC — monitor writefile before loading loader.lua
-- Uses the same Signal.new + hookfunction flow as X.lua.
-- ===========================================================
local Players = game:GetService("Players")
local BASE_URL = "https://keysytemdemo.vercel.app"

local env = getgenv()
if type(env.Signal) ~= "table" or type(env.Signal.new) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] Signal.new unavailable")
end
if type(env.writefile) ~= "function" or type(hookfunction) ~= "function"
    or type(newcclosure) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] Write monitor unavailable")
end

local saved = env.Signal.new()
local target = env.writefile
local RealIsFile = isfile
local RealDelfile = delfile
local oldWrite

oldWrite = hookfunction(target, newcclosure(function(path, contents, ...)
    local result = table.pack(pcall(oldWrite, path, contents, ...))
    local success = result[1] and result[2] ~= false

    if success then
        saved:Fire({
            api = "writefile",
            path = tostring(path),
            bytes = typeof(contents) == "string" and #contents or nil,
        })
    end

    if not result[1] then
        error(result[2], 0)
    end
    return table.unpack(result, 2, result.n)
end))

-- This is intentionally the X.lua event flow. The only behavioral change from
-- the supplied file is replacing print(...) with cleanup and termination.
saved:Connect(function(event)
    if type(RealIsFile) == "function" and type(RealDelfile) == "function" then
        pcall(function()
            if RealIsFile(event.path) then
                RealDelfile(event.path)
            end
        end)
    end

    pcall(function()
        Players.LocalPlayer:Kick("[Luasec] Source save detected: " .. tostring(event.path))
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

-- Let loader.lua and payload.lua recognize this monitor as the monitor that
-- LoadC itself registered.
getgenv().LuasecWriteMonitor = target

local requestFn = (syn and syn.request) or (http and http.request) or request or http_request
if type(requestFn) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] HTTP not supported")
end

local ok, response = pcall(requestFn, {
    Url = BASE_URL .. "/loader.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Players.LocalPlayer:Kick("[Luasec] Loader fetch failed")
end

local source = response.Body or ""
if #source < 100 then
    return Players.LocalPlayer:Kick("[Luasec] Invalid loader")
end

local chunk = loadstring(source)
if type(chunk) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] Loader compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return Players.LocalPlayer:Kick("[Luasec] Loader runtime error")
end
