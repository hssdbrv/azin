CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('public', 'private')),
  name TEXT NOT NULL,
  created_by INT REFERENCES users(id),
  system_key TEXT UNIQUE,
  private_key TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  chat_id INT REFERENCES chats(id),
  user_id INT REFERENCES users(id),
  content TEXT,
  media_url TEXT,
  media_type TEXT,
  seen_at TIMESTAMP,
  seen_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_user_id),
  CHECK (user_id <> contact_user_id)
);

-- Safe for existing DB:
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id INT REFERENCES chats(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_by INT REFERENCES users(id);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_key TEXT UNIQUE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS private_key TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

INSERT INTO chats (type, name, system_key)
VALUES ('public', 'Public Chat', 'public:lobby')
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO chat_members (chat_id, user_id)
SELECT c.id, u.id
FROM chats c
CROSS JOIN users u
WHERE c.system_key = 'public:lobby'
ON CONFLICT DO NOTHING;

UPDATE messages
SET chat_id = c.id
FROM chats c
WHERE messages.chat_id IS NULL
  AND c.system_key = 'public:lobby';
