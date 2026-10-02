/**
 * Компіляція apps/api (+ scripts/emit-openapi.ts) у dist-openapi/ з УВІМКНЕНИМ
 * @nestjs/swagger CLI-плагіном.
 *
 * Навіщо окремий скрипт, а не `tsc -p`:
 * у проєкті 71 рукописний `*ResponseDto`, де поля декоровані БЕЗ явного типу —
 * `@ApiPropertyOptional() notes?: string | null`. Swagger без плагіна не знає типу
 * такого поля, тож у документі з'являється порожня схема `{}`, а openapi-typescript
 * перетворює її на безкорисний `Record<string, never>`. Плагін читає TS-тип із AST і
 * дописує `type`/`nullable`/`required` у метадані — саме це робить згенеровані типи
 * точними (union-статуси, `string | null`) без правок у 71 DTO.
 *
 * Плагін — це звичайний TS-трансформер (`before`), тож підключаємо його через
 * Compiler API. Жодної мережі, жодної живої БД — лише AST.
 */
const ts = require('typescript');
const path = require('node:path');
const { before: swaggerPluginBefore } = require('@nestjs/swagger/plugin');

const configPath = path.resolve(__dirname, 'tsconfig.emit.json');
const parsed = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: d => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  },
);
if (!parsed) throw new Error(`Не вдалося прочитати ${configPath}`);

const program = ts.createProgram(parsed.fileNames, parsed.options);

const emitResult = program.emit(undefined, undefined, undefined, false, {
  before: [
    swaggerPluginBefore(
      {
        // dtoFileNameSuffix: наші DTO живуть у `<module>.dto.ts`, а не у `dto/*.dto.ts`,
        // тож дефолтний суфікс ['.dto.ts', '.entity.ts'] підходить — лишаємо явно
        // для читабельності + додаємо `.response.dto.ts` на випадок майбутніх файлів.
        dtoFileNameSuffix: ['.dto.ts', '.entity.ts'],
        controllerFileNameSuffix: ['.controller.ts'],
        // classValidatorShim: переносить правила class-validator (@IsEnum, @Min, @Max)
        // у схему — enum-и query-DTO стають union-ами, а не просто `string`.
        classValidatorShim: true,
        // introspectComments: JSDoc над полем стає `description` у схемі.
        introspectComments: true,
      },
      program,
    ),
  ],
});

const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) {
  const host = {
    getCanonicalFileName: f => f,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors.slice(0, 30), host));
  process.stderr.write(`\ncompile-for-openapi: ${errors.length} помилок компіляції\n`);
  process.exit(1);
}
