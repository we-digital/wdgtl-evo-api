#!/bin/bash

source ./Docker/scripts/env_functions.sh

if [ "$DOCKER_ENV" != "true" ]; then
    export_env_vars
fi

if [[ "$DATABASE_PROVIDER" == "postgresql" || "$DATABASE_PROVIDER" == "mysql" || "$DATABASE_PROVIDER" == "psql_bouncer" ]]; then
    export DATABASE_URL
    echo "Deploying migrations for $DATABASE_PROVIDER"
    echo "Database URL: $DATABASE_URL"
    # App Platform can restart multiple services at once. If another instance is
    # already running Prisma migrations, retry instead of failing the whole deploy
    # on a transient advisory lock timeout.
    MAX_DB_DEPLOY_ATTEMPTS="${DB_DEPLOY_MAX_ATTEMPTS:-6}"
    DB_DEPLOY_RETRY_DELAY="${DB_DEPLOY_RETRY_DELAY_SECONDS:-15}"
    attempt=1
    while true; do
        if npm run db:deploy; then
            echo "Migration succeeded"
            break
        fi

        if [ "$attempt" -ge "$MAX_DB_DEPLOY_ATTEMPTS" ]; then
            echo "Migration failed after $attempt attempts"
            exit 1
        fi

        echo "Migration attempt $attempt failed; retrying in $DB_DEPLOY_RETRY_DELAY seconds..."
        attempt=$((attempt + 1))
        sleep "$DB_DEPLOY_RETRY_DELAY"
    done

    npm run db:generate
    if [ $? -ne 0 ]; then
        echo "Prisma generate failed"
        exit 1
    else
        echo "Prisma generate succeeded"
    fi
else
    echo "Error: Database provider $DATABASE_PROVIDER invalid."
    exit 1
fi
