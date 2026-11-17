@echo off
rem Start the web console in Docker - Windows (Linux and macOS: StartDocker.sh).
rem
rem   StartDocker.bat            build (only what changed) and run in this window, open the browser;
rem                              Ctrl+C stops the web console
rem   StartDocker.bat stop       stop (if it is still running, e.g. after the window was closed)
rem   StartDocker.bat logs       show the output (Ctrl+C only ends the display)
rem   StartDocker.bat status     is the container running?
rem
rem Requirement: Docker Desktop. Run it by double-clicking or from the command prompt.
rem The user interface: http://localhost:3000 (also used: ports 3333 and 3334).
setlocal
cd /d "%~dp0"

set "URL=http://localhost:3000"
set "CF=webconsole\docker-compose.yml"

rem ---- is Docker installed and reachable? ------------------------------------------------------
where docker >nul 2>nul
if errorlevel 1 (
    echo ERROR: Docker is not installed - Docker Desktop: https://docs.docker.com/get-docker/
    goto :fail
)
docker info >nul 2>nul
if errorlevel 1 (
    echo ERROR: Docker is not running. Please start Docker Desktop and wait until it is ready.
    goto :fail
)
docker compose version >nul 2>nul
if errorlevel 1 (
    echo ERROR: "docker compose" is missing. Please update Docker Desktop.
    goto :fail
)

rem ---- commands ------------------------------------------------------------------------------------
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
if /i "%CMD%"=="stop"   ( docker compose -f "%CF%" down    & goto :end )
if /i "%CMD%"=="logs"   ( docker compose -f "%CF%" logs -f & goto :end )
if /i "%CMD%"=="status" ( docker compose -f "%CF%" ps      & goto :end )
if /i not "%CMD%"=="start" (
    echo Usage: StartDocker.bat [start^|stop^|logs^|status]
    goto :fail
)

rem Git version for the About dialog (click on the logo); without git it stays empty
where git >nul 2>nul
if not errorlevel 1 (
    for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%i"
    for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "GIT_BRANCH=%%i"
    for /f "delims=" %%i in ('git log -1 --format^=%%cI 2^>nul') do set "GIT_DATE=%%i"
)

rem ---- open the browser as soon as the user interface answers (runs alongside docker compose) -----
rem      gives up after 20 minutes, e.g. if the build fails
start "" /b powershell -NoProfile -Command "for ($i = 0; $i -lt 600; $i++) { try { Invoke-WebRequest -UseBasicParsing '%URL%/api/status' | Out-Null; Write-Host ''; Write-Host '>>> Web console ready: %URL%   (Ctrl+C stops it)'; Write-Host ''; Start-Process '%URL%'; break } catch { Start-Sleep -Seconds 2 } }"

echo Building and starting the web console (the first time this takes a few minutes) ...
echo It runs in this window; Ctrl+C stops it.
docker compose -f "%CF%" up --build
if errorlevel 1 goto :fail
goto :end

:fail
echo.
pause
endlocal
exit /b 1

:end
endlocal
exit /b 0
