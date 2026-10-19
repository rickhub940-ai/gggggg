-- 999MS Stage 1. Receives the caller's values as positional locals.
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
    error("MS999:S1:E04:LOADER_UNAVAILABLE", 0)
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
    error("MS999:S1:E06:HTTP_REQUEST_UNAVAILABLE", 0)
end

local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nonce .. "|" .. url, "sha256")
if not okProof or type(proof) ~= "string" then
    error("MS999:S1:E07:PROOF_FAILED", 0)
end

local okGet, response = pcall(requestFn, {
    Url = url,
    Method = "POST",
    Headers = { ["content-type"] = "application/json" },
    Body = '{"p":"' .. proof .. '"}',
})
local body = type(response) == "table" and response.Body or nil
if not okGet or type(body) ~= "string" or body == "" or #body > 512 * 1024 then
    error("MS999:S1:E02:HTTP_GET_FAILED", 0)
end

local okHash, digest = pcall(hasher, body, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= sha then
    error("MS999:S1:E03:SHA256_MISMATCH", 0)
end

local compiler = loadstring or load
if type(compiler) ~= "function" then
    error("MS999:S1:E04:LOADER_UNAVAILABLE", 0)
end
local okCompile, chunk = pcall(compiler, body)
if not okCompile or type(chunk) ~= "function" then
    error("MS999:S1:E05:STAGE2_COMPILE_FAILED", 0)
end

ctx.chain.UpdatedAt = tick()
return chunk(ctx)
