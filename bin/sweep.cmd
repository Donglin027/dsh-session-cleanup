@echo off
setlocal
rem Portable entry: finds a node.exe (DSH bundled runtime first, then PATH).
set "HERE=%~dp0"
set "NODE="
if defined DSH_NODE set "NODE=%DSH_NODE%"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE (
  echo [sweep] node.exe not found. Set DSH_NODE to the full path of node.exe.
  exit /b 1
)
"%NODE%" "%HERE%sweep.js" %*
