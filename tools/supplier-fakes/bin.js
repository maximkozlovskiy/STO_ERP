#!/usr/bin/env node
'use strict';
// Запуск фейків окремим процесом (E2E, ручна перевірка): node tools/supplier-fakes/bin.js --port 4100
const { startSupplierFakes } = require('./index');

const argPort = process.argv.indexOf('--port');
const port = argPort > -1 ? Number(process.argv[argPort + 1]) : Number(process.env.PORT || 4100);

startSupplierFakes({ port, host: process.env.HOST || '127.0.0.1' }).then(f => {
  process.stdout.write(`supplier-fakes: ${f.url} (${f.providers.join(', ')})\n`);
  const stop = () => f.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
