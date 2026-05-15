# Intelligent Media Processing Pipeline

A production-grade, distributed backend system that accepts vehicle images, processes them asynchronously using a message queue, and performs multiple computer-vision heuristics and text-extraction checks.

## Architecture Overview
- **Service Flow**: The Express API server handles synchronous requests. Uploaded files are streamed directly to disk (local `uploads/`). A record is inserted into the PostgreSQL `jobs` table with `status="pending"`. The job ID is pushed to a BullMQ Redis queue and returned instantly to the user (202 Accepted).
- **Queue Strategy**: BullMQ handles robust job processing. A background worker picks up the job, switches the status to `processing`, and executes 5 intensive image processing checks concurrently using `Promise.all()`. If an error occurs, it is caught, the DB is updated to `failed`, and exponential backoff retry kicks in.
- **Database Schema**: 
  - `jobs` tracks the overall lifecycle of an upload, including a SHA-256 hash for O(1) duplicate detection (indexed).
  - `results` is linked via a foreign key (`ON DELETE CASCADE`) to store individual check verdicts, confidences, and JSON details.

## How to Run Locally

You can run the entire infrastructure locally using Docker Compose.

1. **Start the Infrastructure**
   ```bash
   docker-compose up -d
   ```
   *Note: If you run into port conflicts with a local Postgres instance, ensure port 5432 is free or use the provided Neon database integration in your `.env`.*

2. **Initialize Database Tables**
   ```bash
   npm run db:init
   ```

3. **Start the Application (API + Worker)**
   ```bash
   npm run dev
   ```

The application will run on `http://localhost:3000`.

## Sample API Requests

### 1. Health Check
```bash
curl -X GET http://localhost:3000/health
```
**Response:**
```json
{
  "status": "ok"
}
```

### 2. Upload Image
```bash
curl -X POST http://localhost:3000/api/upload \
  -H "Content-Type: multipart/form-data" \
  -F "image=@/path/to/your/test_image.jpg"
```
**Response:** (HTTP 202 Accepted)
```json
{
  "jobId": "e1f13b6c-..."
}
```

### 3. Check Job Status
```bash
curl -X GET http://localhost:3000/api/status/{jobId}
```
**Response:**
```json
{
  "id": "e1f13b6c-...",
  "status": "completed",
  "failure_reason": null,
  "created_at": "2024-05-15T10:00:00.000Z"
}
```

### 4. Fetch Results
```bash
curl -X GET http://localhost:3000/api/results/{jobId}
```
**Response:**
```json
[
  {
    "check_name": "blur",
    "passed": true,
    "confidence": 0.85,
    "detail": { "variance": 255.4 },
    "created_at": "2024-05-15T10:00:02.000Z"
  },
  {
    "check_name": "ocr",
    "passed": true,
    "confidence": 0.92,
    "detail": { "extractedText": "MH12AB1234", "plateFound": true, "plateNumber": "MH12AB1234" },
    "created_at": "2024-05-15T10:00:02.000Z"
  }
]
```

