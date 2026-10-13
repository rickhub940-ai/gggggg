-- Super_boom
-- Luasec stage 2: remove dumped copies of this checker, then terminate.
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

    local marker = "-- Super_boom"
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
    return Players.LocalPlayer:Kick("[Luasec] Source save detected")
end

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

local chunk = loadstring(response.Body or "")
if type(chunk) ~= "function" then
    return Players.LocalPlayer:Kick("[Luasec] Loader compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return Players.LocalPlayer:Kick("[Luasec] Loader runtime error")
end
