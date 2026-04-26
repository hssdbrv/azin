import { pool } from "./db.js";

const PUBLIC_CHAT_KEY = "public:lobby";

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getPrivateDisplayName(chat, userId) {
  if (chat.type !== "private") return chat.name;

  const other = chat.participants.find((member) => member.id !== userId);
  if (!other) return "Private chat";

  return other.full_name || other.username;
}

function buildChatPayload(chat, userId) {
  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    displayName: getPrivateDisplayName(chat, userId),
    memberCount: chat.member_count,
    lastMessagePreview: chat.last_message_preview || "",
    lastMessageAt: chat.last_message_at,
    participants: chat.participants,
  };
}

export async function ensureChatSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('public', 'private')),
      name TEXT NOT NULL,
      created_by INT REFERENCES users(id),
      system_key TEXT UNIQUE,
      private_key TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, contact_user_id),
      CHECK (user_id <> contact_user_id)
    );
  `);

  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id INT REFERENCES chats(id);`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_by INT REFERENCES users(id);`);
  await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_key TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS private_key TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);

  const publicChat = await pool.query(
    `INSERT INTO chats (type, name, system_key)
     VALUES ('public', 'Public Chat', $1)
     ON CONFLICT (system_key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [PUBLIC_CHAT_KEY]
  );
  const publicChatId = publicChat.rows[0]?.id;

  await pool.query(
    `INSERT INTO chat_members (chat_id, user_id)
     SELECT $1, u.id
     FROM users u
     ON CONFLICT DO NOTHING`,
    [publicChatId]
  );

  await pool.query(
    `UPDATE messages
     SET chat_id = $1
     WHERE chat_id IS NULL`,
    [publicChatId]
  );

  return publicChatId;
}

export async function ensurePublicChatMembership(userId) {
  const result = await pool.query(`SELECT id FROM chats WHERE system_key = $1 LIMIT 1`, [PUBLIC_CHAT_KEY]);
  const publicChatId = result.rows[0]?.id;
  if (!publicChatId) return null;

  await pool.query(
    `INSERT INTO chat_members (chat_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [publicChatId, userId]
  );

  return publicChatId;
}

async function getParticipantsByChat(chatIds) {
  if (!chatIds.length) return new Map();

  const participantsResult = await pool.query(
    `SELECT cm.chat_id, u.id, u.username, u.full_name, u.avatar_url, u.bio
     FROM chat_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ANY($1::int[])`,
    [chatIds]
  );

  const participantsByChat = new Map();
  for (const row of participantsResult.rows) {
    const chatId = toInt(row.chat_id);
    if (!participantsByChat.has(chatId)) {
      participantsByChat.set(chatId, []);
    }

    participantsByChat.get(chatId).push({
      id: row.id,
      username: row.username,
      full_name: row.full_name,
      avatar_url: row.avatar_url || null,
      bio: row.bio || "",
    });
  }

  return participantsByChat;
}

export async function listChatsForUser(userId) {
  await ensurePublicChatMembership(userId);

  const chatsResult = await pool.query(
    `SELECT c.id, c.type, c.name,
            COUNT(DISTINCT cm_all.user_id)::int AS member_count,
            lm.content AS last_message_preview,
            lm.created_at AS last_message_at,
            c.created_at
     FROM chats c
     JOIN chat_members cm_user
       ON cm_user.chat_id = c.id
      AND cm_user.user_id = $1
     JOIN chat_members cm_all
       ON cm_all.chat_id = c.id
     LEFT JOIN LATERAL (
       SELECT content, created_at
       FROM messages
       WHERE chat_id = c.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) lm ON TRUE
     GROUP BY c.id, lm.content, lm.created_at
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id ASC`,
    [userId]
  );

  const chatIds = chatsResult.rows.map((row) => toInt(row.id)).filter(Boolean);
  const participantsByChat = await getParticipantsByChat(chatIds);

  return chatsResult.rows.map((row) => {
    const id = toInt(row.id);
    const chat = {
      ...row,
      id,
      member_count: toInt(row.member_count) || 0,
      participants: participantsByChat.get(id) || [],
    };

    return buildChatPayload(chat, userId);
  });
}

export async function getChatDetailsForUser(chatId, userId) {
  const chatResult = await pool.query(
    `SELECT c.id, c.type, c.name, c.created_at,
            COUNT(cm_all.user_id)::int AS member_count
     FROM chats c
     JOIN chat_members cm_user
       ON cm_user.chat_id = c.id
      AND cm_user.user_id = $2
     JOIN chat_members cm_all
       ON cm_all.chat_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [chatId, userId]
  );

  const chat = chatResult.rows[0];
  if (!chat) throw new ServiceError(404, "Chat not found.");

  const membersResult = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.avatar_url, u.bio
     FROM chat_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = $1
     ORDER BY u.username ASC`,
    [chatId]
  );

  const normalized = {
    ...chat,
    id: toInt(chat.id),
    member_count: toInt(chat.member_count) || 0,
    participants: membersResult.rows,
  };

  return buildChatPayload(normalized, userId);
}

export async function getMessagesForChat(chatId, userId) {
  const membership = await pool.query(
    `SELECT c.type
     FROM chat_members
     JOIN chats c ON c.id = chat_members.chat_id
     WHERE chat_id = $1 AND user_id = $2`,
    [chatId, userId]
  );

  if (!membership.rows.length) {
    throw new ServiceError(404, "Chat not found.");
  }

  const messages = await pool.query(
    `SELECT m.id, m.chat_id, m.content, m.media_url, m.media_type, m.created_at,
            m.seen_at, m.seen_by,
            u.username, u.full_name, u.avatar_url
     FROM messages m
     JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = $1
     ORDER BY m.created_at ASC, m.id ASC`,
    [chatId]
  );

  return messages.rows;
}

export async function markPrivateMessagesSeen(chatId, userId) {
  const membership = await pool.query(
    `SELECT c.type
     FROM chat_members cm
     JOIN chats c ON c.id = cm.chat_id
     WHERE cm.chat_id = $1
       AND cm.user_id = $2
     LIMIT 1`,
    [chatId, userId]
  );

  const chat = membership.rows[0];
  if (!chat) {
    throw new ServiceError(404, "Chat not found.");
  }

  if (chat.type !== "private") {
    return [];
  }

  const updated = await pool.query(
    `UPDATE messages
     SET seen_at = NOW(),
         seen_by = $2
     WHERE chat_id = $1
       AND user_id <> $2
       AND seen_at IS NULL
     RETURNING id, seen_at`,
    [chatId, userId]
  );

  return updated.rows;
}

export async function createOrGetPrivateChat(userId, targetUsername) {
  const username = String(targetUsername || "").trim();
  if (!username) {
    throw new ServiceError(400, "A username is required.");
  }

  const requesterResult = await pool.query(
    `SELECT id, username, full_name
     FROM users
     WHERE id = $1`,
    [userId]
  );
  const requester = requesterResult.rows[0];
  if (!requester) {
    throw new ServiceError(401, "Invalid user.");
  }

  const targetResult = await pool.query(
    `SELECT id, username, full_name
     FROM users
     WHERE username = $1`,
    [username]
  );
  const target = targetResult.rows[0];
  if (!target) {
    throw new ServiceError(404, "User not found.");
  }

  if (target.id === userId) {
    throw new ServiceError(400, "You cannot create a private chat with yourself.");
  }

  const privateKey = [userId, target.id].sort((a, b) => a - b).join(":");

  const existing = await pool.query(
    `SELECT id
     FROM chats
     WHERE private_key = $1
     LIMIT 1`,
    [privateKey]
  );

  let chatId = existing.rows[0]?.id;

  if (!chatId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const chatResult = await client.query(
        `INSERT INTO chats (type, name, created_by, private_key)
         VALUES ('private', $1, $2, $3)
         RETURNING id`,
        [`${requester.full_name} / ${target.full_name}`, userId, privateKey]
      );
      chatId = chatResult.rows[0].id;

      await client.query(
        `INSERT INTO chat_members (chat_id, user_id)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [chatId, userId, target.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return getChatDetailsForUser(chatId, userId);
}

export async function searchUsersForUser(userId, queryText) {
  const query = String(queryText || "").trim();
  if (query.length < 2) return [];

  const result = await pool.query(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.avatar_url,
            u.bio,
            (c.user_id IS NOT NULL) AS is_contact,
            dm.id AS private_chat_id
     FROM users u
     LEFT JOIN contacts c
       ON c.user_id = $1
      AND c.contact_user_id = u.id
     LEFT JOIN chats dm
       ON dm.type = 'private'
      AND dm.private_key = CONCAT(LEAST($1, u.id), ':', GREATEST($1, u.id))
     WHERE u.id <> $1
       AND (u.username ILIKE $2 OR u.full_name ILIKE $2)
     ORDER BY
       CASE WHEN u.username ILIKE $3 THEN 0 ELSE 1 END,
       u.username ASC
     LIMIT 20`,
    [userId, `%${query}%`, `${query}%`]
  );

  return result.rows;
}

export async function listContactsForUser(userId) {
  const result = await pool.query(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.avatar_url,
            u.bio,
            c.created_at,
            dm.id AS private_chat_id
     FROM contacts c
     JOIN users u
       ON u.id = c.contact_user_id
     LEFT JOIN chats dm
       ON dm.type = 'private'
      AND dm.private_key = CONCAT(LEAST($1, u.id), ':', GREATEST($1, u.id))
     WHERE c.user_id = $1
     ORDER BY LOWER(u.full_name) ASC, u.username ASC`,
    [userId]
  );

  return result.rows;
}

export async function addContactByUsername(userId, targetUsername) {
  const username = String(targetUsername || "").trim();
  if (!username) {
    throw new ServiceError(400, "A username is required.");
  }

  const userResult = await pool.query(
    `SELECT id, username, full_name, avatar_url, bio
     FROM users
     WHERE username = $1`,
    [username]
  );
  const target = userResult.rows[0];

  if (!target) {
    throw new ServiceError(404, "User not found.");
  }

  if (target.id === userId) {
    throw new ServiceError(400, "You cannot add yourself to contacts.");
  }

  await pool.query(
    `INSERT INTO contacts (user_id, contact_user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, target.id]
  );

  const privateChat = await pool.query(
    `SELECT id
     FROM chats
     WHERE type = 'private'
       AND private_key = CONCAT(LEAST($1, $2), ':', GREATEST($1, $2))
     LIMIT 1`,
    [userId, target.id]
  );

  return {
    ...target,
    private_chat_id: privateChat.rows[0]?.id || null,
  };
}

export async function removeContactByUsername(userId, targetUsername) {
  const username = String(targetUsername || "").trim();
  if (!username) {
    throw new ServiceError(400, "A username is required.");
  }

  const userResult = await pool.query(
    `SELECT id
     FROM users
     WHERE username = $1`,
    [username]
  );
  const target = userResult.rows[0];

  if (!target) {
    throw new ServiceError(404, "User not found.");
  }

  if (target.id === userId) {
    throw new ServiceError(400, "You cannot remove yourself from contacts.");
  }

  await pool.query(
    `DELETE FROM contacts
     WHERE user_id = $1
       AND contact_user_id = $2`,
    [userId, target.id]
  );

  return { username };
}

export async function getUserProfileForViewer(viewerId, targetUsername) {
  const username = String(targetUsername || "").trim();
  if (!username) {
    throw new ServiceError(400, "A username is required.");
  }

  const result = await pool.query(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.avatar_url,
            u.bio,
            (c.user_id IS NOT NULL) AS is_contact,
            dm.id AS private_chat_id
     FROM users u
     LEFT JOIN contacts c
       ON c.user_id = $1
      AND c.contact_user_id = u.id
     LEFT JOIN chats dm
       ON dm.type = 'private'
      AND dm.private_key = CONCAT(LEAST($1, u.id), ':', GREATEST($1, u.id))
     WHERE u.username = $2
     LIMIT 1`,
    [viewerId, username]
  );

  const user = result.rows[0];
  if (!user) {
    throw new ServiceError(404, "User not found.");
  }

  return user;
}

export async function listUserChatIds(userId) {
  const result = await pool.query(
    `SELECT chat_id
     FROM chat_members
     WHERE user_id = $1`,
    [userId]
  );

  return result.rows.map((row) => toInt(row.chat_id)).filter(Boolean);
}

export async function isUserInChat(userId, chatId) {
  const result = await pool.query(
    `SELECT 1
     FROM chat_members
     WHERE user_id = $1 AND chat_id = $2
     LIMIT 1`,
    [userId, chatId]
  );

  return Boolean(result.rows.length);
}

export async function createMessage({ chatId, userId, content, mediaUrl, mediaType }) {
  const result = await pool.query(
    `INSERT INTO messages (chat_id, user_id, content, media_url, media_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [chatId, userId, content || null, mediaUrl || null, mediaType || null]
  );

  return result.rows[0];
}

export { ServiceError };
