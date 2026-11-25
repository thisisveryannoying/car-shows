@echo off
title Car Shows server
echo Starting Car Shows...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo The server stopped. If it did not start, the error is shown above.
pause
