if not game:IsLoaded() then game.Loaded:Wait() end

local __stBase="https://keysytemdemo.vercel.app"
local __stConfig={__stBase,"/loada.lua","999MS-chain-v1","lite",true}
local __stD="__LOADA_D__"
local __stN="__LOADA_N__"
local __stChainId="__CHAIN_ID__"
local __stExpectedHash="1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d"
local __stEnv=(getgenv and getgenv())or _G

if not __stChainId:match("^[a-f0-9]+$")or #__stChainId~=64 then error("0x2b6e39f1a442",0)end
__stEnv.MS999Chain=nil
__stEnv.MS999Chain={Version="999MS-chain-v1",Id=__stChainId,Stage="stage1",UpdatedAt=tick()}

local __stRunUrl=__stBase.."/loada.lua/"..__stD.."/"..__stN..'?run='..tostring(os.clock())
local __stRequestOk,__stSource=pcall(function()return game:HttpGet(__stRunUrl)end)

if not __stRequestOk or type(__stSource)~="string"or __stSource==""then
    __stEnv.MS999Chain=nil
    error("0x4f98daf3fd5d",0)
end

local __stCrypt=(__stEnv and __stEnv.crypt)or crypt
local __stHashOk,__stHash=pcall(type(__stCrypt)=="table"and __stCrypt.hash or nil,__stSource,"sha256")
if not __stHashOk or type(__stHash)~="string"or string.lower(__stHash)~=__stExpectedHash then
    __stEnv.MS999Chain=nil
    error("0x31d7a640f95e",0)
end

local __stLoad=loadstring or load
if type(__stLoad)~="function"then
    __stEnv.MS999Chain=nil
    error("0x75934d1098b9",0)
end

local __stCompileOk,__stChunk=pcall(__stLoad,__stSource)
if not __stCompileOk or type(__stChunk)~="function"then
    __stEnv.MS999Chain=nil
    error("0xc6ee23173a05",0)
end

return __stChunk(__stConfig,...)
