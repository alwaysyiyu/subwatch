@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  subwatch 绿色版 · 一键修复启动问题
rem
rem  为什么需要这个：Windows 会用一个受限令牌（AppContainer）启动 Electron 的
rem  渲染进程，而该令牌必须能读取程序自身所在目录。从 zip 解压到某些目录
rem  （尤其是非系统盘、或通过浏览器下载后直接解压的目录）时，这个目录缺少
rem  「ALL APPLICATION PACKAGES」的读取权限，Electron 会直接崩溃并提示：
rem
rem    Sandboxed processes cannot read <目录>: its ACL has an entry for an
rem    AppContainer package SID but none for ALL APPLICATION PACKAGES
rem
rem  这个脚本就是给当前目录补上那条权限。安装版（装到
rem  %LOCALAPPDATA%\Programs）不会有这个问题，不需要运行本脚本。
rem ============================================================

echo.
echo   subwatch 绿色版 · 一键修复
echo   ==========================
echo.
echo   如果你双击 subwatch.exe 没反应、或者看到窗口一闪而过，
echo   运行这个脚本就能修好（它会给当前文件夹补一条读取权限）。
echo.

rem 需要管理员权限才能改 ACL
net session >nul 2>&1
if errorlevel 1 (
  echo   正在申请管理员权限...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo   正在给当前文件夹授予读取权限...
icacls "%~dp0" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /C >nul 2>&1

if errorlevel 1 (
  echo.
  echo   [失败] 权限授予失败。你可以手动在管理员命令行里执行：
  echo          icacls "%~dp0" /grant *S-1-15-2-1:(OI)(CI)(RX) /T
  echo.
) else (
  echo.
  echo   [成功] 修好了。现在双击 subwatch.exe 应该能正常打开。
  echo.
)

echo   按任意键退出...
pause >nul
endlocal
