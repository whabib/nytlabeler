# NY Times Bluesky Labeler (`nytlabeler`)

An automated, custom social media post labeler for the AT Protocol (Bluesky) social network. It listens to the live ATProto Jetstream firehose, detects posts referencing article links from *The New York Times*, looks up corresponding metadata in a Cloud SQL PostgreSQL database (`nytdata`), and issues section, subsection, and author labels dynamically.

It includes a beautiful, real-time glassmorphic monitoring dashboard and a automated publishing workflow, designed for seamless containerization and deployment to Google Cloud Run.

---

## ✨ Features

* **Real-time Firehose Tracking**: Uses `@skyware/jetstream` to consume post creations on the Bluesky network with minimal latency.
* **Precise Match Engine**: Sanitizes/normalizes URLs to match canonical database storage and joins articles with authors.
* **Refined Taxonomy Scope**:
  * Emits raw section and subsection labels cleanly with no prefixes (e.g., `travel`, `review`).
  * Emits author labels *only* for authors of `opinion` section pieces who have written more than one total article in the database (e.g., `ross-douthat`).
* **ATProto Compliance**: Signs and transmits lower-case kebab-case labels (`val` tokens) while publishing beautiful proper-cased display names (`Ross Douthat`) in the locales registry.
* **Glassmorphic Web Dashboard**: Express + WebSocket control panel displaying real-time post throughput, matched database articles, system statistics, and active memory charts.
* **Cloud-Ready**: Bundled with a production-optimized multi-stage `Dockerfile` and a fully parameterized `deploy.sh` script for Google Cloud Run.

---

## 🛠️ Tech Stack

* **Language**: TypeScript (ESM, Target: ES2022)
* **ATProto Integration**: `@skyware/labeler`, `@skyware/jetstream`, `@atproto/api`
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
Fill in the database credentials and ATProto credentials:
```ini
# Environment Selector: 'development' or 'production'
ENV=development

# ATProto Credentials
BSKY_DID=did:plc:your-did
BSKY_SIGNING_KEY=your-signing-key
BSKY_IDENTIFIER=your-account@bsky.social
BSKY_PASSWORD=your-app-password

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=nytdata
DB_PASSWORD=your_password
DB_NAME=nytdata

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

### 3. VPC & Cloud SQL Settings
To ensure both the Service and Job can securely reach the PostgreSQL instance (VPC private IP `10.73.128.3`), `deploy.sh` supports the following connectivity parameters:
* **Gen 2 Direct VPC Egress**: Use `--direct-vpc <network_name>`
* **Serverless VPC Access**: Use `--vpc-connector <connector_name>`
* **Cloud SQL Auth Proxy**: If neither network option is specified, the script automatically mounts the Cloud SQL Auth proxy instance (`--add-cloudsql-instances`) as a fallback integration, resolving sockets securely.

---

## 📁 Repository Exclusion Configuration

We exclude sensitive credentials and localized binaries using `.gitignore` and `.dockerignore`.
* **`.gitignore`**: Excludes `.env`, local `node_modules/`, compiler build artifacts (`dist/`), local SQLite runtime database files generated by `@skyware/labeler` (`labels.db*`), and system configs.
* **`.dockerignore`**: Excludes documentation, deployment shell scripts, credentials, and local build states to keep Docker build context slim and extremely secure.
