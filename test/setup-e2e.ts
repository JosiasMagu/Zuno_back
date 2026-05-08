import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(process.cwd(), '.env');

if (!fs.existsSync(envPath)) {
  console.error('');
  console.error('ERRO: ficheiro .env nao encontrado em', envPath);
  console.error(
    'Os testes E2E precisam de DATABASE_URL_TEST definida no .env.',
  );
  console.error('');
  process.exit(1);
}

dotenv.config({ path: envPath });

const testDbUrl = process.env.DATABASE_URL_TEST;

if (!testDbUrl) {
  console.error('');
  console.error('ERRO: DATABASE_URL_TEST nao esta definida no .env');
  console.error('Adiciona uma linha tipo:');
  console.error(
    '  DATABASE_URL_TEST=postgresql://user:pass@localhost:5432/zuno_db_test',
  );
  console.error('');
  process.exit(1);
}

if (!testDbUrl.includes('zuno_db_test')) {
  console.error('');
  console.error(
    'ERRO: DATABASE_URL_TEST nao aponta para uma BD com "zuno_db_test" no nome.',
  );
  console.error(
    'Por seguranca, recusamos correr E2E numa BD que nao tem "test" no nome.',
  );
  console.error('Valor actual aponta para:', testDbUrl.split('/').pop());
  console.error('');
  process.exit(1);
}

process.env.DATABASE_URL = testDbUrl;
process.env.NODE_ENV = 'test';

if (!process.env.JWT_ACCESS_SECRET) {
  process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret';
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
}
if (!process.env.JWT_ACCESS_EXPIRES_IN) {
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
}
if (!process.env.JWT_REFRESH_EXPIRES_IN) {
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
}
if (!process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
}
