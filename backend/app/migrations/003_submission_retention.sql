CREATE FUNCTION reject_submission_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'monthly submissions are retained';
END;
$$;
CREATE TRIGGER monthly_submission_no_delete BEFORE DELETE ON monthly_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_submission_delete();
