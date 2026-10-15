






local SDK = {
    Version = "1.0.0",
    ChallengeTransforms = {
        { multiplier = 2, offset = -32 },
        { multiplier = 5, offset = 256 },
        { multiplier = 3, offset = -17 },
        { multiplier = 7, offset = 19 },
        { multiplier = 11, offset = -101 },
    },
}

local Client = {}
Client.__index = Client

local Charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function isFinite(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function isInteger(value)
    return isFinite(value) and value % 1 == 0
end

local function isSafeInteger(value)
    return isInteger(value) and math.abs(value) <= 9007199254740991
end

local function isValidScriptName(value)
    return type(value) == "string" and #value >= 1 and #value <= 64 and value:match("^[%w_-]+$") ~= nil
end

local function getGlobalEnv()
    local getter = rawget(_G, "getgenv")
    if type(getter) == "function" then
        local ok, env = pcall(getter)
        if ok and type(env) == "table" then return env end
    end
    return _G
end

local function split(str, separator)
    local parts = {}
    for part in string.gmatch(str, "([^" .. separator .. "]+)") do
        table.insert(parts, part)
    end
    return parts
end

local function xorBytes(data, key)
    if type(data) ~= "string" or type(key) ~= "string" or #key == 0 then
        return nil, "invalid protected payload key"
    end
    if type(bit32) ~= "table" or type(bit32.bxor) ~= "function" then
        return nil, "bit32 support is required"
    end

    local out = {}
    for index = 1, #data do
        out[index] = string.char(bit32.bxor(data:byte(index), key:byte(((index - 1) % #key) + 1)))
    end
    return table.concat(out)
end

local function base64Encode(data)
    local out = {}
    for index = 1, #data, 3 do
        local a, b, c = data:byte(index, index + 2)
        a, b, c = a or 0, b or 0, c or 0
        local number = bit32.lshift(a, 16) + bit32.lshift(b, 8) + c
        local p1 = bit32.rshift(number, 18) % 64
        local p2 = bit32.rshift(number, 12) % 64
        local p3 = bit32.rshift(number, 6) % 64
        local p4 = number % 64
        local encoded = Charset:sub(p1 + 1, p1 + 1) .. Charset:sub(p2 + 1, p2 + 1)
        if index + 1 > #data then
            encoded = encoded .. "=="
        elseif index + 2 > #data then
            encoded = encoded .. Charset:sub(p3 + 1, p3 + 1) .. "="
        else
            encoded = encoded .. Charset:sub(p3 + 1, p3 + 1) .. Charset:sub(p4 + 1, p4 + 1)
        end
        table.insert(out, encoded)
    end
    return table.concat(out)
end

local function base64Decode(data)
    if type(data) ~= "string" then return nil, "invalid base64" end
    data = data:gsub("-", "+"):gsub("_", "/")
    while #data % 4 ~= 0 do data = data .. "=" end

    local out, buffer, bits = {}, 0, 0
    for index = 1, #data do
        local char = data:sub(index, index)
        if char ~= "=" then
            local found = Charset:find(char, 1, true)
            if not found then return nil, "invalid base64" end
            buffer = bit32.lshift(buffer, 6) + (found - 1)
            bits = bits + 6
            if bits >= 8 then
                bits = bits - 8
                table.insert(out, string.char(bit32.rshift(buffer, bits) % 256))
            end
        end
    end
    return table.concat(out)
end

local function validateRng(rng)
    if type(rng) ~= "table" then return nil, "rng challenge missing" end
    local names = { "Rng1", "Rng2", "Rng3", "Rng4", "Rng5" }
    for _, name in ipairs(names) do
        if not isSafeInteger(rng[name]) then return nil, "rng integer invalid" end
    end
    if not isFinite(rng.RngFloat) or isInteger(rng.RngFloat) then
        return nil, "rng float invalid"
    end
    return true
end

local function normalizeResponse(httpService, response)
    if type(response) ~= "table" then return nil, "invalid HTTP response" end
    local status = response.StatusCode or response.Status
    local body = response.Body
    if type(status) ~= "number" or type(body) ~= "string" then
        return nil, "malformed HTTP response"
    end

    local decoded
    local ok = pcall(function()
        decoded = httpService:JSONDecode(body)
    end)
    if not ok or type(decoded) ~= "table" then return nil, "invalid JSON response" end
    return { status = status, data = decoded, body = body }
end

function SDK.new(options)
    options = options or {}
    local baseUrl = options.baseUrl
    local httpService = options.httpService
    local request = options.request

    if type(baseUrl) ~= "string" or baseUrl == "" then
        return nil, "baseUrl is required"
    end
    if type(httpService) ~= "userdata" and type(httpService) ~= "table" then
        return nil, "httpService is required"
    end
    if type(request) ~= "function" then
        return nil, "request function is required"
    end

    baseUrl = baseUrl:gsub("/+$", "")
    return setmetatable({
        baseUrl = baseUrl,
        httpService = httpService,
        request = request,
        getHwid = options.getHwid,
        getUserId = options.getUserId,
        random = options.random or math.random,
        compile = options.compile or loadstring or load,
        ticket = nil,
        xorKey = nil,
        session = nil,
        closed = false,
    }, Client)
end

function Client:_post(path, payload)
    local encoded
    local encodedOk = pcall(function()
        encoded = self.httpService:JSONEncode(payload)
    end)
    if not encodedOk then return nil, "request JSON encode failed" end

    local ok, response = pcall(self.request, {
        Url = self.baseUrl .. path,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = encoded,
    })
    if not ok then return nil, "HTTP request failed" end
    return normalizeResponse(self.httpService, response)
end

function Client:makeRngChallenge()
    local rng = {}
    for index = 1, 5 do
        local value = self.random(1, 1000000)
        if not isSafeInteger(value) then return nil, "random integer generation failed" end
        rng["Rng" .. index] = value
    end

    local fraction = self.random()
    if not isFinite(fraction) or isInteger(fraction) then fraction = 0.5 end
    rng.RngFloat = rng.Rng1 + fraction

    local ok, err = validateRng(rng)
    if not ok then return nil, err end
    return rng
end

function Client:_encodeProtected(data)
    if type(self.xorKey) ~= "string" or #self.xorKey == 0 then
        return nil, "session cipher key missing"
    end
    local json
    local ok = pcall(function()
        json = self.httpService:JSONEncode(data)
    end)
    if not ok then return nil, "protected JSON encode failed" end

    local encrypted, err = xorBytes(json, self.xorKey)
    if not encrypted then return nil, err end
    local full = self.xorKey .. base64Encode(encrypted)
    local bytes = {}
    for index = 1, #full do bytes[index] = full:byte(index) end
    return { Data = bytes }
end

function Client:_decodeProtected(response)
    if type(self.xorKey) ~= "string" or #self.xorKey == 0 then
        return nil, "session cipher key missing"
    end
    if type(response) ~= "table" or type(response.Data) ~= "table" then
        return nil, "protected response missing"
    end

    local bytes = response.Data
    local raw = {}
    for index = 1, #bytes do
        local byte = bytes[index]
        if not isInteger(byte) or byte < 0 or byte > 255 then
            return nil, "protected response contains invalid bytes"
        end
        raw[index] = string.char(byte)
    end
    raw = table.concat(raw)
    if raw:sub(1, #self.xorKey) ~= self.xorKey then
        return nil, "protected response key mismatch"
    end

    local decoded, decodeErr = base64Decode(raw:sub(#self.xorKey + 1))
    if not decoded then return nil, decodeErr end
    local plain, xorErr = xorBytes(decoded, self.xorKey)
    if not plain then return nil, xorErr end

    local value
    local ok = pcall(function()
        value = self.httpService:JSONDecode(plain)
    end)
    if not ok or type(value) ~= "table" then return nil, "protected response decode failed" end
    return value
end

function Client:verifyChallenge(rng, check)
    local valid, err = validateRng(rng)
    if not valid then return false, err end
    if type(check) ~= "string" then return false, "rng challenge missing" end

    local parts = split(check, "|")
    if #parts ~= #SDK.ChallengeTransforms then return false, "rng challenge malformed" end
    for index, transform in ipairs(SDK.ChallengeTransforms) do
        local value = tonumber(parts[index])
        if not isFinite(value) then return false, "rng challenge malformed" end
        local restored = (value - transform.offset) / transform.multiplier
        if not isInteger(restored) or restored ~= rng["Rng" .. index] then
            return false, "rng challenge rejected"
        end
    end
    return true
end

function Client:authenticate(input)
    if self.closed then return nil, "client is closed" end
    input = input or {}
    local scriptName = input.scriptName
    if not isValidScriptName(scriptName) then return nil, "invalid scriptName" end

    local hwid = input.hwid
    if hwid == nil and type(self.getHwid) == "function" then
        local ok, value = pcall(self.getHwid)
        if ok then hwid = value end
    end
    if type(hwid) ~= "string" or #hwid < 4 or #hwid > 512 then
        return nil, "invalid hwid"
    end
    if type(input.key) ~= "string" or input.key:match("^%s*$") then
        return nil, "key is required"
    end

    local userId = input.userId
    if userId == nil and type(self.getUserId) == "function" then
        local ok, value = pcall(self.getUserId)
        if ok then userId = value end
    end

    local verified, verifyErr = self:_post("/api/verify", {
        key = input.key,
        hwid = hwid,
        userId = userId and tostring(userId) or nil,
        scriptName = scriptName,
    })
    if not verified then return nil, verifyErr end
    if verified.status == 429 then return nil, "rate limited" end
    if verified.status ~= 200 or verified.data.valid ~= true then
        return nil, verified.data.message or verified.data.error or "key rejected"
    end
    if type(verified.data.ticket) ~= "string" or type(verified.data.k) ~= "string" or #verified.data.k == 0 then
        return nil, "malformed verification response"
    end

    self.ticket = verified.data.ticket
    self.xorKey = verified.data.k

    local rng = input.rng
    if rng == nil then
        rng, verifyErr = self:makeRngChallenge()
        if not rng then self:clear(); return nil, verifyErr end
    end
    local validRng, rngErr = validateRng(rng)
    if not validRng then self:clear(); return nil, rngErr end

    local protected, protectedErr = self:_encodeProtected(rng)
    if not protected then self:clear(); return nil, protectedErr end
    protected.ticket = self.ticket
    protected.scriptName = scriptName

    local scripted, scriptErr = self:_post("/api/script", protected)
    if not scripted then self:clear(); return nil, scriptErr end
    if scripted.status ~= 200 then self:clear(); return nil, "script request rejected" end

    local decrypted, decryptErr = self:_decodeProtected(scripted.data)
    if not decrypted then self:clear(); return nil, decryptErr end
    if decrypted.Valid ~= true then self:clear(); return nil, decrypted.reason or "server rejected" end

    local challengeOk, challengeErr = self:verifyChallenge(rng, decrypted.check)
    if not challengeOk then self:clear(); return nil, challengeErr end
    if type(decrypted.Body) ~= "string" or type(decrypted.ServerId) ~= "string" or
        type(decrypted.ScriptToken) ~= "string" or #decrypted.ScriptToken == 0 or
        type(decrypted.RuntimeSecret) ~= "string" or #decrypted.RuntimeSecret ~= 64 then
        self:clear()
        return nil, "malformed script response"
    end

    local session = {
        ticket = self.ticket,
        hwid = hwid,
        scriptName = scriptName,
        body = decrypted.Body,
        serverId = decrypted.ServerId,
        scriptToken = decrypted.ScriptToken,
        runtimeSecret = decrypted.RuntimeSecret,
    }
    self.session = session
    return session
end

function Client:verifyRuntime(session)
    session = session or self.session
    if type(session) ~= "table" then return false, "session missing" end

    local response, err = self:_post("/api/script-verify", {
        ticket = session.ticket,
        hwid = session.hwid,
        scriptToken = session.scriptToken,
        runtimeSecret = session.runtimeSecret,
        scriptName = session.scriptName,
    })
    if not response then return false, err end
    if response.status ~= 200 or response.data.valid ~= true then
        return false, response.data.reason or "runtime rejected"
    end
    return true
end

function Client:prepareRuntime(session, key)
    session = session or self.session
    if type(session) ~= "table" then return false, "session missing" end
    local env = getGlobalEnv()
    env.MS999Loader = true
    env.MS999Ticket = session.ticket
    env.MS999Token = session.scriptToken
    env.MS999Secret = session.runtimeSecret
    env.MS999Session = session.serverId
    env.MS999Script = session.scriptName
    env.MS999LoadTime = tick and tick() or os.clock()
    env.MS999Request = self.request
    env.Key = key
    return true
end

function Client:run(session, key)
    session = session or self.session
    if type(session) ~= "table" then return false, "session missing" end
    if type(self.compile) ~= "function" then return false, "loadstring is required" end

    local ready, readyErr = self:prepareRuntime(session, key)
    if not ready then return false, readyErr end
    local chunk, compileErr = self.compile(session.body)
    if type(chunk) ~= "function" then return false, compileErr or "script compile failed" end

    local ok, result = pcall(chunk)
    if not ok then return false, result end
    return true, result
end

function Client:clear(clearRuntime)
    self.ticket = nil
    self.xorKey = nil
    self.session = nil
    if clearRuntime then
        local env = getGlobalEnv()
        env.MS999Ticket = nil
        env.MS999Token = nil
        env.MS999Secret = nil
        env.MS999Session = nil
        env.MS999Script = nil
        env.MS999LoadTime = nil
        env.Key = nil
    end
end

function Client:close()
    self:clear(true)
    self.closed = true
end

return SDK
