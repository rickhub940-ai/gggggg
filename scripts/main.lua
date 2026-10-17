


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

-- Long-lived session token: lets the realtime loop mint fresh tickets while the
-- script is running, without asking the provider to re-check the key.
local sessionToken = decoded.sessionToken
if type(sessionToken) == "string" and #sessionToken > 32 then
    getgenv().MS999SessionToken = sessionToken
end

-- Realtime is a side channel to the Render gateway: the control panel uses it to
-- list sessions and push notice / reauth / disconnect. It is kept alive on
-- purpose: a heartbeat every second, and an automatic reconnect forever, so an
-- admin command always reaches the client.
--
-- Duplicate realtime sessions are impossible: the gateway closes the older
-- socket with 4402 even when a reconnect races the previous one.
local RECONNECT_MIN = 1
local RECONNECT_MAX = 10
local HEARTBEAT_EVERY = 1

local function pickSocketConnect()
    local a = type(syn) == "table" and type(syn.websocket) == "table" and syn.websocket.connect or nil
    local b = type(WebSocket) == "table" and WebSocket.connect or nil
    local d = type(websocket) == "table" and websocket.connect or nil
    return type(a) == "function" and a or type(b) == "function" and b or type(d) == "function" and d
end

local MESSAGE_FIELDS = { "OnMessage", "MessageReceived", "OnMessageReceived", "OnEvent" }
local CLOSE_FIELDS = { "OnClose", "Closed", "OnDisconnected" }

local function socketShape(s)
    local parts = {}
    for _, name in ipairs({ "OnMessage", "MessageReceived", "OnMessageReceived", "OnEvent", "OnClose", "Closed", "OnDisconnected", "Send", "send", "SendText", "Close" }) do
        local value = s[name]
        if value ~= nil then table.insert(parts, name .. ":" .. type(value)) end
    end
    return #parts > 0 and table.concat(parts, ",") or "none"
end

local function hookSocket(s, fields, handler)
    for _, name in ipairs(fields) do
        local slot = s[name]
        if type(slot) == "table" and type(slot.Connect) == "function" then
            local ok = pcall(function() slot:Connect(handler) end)
            if ok then return true end
        elseif type(slot) == "function" then
            local ok = pcall(function() s[name] = handler end)
            if ok and s[name] == handler then return true end
        end
    end
    for _, name in ipairs(fields) do
        if type(s[name]) == "function" then
            local ok = pcall(function() s[name](s, handler) end)
            if ok then return true end
        end
    end
    return false
end

-- The server hands out short tickets; the session token lets us swap it for a
-- fresh one (and a fresh realtime token) without re-verifying the key.
local function renewSession(h, sname)
    local SessionToken = getgenv().MS999SessionToken
    if type(SessionToken) ~= "string" or #SessionToken < 32 then return nil end
    local ok, rs = pcall(req, {
        Url = BASE_URL .. "/api/session-renew",
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode({ sessionToken = SessionToken, hwid = h, scriptName = sname }),
    })
    if not ok or type(rs) ~= "table" then return nil, "renew request failed" end
    local c
    pcall(function() c = HttpService:JSONDecode(rs.Body) end)
    if type(c) ~= "table" or c.valid ~= true then
        return nil, type(c) == "table" and tostring(c.error or "renew rejected") or "renew rejected"
    end
    getgenv().MS999SessionToken = c.sessionToken or SessionToken
    getgenv().MS999Ticket = c.ticket
    return c
end

local function fetchRealtimeTicket(h, sname)
    if type(Ticket) == "string" and #Ticket > 0 then
        local ok, rs = pcall(req, {
            Url = BASE_URL .. "/api/realtime-ticket",
            Method = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body = HttpService:JSONEncode({ ticket = Ticket, hwid = h, scriptName = sname }),
        })
        if ok and type(rs) == "table" then
            local c
            pcall(function() c = HttpService:JSONDecode(rs.Body) end)
            if type(c) == "table" and c.valid == true and type(c.url) == "string" and type(c.token) == "string" then
                return c
            end
        end
    end
    -- Ticket aged out: trade the long-lived session token for a fresh one.
    local renewed = renewSession(h, sname)
    if not renewed then return nil end
    Ticket = renewed.ticket
    if type(renewed.realtime) == "table" and type(renewed.realtime.url) == "string"
        and type(renewed.realtime.token) == "string" then
        return renewed.realtime
    end
    local ok2, rs2 = pcall(req, {
        Url = BASE_URL .. "/api/realtime-ticket",
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = HttpService:JSONEncode({ ticket = Ticket, hwid = h, scriptName = sname }),
    })
    if not ok2 or type(rs2) ~= "table" then return nil end
    local c2
    pcall(function() c2 = HttpService:JSONDecode(rs2.Body) end)
    if type(c2) ~= "table" or c2.valid ~= true then return nil end
    return c2
end

local function startRealtime()
    local f = pickSocketConnect()
    if type(f) ~= "function" then
        print("[999MS] Realtime unavailable in this executor - continuing without it")
        return
    end

    local h = getHWID()
    local sname = ExpectedScript
    local stopped = false
    local failures = 0

    local function connectOnce()
        local c = fetchRealtimeTicket(h, sname)
        if not c then return false, "ticket unavailable" end

        local ok, s = pcall(f, c.url)
        if not ok or s == nil then return false, "connect failed" end

        local authenticated = false
        local closed = false
        local lastMessage = os.clock()

        local function send(v)
            local okj, encoded = pcall(function() return HttpService:JSONEncode(v) end)
            if not okj then return false end
            if type(s.Send) == "function" then return pcall(function() s:Send(encoded) end) end
            if type(s.send) == "function" then return pcall(s.send, encoded) end
            if type(s.SendText) == "function" then return pcall(s.SendText, s, encoded) end
            return false
        end

        local function onMessage(v)
            local m
            pcall(function() m = HttpService:JSONDecode(tostring(v)) end)
            if type(m) ~= "table" then return end
            lastMessage = os.clock()
            if m.type == "handshake_challenge" and type(m.id) == "string" and type(m.challenge) == "string" then
                send({ type = "handshake_response", id = m.id, challenge = m.challenge })
            elseif m.type == "authenticated" then
                authenticated = true
                failures = 0
                print("[999MS] Realtime connected")
            elseif m.type == "command" then
                if m.command == "disconnect" then
                    stopped = true
                    Kick("[999MS] " .. tostring(m.reason or "Session ended"))
                elseif m.command == "reauth" then
                    stopped = true
                    Kick("[999MS] Reauthentication required")
                elseif m.command == "notice" then
                    print("[999MS] Admin: " .. tostring(m.message or ""))
                end
            end
        end

        if not hookSocket(s, MESSAGE_FIELDS, onMessage) then
            print("[999MS] Realtime messages unsupported in this executor (" .. socketShape(s) .. ") - continuing without it")
            return false, "messages unsupported"
        end
        hookSocket(s, CLOSE_FIELDS, function() closed = true end)

        if not send({ type = "authenticate", token = c.token, hwid = h, scriptName = sname }) then
            return false, "authenticate send failed"
        end

        -- The wait loop runs until this socket closes; the outer loop then
        -- reconnects. Returns the reason so the caller can decide the backoff.
        local deadline = os.clock() + 60
        while not closed and not stopped do
            task.wait(HEARTBEAT_EVERY)
            if closed or stopped then break end
            if not authenticated then
                if os.clock() > deadline then return false, "handshake timeout" end
            else
                if os.clock() - lastMessage > 45 then return false, "idle" end
                if not send({ type = "heartbeat" }) then return false, "heartbeat failed" end
            end
        end
        return true, closed and "closed" or "stopped"
    end

    task.spawn(function()
        while not stopped do
            local ok, reason = connectOnce()
            if stopped then break end
            failures = failures + 1
            local waitFor = math.min(RECONNECT_MAX, RECONNECT_MIN + failures)
            local detail = tostring(reason)
            if failures == 1 then
                print("[999MS] Realtime link lost (" .. detail .. ") - reconnecting")
            elseif failures % 10 == 0 then
                print("[999MS] Realtime still reconnecting (" .. detail .. ") - attempt " .. tostring(failures))
            end
            if not ok and detail == "messages unsupported" then
                print("[999MS] Realtime messages unsupported in this executor - continuing without it")
                return
            end
            task.wait(waitFor)
        end
    end)
end

pcall(startRealtime)

if ChainEnv.MS999Chain == Chain then
    ChainEnv.MS999Chain = nil
end
