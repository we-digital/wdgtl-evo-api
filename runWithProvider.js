const dotenv = require('dotenv');
const { execSync } = require('child_process');
const { existsSync } = require('fs');

dotenv.config();

const { DATABASE_PROVIDER } = process.env;
const databaseProviderDefault = DATABASE_PROVIDER ?? 'postgresql';

if (!DATABASE_PROVIDER) {
  console.warn(`DATABASE_PROVIDER is not set in the .env file, using default: ${databaseProviderDefault}`);
}

// Função para determinar qual pasta de migrations usar
// Função para determinar qual pasta de migrations usar
function getMigrationsFolder(provider) {
  switch (provider) {
    case 'psql_bouncer':
      return 'postgresql-migrations'; // psql_bouncer usa as migrations do postgresql
    default:
      return `${provider}-migrations`;
  }
}

const migrationsFolder = getMigrationsFolder(databaseProviderDefault);

let command = process.argv
  .slice(2)
  .join(' ')
  .replace(/DATABASE_PROVIDER/g, databaseProviderDefault);

// Substituir referências à pasta de migrations pela pasta correta
const migrationsPattern = new RegExp(`${databaseProviderDefault}-migrations`, 'g');
command = command.replace(migrationsPattern, migrationsFolder);

if (command.includes('rmdir') && existsSync('prisma\\migrations')) {
  try {
    execSync('rmdir /S /Q prisma\\migrations', { stdio: 'inherit' });
  } catch (error) {
    console.error(`Error removing directory: prisma\\migrations`);
    process.exit(1);
  }
} else if (command.includes('rmdir')) {
  console.warn(`Directory 'prisma\\migrations' does not exist, skipping removal.`);
}

// Session advisory locks must use a direct migration connection, while the
// application and client generation retain their configured pooled connection.
const isMigrationDeploy = /(?:^|&&)\s*npx\s+prisma\s+migrate\s+deploy(?:\s|$)/.test(command);
const migrationConnectionURI = process.env.DATABASE_MIGRATION_CONNECTION_URI;
const commandEnv =
  isMigrationDeploy && migrationConnectionURI
    ? { ...process.env, DATABASE_CONNECTION_URI: migrationConnectionURI }
    : process.env;

try {
  execSync(command, { stdio: 'inherit', env: commandEnv });
} catch (error) {
  console.error(`Error executing command: ${command}`);
  process.exit(1);
}
