CREATE TABLE attachments (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  step_id text,
  report_month text,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  replaces_id text REFERENCES attachments(id),
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_project_idx ON attachments(project_id,created_at);
CREATE TABLE monthly_submissions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  report_month text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','approved','returned')),
  snapshot jsonb NOT NULL,
  submitted_by jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by jsonb,
  review_comment text,
  reviewed_at timestamptz
);
CREATE UNIQUE INDEX one_open_submission_per_month ON monthly_submissions(project_id,report_month) WHERE status IN ('submitted','approved');
CREATE INDEX monthly_submission_lookup ON monthly_submissions(project_id,report_month,submitted_at);
CREATE FUNCTION protect_submission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'submitted' OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.project_id <> OLD.project_id OR NEW.report_month <> OLD.report_month
     OR NEW.submitted_at <> OLD.submitted_at OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'submitted snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER monthly_submission_immutable BEFORE UPDATE ON monthly_submissions
  FOR EACH ROW EXECUTE FUNCTION protect_submission_snapshot();
