if not game:IsLoaded()then game.Loaded:Wait()end
__PRELUDE__
__SETUP__
local __FETCHED__,__BODY__=pcall(game.HttpGet,game,__BASE__.."/loada.lua/"..__D__.."/"..__N__.."?run="..__CLOCK__.."&t="..__TIME__..__DATE__.yday..os.difftime(__TIME__,__TIME__-1))
assert(__FETCHED__,"S1G")
local __HASHED__,__DIGEST__=pcall((__ENV__.crypt or crypt or{}).hash,__BODY__,"sha256")
assert(__HASHED__ and string.lower(__DIGEST__)=="1724d4c3006c7fe68e73f41f7895b848f94c9618f2ddbb7b6f704d4e4927903d","S1H")
local __LOADER__=assert(loadstring or load,"S1L")
local __EXECUTED__,__FUNCTION__=pcall(__LOADER__,__BODY__)
assert(__EXECUTED__,"S1C")
return __FUNCTION__({__BASE__,"/loada.lua","999MS-chain-v1","lite",true},...)
