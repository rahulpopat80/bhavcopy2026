@echo off
title Launch Bhavcopy (CORS Disabled for Auto-Fetch)
echo Launching Google Chrome with Web Security disabled...
echo This enables 100% automated daily bhavcopy fetching from NSE archives.
echo.

:: Get absolute path of index.html
set "APP_PATH=%~dp0index.html"
:: Replace backslashes with forward slashes for file:// URL
set "APP_PATH=%APP_PATH:\=/%"

:: Check if Chrome exists in standard paths
set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_PATH%" set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_PATH%" set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if exist "%CHROME_PATH%" (
    start "" "%CHROME_PATH%" --disable-web-security --user-data-dir="%TEMP%\chrome-bhavcopy-profile" --disable-site-isolation-trials "file:///%APP_PATH%"
    echo Chrome launched successfully!
) else (
    echo Error: Google Chrome was not found in standard directories.
    echo Please run Chrome manually with --disable-web-security flag.
    pause
)
