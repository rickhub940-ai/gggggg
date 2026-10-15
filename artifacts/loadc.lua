if not game:IsLoaded() then game.Loaded:Wait() end

__PRELUDE__

__SETUP__

local __URL__=__BASE__.."/loada.lua/"..__D__.."/"..__N__..'?run='..tostring(__CLOCK__)..'&stamp='..__STAMP__
local __FETCHED__,__BODY__=pcall(function() return game:HttpGet(__URL__) end)

if not __FETCHED__ or type(__BODY__)~='string' or __BODY__=='' then
    __ENV__.MS999Chain=nil
    error("MS999:S1:E02:HTTP_GET_FAILED",0)
end

local __CRYPTO__=(__ENV__ and __ENV__.crypt)or crypt
local __HASHED__,__DIGEST__=pcall(type(__CRYPTO__)=="table"and __CRYPTO__.hash or nil,__BODY__,"sha256")
if not __HASHED__ or type(__DIGEST__)~="string"or string.lower(__DIGEST__)~=__HASH__ then
    __ENV__.MS999Chain=nil
    error("MS999:S1:E03:SHA256_MISMATCH",0)
end

local __LOADER__=loadstring or load
if type(__LOADER__)~='function' then
    __ENV__.MS999Chain=nil
    error("MS999:S1:E04:LOADER_UNAVAILABLE",0)
end

local __EXECUTED__,__FUNCTION__=pcall(__LOADER__,__BODY__)
if not __EXECUTED__ or type(__FUNCTION__)~='function' then
    __ENV__.MS999Chain=nil
    error("MS999:S1:E05:STAGE2_COMPILE_FAILED",0)
end

return __FUNCTION__(__ARGS__,...)
