# NY Times Bluesky Labeler (`nytlabeler`)

An automated, custom social media post labeler for the AT Protocol (Bluesky) social network. It listens to the live ATProto Jetstream firehose, detects posts referencing article links from *The New York Times*, looks up corresponding metadata in a Cloud SQL PostgreSQL database (`nytdata`), and issues section, subsection, and author labels dynamically.

It includes a monitoring dashboard and a automated publishing workflow, designed for containerization and deployment to Google Cloud Run.

I won't say I vibe-coded this because I paid careful attention to what was done, but I did use Google Gemini to develop this. Realistically it would not have happened without it because I don't think I would have wanted to invest the time. It was also an interesting learning experience of both the pros and cons to this approach, and I'm
happy to discuss that. It definitely did some dumb things (that are still in here and I would fix if I had all day). But in general, I would not have delved as deeply in the ATProto docs and websocket programming myself and I do think this could be useful.

Most recent work has moved from Gemini to Claude Opus 5.5, pairing with Github Copilot reviews (which had many good comments). I didn't dislike Claude, but Google's Developer Program is a confusing mess and particularly hostile towards individual developers.

---

## ✨ Features

* **Real-time Firehose Tracking**: Uses a native JSON-over-WebSocket subscriber to Jetstream public endpoints to consume post creations with maximum resiliency.
* **Precise Match Engine**: Sanitizes/normalizes URLs to match canonical database storage and joins articles with authors.
* **Refined Taxonomy Scope**:
  * Emits raw section and subsection labels cleanly with no prefixes (e.g., `travel`, `review`).
  * Emits author labels *only* for authors of `opinion` section pieces who have written more than one total article in the database (e.g., `ross-douthat`).
* **ATProto Compliance**: Signs and transmits lower-case kebab-case labels (`val` tokens) while publishing beautiful proper-cased display names (`Ross Douthat`) in the locales registry.
* **Glassmorphic Web Dashboard**: Express + WebSocket control panel displaying real-time post throughput, matched database articles, system statistics, and active memory charts.
* **Cloud-Ready**: Bundled with a production-optimized multi-stage `Dockerfile` and a fully parameterized `deploy.sh` script for Google Cloud Run. The image is built on [Docker Hardened Images](https://dhi.io) (Alpine), with no npm or shell at runtime, and runs as a non-root user. CI fails on any critical or high vulnerability in it.

---

## 🛠️ Tech Stack

* **Language**: TypeScript (ESM, Target: ES2022)
* **ATProto Integration**: `whabib/labeler`, `@atproto/api`
* **Web Server**: Express, `ws` (WebSockets)
* **Database Client**: `pg` (PostgreSQL connection pool)
* **Runtime / Compiler**: `tsx` (TypeScript Execute), `typescript`
* **Hosting / CI**: Google Cloud Build, Google Cloud Run, Google Cloud SQL

---

## 📋 Database Schema Expectations

The local or remote PostgreSQL database (`nytdata`) should match the following Prisma-backed structure:

```sql
-- Article Table
CREATE TABLE "Article" (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    section TEXT,
    subsection TEXT,
    title TEXT
);

-- Author Table
CREATE TABLE "Author" (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

-- Many-to-Many Join Table
CREATE TABLE "_ArticleToAuthor" (
    "A" INTEGER NOT NULL REFERENCES "Article"(id) ON DELETE CASCADE,
    "B" INTEGER NOT NULL REFERENCES "Author"(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX "_ArticleToAuthor_AB_unique" ON "_ArticleToAuthor"("A", "B");
```

### Tables the labeler creates

The service creates these in the `labeler` schema at startup, one per environment (e.g. `_development`):

- **`labeler.labels_<environment>`**: the signed labels, owned by the labeler library. Their ids are the `subscribeLabels` sequence numbers.
- **`labeler.post_articles_<environment>`**: which nytdata articles each labeled post linked, for metrics. It has one row per (post, article) with the post `uri`, `author_did`, `article_id` (`"Article".id`) and `created_at`. It covers posts labeled from September 2026 on. Recording is best-effort and never holds up labeling.

```sql
-- Most-shared articles in the last week
SELECT a.title, a.section, COUNT(*) AS posts
FROM labeler.post_articles_development pa
JOIN "Article" a ON a.id = pa.article_id
WHERE pa.created_at > now() - interval '7 days'
GROUP BY a.id ORDER BY posts DESC LIMIT 20;

-- The labels a post received
SELECT pa.article_id, l.val
FROM labeler.post_articles_development pa
JOIN labeler.labels_development l ON l.uri = pa.uri;
```

---

## 🚀 Setup & Local Installation

### 1. Clone & Install Dependencies
```bash
git clone <your-repository-url>
cd nytlabeler
npm install
```

### 2. Configure Environment variables
Copy the template `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Fill in the database connection string and ATProto credentials:
```ini
# Environment Selector: 'development' or 'production'
ENV=development

# ATProto Credentials
BSKY_DID=did:plc:your-did
BSKY_SIGNING_KEY=your-signing-key
BSKY_IDENTIFIER=your-account.bsky.social
BSKY_PASSWORD=your-app-password

# PostgreSQL Database Configuration (unified connection string)
DATABASE_URL=postgresql://nytdata@localhost:5432/nytdata

# Dry Run Mode (Highly recommended for development)
# Set to 'true' to parse, query, and monitor logs, but do NOT push labels or definitions to Bluesky.
DRY_RUN=true
```

### 3. Build & Run
Compile TypeScript and make sure there are no errors:
```bash
npm run build
```

Start the application locally with live-reload (monitoring the firehose in Dry Run mode):
```bash
npm run dev
```

Open [http://localhost:4100](http://localhost:4100) in your browser to inspect the Web Dashboard and watch live firehose throughput!

### 4. Running Unit Tests
We provide a complete automated unit test suite with 10 built-in test specs targeting database matching, URL normalization, slugification, and active author filters.

To execute the unit test suite locally:
```bash
npm run test
```

---

## 🏷️ Publishing Label Definitions (Taxonomy)

Before your labeler can assign labels that clients (like the Bluesky app or Ozone) recognize, you must compile and publish the service's taxonomy record.

The publisher script queries your PostgreSQL database for all distinct sections/subsections and active opinion authors, registers proper descriptive names inside the locales array, and uploads the policy schema to ATProto:

```bash
# Test and view compiled taxonomy record (Dry Run mode)
npm run publish-definitions

# Publish live to your Bluesky account (Ensure DRY_RUN=false in .env)
npm run publish-definitions
```

---

## 🐳 Deployment to Google Cloud Run (Service & Job)

We provide a streamlined deployment process to containerize and publish the application to Google Cloud Run. 

The deployment pipeline is unique: it creates and updates **both** a long-running **Cloud Run Service** (for the live firehose listener and WebSocket telemetry dashboard) and a one-shot **Cloud Run Job** (configured to run the `dist/publish-definitions.js` taxonomy population script on demand).

### 1. Build and Deploy Script
Use the provided `deploy.sh` wrapper script, which leverages **Google Cloud Build** to construct the container image and deploy both Cloud Run resources:

```bash
chmod +x deploy.sh

# Deploy to Development
# - Service: nyt-labeler-dev (mapped to nyt-labeler-dev.warren.nyc)
# - Job:     nyt-labeler-dev-job
./deploy.sh --env dev --project pointless-enterprises --region us-central1

# Deploy to Production
# - Service: nyt-labeler (mapped to nyt-labeler.warren.nyc)
# - Job:     nyt-labeler-job
./deploy.sh --env prod --project pointless-enterprises --region us-central1
```

### 2. Running the Taxonomy Publisher Job
Once deployed, you can trigger the one-shot Cloud Run Job directly to query the hosted database and publish/update your taxonomy on the live Bluesky network:
```bash
# Trigger the dev job
gcloud run jobs execute nyt-labeler-dev-job --region us-central1

# Trigger the prod job
gcloud run jobs execute nyt-labeler-job --region us-central1
```

### 3. Secret Manager & Cloud SQL Connection Settings
To maximize security, sensitive environment credentials are retrieved dynamically from **Google Secret Manager** during Cloud Run Service and Job startup:

* **Database Connection (`DATABASE_URL`)**:
  - Store your database URI as a secret named `DATABASE_URL` in Secret Manager.
  - Secret format: `postgresql://[user[:password]@]host[:port][/dbname]`.
  - Mapped automatically via `--set-secrets="DATABASE_URL=DATABASE_URL:latest"`.

* **Bluesky / ATProto Credentials (`BSKY_SIGNING_KEY` & `BSKY_PASSWORD`)**:
  - Create Google Secrets named `BSKY_SIGNING_KEY` and `BSKY_PASSWORD`.
  - Add secret versions with appropriate values for development and production.
  - Apply version aliases (`dev` and `prod`) to those versions.
  - Mapped automatically via `--set-secrets` using the corresponding environment version alias (e.g., `BSKY_SIGNING_KEY:dev` or `BSKY_SIGNING_KEY:prod`).

* **VPC Connectivity (to VPC private IP `10.73.128.3`)**:
  - **Gen 2 Direct VPC Egress**: Use `--direct-vpc <network_name>`
  - **Serverless VPC Access**: Use `--vpc-connector <connector_name>`
  - **Cloud SQL Auth Proxy fallback**: If neither network option is specified, the script automatically mounts the Cloud SQL Auth proxy instance (`--add-cloudsql-instances`) as a fallback integration, resolving sockets securely.

### 4. Deploying on release (GitHub Actions)

`.github/workflows/deploy-dev.yml` deploys to **nyt-labeler-dev** when a GitHub release is published (e.g. tag `1.2.0`):

1. It runs the test suite on the tagged commit.
2. It checks that the tag is on `main`.
3. It runs the same command as a manual deploy: `./deploy.sh --env dev --direct-vpc default`.
4. It checks that the service responds.

To redeploy a release, run the workflow from the Actions tab and pick the release **tag** under "Use workflow from".

GitHub stores no key or secret for this. The job signs in with [Workload Identity Federation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account). The signing key, Bluesky password and database URL stay in Secret Manager, as with a manual deploy.

**What stops other code from deploying.** Anyone who can push could write their own workflow, so the workflow's own checks aren't what protects the deploy account. These three layers are, and each is enforced outside the workflow file:

1. **Google Cloud** issues tokens only to runs of this repository from a **tag**, and only to jobs in the **`dev` environment**.
2. **The `dev` environment** accepts deployments only from tags matching `*.*.*`, so GitHub blocks any branch run before it starts.
3. **The "Release tags" ruleset** lets only repository admins create, move or delete `*.*.*` tags, so nobody else can make a tag that passes 1 and 2.

To also approve each deploy by hand, add yourself as a required reviewer under **Settings → Environments → dev**.

This setup was done on 2026-09-28. The commands below are kept as a record, and for setting it up again.

**One-time setup in Google Cloud** (as a project owner):

```bash
PROJECT_ID=pointless-enterprises
PROJECT_NUMBER=506551886695
SA=github-deployer@${PROJECT_ID}.iam.gserviceaccount.com

# Security Token Service, which exchanges GitHub's token for a Google one
gcloud services enable sts.googleapis.com --project=$PROJECT_ID

# A pool and provider that accept GitHub's tokens only for tag runs of this repository
gcloud iam workload-identity-pools create github --project=$PROJECT_ID --location=global \
  --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc nytlabeler --project=$PROJECT_ID \
  --location=global --workload-identity-pool=github --display-name="whabib/nytlabeler" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref_type=assertion.ref_type" \
  --attribute-condition="assertion.repository == 'whabib/nytlabeler' && assertion.ref_type == 'tag'"

# The account deploys run as
gcloud iam service-accounts create github-deployer --project=$PROJECT_ID \
  --display-name="GitHub Actions deployer (nytlabeler)" \
  --description="Deploys nyt-labeler-dev from release tags via .github/workflows/deploy-dev.yml"

# Only jobs in the repository's "dev" environment may use it
gcloud iam service-accounts add-iam-policy-binding $SA --project=$PROJECT_ID \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/subject/repo:whabib/nytlabeler:environment:dev"

# What deploy.sh needs: deploy Cloud Run services and jobs, run Cloud Build (roles/viewer
# lets gcloud stream the build log), upload the source, and run things as the runtime account
for role in roles/run.admin roles/cloudbuild.builds.editor roles/viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=$role --condition=None
done
gcloud storage buckets add-iam-policy-binding gs://${PROJECT_ID}_cloudbuild \
  --member="serviceAccount:$SA" --role=roles/storage.admin
gcloud iam service-accounts add-iam-policy-binding ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
  --project=$PROJECT_ID --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser
```

**One-time setup in GitHub:** create the `dev` environment (tags only), its variables and the tag ruleset. None of the variables are secret:

```bash
# The dev environment, accepting deployments from release tags only
gh api -X PUT repos/whabib/nytlabeler/environments/dev \
  --input - <<< '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
gh api -X POST repos/whabib/nytlabeler/environments/dev/deployment-branch-policies -f name='*.*.*' -f type=tag

# What deploy.sh reads from .env
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --env dev \
  --body "projects/506551886695/locations/global/workloadIdentityPools/github/providers/nytlabeler"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --env dev --body "github-deployer@pointless-enterprises.iam.gserviceaccount.com"
gh variable set BSKY_DID --env dev --body "did:plc:diitczh77g62vvea5fjbbz6b"
gh variable set BSKY_IDENTIFIER --env dev --body "nyt-labeler-dev.bsky.social"
gh variable set FIREHOSE_URL --env dev --body "wss://jetstream1.us-east.bsky.network/subscribe"
gh variable set WANTED_COLLECTION --env dev --body "app.bsky.feed.post"

# Only admins (actor 5 is the Admin repository role) may create, move or delete release tags
gh api -X POST repos/whabib/nytlabeler/rulesets --input - <<'JSON'
{
  "name": "Release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/*.*.*"], "exclude": [] } },
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
}
JSON
```

---

## 📁 Repository Exclusion Configuration

We exclude sensitive credentials and localized binaries using `.gitignore` and `.dockerignore`.
* **`.gitignore`**: Excludes `.env`, local `node_modules/`, compiler build artifacts (`dist/`), local SQLite database files from older versions of `labeler` (`labels.db*`), and system configs.
* **`.dockerignore`**: Excludes documentation, deployment shell scripts, credentials, and local build states to keep Docker build context slim and extremely secure.

---

## 🚦 Continuous Integration (GitHub Actions)

We have configured an automated continuous integration workflow inside `.github/workflows/test.yml` that:
* Triggers on any Push or Pull Request targetting `main` or `master`.
* Sets up Node.js 24 environment on `ubuntu-latest`.
* Automatically installs workspace dependencies cleanly (`npm ci`).
* Executes the full unit test suite (`npm run test`) to verify all URL normalization, slugification, and label filtering assertions pass successfully before merge.

The deploy workflow (`.github/workflows/deploy-dev.yml`, see [Deploying on release](#4-deploying-on-release-github-actions)) calls the same test workflow on each release before deploying it.
