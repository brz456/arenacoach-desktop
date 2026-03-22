local addonName = ...
local CHAT_PREFIX = "|cff4cc9f0ArenaCoach|r"
local STARTUP_MESSAGE = CHAT_PREFIX .. ": Advanced combat logging is enabled."
local ARENA_LOGGING_MESSAGE = CHAT_PREFIX .. ": Combat log started for this arena match."

local ArenaLogRuntime = {
    frame = CreateFrame("Frame"),
}

function ArenaLogRuntime.ApplyStartupConfiguration()
    SetCVar("advancedCombatLogging", "1")
end

function ArenaLogRuntime.PrintStartupMessage()
    print(STARTUP_MESSAGE)
end

function ArenaLogRuntime.IsArenaContext()
    local inInstance = IsInInstance()
    if not inInstance then
        return false
    end

    local _, instanceType = GetInstanceInfo()
    return instanceType == "arena"
end

function ArenaLogRuntime.EnableCombatLogging()
    local loggingState = LoggingCombat()
    if loggingState ~= true and loggingState ~= 1 then
        LoggingCombat(true)
        print(ARENA_LOGGING_MESSAGE)
    end
end

function ArenaLogRuntime.HandleRuntimeTransition()
    if ArenaLogRuntime.IsArenaContext() then
        ArenaLogRuntime.EnableCombatLogging()
    end
end

ArenaLogRuntime.frame:RegisterEvent("ADDON_LOADED")
ArenaLogRuntime.frame:RegisterEvent("PLAYER_ENTERING_WORLD")
ArenaLogRuntime.frame:RegisterEvent("ZONE_CHANGED_NEW_AREA")

ArenaLogRuntime.frame:SetScript("OnEvent", function(_, event, ...)
    if event == "ADDON_LOADED" then
        local loadedAddonName = ...
        if loadedAddonName == addonName then
            ArenaLogRuntime.ApplyStartupConfiguration()
            ArenaLogRuntime.frame:UnregisterEvent("ADDON_LOADED")
        end

        return
    end

    if event == "PLAYER_ENTERING_WORLD" then
        local isInitialLogin, isReloadingUi = ...
        if isInitialLogin and not isReloadingUi then
            ArenaLogRuntime.PrintStartupMessage()
        end
    end

    ArenaLogRuntime.HandleRuntimeTransition()
end)
