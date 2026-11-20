@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE call :select_node "%%N"
if not defined NODE_EXE (
  for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.*") do (
    if not defined NODE_EXE if exist "%%~fD\dependencies\node\bin\node.exe" call :select_node "%%~fD\dependencies\node\bin\node.exe"
  )
)
if not defined NODE_EXE (
  echo Could not find Node.js. Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
start "Shipyard" /D "%~dp0" "%NODE_EXE%" server.mjs
for /l %%I in (1,1,30) do (
  curl.exe --fail --silent --max-time 1 http://127.0.0.1:4173/api/health >nul 2>&1 && goto :server_ready
  timeout /t 1 /nobreak >nul
)
echo Shipyard did not become ready. Check the Shipyard terminal window for the startup error.
pause
exit /b 1
:server_ready
start "" http://localhost:4173
endlocal & exit /b 0

:select_node
"%~1" -e "if (Number(process.versions.node.split('.')[0]) >= 22) process.exit(0); process.exit(1)" >nul 2>&1
if not errorlevel 1 set "NODE_EXE=%~1"
exit /b 0
