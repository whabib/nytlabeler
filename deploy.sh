#!/usr/bin/env bash
#
# NY Times Bluesky Labeler (nytlabeler) - Deployment Script
# Deploys both the long-running Service and the one-shot publisher Job to Google Cloud Run.
#

set -euo pipefail

# --- CONFIGURATION DEFAULTS ---
PROJECT_ID="pointless-enterprises"
REGION="us-central1"
DB_HOST_PROD="10.73.128.3" # Private VPC IP of Cloud SQL nytdata
DB_NAME="nytdata"
DB_USER="nytdata"

# Help / Usage block
usage() {
  echo "Usage: $0 [options]"
  echo "Options:"
  echo "  --env <dev|prod>      Target environment (default: dev)"
  echo "  --project <id>        Google Cloud Project ID (default: pointless-enterprises)"
  echo "  --region <region>     Google Cloud Region (default: us-central1)"
  echo "  --vpc-connector <n>   Serverless VPC Access connector name if needed"
  echo "  --direct-vpc <net>    VPC network name for direct Gen2 VPC egress (e.g., 'default')"
  echo "  --help                Show this message"
  exit 1
}

# Parse command line options
TARGET_ENV="dev"
VPC_CONNECTOR=""
DIRECT_VPC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      TARGET_ENV="$2"
      shift 2
      ;;
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --vpc-connector)
      VPC_CONNECTOR="$2"
      shift 2
      ;;
    --direct-vpc)
      DIRECT_VPC="$2"
      shift 2
      ;;
    --help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [[ "$TARGET_ENV" != "dev" && "$TARGET_ENV" != "prod" ]]; then
  echo "❌ Error: --env must be either 'dev' or 'prod'."
  exit 1
fi

# Set environment-specific variables
if [ "$TARGET_ENV" = "dev" ]; then
  SERVICE_NAME="nyt-labeler-dev"
  CUSTOM_DOMAIN="nyt-labeler-dev.warren.nyc"
  APP_ENV="development"
else
  SERVICE_NAME="nyt-labeler"
  CUSTOM_DOMAIN="nyt-labeler.warren.nyc"
  APP_ENV="production"
fi

JOB_NAME="${SERVICE_NAME}-job"
IMAGE_TAG="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

echo "================================================================"
echo "🚀 Preparing deployment of NY Times Bluesky Labeler"
echo "   Target Env   : ${TARGET_ENV} (${APP_ENV})"
echo "   Service Name : ${SERVICE_NAME}"
echo "   Job Name     : ${JOB_NAME}"
echo "   Custom Domain: ${CUSTOM_DOMAIN}"
echo "   GCP Project  : ${PROJECT_ID}"
echo "   GCP Region   : ${REGION}"
echo "   Docker Image : ${IMAGE_TAG}"
echo "================================================================"

# Check if logged in and project is set
echo "🔍 Checking gcloud configuration..."
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
  echo "⚠️ Warning: Current gcloud project is '${CURRENT_PROJECT}'. Setting it to '${PROJECT_ID}'."
  gcloud config set project "${PROJECT_ID}"
fi

# Load existing environment variables if present to pass ATProto credentials
echo "🔑 Reading secrets from .env..."
if [ -f .env ]; then
  # Source .env but ignore commented lines
  export $(grep -v '^#' .env | xargs)
else
  echo "❌ Error: Local .env file not found. Please configure .env with ATProto credentials first."
  exit 1
fi

# Build list of environment variables for Cloud Run
ENV_VARS="ENV=${APP_ENV}"
ENV_VARS="${ENV_VARS},PORT=8080"
ENV_VARS="${ENV_VARS},DRY_RUN=false"
ENV_VARS="${ENV_VARS},DB_NAME=${DB_NAME}"
ENV_VARS="${ENV_VARS},DB_USER=${DB_USER}"
ENV_VARS="${ENV_VARS},DB_HOST=${DB_HOST_PROD}"
ENV_VARS="${ENV_VARS},DB_PASSWORD=${DB_PASSWORD:-}"

# Unified ATProto credentials passed directly from local env
ENV_VARS="${ENV_VARS},BSKY_DID=${BSKY_DID:-}"
ENV_VARS="${ENV_VARS},BSKY_SIGNING_KEY=${BSKY_SIGNING_KEY:-}"
ENV_VARS="${ENV_VARS},BSKY_IDENTIFIER=${BSKY_IDENTIFIER:-}"
ENV_VARS="${ENV_VARS},BSKY_PASSWORD=${BSKY_PASSWORD:-}"

# Add optional firehose parameters
if [ -n "${FIREHOSE_URL:-}" ]; then
  ENV_VARS="${ENV_VARS},FIREHOSE_URL=${FIREHOSE_URL}"
fi
if [ -n "${WANTED_COLLECTION:-}" ]; then
  ENV_VARS="${ENV_VARS},WANTED_COLLECTION=${WANTED_COLLECTION}"
fi

# Build the container using Cloud Build
echo "📦 Building and uploading container image via Cloud Build..."
gcloud builds submit --tag "${IMAGE_TAG}" .

# Prepare gcloud deploy command options for the Service
echo "🚀 Deploying Cloud Run Service: ${SERVICE_NAME}..."
DEPLOY_FLAGS=(
  "--image" "${IMAGE_TAG}"
  "--platform" "managed"
  "--region" "${REGION}"
  "--project" "${PROJECT_ID}"
  "--set-env-vars" "${ENV_VARS}"
  "--allow-unauthenticated"
)

# VPC Egress settings to reach private IP of Cloud SQL
if [ -n "$DIRECT_VPC" ]; then
  echo "🔗 Configuring Direct VPC Egress (Gen 2) on network '${DIRECT_VPC}'..."
  DEPLOY_FLAGS+=("--vpc-network" "$DIRECT_VPC" "--vpc-egress" "private-ranges-only")
elif [ -n "$VPC_CONNECTOR" ]; then
  echo "🔗 Configuring Serverless VPC Access Connector '${VPC_CONNECTOR}'..."
  DEPLOY_FLAGS+=("--vpc-connector" "$VPC_CONNECTOR" "--vpc-egress" "private-ranges-only")
else
  # Always attach Cloud SQL Auth proxy instance as a reliable alternative
  echo "🔗 Adding Cloud SQL connection proxy as a fallback integration..."
  DEPLOY_FLAGS+=("--add-cloudsql-instances" "${PROJECT_ID}:${REGION}:${DB_NAME}")
fi

gcloud run deploy "${SERVICE_NAME}" "${DEPLOY_FLAGS[@]}"

# Map Custom Domain if supported in the region
echo "🌐 Configuring custom domain mapping for ${CUSTOM_DOMAIN}..."
set +e
gcloud beta run domain-mappings create \
  --service "${SERVICE_NAME}" \
  --domain "${CUSTOM_DOMAIN}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" 2>/dev/null || echo "ℹ️ Custom domain mapping already exists or is managed externally."
set -e

# Prepare gcloud run jobs deploy options for the Job
echo "🚀 Deploying Cloud Run Job: ${JOB_NAME}..."
JOB_FLAGS=(
  "--image" "${IMAGE_TAG}"
  "--region" "${REGION}"
  "--project" "${PROJECT_ID}"
  "--set-env-vars" "${ENV_VARS}"
)

# VPC / Cloud SQL connection settings for the Job
if [ -n "$DIRECT_VPC" ]; then
  JOB_FLAGS+=("--vpc-network" "$DIRECT_VPC" "--vpc-egress" "private-ranges-only")
elif [ -n "$VPC_CONNECTOR" ]; then
  JOB_FLAGS+=("--vpc-connector" "$VPC_CONNECTOR" "--vpc-egress" "private-ranges-only")
else
  JOB_FLAGS+=("--add-cloudsql-instances" "${PROJECT_ID}:${REGION}:${DB_NAME}")
fi

# Override container command to execute the taxonomy script instead of main daemon
JOB_FLAGS+=("--command" "node" "--args" "dist/publish-definitions.js")

gcloud run jobs deploy "${JOB_NAME}" "${JOB_FLAGS[@]}"

echo "================================================================"
echo "🎉 SUCCESS: Deployment to ${APP_ENV} is complete!"
echo "🌐 Service URL : ${CUSTOM_DOMAIN}"
echo "💼 One-shot Job: ${JOB_NAME}"
echo "🚀 Run the Job using: gcloud run jobs execute ${JOB_NAME} --region ${REGION}"
echo "================================================================"
