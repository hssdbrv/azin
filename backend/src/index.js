import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import http from "http";
import path from "path";
import multer from "multer";

import { pool } from "./db.js";
import { authMiddleware } from "./auth.js";
import { setupSocket } from "./socket.js";
import {
  ServiceError,
  createOrGetPrivateChat,
  ensureChatSchema,
  ensurePublicChatMembership,
  getChatDetailsForUser,
  getMessagesForChat,
  listChatsForUser,
} from "./chat-service.js";

const app = express();
app.use(cors());
app.use(express.json());

// Serve uploads
const uploadDir = path.resolve("uploads");
app.use("/uploads", express.static(uploadDir));

// Multer setup
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + "-" + file.originalname);
  }
});
const upload = multer({ storage });

app.post("/upload", authMiddleware, upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file" });

  const url = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
  res.json({ url, type: file.mimetype });
});

app.post("/signup", async (req, res) => {
  const { full_name, username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  try {
    const result = await pool.query(
      "INSERT INTO users (full_name, username, password_hash) VALUES ($1,$2,$3) RETURNING id, username, full_name, bio, avatar_url",
      [full_name, username, hash]
    );
    await ensurePublicChatMembership(result.rows[0].id);
    res.json(result.rows[0]);
  } catch {
    res.status(400).json({ error: "Username already exists" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (!result.rows.length) return res.status(401).json({ error: "Invalid credentials" });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      bio: user.bio || "",
      avatar_url: user.avatar_url || null,
    },
  });
});

app.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, bio, avatar_url
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load profile." });
  }
});

app.patch("/me", authMiddleware, upload.single("avatar"), async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT id, full_name, bio, avatar_url
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "User not found." });
    }

    const current = existing.rows[0];
    const nextFullName = (req.body?.full_name || "").trim() || current.full_name;
    const nextBio = typeof req.body?.bio === "string" ? req.body.bio.trim() : current.bio || "";

    const avatarUrl = req.file
      ? `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
      : current.avatar_url;

    const updated = await pool.query(
      `UPDATE users
       SET full_name = $2,
           bio = $3,
           avatar_url = $4
       WHERE id = $1
       RETURNING id, username, full_name, bio, avatar_url`,
      [req.user.id, nextFullName, nextBio, avatarUrl]
    );

    return res.json(updated.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to update profile." });
  }
});

app.get("/messages", authMiddleware, async (_req, res) => {
  try {
    const chats = await listChatsForUser(_req.user.id);
    const publicChat = chats.find((chat) => chat.type === "public") || chats[0];
    if (!publicChat) return res.json([]);

    const messages = await getMessagesForChat(publicChat.id, _req.user.id);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to load messages." });
  }
});

app.get("/chats", authMiddleware, async (req, res) => {
  try {
    const chats = await listChatsForUser(req.user.id);
    res.json(chats);
  } catch (error) {
    res.status(500).json({ error: error?.message || "Failed to load chats." });
  }
});

app.get("/chats/:chatId/messages", authMiddleware, async (req, res) => {
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (Number.isNaN(chatId)) {
    return res.status(400).json({ error: "Invalid chat id." });
  }

  try {
    const messages = await getMessagesForChat(chatId, req.user.id);
    res.json(messages);
  } catch (error) {
    if (error instanceof ServiceError) {
      return res.status(error.status).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to load chat messages." });
  }
});

app.get("/chats/:chatId/detail", authMiddleware, async (req, res) => {
  const chatId = Number.parseInt(req.params.chatId, 10);
  if (Number.isNaN(chatId)) {
    return res.status(400).json({ error: "Invalid chat id." });
  }

  try {
    const detail = await getChatDetailsForUser(chatId, req.user.id);
    res.json(detail);
  } catch (error) {
    if (error instanceof ServiceError) {
      return res.status(error.status).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to load chat details." });
  }
});

app.post("/chats/private", authMiddleware, async (req, res) => {
  const targetUsername = req.body?.username;

  try {
    const chat = await createOrGetPrivateChat(req.user.id, targetUsername);
    res.json(chat);
  } catch (error) {
    if (error instanceof ServiceError) {
      return res.status(error.status).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to create private chat." });
  }
});

await ensureChatSchema();
const server = http.createServer(app);
setupSocket(server);

server.listen(4000, () => console.log("Backend running on 4000"));
