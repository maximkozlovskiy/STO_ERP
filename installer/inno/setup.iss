#define AppName "STO ERP"
#define AppVersion "1.0.0"
#define AppPublisher "STO ERP"
#define AppURL "https://sto-erp.ua"
#define AppInstallDir "{commonpf64}\STO-ERP"
#define DataDir "{commonappdata}\STO-ERP"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={#AppInstallDir}
DefaultGroupName={#AppName}
OutputDir=..\output
OutputBaseFilename=STO-ERP-Setup-v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
MinVersion=10.0.17763
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
WizardSizePercent=120
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\icon.ico
LicenseFile=..\assets\license_uk.rtf
WizardImageFile=..\assets\wizard.bmp
WizardSmallImageFile=..\assets\header.bmp

[Languages]
Name: "ukrainian"; MessagesFile: ".\messages_uk.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}:"
Name: "autostart";   Description: "Запускати STO ERP при старті Windows"; GroupDescription: "Додаткові параметри:"; Checked: yes

[Files]
; Docker images (bundle — gitignored, CI-generated)
Source: "..\bundle\images\*";              DestDir: "{tmp}\images";  Flags: deleteafterinstall; Check: BundleExists
Source: "..\bundle\docker-desktop-installer.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: BundleExists
Source: "..\bundle\nssm.exe";              DestDir: "{app}\bin"
; Production compose + Caddyfile
Source: "..\..\docker-compose.yml";        DestDir: "{#DataDir}"
Source: "..\..\Caddyfile";                 DestDir: "{#DataDir}"; Check: CaddyfileExists
; PowerShell scripts
Source: "..\scripts\*";                    DestDir: "{app}\scripts"; Flags: recursesubdirs
; Assets
Source: "..\assets\icon.ico";              DestDir: "{app}"

[Icons]
Name: "{group}\{#AppName}";       Filename: "{#DataDir}\STO ERP.url"; IconFilename: "{app}\icon.ico"
Name: "{group}\Зупинити STO ERP"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Update.ps1"""; IconFilename: "{app}\icon.ico"
Name: "{userdesktop}\{#AppName}"; Filename: "{#DataDir}\STO ERP.url"; Tasks: desktopicon; IconFilename: "{app}\icon.ico"

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Check-Requirements.ps1"""; Flags: runhidden waituntilterminated; StatusMsg: "Перевірка системних вимог..."; Check: not WizardSilent
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Install-Docker.ps1"" -BundlePath ""{tmp}"""; Flags: runhidden waituntilterminated; StatusMsg: "Встановлення Docker Desktop..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Setup-Stack.ps1"" -DataDir ""{#DataDir}"" -ImagesDir ""{tmp}\images"""; Flags: runhidden waituntilterminated; StatusMsg: "Розгортання STO ERP..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\First-Run.ps1"" -DataDir ""{#DataDir}"""; Flags: runhidden waituntilterminated; StatusMsg: "Перший запуск системи..."
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Register-Service.ps1"" -AppDir ""{app}"" -DataDir ""{#DataDir}"""; Flags: runhidden waituntilterminated; StatusMsg: "Реєстрація Windows Service..."; Tasks: autostart

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\Uninstall.ps1"" -DataDir ""{#DataDir}"" -AppDir ""{app}"""; Flags: runhidden waituntilterminated

[Code]
function BundleExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{src}\..\bundle\nssm.exe'));
end;

function CaddyfileExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{src}\..\..\Caddyfile'));
end;
