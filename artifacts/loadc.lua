if not game:IsLoaded() then game.Loaded:Wait() end

local __stRunUrl="https://loader999ms.vercel.app/loader/ride-a-pet.lua"..'?run='..tostring(os.clock())

local __stRequestOk,__stSource=pcall(function() return game:HttpGet(__stRunUrl) end)

if not __stRequestOk or type(__stSource)~='string' or __stSource=='' then error("0x4f98daf3fd5d",0) end

local __stLoad=loadstring or load

if type(__stLoad)~='function' then error("0x75934d1098b9",0) end

local __stCompileOk,__stChunk=pcall(__stLoad,__stSource)

if not __stCompileOk or type(__stChunk)~='function' then error("0xc6ee23173a05",0) end

return __stChunk(...)
