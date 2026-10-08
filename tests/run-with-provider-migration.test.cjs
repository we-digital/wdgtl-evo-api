const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../runWithProvider.js'), 'utf8');
const pool = 'postgresql://fixture:synthetic@localhost:25061/pool?schema=public';
const direct = 'postgresql://fixture:synthetic@localhost:25060/database?schema=public';

function run(command, overrides = {}, fail = false) {
  const env = { ...process.env, DATABASE_PROVIDER: 'postgresql', DATABASE_CONNECTION_URI: pool, ...overrides };
  delete env.DATABASE_MIGRATION_CONNECTION_URI;
  Object.assign(env, overrides);
  const before = { ...env };
  const calls = [];
  const logs = [];
  const processStub = {
    env,
    argv: ['node', 'runWithProvider.js', command],
    exit(code) {
      throw { exitCode: code };
    },
  };
  let exitCode = 0;
  try {
    vm.runInNewContext(source, {
      process: processStub,
      console: {
        log: (...v) => logs.push(v.join(' ')),
        warn: (...v) => logs.push(v.join(' ')),
        error: (...v) => logs.push(v.join(' ')),
      },
      require(name) {
        if (name === 'dotenv') return { config() {} };
        if (name === 'fs')
          return {
            existsSync() {
              return false;
            },
          };
        if (name === 'child_process')
          return {
            execSync(actualCommand, options) {
              const child = JSON.parse(
                execFileSync(
                  process.execPath,
                  [
                    '-e',
                    'process.stdout.write(JSON.stringify({uri:process.env.DATABASE_CONNECTION_URI,provider:process.env.DATABASE_PROVIDER}))',
                  ],
                  { env: options.env, encoding: 'utf8' },
                ),
              );
              calls.push({ command: actualCommand, child, stdio: options.stdio });
              if (fail) throw new Error('synthetic subprocess failure');
            },
          };
        throw new Error('unexpected dependency');
      },
    });
  } catch (error) {
    if (!Number.isInteger(error.exitCode)) throw error;
    exitCode = error.exitCode;
  }
  assert.deepEqual(env, before, 'parent application environment remains unchanged');
  assert.ok(
    logs.every((line) => !line.includes(pool) && !line.includes(direct)),
    'no connection URI logs',
  );
  return { calls, exitCode };
}

test('migration deploy gets explicit direct URI only in its subprocess', () => {
  const result = run(
    'rm -rf ./prisma/migrations && cp -r ./prisma/DATABASE_PROVIDER-migrations ./prisma/migrations && npx prisma migrate deploy --schema ./prisma/DATABASE_PROVIDER-schema.prisma',
    { DATABASE_MIGRATION_CONNECTION_URI: direct },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].child.uri, direct);
  assert.equal(result.calls[0].stdio, 'inherit');
  assert.match(result.calls[0].command, /postgresql-migrations/);
  assert.match(result.calls[0].command, /postgresql-schema\.prisma/);
});

test('absent or empty migration override retains the configured URI', () => {
  for (const overrides of [{}, { DATABASE_MIGRATION_CONNECTION_URI: '' }]) {
    assert.equal(
      run('npx prisma migrate deploy --schema prisma/DATABASE_PROVIDER-schema.prisma', overrides).calls[0].child.uri,
      pool,
    );
  }
});

test('generate, migrate dev and lookalike commands retain application URI', () => {
  for (const command of [
    'npx prisma generate --schema prisma/DATABASE_PROVIDER-schema.prisma',
    'npx prisma migrate dev',
    'echo npx prisma migrate deploy',
  ]) {
    assert.equal(run(command, { DATABASE_MIGRATION_CONNECTION_URI: direct }).calls[0].child.uri, pool);
  }
});

test('provider substitution remains intact with a separately configured migration URI', () => {
  const result = run('npx prisma migrate deploy --schema prisma/DATABASE_PROVIDER-schema.prisma', {
    DATABASE_PROVIDER: 'mysql',
    DATABASE_MIGRATION_CONNECTION_URI: 'mysql://fixture:synthetic@localhost/database',
  });
  assert.equal(result.calls[0].child.uri, 'mysql://fixture:synthetic@localhost/database');
  assert.match(result.calls[0].command, /mysql-schema\.prisma/);
});

test('migration errors still fail instead of starting an application', () => {
  const result = run('npx prisma migrate deploy', { DATABASE_MIGRATION_CONNECTION_URI: direct }, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.length, 1);
});
