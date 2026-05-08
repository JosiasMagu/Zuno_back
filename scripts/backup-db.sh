#!/usr/bin/env bash
# Backup da base de dados Postgres do Zuno.
#
# Uso:
#   DATABASE_URL=postgres://user:pass@host:5432/db  scripts/backup-db.sh
#
# Variaveis:
#   DATABASE_URL   (obrigatoria)
#   BACKUP_DIR     destino local (default: ./backups)
#   BACKUP_PREFIX  prefixo do ficheiro (default: zuno)
#   RETENTION_DAYS apaga locais com mais de N dias (default: 14, 0=desligado)
#   S3_BUCKET      se definido, faz upload via aws-cli para s3://$S3_BUCKET/...
#
# O dump usa formato custom (pg_dump -Fc) e gzip. Restaura com:
#   gunzip -c file.dump.gz | pg_restore -d "$DATABASE_URL" --clean --if-exists
#
# Recomendado correr via cron diario fora de horas de pico:
#   0 3 * * *  cd /opt/zuno && ./scripts/backup-db.sh >> /var/log/zuno-backup.log 2>&1

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERRO: DATABASE_URL nao esta definida." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-zuno}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

timestamp=$(date -u +"%Y%m%dT%H%M%SZ")
filename="${BACKUP_PREFIX}-${timestamp}.dump.gz"
filepath="${BACKUP_DIR}/${filename}"

echo "[$(date -Iseconds)] backup -> ${filepath}"

pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$filepath"

size=$(du -h "$filepath" | awk '{print $1}')
echo "[$(date -Iseconds)] feito (${size})"

if [[ -n "${S3_BUCKET:-}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "AVISO: aws-cli nao encontrado. A saltar upload S3." >&2
  else
    s3_key="zuno-backups/$(date -u +"%Y/%m/%d")/${filename}"
    echo "[$(date -Iseconds)] upload -> s3://${S3_BUCKET}/${s3_key}"
    aws s3 cp "$filepath" "s3://${S3_BUCKET}/${s3_key}"
  fi
fi

if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -name "${BACKUP_PREFIX}-*.dump.gz" -mtime +"$RETENTION_DAYS" -print -delete
fi
