# Postgres MCP (лише читання) на dev-машині: роль sto_readonly у dev-базі + змінна користувача
# STO_DB_READONLY_URI, яку читає .mcp.json. Повторний запуск змінює пароль (роль і права — ті самі).
#
# Захист тримають ПРАВА ролі (pg_read_all_data + pg_monitor, без INSERT/UPDATE/DELETE/CREATE), а не
# default_transaction_read_only — його сесія може вимкнути сама. Хост 127.0.0.1, не localhost:
# образ postgres-mcp для localhost друкує рядок підключення разом із паролем у свій лог.
#
#   powershell -File scripts/mcp/setup-readonly-db.ps1
# Після запуску перезапустити VS Code / Claude Code, щоб процес побачив нову змінну.

$ErrorActionPreference = 'Stop'
$container = 'stoerp-postgres-1'

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pw = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''

$sql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sto_readonly') THEN CREATE ROLE sto_readonly LOGIN; END IF;
END `$`$;
ALTER ROLE sto_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$pw';
ALTER ROLE sto_readonly SET default_transaction_read_only = on;
GRANT pg_read_all_data TO sto_readonly;
GRANT pg_monitor TO sto_readonly;
"@

$sql | wsl -e docker exec -i $container psql -U sto -d sto_erp -v ON_ERROR_STOP=1 -q
if ($LASTEXITCODE -ne 0) { throw "psql завершився з кодом $LASTEXITCODE" }

[Environment]::SetEnvironmentVariable(
  'STO_DB_READONLY_URI',
  "postgresql://sto_readonly:$pw@127.0.0.1:5432/sto_erp",
  'User'
)
Write-Output 'sto_readonly готова, STO_DB_READONLY_URI записано для користувача. Перезапустіть VS Code.'
