@echo off
rem Wrapper that dies while its worker survives: launches the node grandchild detached,
rem then exits once the flag file appears. Models a crashed wrapper leaving an orphan.
start "" /b "%ARKE_SHIM_NODE%" "%ARKE_SHIM_TARGET%"
:waitloop
if exist "%ARKE_SHIM_EXIT_FLAG%" exit /b 0
ping -n 2 127.0.0.1 >nul
goto waitloop
