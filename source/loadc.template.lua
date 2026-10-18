-- 999MS Stage 1. Receives the caller's values as positional locals.
local function Kick(reason)
    local message = tostring(reason or "[999MS] Runtime error")
    local coreGui
    pcall(function() coreGui = game:GetService("CoreGui") end)

    local function patchPrompt()
        pcall(function()
            local promptGui = coreGui and coreGui:FindFirstChild("RobloxPromptGui")
            local overlay = promptGui and promptGui:FindFirstChild("promptOverlay")
            local prompt = overlay and overlay:FindFirstChild("ErrorPrompt")
            local titleFrame = prompt and prompt:FindFirstChild("TitleFrame")
            local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
            local messageArea = prompt and prompt:FindFirstChild("MessageArea")
            local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
            local text = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
            if title and text then
                title.Text = "[ 999MS ]"
                text.Text = "Reason :  " .. message
            end
        end)
    end

    pcall(function()
        if coreGui then
            coreGui.ChildAdded:Connect(function(child)
                if child.Name == "RobloxPromptGui" then
                    task.wait(0.01)
                    patchPrompt()
                end
            end)
        end
    end)
    pcall(function()
        task.spawn(function()
            for _ = 1, 50 do
                patchPrompt()
                task.wait(0.01)
            end
        end)
    end)

    local player
    pcall(function() player = game:GetService("Players").LocalPlayer end)
    if player then
        pcall(function()
            if type(replicatesignal) == "function" then
                replicatesignal(player.StatsAvailable, "Kick")
            end
        end)
        pcall(function() player:Kick(message) end)
    end
    return false
end

local function Run(...)
    local key, scriptName = ...
    if type(key) ~= "string" then key = "" end
    if type(scriptName) ~= "string" or #scriptName < 1 or #scriptName > 64
        or not scriptName:match("^[%w_%-]+$") then
        scriptName = "main"
    end
    if scriptName == "Main" then scriptName = "main" end

    local link = "__STAGE2_TOKEN__"
    local url = "__BASE_URL__" .. "/" .. link
    local sha = "__STAGE2_SHA256__"
    local nonce = "__STAGE2_NONCE__"
    local ctx = {
        key = key,
        scriptName = scriptName,
        chain = {
            Version = "999MS-chain-v1",
            Id = link:match("^(%x+)") or link,
            Stage = "stage1",
            UpdatedAt = tick(),
        },
    }

    local crypto = (type(syn) == "table" and syn.crypt) or crypt
    local hasher = type(crypto) == "table" and crypto.hash or nil
    if type(hasher) ~= "function" then
        return Kick("MS999:S1:E04:LOADER_UNAVAILABLE")
    end

    local requestCandidates = {
        type(syn) == "table" and syn.request or false,
        type(http) == "table" and http.request or false,
        type(request) == "function" and request or false,
        type(http_request) == "function" and http_request or false,
    }
    local requestFn
    for _, candidate in ipairs(requestCandidates) do
        if type(candidate) == "function" then requestFn = candidate; break end
    end
    if not requestFn then
        return Kick("MS999:S1:E06:HTTP_REQUEST_UNAVAILABLE")
    end

    local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nonce .. "|" .. url, "sha256")
    if not okProof or type(proof) ~= "string" then
        return Kick("MS999:S1:E07:PROOF_FAILED")
    end

    local okGet, response = pcall(requestFn, {
        Url = url,
        Method = "POST",
        Headers = { ["content-type"] = "application/json" },
        Body = '{"p":"' .. proof .. '"}',
    })
    local body = type(response) == "table" and response.Body or nil
    if not okGet or type(body) ~= "string" or body == "" or #body > 256 * 1024 then
        return Kick("MS999:S1:E02:HTTP_GET_FAILED")
    end

    local okHash, digest = pcall(hasher, body, "sha256")
    if not okHash or type(digest) ~= "string" or string.lower(digest) ~= sha then
        return Kick("MS999:S1:E03:SHA256_MISMATCH")
    end

    local compiler = loadstring or load
    if type(compiler) ~= "function" then
        return Kick("MS999:S1:E04:LOADER_UNAVAILABLE")
    end
    local okCompile, chunk = pcall(compiler, body)
    if not okCompile or type(chunk) ~= "function" then
        return Kick("MS999:S1:E05:STAGE2_COMPILE_FAILED")
    end

    ctx.chain.UpdatedAt = tick()
    return chunk(ctx)
end

local ok, result = pcall(Run, ...)
if not ok then return Kick("MS999:S1:E99:RUNTIME_ERROR") end
return result
