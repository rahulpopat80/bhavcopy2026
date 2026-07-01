@echo off
echo ===================================================
echo Pushing project to https://github.com/rahulpopat80/bhavcopy2026.git
echo ===================================================
cd /d "%~dp0"

echo.
echo [1/5] Initializing Git...
git init

echo.
echo [2/5] Adding files...
git add .

echo.
echo [3/5] Committing changes...
git commit -m "Complete investment research dashboard with secure login, batch CSV processing, auto-add new companies and charting"

echo.
echo [4/5] Setting branch and remote URL...
git branch -M main
git remote remove origin >nul 2>&1
git remote add origin https://github.com/rahulpopat80/bhavcopy2026.git

echo.
echo [5/5] Pushing to GitHub...
echo.
echo Please authenticate in the browser if prompted by GitHub.
git push -u origin main

echo.
echo ===================================================
echo Push completed! Press any key to close this window.
echo ===================================================
pause
