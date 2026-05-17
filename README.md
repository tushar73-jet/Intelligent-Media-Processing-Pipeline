# Intelligent Media Processing Pipeline

A highly performant, production-grade, distributed backend system designed to accept vehicle images, process them asynchronously using a message queue, and perform computer-vision heuristics and text-extraction checks.

---

## 🚀 Key Production Features

1. **Robust Asynchronous Processing**: Utilizes Express as the API gateway and BullMQ (backed by Redis) as the message queue to decouple ingestion from processing.
2. **Perceptual Hashing (dHash)**: Implements standard SHA-256 for exact duplicates and dHash with configurable Hamming distance (`DHASH_THRESHOLD`) for near-duplicate image detection.
3. **Real-time Push Notifications (SSE & Webhooks)**: Implements Server-Sent Events (SSE) via `/api/status/:id/events` for high-throughput, unidirectional client updates, alongside configurable webhook triggers.
4. **Token-Bucket Rate Limiting**: Features a Redis-backed, stateful token-bucket rate limiter that supports customizable capacities and refill rates per API key (with fallback to client IP).
5. **Observability Suite**: 
   - **Prometheus Metrics**: Exposes queue depth, job status, and test pass-rate gauges on `/metrics`.
   - **Distributed Tracing**: Integrates OpenTelemetry (OTel) to trace individual checks (`checkBlur`, `checkBrightness`, etc.) for bottleneck detection.
   - **Request ID Tracking**: Employs `express-request-id` to trace requests from origin to workers.
6. **Strict Validation**: Enforces image dimensions (minimum 200x200 px) and filters zero-byte files prior to enqueuing.
7. **Concurrency Guard**: Employs PostgreSQL advisory locks (`pg_advisory_xact_lock`) on file hashes in the worker to prevent race conditions during concurrent duplicate checks.

---

## 🏗 Architecture Overview

```mermaid
graph TD
    Client[Web Client / API Consumer] -->|POST /api/upload| API[Express API Server]
    API -->|Redis Token Bucket| Limiter[Rate Limiter]
    API -->|Dimension & Integrity Check| SharpValidation[Sharp Validation]
    API -->|Write metadata status=pending| DB[(PostgreSQL)]
    API -->|Enqueue Job| Queue[BullMQ Redis Queue]
    Queue -->|Asynchronous Pickup| Worker[Independent Worker Service]
    Worker -->|Postgres Advisory Lock on Hash| LockManager[Lock Manager]
    Worker -->|Run Image Checks in Parallel| RunChecks[Image Processing Checks]
    RunChecks -->|Check Blur - Sharp| Blur[Blur Detection]
    RunChecks -->|Check Brightness - Sharp| Brightness[Brightness Assessment]
    RunChecks -->|Perceptual Hashing - dHash| dHash[Deduplication Check]
    RunChecks -->|Screenshot Check - EXIF| Screenshot[Screenshot Verification]
    RunChecks -->|OCR Engine - Tesseract/Vision| OCR[License Plate OCR]
    RunChecks -->|OpenTelemetry Tracing| OTel[OTel SDK]
    Worker -->|Save Check Results| DB
    Worker -->|Publish Status completed/failed| RedisPubSub[Redis Pub/Sub]
    RedisPubSub -->|Stream Events to Client| SSE[SSE /api/status/:id/events]
    Worker -->|POST callback| Webhook[Client Webhook URL]
```

---

## 🛠 Tech Stack Trade-offs

During development, several structural and design trade-offs were carefully considered to balance scalability, latency, cost, and developer experience:

### 1. Database Polling vs. Server-Sent Events (SSE)
* **Polling (Old approach)**: Clients repeatedly hit `/api/status/:id` every 2 seconds. This causes database read amplification, high CPU usage on the API gateway, and redundant HTTP handshake overhead.
* **Server-Sent Events (Chosen)**: Establishes a single, persistent HTTP connection per client using Redis Pub/Sub to trigger updates instantly. This reduces DB query rates to zero during active waiting, lowers CPU load, and delivers real-time user experiences. WebSockets were rejected as bidirectional communication was not required, saving protocol complexity and connection state overhead.

### 2. Concurrency: Advisory Locks vs. In-App Mutexes
* **In-App Mutex**: Simple to implement using packages like `async-mutex`, but strictly confined to a single Node.js process. It fails instantly in a scaled environment with multiple containerized workers.
* **PostgreSQL Advisory Locks (Chosen)**: Acquiring a transactional advisory lock (`pg_advisory_xact_lock`) keyed to the image hash ensures that duplicate checks are serialized cluster-wide, even when workers are scaled horizontally across multiple servers or Kubernetes pods.

### 3. Local OCR vs. Cloud Providers (Tesseract vs. Google Vision / AWS Textract)
* **Local Tesseract (Default)**: Completely free, runs locally in the container, and doesn't require internet connectivity. However, it can be CPU-intensive and struggles with skewed or low-light images.
* **Configurable Strategy Pattern (Chosen)**: Created a provider-agnostic interface (`OCRProvider`). The default is Tesseract, but production deployments can seamlessly toggle `google-vision` or `aws-textract` via environmental variables (`OCR_PROVIDER`) for superior accuracy and offloading CPU cycles to external cloud networks.

### 4. Perceptual Hashing (dHash) vs. Cryptographic Hashing (SHA-256)
* **SHA-256 (Exact Match)**: O(1) time and memory lookup. Ideal for finding identical file uploads. However, if a single pixel is altered, the hash completely changes (avalanche effect).
* **dHash (Near-Duplicate Match)**: Resizes images to a 9x8 greyscale grid and evaluates relative pixel brightness. Using Hamming distance calculation with advisory locking, the system can reliably identify cropped, re-compressed, or watermarked duplicates without expensive deep-learning models.

---

## 🚀 How to Run Locally

### 1. Prerequisites
- Node.js (v18 or higher)
- Docker & Docker Compose
- PostgreSQL & Redis (if running outside Docker)

### 2. Quickstart with Docker Compose
To boot up the entire stack including database, queue, API, and Worker services:
```bash
# 1. Spin up the infrastructure
docker-compose up -d --build

# 2. Check service status
docker-compose ps
```
The Express API Gateway will be available at `http://localhost:3000`.

---

### 3. Manual Local Installation

If you prefer to run services manually for debugging:

#### A. Install Dependencies
```bash
npm install
```

#### B. Setup Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5433/media_pipeline
REDIS_HOST=localhost
REDIS_PORT=6379
UPLOAD_DIR=uploads/
DHASH_THRESHOLD=10
OCR_PROVIDER=tesseract
DB_POOL_MAX=10
```

#### C. Database Setup & Seeding
```bash
# Initialize Tables & Schema
npm run db:init

# Seed Database with Mock Data (Bonus Feature)
npm run db:seed
```

#### D. Start API Server & Worker
```bash
# Start API Gateway in Development Mode
npm run dev

# Start Worker Service (Separate Terminal or Background)
npx ts-node-dev --respawn --transpile-only src/workers/index.ts
```

---

## 🧪 Testing Suite

The project includes unit and integration tests. The integration tests automatically manage databases using `testcontainers` locally, but gracefully fall back to existing service containers in CI environments (GitHub Actions).

```bash
# Run all tests
npm test

# Run code style linter
npm run lint

# Run code formatter
npm run format
```

---

## 📊 Sample API & SSE Usage

### 1. Upload Media & Enqueue Job
Submit a vehicle photo for asynchronous processing:
```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Content-Type: multipart/form-data" \
  -F "image=@/path/to/vehicle.jpg"
```
**Response:**
```json
{
  "jobId": "8f2a1b9c-4d5e-6f7a-8b9c-0d1e2f3a4b5c"
}
```

### 2. Stream Real-Time Job Progress (SSE)
Subscribe to real-time execution steps without polling:
```bash
curl -N http://localhost:3000/api/status/8f2a1b9c-4d5e-6f7a-8b9c-0d1e2f3a4b5c/events
```
**Output Events Stream:**
```text
data: {"status":"processing"}

data: {"status":"completed"}
```

### 3. Fetch Full Verification Results
Retrieve the comprehensive suite of computer-vision heuristics and text-extraction checks:
```bash
curl -X GET http://localhost:3000/api/results/8f2a1b9c-4d5e-6f7a-8b9c-0d1e2f3a4b5c
```
**Response:**
```json
{
  "jobId": "8f2a1b9c-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
  "jobStatus": "completed",
  "overallConfidence": 0.81,
  "checks": [
    {
      "check_name": "blur",
      "passed": true,
      "confidence": 0.95,
      "detail": {
        "variance": 348.21,
        "threshold": 100
      }
    },
    {
      "check_name": "brightness",
      "passed": true,
      "confidence": 1.0,
      "detail": {
        "luminance": 142.11,
        "verdict": "normal"
      }
    },
    {
      "check_name": "duplicate",
      "passed": true,
      "confidence": 1.0,
      "detail": {
        "isDuplicate": false,
        "distance": 0
      }
    },
    {
      "check_name": "screenshot",
      "passed": true,
      "confidence": 0.15,
      "detail": {
        "signals": [
          "No EXIF GPS data"
        ],
        "weightedScore": 0.15
      }
    },
    {
      "check_name": "ocr",
      "passed": true,
      "confidence": 0.95,
      "detail": {
        "extractedText": "MH12DE5678",
        "plateFound": true,
        "plateNumber": "MH12DE5678",
        "allMatches": [
          "MH12DE5678"
        ]
      }
    }
  ]
}
```

---

## 🔮 Future Improvements ("What I'd Improve")

While the pipeline is highly resilient, secure, and ready for production, the following architectures represent optimal paths for future cloud and infrastructure scaling:

1. **Object Storage Integration**: Migrate the local file system (`uploads/`) to secure, cloud-native storage like AWS S3 or Google Cloud Storage. Uploaded images should be streamed directly using S3 Signed URLs to prevent the API gateway from caching files in local disk volumes, saving storage overhead and disk-write IOPS.
2. **Distributed Advisory Locking with Redlock**: Currently, advisory locks are coupled with the PostgreSQL transaction lifecycle. If we decouple operations or drop the database dependence, implementing a distributed lock manager using Redis (e.g., Redlock algorithm) would yield superior performance and lower PostgreSQL CPU utilization.
3. **Queue Prioritization**: Introduce job priorities (e.g., high, medium, low) inside BullMQ to allow real-time users' uploads to preempt heavy batch uploads or system duplicate audits.
4. **Auto-scaling Workers**: Configure Kubernetes HPA (Horizontal Pod Autoscaler) based on the `media_pipeline_queue_depth` metric exposed via Prometheus. This automatically boots worker containers when queue processing backlogs build up and terminates them when the queue is dry.

---

## 🤖 AI Usage Disclosure

This software was developed with the assistance of an AI coding assistant.

### How AI was utilized:
- **Architecting Refactoring**: Assisted in planning the structural separation of the Express API and the BullMQ background workers into separate scalable processes.
- **Observability Configuration**: Designed the integration patterns for Prometheus `prom-client` and standardizing OpenTelemetry tracing middleware.
- **Bug Resolution**: Debugged linter issues, ESM/CommonJS module compilation mismatches inside Jest, and resolved database transaction rollbacks during concurrent locks.
- **Stateful Rate Limiting**: Code-designed the Token Bucket rate-limiting algorithm using Redis hash operations to ensure horizontal support.

All code and algorithmic designs generated by the AI were rigorously reviewed, local/CI compilation-validated, and integration-tested to ensure adherence to professional backend standards.
