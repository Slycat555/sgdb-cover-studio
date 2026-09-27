@echo off
rem Launch Cover Studio on Windows (opens in your browser). Extra args go to server.py, e.g. --port 9000
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0server.py" %*
) else (
  python "%~dp0server.py" %*
)
if errorlevel 1 pause
