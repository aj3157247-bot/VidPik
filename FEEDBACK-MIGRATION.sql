-- این فایل را یک‌بار روی دیتابیس D1 فعلی VidPik اجرا کن.
CREATE TABLE IF NOT EXISTS feedback_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'نظر',
  name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  replied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_messages(status, id);
