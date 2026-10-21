#!/usr/bin/env node
// headersHelper для GitHub MCP (.mcp.json): заголовки авторизації з токена, який git уже тримає в
// менеджері облікових даних. Токен не зберігається ні у файлах, ні в змінних середовища.
// `actions` — інструменти GitHub Actions (запуски й логи CI) понад типовий набір.
const { execSync } = require('node:child_process');

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  stdio: ['pipe', 'pipe', 'ignore'],
}).toString();
const token = /^password=(.*)$/m.exec(cred)?.[1]?.trim();
if (!token) {
  process.stderr.write('github-auth-headers: git не має токена для github.com\n');
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'default,actions' }),
);
