


local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer



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



    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local HttpService = game:GetService("HttpService")
local ExpectedScript = "${SCRIPTID}"
local CHAIN_VERSION = "999MS-chain-v1"

local ChainEnv = getgenv()
local Chain = ChainEnv.MS999Chain
if type(Chain) ~= "table"
    or Chain.Version ~= CHAIN_VERSION
    or type(Chain.Id) ~= "string"
    or Chain.Stage ~= "script"
    or Chain.Script ~= ExpectedScript
    or type(Chain.UpdatedAt) ~= "number"
    or tick() - Chain.UpdatedAt < 0
    or tick() - Chain.UpdatedAt > 20 then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

if not getgenv().MS999Loader then
    return Kick("[999MS] Must run via loader")
end

local RuntimeSecret = getgenv().MS999Secret
local Ticket = getgenv().MS999Ticket
local ScriptToken = getgenv().MS999Token
local MS999Script = getgenv().MS999Script

if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
    return Kick("[999MS] Missing runtime secret")
end
if not Ticket or not ScriptToken then
    return Kick("[999MS] Invalid session")
end
if MS999Script ~= ExpectedScript then
    return Kick("[999MS] Script mismatch")
end

local LoadTime = getgenv().MS999LoadTime
if not LoadTime or (tick() - LoadTime) > 60 then
    return Kick("[999MS] Session expired")
end

local function getHWID()
    if type(gethwid) == "function" then
        local ok, v = pcall(gethwid)
        if ok and type(v) == "string" and #v > 0 then return v end
    end
    local lp = Players.LocalPlayer
    return tostring(lp.UserId) .. "|" .. tostring(lp.AccountAge) .. "|" .. tostring(game.PlaceId or 0)
end

local function getRequest()
    local captured = getgenv().MS999Request
    if type(captured) == "function" then return captured end
    return (syn and syn.request) or (http and http.request) or request or http_request
end

local BASE_URL = "https://loader999mss.vercel.app"
local req = getRequest()
if not req then return Kick("[999MS] HTTP not supported") end

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/script-verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = HttpService:JSONEncode({
        ticket = Ticket,
        hwid = getHWID(),
        scriptToken = ScriptToken,
        runtimeSecret = RuntimeSecret,
        scriptName = ExpectedScript,
    }),
})

if not ok or type(res) ~= "table" then
    return Kick("[999MS] Verification failed")
end

local decoded
pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
if not decoded or decoded.valid ~= true then



    local diagnostic = decoded and decoded.diagnostic
    if type(diagnostic) ~= "string" or not diagnostic:match("^D2_[A-Z0-9_]+$") then
        diagnostic = "D2_RESPONSE_INVALID"
    end
    return Kick("[999MS] " .. diagnostic)
end

-- Realtime is a side channel: sessions show up in the control panel, and an
-- admin can push notice/reauth/disconnect. It must never take the script down
-- on a machine that has no WebSocket API, or while the free-tier gateway is
-- still cold starting (Render sleeps and can take ~45s to wake).
local function startRealtime()
    local a = type(syn) == "table" and type(syn.websocket) == "table" and syn.websocket.connect or nil
    local b = type(WebSocket) == "table" and WebSocket.connect or nil
    local d = type(websocket) == "table" and websocket.connect or nil
    local f = type(a) == "function" and a or type(b) == "function" and b or type(d) == "function" and d
    if type(f) ~= "function" then
        print("[999MS] Realtime unavailable in this executor - continuing without it")
        return
    end

    local h = getHWID()
    local ok1, rs = pcall(req, {
        Url = BASE_URL .. "/api/realtime-ticket",
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode({ ticket = Ticket, hwid = h, scriptName = ExpectedScript }),
    })
    if not ok1 or type(rs) ~= "table" then
        print("[999MS] Realtime ticket unavailable - continuing without it")
        return
    end
    local c
    pcall(function() c = HttpService:JSONDecode(rs.Body) end)
    if type(c) ~= "table" or c.valid ~= true or type(c.url) ~= "string" or type(c.token) ~= "string" then
        print("[999MS] Realtime ticket rejected - continuing without it")
        return
    end

    local ok2, s = pcall(f, c.url)
    if not ok2 or s == nil then
        print("[999MS] Realtime connect failed - continuing without it")
        return
    end

    local authenticated = false
    local lastMessage = os.clock()

    local function send(v)
        local ok, encoded = pcall(function() return HttpService:JSONEncode(v) end)
        if not ok then return false end
        if type(s.Send) == "function" then return pcall(function() s:Send(encoded) end) end
        if type(s.send) == "function" then return pcall(s.send, encoded) end
        return false
    end

    if not send({ type = "authenticate", token = c.token, hwid = h, scriptName = ExpectedScript }) then
        print("[999MS] Realtime authenticate failed - continuing without it")
        return
    end

    local q = s.OnMessage or s.MessageReceived
    if type(q) == "table" and type(q.Connect) == "function" then
        q:Connect(function(v)
            local m
            pcall(function() m = HttpService:JSONDecode(v) end)
            if type(m) ~= "table" then return end
            lastMessage = os.clock()
            if m.type == "handshake_challenge" and type(m.id) == "string" and type(m.challenge) == "string" then
                send({ type = "handshake_response", id = m.id, challenge = m.challenge })
            elseif m.type == "authenticated" then
                authenticated = true
                print("[999MS] Realtime connected")
            elseif m.type == "command" and m.command == "disconnect" then
                -- Admin action from the control panel: this one really kicks.
                Kick("[999MS] " .. tostring(m.reason or "Session ended"))
            elseif m.type == "command" and m.command == "reauth" then
                Kick("[999MS] Reauthentication required")
            end
        end)
    end

    -- No client-side timeout kick: a slow/cold gateway only costs us the side
    -- channel, never the user's session. The loop stops quietly instead.
    task.spawn(function()
        local failures = 0
        while s do
            task.wait(5)
            if not authenticated then
                if os.clock() - lastMessage > 60 then
                    print("[999MS] Realtime handshake timed out - continuing without it")
                    return
                end
            elseif os.clock() - lastMessage > 30 then
                print("[999MS] Realtime link idle - stopping heartbeat")
                return
            end
            if authenticated then
                local okHeartbeat = send({ type = "heartbeat" })
                local okStatus = okHeartbeat and send({ type = "status", stage = "script", code = "active" })
                if not okHeartbeat or not okStatus then
                    failures = failures + 1
                    if failures >= 3 then
                        print("[999MS] Realtime link lost - continuing without it")
                        return
                    end
                else
                    failures = 0
                end
            end
        end
    end)
end

pcall(startRealtime)

if ChainEnv.MS999Chain == Chain then
    ChainEnv.MS999Chain = nil
end
