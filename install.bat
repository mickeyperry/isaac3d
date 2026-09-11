@echo off
setlocal EnableDelayedExpansion
title Isaac3D - Installer

echo ============================================================
echo  Isaac3D for After Effects - Installer
echo ============================================================
echo.

set "SRC=%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.mickyp.isaac3d"

:: ------------------------------------------------------------
:: 1. Allow unsigned CEP extensions (PlayerDebugMode for CSXS 9-14)
:: ------------------------------------------------------------
echo [1/3] Enabling unsigned CEP extensions...
for %%V in (9 10 11 12 13 14) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo       Done.
echo.

:: ------------------------------------------------------------
:: 2. Copy the panel to the CEP extensions folder
:: ------------------------------------------------------------
echo [2/3] Installing extension files...
if /I "%SRC:~0,-1%"=="%DEST%" (
    echo       Already running from the install location - skipping copy.
) else (
    if not exist "%DEST%" mkdir "%DEST%"
    for %%D in (CSXS client host) do (
        robocopy "%SRC%%%D" "%DEST%\%%D" /MIR /NJH /NJS /NFL /NDL >nul
        if !ERRORLEVEL! GEQ 8 (
            echo       ERROR: Could not copy %%D to %DEST%
            pause
            exit /b 1
        )
    )
    copy /Y "%SRC%.debug" "%DEST%\.debug" >nul 2>&1
    echo       Installed to %DEST%
)
echo.

:: ------------------------------------------------------------
:: 3. Done
:: ------------------------------------------------------------
echo [3/3] All set!
echo.
echo   Restart After Effects, then open:  Window ^> Extensions ^> Isaac3D
echo.
pause
