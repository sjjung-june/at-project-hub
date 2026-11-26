CREATE TABLE knowledge_documents (
  attachment_id text PRIMARY KEY REFERENCES attachments(id),
  project_id text NOT NULL REFERENCES projects(id),
  filename text NOT NULL,
  content_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('ready','unsupported','too_large')),
  text_content text NOT NULL DEFAULT '',
  truncated boolean NOT NULL DEFAULT false,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_documents_project_idx ON knowledge_documents(project_id);
