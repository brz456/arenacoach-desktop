#!/bin/bash
# Direct Windows execution with WSL terminal output

echo "🚀 Starting ArenaCoach Desktop on Windows..."
echo "============================================="

# Execute the PowerShell script directly - output flows to current terminal
powershell.exe -ExecutionPolicy Bypass -File ./dev-windows.ps1