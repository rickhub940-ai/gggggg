if not game:IsLoaded() then game.Loaded:Wait() end

local __CLOCK__=os.clock()
local __TIME__=os.time()
local __DATE__=os.date("*t")
local __DIFF__=os.difftime(__TIME__,__TIME__-1)
local __STAMP__=table.concat({tostring(__TIME__),tostring(__DATE__.year),tostring(__DATE__.yday),tostring(__DATE__.hour),tostring(__DATE__.min),tostring(__DATE__.sec),tostring(__DIFF__)},"-")

local __BASE__="https://loader999ms.vercel.app"
local __ARGS__={__BASE__,"/loada.lua","999MS-chain-v1","lite",true}
local __D__="__LOADA_D__"
local __N__="__LOADA_N__"
local __ID__="__CHAIN_ID__"
local __HASH__="1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d"
local __ENV__=(getgenv and getgenv())or _G

if not __ID__:match("^[a-f0-9]+$")or #__ID__~=64 then error("0x2b6e39f1a442",0)end
__ENV__.MS999Chain=nil
__ENV__.MS999Chain={Version="999MS-chain-v1",Id=__ID__,Stage="stage1",UpdatedAt=tick()}

local __URL__=__BASE__.."/loada.lua/"..__D__.."/"..__N__..'?run='..tostring(__CLOCK__)..'&stamp='..__STAMP__
local __FETCHED__,__BODY__=pcall(function() return game:HttpGet(__URL__) end)

if not __FETCHED__ or type(__BODY__)~='string' or __BODY__=='' then
    __ENV__.MS999Chain=nil
    error("0x4f98daf3fd5d",0)
end

local __CRYPTO__=(__ENV__ and __ENV__.crypt)or crypt
local __HASHED__,__DIGEST__=pcall(type(__CRYPTO__)=="table"and __CRYPTO__.hash or nil,__BODY__,"sha256")
if not __HASHED__ or type(__DIGEST__)~="string"or string.lower(__DIGEST__)~=__HASH__ then
    __ENV__.MS999Chain=nil
    error("0x31d7a640f95e",0)
end

local __LOADER__=loadstring or load
if type(__LOADER__)~='function' then
    __ENV__.MS999Chain=nil
    error("0x75934d1098b9",0)
end

local __EXECUTED__,__FUNCTION__=pcall(__LOADER__,__BODY__)
if not __EXECUTED__ or type(__FUNCTION__)~='function' then
    __ENV__.MS999Chain=nil
    error("0xc6ee23173a05",0)
end

return __FUNCTION__(__ARGS__,...)
