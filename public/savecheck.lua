-- supper_Boom
-- Stage 2: remove dumped copies of this checker, then terminate.
local Players = game:GetService("Players")
local BASE_URL = "https://keysytemdemo.vercel.app"

local RealListFiles = listfiles
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile

local function removeMarkedFiles()
    if type(RealListFiles) ~= "function" or type(RealReadFile) ~= "function"
        or type(RealDelfile) ~= "function" then
        return false
    end

    local marker = "-- supper_Boom"
    local pending = { "." }
    local seen = {}
    local matches = {}

    while #pending > 0 do
        local folder = table.remove(pending)
        if not seen[folder] then
            seen[folder] = true
            local listed, entries = pcall(RealListFiles, folder)
            if listed and type(entries) == "table" then
                for _, entry in ipairs(entries) do
                    if not seen[entry] then
                        local fileCheck, isFile = false, false
                        if type(RealIsFile) == "function" then
                            fileCheck, isFile = pcall(RealIsFile, entry)
                        end

                        local readOk, content = false, nil
                        if not fileCheck or isFile then
                            readOk, content = pcall(RealReadFile, entry)
                            if readOk and type(content) == "string"
                                and content:find(marker, 1, true) then
                                table.insert(matches, entry)
                            end
                        end

                        if not isFile and not readOk then
                            table.insert(pending, entry)
                        end
                    end
                end
            end
        end
    end

    if #matches == 0 then return false end

    for _, path in ipairs(matches) do
        pcall(RealDelfile, path)
    end
    return true
end

if removeMarkedFiles() then
    return Players.LocalPlayer:Kick("[999MS] Source save detected")
end

-- Use the same Signal.new + hookfunction write detector as X.lua for files
-- created after this stage has started.
local env = getgenv()
if type(env.Signal) ~= "table" or type(env.Signal.new) ~= "function" then
    return Players.LocalPlayer:Kick("[999MS] Signal.new unavailable")
end
if type(env.writefile) ~= "function" or type(hookfunction) ~= "function"
    or type(newcclosure) ~= "function" then
    return Players.LocalPlayer:Kick("[999MS] Write monitor unavailable")
end

local saved = env.Signal.new()
local target = env.writefile
local oldWrite
local saveConnection

env.MS999ChecksActive = true

oldWrite = hookfunction(target, newcclosure(function(path, contents, ...)
    local result = table.pack(pcall(oldWrite, path, contents, ...))
    local success = result[1] and result[2] ~= false

    if success and env.MS999ChecksActive ~= false then
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

saveConnection = saved:Connect(function(event)
    if env.MS999ChecksActive == false then return end

    if type(RealIsFile) == "function" and type(RealDelfile) == "function" then
        pcall(function()
            if RealIsFile(event.path) then
                RealDelfile(event.path)
            end
        end)
    end

    pcall(function()
        Players.LocalPlayer:Kick("[999MS] Source save detected: " .. tostring(event.path))
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

-- Called by the UI on close and after a successful main-script launch. The
-- hook itself cannot be safely removed across executors, so it is made inert
-- and its signal subscription is disconnected.
env.MS999StopChecks = function()
    env.MS999ChecksActive = false
    if saveConnection and type(saveConnection.Disconnect) == "function" then
        pcall(function() saveConnection:Disconnect() end)
    end
    env.MS999WriteMonitor = nil
    env.MS999StopChecks = nil
end

-- Stage 3 recognizes this stage-owned writefile hook as trusted.
env.MS999WriteMonitor = target

local requestFn = (syn and syn.request) or (http and http.request) or request or http_request
if type(requestFn) ~= "function" then
    return Players.LocalPlayer:Kick("[999MS] HTTP not supported")
end

local ok, response = pcall(requestFn, {
    Url = BASE_URL .. "/loader.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Players.LocalPlayer:Kick("[999MS] Loader fetch failed")
end

local chunk = loadstring(response.Body or "")
if type(chunk) ~= "function" then
    return Players.LocalPlayer:Kick("[999MS] Loader compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return Players.LocalPlayer:Kick("[999MS] Loader runtime error")
end
