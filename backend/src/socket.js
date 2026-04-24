import { Server } from "socket.io";
import { redis, redisPub, redisSub } from "./redis.js";
import { createMessage, isUserInChat, listUserChatIds } from "./chat-service.js";

const CHAT_CHANNEL = "chat_message";

function parseJson(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function roomName(chatId) {
  return `chat:${chatId}`;
}

function withSocketGuard(handler) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error("Socket handler failed:", error);
    });
  };
}

function normalizePresenceUser(user, fallbackUsername = "") {
  const username = String(user?.username || fallbackUsername || "").trim();
  if (!username) return null;

  return {
    id: toInt(user?.id),
    username,
    full_name: user?.full_name || username,
    bio: user?.bio || "",
    avatar_url: user?.avatar_url || null,
    status: user?.status === "away" ? "away" : "online",
  };
}

async function readSocketUser(socketId) {
  return normalizePresenceUser(parseJson(await redis.hGet("socket_users", socketId)));
}

async function broadcastPresenceList(io) {
  const socketUsers = await redis.hGetAll("socket_users");
  const socketStatuses = await redis.hGetAll("socket_status");

  const map = new Map();

  for (const [socketId, rawUser] of Object.entries(socketUsers)) {
    const socketUser = normalizePresenceUser(parseJson(rawUser));
    if (!socketUser?.username) continue;

    const status = socketStatuses[socketId] === "away" ? "away" : "online";
    const current = map.get(socketUser.username);

    if (!current) {
      map.set(socketUser.username, {
        id: socketUser.id,
        username: socketUser.username,
        full_name: socketUser.full_name,
        bio: socketUser.bio,
        avatar_url: socketUser.avatar_url,
        status,
      });
      continue;
    }

    if ((!current.id || current.id < 1) && socketUser.id) {
      current.id = socketUser.id;
    }

    if (current.full_name === current.username && socketUser.full_name) {
      current.full_name = socketUser.full_name;
    }

    if (!current.avatar_url && socketUser.avatar_url) {
      current.avatar_url = socketUser.avatar_url;
    }

    if (!current.bio && socketUser.bio) {
      current.bio = socketUser.bio;
    }

    if (status === "online") {
      current.status = "online";
    }
  }

  const list = Array.from(map.values()).sort((a, b) => a.username.localeCompare(b.username));
  io.emit("presence:list", list);
}

async function joinMemberChats(socket, userId) {
  const chatIds = await listUserChatIds(userId);

  for (const chatId of chatIds) {
    socket.join(roomName(chatId));
  }
}

export function setupSocket(server) {
  const io = new Server(server, { cors: { origin: "*" } });

  redisSub.subscribe(CHAT_CHANNEL, (rawMessage) => {
    const message = parseJson(rawMessage);
    const chatId = toInt(message?.chatId);
    if (!chatId) return;

    io.to(roomName(chatId)).emit("message", message);
  });

  io.on("connection", (socket) => {
    socket.on("presence:join", withSocketGuard(async ({ user }) => {
      const normalizedUser = normalizePresenceUser(user);
      if (!normalizedUser?.username || !normalizedUser.id) return;

      await redis.hSet("socket_users", socket.id, JSON.stringify(normalizedUser));
      await redis.hSet("socket_status", socket.id, normalizedUser.status);

      await joinMemberChats(socket, normalizedUser.id);
      await broadcastPresenceList(io);
    }));

    socket.on("presence:status", withSocketGuard(async ({ status }) => {
      if (status !== "online" && status !== "away") return;

      const socketUser = await readSocketUser(socket.id);
      if (!socketUser?.username) return;

      await redis.hSet("socket_status", socket.id, status);
      await broadcastPresenceList(io);
    }));

    socket.on("chat:join", withSocketGuard(async ({ chatId }) => {
      const parsedChatId = toInt(chatId);
      if (!parsedChatId) return;

      const socketUser = await readSocketUser(socket.id);
      if (!socketUser?.id) return;

      const canJoin = await isUserInChat(socketUser.id, parsedChatId);
      if (!canJoin) return;

      socket.join(roomName(parsedChatId));
    }));

    socket.on("typing", withSocketGuard(async ({ chatId, username, isTyping }) => {
      const parsedChatId = toInt(chatId);
      if (!parsedChatId) return;

      const socketUser = await readSocketUser(socket.id);
      if (!socketUser?.id) return;

      const canType = await isUserInChat(socketUser.id, parsedChatId);
      if (!canType) return;

      socket.to(roomName(parsedChatId)).emit("typing", {
        chatId: parsedChatId,
        username: socketUser.username || username,
        isTyping: Boolean(isTyping),
      });
    }));

    socket.on("message", withSocketGuard(async (msg) => {
      const parsedChatId = toInt(msg?.chatId);
      if (!parsedChatId) return;

      const socketUser = await readSocketUser(socket.id);
      if (!socketUser?.id || !socketUser.username) return;

      const canSend = await isUserInChat(socketUser.id, parsedChatId);
      if (!canSend) return;

      const content = typeof msg?.content === "string" ? msg.content.trim() : "";
      const mediaUrl = msg?.mediaUrl || null;
      const mediaType = msg?.mediaType || null;

      if (!content && !mediaUrl) return;

      const created = await createMessage({
        chatId: parsedChatId,
        userId: socketUser.id,
        content,
        mediaUrl,
        mediaType,
      });

      const payload = {
        id: created.id,
        chatId: parsedChatId,
        clientId: msg?.clientId || null,
        userId: socketUser.id,
        username: socketUser.username,
        fullName: socketUser.full_name,
        avatarUrl: socketUser.avatar_url,
        content,
        mediaUrl,
        mediaType,
        createdAt: created.created_at,
      };

      await redisPub.publish(CHAT_CHANNEL, JSON.stringify(payload));
    }));

    socket.on("disconnect", withSocketGuard(async () => {
      await redis.hDel("socket_users", socket.id);
      await redis.hDel("socket_status", socket.id);
      await broadcastPresenceList(io);
    }));
  });

  return io;
}
