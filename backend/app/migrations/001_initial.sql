CREATE TABLE projects (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  team text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document->>'id' = id)
);
CREATE INDEX projects_team_idx ON projects(team);
CREATE INDEX projects_document_gin_idx ON projects USING gin(document jsonb_path_ops);

-- Steps and monthly reports remain in the project JSON document initially.
-- Dedicated projections make approval/audit queries independent of document layout.
CREATE TABLE change_requests (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_request_per_project ON change_requests(project_id) WHERE status = 'pending';
CREATE INDEX change_requests_project_idx ON change_requests(project_id);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  action text NOT NULL,
  actor jsonb NOT NULL,
  before_document jsonb,
  after_document jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_project_time_idx ON audit_events(project_id,created_at DESC);
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
