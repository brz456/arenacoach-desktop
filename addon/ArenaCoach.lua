-- ArenaCoach Addon - Minimal Combat Logging Enabler
-- Only enables combat logging when entering arena/PvP zones

local function OnEvent(self, event, ...)
  if event == "ZONE_CHANGED_NEW_AREA" then
    local type = select(2, IsInInstance())
    
    -- Enable combat logging in arena zones
    if type == "arena" then
      LoggingCombat(true)
      print("ArenaCoach: Combat logging enabled for arena. Good luck!")
      return
    end
    
    -- Enable combat logging for PvP zones (battlegrounds, etc.)
    local _, instanceType = GetInstanceInfo()
    if instanceType == "pvp" then
      LoggingCombat(true)
      print("ArenaCoach: Combat logging enabled for PvP. Good luck!")
      return
    end
  end
end

local function OnInitialize()
  SetCVar("advancedCombatLogging", "1")
  print("ArenaCoach: Loaded. Your arena combats will be automatically logged.")
end

local loadFrame = CreateFrame("Frame")
loadFrame:RegisterEvent("PLAYER_LOGIN")
loadFrame:SetScript("OnEvent", OnInitialize)

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
eventFrame:SetScript("OnEvent", OnEvent)