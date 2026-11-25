@echo off
title Car Shows for your phone
echo Starting Car Shows for your phone...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-phone.ps1"
echo.
echo The server stopped. If it did not start, the error is shown above.
pause
