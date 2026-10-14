@echo off
setlocal
REM Cria a tarefa no Agendador do Windows pra iniciar o robo no login.
set "SCRIPT=%~dp0robo-demonstrativo-mensal.ahk"
set "AHK=C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
if not exist "%AHK%" set "AHK=C:\Program Files\AutoHotkey\AutoHotkey64.exe"
if not exist "%AHK%" (
  echo.
  echo Nao encontrei o AutoHotkey v2. Instale em https://www.autohotkey.com e rode de novo.
  echo.
  pause
  exit /b 1
)
schtasks /create /tn "Robo Demonstrativo Mensal Dominio" /tr "\"%AHK%\" \"%SCRIPT%\"" /sc onlogon /rl highest /f
if %errorlevel%==0 (
  echo.
  echo Tarefa "Robo Demonstrativo Mensal Dominio" criada. Ela inicia o robo no proximo login.
  echo Para iniciar agora sem reiniciar, de duplo-clique no robo-demonstrativo-mensal.ahk.
) else (
  echo.
  echo Falhou ao criar a tarefa. Rode este .bat como Administrador (botao direito ^> Executar como administrador).
)
echo.
pause
