if not game:IsLoaded() then game.Loaded:Wait() end

local qV=os.clock()
local aN=os.time()
local xT=os.date("*t")
local mK=os.difftime(aN,aN-1)
local sE=table.concat({tostring(aN),tostring(xT.year),tostring(xT.yday),tostring(xT.hour),tostring(xT.min),tostring(xT.sec),tostring(mK)},"-")

local gR="https://loader999ms.vercel.app"
local pY={gR,"/loada.lua","999MS-chain-v1","lite",true}
local wC="__LOADA_D__"
local hF="__LOADA_N__"
local uJ="__CHAIN_ID__"
local bM="1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d"
local kL=(getgenv and getgenv())or _G

if not uJ:match("^[a-f0-9]+$")or #uJ~=64 then error("0x2b6e39f1a442",0)end
kL.MS999Chain=nil
kL.MS999Chain={Version="999MS-chain-v1",Id=uJ,Stage="stage1",UpdatedAt=tick()}

local yX=gR.."/loada.lua/"..wC.."/"..hF..'?run='..tostring(qV)..'&stamp='..sE
local rP,tD=pcall(function() return game:HttpGet(yX) end)

if not rP or type(tD)~='string' or tD=='' then
    kL.MS999Chain=nil
    error("0x4f98daf3fd5d",0)
end

local nS=(kL and kL.crypt)or crypt
local vE,zQ=pcall(type(nS)=="table"and nS.hash or nil,tD,"sha256")
if not vE or type(zQ)~="string"or string.lower(zQ)~=bM then
    kL.MS999Chain=nil
    error("0x31d7a640f95e",0)
end

local cA=loadstring or load
if type(cA)~='function' then
    kL.MS999Chain=nil
    error("0x75934d1098b9",0)
end

local oW,fG=pcall(cA,tD)
if not oW or type(fG)~='function' then
    kL.MS999Chain=nil
    error("0xc6ee23173a05",0)
end

return fG(pY,...)
