CREATE TABLE IF NOT EXISTS jobs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','processing','completed','failed')),
  filename       TEXT        NOT NULL,
  filepath       TEXT        NOT NULL,
  hash           TEXT,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(hash);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS results (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  check_name  TEXT        NOT NULL,
  passed      BOOLEAN     NOT NULL,
  confidence  FLOAT       NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_job_id ON results(job_id);