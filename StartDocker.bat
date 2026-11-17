@echo off
rem Start the web console in Docker - Windows (Linux and macOS: StartDocker.sh).
rem
rem   StartDocker.bat            build (only what changed), start in the background, open the browser
rem   StartDocker.bat stop       stop
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

echo Building and starting the web console (the first time this takes a few minutes) ...
docker compose -f "%CF%" up -d --build
if errorlevel 1 goto :fail

rem ---- wait until the user interface answers ------------------------------------------------------
echo Waiting for %URL% ...
set /a N=0
:wait
where curl >nul 2>nul
if not errorlevel 1 (
    curl -fs "%URL%/api/status" >nul 2>nul && goto :ready
) else (
    powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%URL%/api/status' | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul && goto :ready
)
set /a N+=1
if %N% geq 60 (
    echo ERROR: The web console does not answer. Show the output: StartDocker.bat logs
    goto :fail
)
ping -n 3 127.0.0.1 >nul
goto :wait

:ready
start "" "%URL%"
echo.
echo Web console running: %URL%
echo   Stop:    StartDocker.bat stop
echo   Output:  StartDocker.bat logs
echo The container keeps running in the background (also after a reboot) until you stop it.
echo.
pause
goto :end

:fail
echo.
pause
endlocal
exit /b 1

:end
endlocal
exit /b 0
