#requires -Version 5.1
<#
.SYNOPSIS
  Ставит на эту Windows-машину self-hosted раннер GitHub Actions, на котором
  выполняется job «Обновить локальный стенд» (.github/workflows/stand.yml).

.DESCRIPTION
  Что делает скрипт:
    1. получает токен регистрации (короткий из настроек репозитория либо сам,
       по PAT) и номер последней версии раннера;
    2. скачивает actions-runner-win-x64 и распаковывает в -RunDir;
    3. регистрирует раннер в репозитории с меткой `crm-ci`;
    4. поднимает его одним из двух способов (-Mode):
         Task    — задание Планировщика Windows «crm-ci-runner», запуск при
                   входе пользователя, раннер живёт в пользовательской сессии;
         Service — служба Windows (--runasservice), работает без входа.

  Какой режим выбрать. Docker Desktop на Windows отдаёт свой именованный канал
  только пользователю, который вошёл в систему (и состоит в группе
  docker-users). Поэтому шаги `docker compose build …` работают надёжно только
  в режиме Task: служба от системной учётной записи до Docker Desktop не
  достучится. Service имеет смысл, если Docker вам в CI не нужен.

  Токен регистрации можно не искать руками: передайте -Pat (classic PAT со
  scope `repo` + `admin:repo_hook` или fine-grained с правом Administration:
  Read and write) — скрипт возьмёт токен через API. Без PAT возьмите короткий
  токен на странице
  https://github.com/<owner>/<repo>/settings/actions/runners/new
  (он в команде `./config.cmd --url … --token <TOKEN>`) и передайте
  -RegistrationToken.

  Запускать из Windows PowerShell 5.1 (powershell.exe) — на машине стоит именно
  она. Файл сохранён в UTF-8 с BOM: без него 5.1 читает кириллицу как ANSI.

.EXAMPLE
  # поставить раннер в пользовательской сессии (рекомендуется)
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT

.EXAMPLE
  # поставить службой под текущей учётной записью
  $cred = Get-Credential "$env:USERDOMAIN\$env:USERNAME"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT -Mode Service -Credential $cred

.EXAMPLE
  # снять раннер с репозитория и убрать задание (каталог остаётся)
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File _tools\runner\install-runner.ps1 -Pat $env:GITHUB_PAT -Uninstall

.NOTES
  Порядок, оговорки и разбор сбоев — docs/ci.md.
#>
[CmdletBinding()]
param(
    [string]$Repo = 'gidvantus/factory-dormitory-management',
    [string]$Name = "crm-ci-$env:COMPUTERNAME",
    [string]$Labels = 'crm-ci',
    [string]$RunDir = 'D:\actions-runner-crm',
    # Где раннер держит одноразовые копии репозитория. Относительный путь —
    # от $RunDir, абсолютный — как задан. Каталогом проекта быть не может:
    # раннер сам создаёт и чистит здесь <repo>/<repo>.
    [string]$Work = '_work',
    [string]$Version = 'latest',

    # Токен регистрации из UI репозитория (короткоживущий).
    [string]$RegistrationToken,
    # PAT: скрипт сам возьмёт токены регистрации и удаления через API.
    [string]$Pat,

    [ValidateSet('Task', 'Service')]
    [string]$Mode = 'Task',
    [pscredential]$Credential,

    [switch]$Force,
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$TaskName = 'crm-ci-runner'
$RepoUrl = "https://github.com/$Repo"

function Write-Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }

function Get-GitHubToken([ValidateSet('registration-token', 'remove-token')][string]$Kind) {
    if (-not $Pat) {
        throw "Нужен -Pat или -RegistrationToken: без токена раннер не зарегистрировать."
    }
    $uri = "https://api.github.com/repos/$Repo/actions/runners/$Kind"
    $headers = @{
        Authorization          = "Bearer $Pat"
        Accept                 = 'application/vnd.github+json'
        'User-Agent'           = 'crm-ci-install'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers
    return $response.token
}

function Get-RunnerVersion {
    if ($Version -ne 'latest') { return $Version.Replace('v', '') }
    $headers = @{ 'User-Agent' = 'crm-ci-install'; Accept = 'application/vnd.github+json' }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers $headers
    return $release.tag_name.Replace('v', '')
}

function Stop-RunnerTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "задание $TaskName снято"
    }
}

function Uninstall-Runner {
    Write-Step "Снятие раннера $Name c $RepoUrl"

    Stop-RunnerTask

    # Имя службы раннера: actions.runner.<owner>-<repo>.<ИмяРаннера>
    $svc = Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*$Name" }
    foreach ($s in @($svc)) {
        if (-not $s) { continue }
        if ($s.Status -eq 'Running') { Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue }
        & sc.exe delete $s.Name | Out-Null
        Write-Ok "служба $($s.Name) удалена"
    }

    if (Test-Path (Join-Path $RunDir '.runner')) {
        if (-not $RegistrationToken) {
            try { $RegistrationToken = Get-GitHubToken -Kind 'remove-token' }
            catch { Write-Warn2 "токен удаления не получен ($($_.Exception.Message)) — удалите раннер вручную в Settings → Actions → Runners" }
        }
        if ($RegistrationToken) {
            Push-Location $RunDir
            try {
                & .\config.cmd remove --unattended --token $RegistrationToken
                if ($LASTEXITCODE -ne 0) { Write-Warn2 "config.cmd remove вернул код $LASTEXITCODE — проверьте Settings → Actions → Runners" }
                else { Write-Ok 'раннер снят с репозитория' }
            }
            finally { Pop-Location }
        }
    }

    if ($Purge -and (Test-Path $RunDir)) {
        Remove-Item -LiteralPath $RunDir -Recurse -Force
        Write-Ok "каталог $RunDir удалён"
    }
    Write-Host ''
    Write-Host 'Готово. Проверьте список: Settings → Actions → Runners.'
}

function Install-Runner {
    Write-Step "Раннер $Name для $RepoUrl (метка: $Labels, режим: $Mode)"

    if ($Mode -eq 'Service' -and -not $Credential) {
        throw "-Mode Service требует -Credential: под какой учётной записью работать службе."
    }

    if (-not $RegistrationToken) {
        Write-Step 'Токен регистрации через API'
        $RegistrationToken = Get-GitHubToken -Kind 'registration-token'
        Write-Ok 'получен'
    }

    Write-Step 'Версия раннера'
    $runnerVersion = Get-RunnerVersion
    Write-Ok "actions-runner $runnerVersion"

    if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir | Out-Null }

    # Уже настроенный раннер нельзя конфигурировать повторно без перерегистрации.
    if (Test-Path (Join-Path $RunDir '.runner')) {
        if (-not $Force) {
            throw "$RunDir уже сконфигурирован. Переустановка: -Force (снимет старую регистрацию), снятие: -Uninstall."
        }
        Write-Step 'Снимаю прежнюю регистрацию (-Force)'
        # Для удаления GitHub выдаёт отдельный токен; если есть PAT — берём его.
        $removeToken = $RegistrationToken
        if ($Pat) {
            try { $removeToken = Get-GitHubToken -Kind 'remove-token' }
            catch { Write-Warn2 "токен удаления не получен, пробую токеном регистрации" }
        }
        Push-Location $RunDir
        try {
            & .\config.cmd remove --unattended --token $removeToken
            if ($LASTEXITCODE -ne 0) { Write-Warn2 "config.cmd remove вернул код $LASTEXITCODE — продолжаю" }
        }
        finally { Pop-Location }
    }

    $zip = Join-Path $RunDir "actions-runner-win-x64-$runnerVersion.zip"
    if (-not (Test-Path (Join-Path $RunDir 'config.cmd'))) {
        Write-Step "Скачивание $zip"
        $url = "https://github.com/actions/runner/releases/download/v$runnerVersion/actions-runner-win-x64-$runnerVersion.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Write-Ok "$([math]::Round((Get-Item $zip).Length / 1MB, 1)) МБ"
        Write-Step 'Распаковка'
        Expand-Archive -LiteralPath $zip -DestinationPath $RunDir -Force
        Remove-Item -LiteralPath $zip -Force
        Write-Ok 'распаковано'
    }
    else {
        Write-Ok "файлы раннера уже в $RunDir — скачивание пропущено"
    }

    Write-Step 'Регистрация'
    $configArgs = @(
        '--unattended'
        '--url', $RepoUrl
        '--token', $RegistrationToken
        '--name', $Name
        '--labels', $Labels
        '--work', $Work
        '--replace'
    )
    if ($Mode -eq 'Service') {
        $plain = $Credential.GetNetworkCredential()
        $configArgs += @(
            '--runasservice'
            '--windowslogonaccount', $Credential.UserName
            '--windowslogonpassword', $plain.Password
        )
    }
    Push-Location $RunDir
    try {
        & .\config.cmd @configArgs
        if ($LASTEXITCODE -ne 0) { throw "config.cmd завершился с кодом $LASTEXITCODE" }
    }
    finally { Pop-Location }
    Write-Ok 'раннер зарегистрирован'

    if ($Mode -eq 'Task') {
        Write-Step "Задание Планировщика $TaskName (запуск при входе пользователя)"
        Stop-RunnerTask

        $action = New-ScheduledTaskAction -Execute (Join-Path $RunDir 'run.cmd') -WorkingDirectory $RunDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName `
            -Action $action -Trigger $trigger -Settings $settings `
            -Description "GitHub Actions runner: обновление локального стенда $Repo (метка $Labels)" `
            -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        $state = (Get-ScheduledTask -TaskName $TaskName).State
        Write-Ok "задание $TaskName создано, состояние: $state"
        Write-Warn2 'после перезагрузки машины раннер поднимется при входе пользователя — раньше Docker Desktop не готов'
    }
    else {
        Write-Step 'Служба Windows'
        $service = Get-Service -Name 'actions.runner.*' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like "*$Name*" }
        if ($service) {
            Set-Service -Name $service.Name -StartupType Automatic
            Start-Service -Name $service.Name -ErrorAction SilentlyContinue
            Write-Ok "служба $($service.Name): $((Get-Service -Name $service.Name).Status)"
        }
        else {
            Write-Warn2 'служба не найдена — проверьте вывод config.cmd выше'
        }
        Write-Warn2 'служба не видит Docker Desktop: шаги docker compose в stand.yml упадут, если Docker не отдаёт канал учётной записи службы'
    }

    Write-Host ''
    Write-Host 'Дальше:' -ForegroundColor Cyan
    Write-Host "  1. Settings → Actions → Runners: строка $Name должна стать Idle (зелёная)."
    Write-Host "  2. Actions → «Обновить локальный стенд» → Run workflow — руками прогнать первый раз."
    Write-Host '  3. Проверка с машины: Get-ScheduledTask -TaskName crm-ci-runner'
}

Write-Host "Раннер GitHub Actions — $Repo" -ForegroundColor White
Write-Host ''

if ($Uninstall) { Uninstall-Runner } else { Install-Runner }
