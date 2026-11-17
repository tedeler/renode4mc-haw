@echo off
rem Web-Konsole in Docker starten - Windows (Linux und macOS: StartDocker.sh).
rem
rem   StartDocker.bat            bauen (nur Geaendertes) und im Hintergrund starten, Browser oeffnen
rem   StartDocker.bat stop       anhalten
rem   StartDocker.bat logs       Ausgaben ansehen (Strg+C beendet nur die Anzeige)
rem   StartDocker.bat status     laeuft der Container?
rem
rem Voraussetzung: Docker Desktop. Per Doppelklick oder in der Eingabeaufforderung aufrufen.
rem Die Oberflaeche: http://localhost:3000 (zusaetzlich belegt: Ports 3333 und 3334).
setlocal
cd /d "%~dp0"

set "URL=http://localhost:3000"
set "CF=webconsole\docker-compose.yml"

rem ---- Docker vorhanden und erreichbar? ---------------------------------------------------------
where docker >nul 2>nul
if errorlevel 1 (
    echo FEHLER: Docker ist nicht installiert - Docker Desktop: https://docs.docker.com/get-docker/
    goto :fail
)
docker info >nul 2>nul
if errorlevel 1 (
    echo FEHLER: Docker laeuft nicht. Bitte Docker Desktop starten und warten, bis es bereit ist.
    goto :fail
)
docker compose version >nul 2>nul
if errorlevel 1 (
    echo FEHLER: "docker compose" fehlt. Bitte Docker Desktop aktualisieren.
    goto :fail
)

rem ---- Befehle -------------------------------------------------------------------------------------
set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
if /i "%CMD%"=="stop"   ( docker compose -f "%CF%" down    & goto :end )
if /i "%CMD%"=="logs"   ( docker compose -f "%CF%" logs -f & goto :end )
if /i "%CMD%"=="status" ( docker compose -f "%CF%" ps      & goto :end )
if /i not "%CMD%"=="start" (
    echo Aufruf: StartDocker.bat [start^|stop^|logs^|status]
    goto :fail
)

rem Git-Stand fuer den Ueber-Dialog (Klick aufs Logo); ohne git bleibt er leer
where git >nul 2>nul
if not errorlevel 1 (
    for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "GIT_COMMIT=%%i"
    for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "GIT_BRANCH=%%i"
    for /f "delims=" %%i in ('git log -1 --format^=%%cI 2^>nul') do set "GIT_DATE=%%i"
)

echo Baue und starte die Web-Konsole (beim ersten Mal dauert das einige Minuten) ...
docker compose -f "%CF%" up -d --build
if errorlevel 1 goto :fail

rem ---- warten, bis die Oberflaeche antwortet -----------------------------------------------------
echo Warte auf %URL% ...
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
    echo FEHLER: Die Web-Konsole antwortet nicht. Ausgaben ansehen: StartDocker.bat logs
    goto :fail
)
ping -n 3 127.0.0.1 >nul
goto :wait

:ready
start "" "%URL%"
echo.
echo Web-Konsole laeuft: %URL%
echo   Anhalten:  StartDocker.bat stop
echo   Ausgaben:  StartDocker.bat logs
echo Der Container laeuft im Hintergrund weiter (auch nach einem Neustart), bis Sie ihn anhalten.
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
