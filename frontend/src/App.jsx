import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL, api } from "./api";
import { io } from "socket.io-client";

const SOCKET_URL = API_BASE_URL;
const TOKEN_KEY = "azin_token";
const USER_KEY = "azin_user";

function getClientId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readStoredUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeMessage(message) {
  return {
    id: message.id ?? null,
    chatId: toNumber(message.chatId ?? message.chat_id),
    clientId: message.clientId ?? null,
    username: message.username ?? "Unknown",
    fullName: message.fullName ?? message.full_name ?? message.username ?? "Unknown",
    avatarUrl: message.avatarUrl ?? message.avatar_url ?? null,
    content: message.content ?? "",
    mediaUrl: message.mediaUrl ?? message.media_url ?? null,
    mediaType: message.mediaType ?? message.media_type ?? null,
    createdAt: message.createdAt ?? message.created_at ?? null,
  };
}

function normalizeChat(chat) {
  const id = toNumber(chat?.id);

  return {
    id,
    type: chat?.type === "private" ? "private" : "public",
    name: chat?.name || "Untitled chat",
    displayName: chat?.displayName || chat?.display_name || chat?.name || "Untitled chat",
    memberCount: toNumber(chat?.memberCount ?? chat?.member_count) || 0,
    lastMessagePreview: chat?.lastMessagePreview ?? chat?.last_message_preview ?? "",
    lastMessageAt: chat?.lastMessageAt ?? chat?.last_message_at ?? null,
    participants: Array.isArray(chat?.participants)
      ? chat.participants
          .map((member) => ({
            id: toNumber(member?.id),
            username: member?.username || "Unknown",
            full_name: member?.full_name || member?.username || "Unknown",
            avatar_url: member?.avatar_url || null,
            bio: member?.bio || "",
          }))
          .filter((member) => member.id)
      : [],
  };
}

function normalizePresenceUser(user) {
  if (!user?.username) return null;

  return {
    id: toNumber(user?.id),
    username: user.username,
    full_name: user.full_name || user.username,
    avatar_url: user.avatar_url || null,
    bio: user.bio || "",
    status: user.status === "away" ? "away" : "online",
  };
}

function messageFromError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback;
}

function formatTime(createdAt) {
  if (!createdAt) return "";

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatChatItemTime(createdAt) {
  if (!createdAt) return "";

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function sortChatsByRecent(chats) {
  return [...chats].sort((a, b) => {
    const aDate = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bDate = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;

    if (aDate === bDate) {
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    }

    return bDate - aDate;
  });
}

function getPresenceStatus() {
  if (typeof document === "undefined") return "online";

  const isVisible = document.visibilityState !== "hidden";
  const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;

  return isVisible && hasFocus ? "online" : "away";
}

function getInitials(label) {
  const words = String(label || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2);
  if (!words.length) return "?";

  return words.map((word) => word[0]?.toUpperCase() || "").join("");
}

function Avatar({ src, label, className }) {
  if (src) {
    return <img className={className} src={src} alt={label} />;
  }

  return <span className={`${className} avatar-fallback`}>{getInitials(label)}</span>;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [user, setUser] = useState(() => readStoredUser());

  const [chats, setChats] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [messagesByChat, setMessagesByChat] = useState({});
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingByChat, setTypingByChat] = useState({});

  const [content, setContent] = useState("");
  const [file, setFile] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [chatDetailsOpen, setChatDetailsOpen] = useState(false);
  const [chatDetailsBusy, setChatDetailsBusy] = useState(false);
  const [chatDetails, setChatDetails] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileForm, setProfileForm] = useState({
    full_name: "",
    bio: "",
    avatarFile: null,
  });
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [connectionState, setConnectionState] = useState("disconnected");

  const socketRef = useRef(null);
  const activeUserRef = useRef(user);
  const chatRef = useRef(null);
  const fileInputRef = useRef(null);
  const profileFileInputRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) || null,
    [chats, selectedChatId]
  );

  const currentMessages = useMemo(() => {
    if (!selectedChatId) return [];
    return messagesByChat[selectedChatId] || [];
  }, [messagesByChat, selectedChatId]);

  const typingUsers = useMemo(() => {
    if (!selectedChatId) return [];
    return typingByChat[selectedChatId] || [];
  }, [typingByChat, selectedChatId]);

  const presenceByUsername = useMemo(() => {
    const map = new Map();
    for (const onlineUser of onlineUsers) {
      map.set(onlineUser.username, onlineUser.status);
    }
    return map;
  }, [onlineUsers]);

  const selectedOnlineCount = useMemo(() => {
    if (!selectedChat?.participants?.length) return 0;

    return selectedChat.participants.reduce((count, member) => {
      return presenceByUsername.get(member.username) === "online" ? count + 1 : count;
    }, 0);
  }, [presenceByUsername, selectedChat]);

  useEffect(() => {
    activeUserRef.current = user;
  }, [user]);

  useEffect(() => {
    if (token && user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      return;
    }

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }, [token, user]);

  useEffect(() => {
    if (!profileOpen || !user) return;

    setProfileForm((current) => ({
      ...current,
      full_name: user.full_name || "",
      bio: user.bio || "",
      avatarFile: null,
    }));
  }, [profileOpen, user]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [selectedChatId, currentMessages.length]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 700,
      reconnectionDelayMax: 3000,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnectionState("connected");
      if (activeUserRef.current) {
        socket.emit("presence:join", {
          user: {
            ...activeUserRef.current,
            status: getPresenceStatus(),
          },
        });
      }
    });

    socket.on("disconnect", () => {
      setConnectionState("disconnected");
    });

    socket.on("connect_error", () => {
      setConnectionState("reconnecting");
    });

    socket.on("message", (incoming) => {
      const normalized = normalizeMessage(incoming);
      if (!normalized.chatId) return;

      setMessagesByChat((current) => {
        const forChat = current[normalized.chatId] || [];
        return {
          ...current,
          [normalized.chatId]: [...forChat, normalized],
        };
      });

      setChats((current) => {
        const updated = current.map((chat) => {
          if (chat.id !== normalized.chatId) return chat;

          return {
            ...chat,
            lastMessageAt: normalized.createdAt,
            lastMessagePreview: normalized.content || (normalized.mediaUrl ? "Attachment" : ""),
          };
        });

        return sortChatsByRecent(updated);
      });
    });

    socket.on("presence:list", (list) => {
      if (!Array.isArray(list)) {
        setOnlineUsers([]);
        return;
      }

      setOnlineUsers(list.map(normalizePresenceUser).filter(Boolean));
    });

    socket.on("typing", ({ chatId, username, isTyping }) => {
      if (!username || username === activeUserRef.current?.username) return;

      const parsedChatId = toNumber(chatId);
      if (!parsedChatId) return;

      setTypingByChat((current) => {
        const existing = new Set(current[parsedChatId] || []);

        if (isTyping) {
          existing.add(username);
        } else {
          existing.delete(username);
        }

        return {
          ...current,
          [parsedChatId]: Array.from(existing),
        };
      });
    });

    if (activeUserRef.current) {
      socket.connect();
    }

    return () => {
      clearTimeout(typingTimeoutRef.current);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnectionState("disconnected");
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    if (!token || !user) {
      socket.disconnect();
      setChats([]);
      setSelectedChatId(null);
      setMessagesByChat({});
      setTypingByChat({});
      setOnlineUsers([]);
      return;
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit("presence:join", {
      user: {
        ...user,
        status: getPresenceStatus(),
      },
    });
  }, [token, user]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !token || !user) return;

    for (const chat of chats) {
      socket.emit("chat:join", { chatId: chat.id });
    }
  }, [chats, token, user]);

  useEffect(() => {
    if (!token || !user) return;

    const handlePresenceChange = () => {
      emitPresenceStatus(getPresenceStatus());
    };

    window.addEventListener("focus", handlePresenceChange);
    window.addEventListener("blur", handlePresenceChange);
    document.addEventListener("visibilitychange", handlePresenceChange);
    handlePresenceChange();

    return () => {
      window.removeEventListener("focus", handlePresenceChange);
      window.removeEventListener("blur", handlePresenceChange);
      document.removeEventListener("visibilitychange", handlePresenceChange);
    };
  }, [token, user]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    setLoadingChats(true);
    setErrorMessage("");

    api
      .get("/chats", {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (cancelled) return;

        const normalizedChats = Array.isArray(response.data)
          ? sortChatsByRecent(response.data.map(normalizeChat).filter((chat) => chat.id))
          : [];

        setChats(normalizedChats);

        setSelectedChatId((currentSelected) => {
          if (currentSelected && normalizedChats.some((chat) => chat.id === currentSelected)) {
            return currentSelected;
          }

          return normalizedChats[0]?.id ?? null;
        });
      })
      .catch((error) => {
        if (cancelled) return;

        setErrorMessage(messageFromError(error, "Failed to load chats."));
        if (error?.response?.status === 401) {
          setToken("");
          setUser(null);
          setStatusMessage("Session expired. Please login again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingChats(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !selectedChatId) return;

    let cancelled = false;
    setLoadingMessages(true);

    api
      .get(`/chats/${selectedChatId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (cancelled) return;

        const normalizedMessages = Array.isArray(response.data)
          ? response.data.map(normalizeMessage).filter((message) => message.chatId)
          : [];

        setMessagesByChat((current) => ({
          ...current,
          [selectedChatId]: normalizedMessages,
        }));
      })
      .catch((error) => {
        if (cancelled) return;

        setErrorMessage(messageFromError(error, "Failed to load chat messages."));
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMessages(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedChatId, token]);

  useEffect(() => {
    if (!chatDetailsOpen || !selectedChatId || !token) return;

    let cancelled = false;
    setChatDetailsBusy(true);

    api
      .get(`/chats/${selectedChatId}/detail`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (cancelled) return;
        setChatDetails(normalizeChat(response.data));
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(messageFromError(error, "Failed to load chat details."));
      })
      .finally(() => {
        if (!cancelled) {
          setChatDetailsBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chatDetailsOpen, selectedChatId, token]);

  function emitTyping(chatId, isTyping) {
    if (!chatId || !activeUserRef.current?.username) return;
    const socket = socketRef.current;
    if (!socket?.connected) return;

    socket.emit("typing", {
      chatId,
      username: activeUserRef.current.username,
      isTyping,
    });
  }

  function emitPresenceStatus(status) {
    if (!activeUserRef.current?.username) return;
    const socket = socketRef.current;
    if (!socket?.connected) return;

    socket.emit("presence:status", {
      status: status === "away" ? "away" : "online",
    });
  }

  function handleContentChange(event) {
    const value = event.target.value;
    setContent(value);

    if (!selectedChatId) return;

    if (!value.trim()) {
      clearTimeout(typingTimeoutRef.current);
      emitTyping(selectedChatId, false);
      return;
    }

    emitTyping(selectedChatId, true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      emitTyping(selectedChatId, false);
    }, 1200);
  }

  function handleChatSelect(chatId) {
    if (chatId === selectedChatId) return;

    if (selectedChatId) {
      clearTimeout(typingTimeoutRef.current);
      emitTyping(selectedChatId, false);
    }

    setSelectedChatId(chatId);
    setChatDetailsOpen(false);
    setChatDetails(null);
    setContent("");
    setErrorMessage("");
  }

  async function openProfile() {
    setProfileOpen(true);
    setErrorMessage("");

    if (!token) return;

    try {
      const response = await api.get("/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.data?.id) return;

      setUser((current) => ({ ...current, ...response.data }));
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to load profile."));
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!token || profileBusy) return;

    const fullName = profileForm.full_name.trim();
    if (!fullName) {
      setErrorMessage("Name is required.");
      return;
    }

    setProfileBusy(true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      const formData = new FormData();
      formData.append("full_name", fullName);
      formData.append("bio", profileForm.bio.trim());
      if (profileForm.avatarFile) {
        formData.append("avatar", profileForm.avatarFile);
      }

      const response = await api.patch("/me", formData, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const updatedUser = response.data;
      setUser((current) => ({ ...current, ...updatedUser }));
      setStatusMessage("Profile updated.");

      setMessagesByChat((current) => {
        const updated = {};

        for (const [chatId, list] of Object.entries(current)) {
          updated[chatId] = list.map((message) => {
            if (message.username !== updatedUser.username) return message;

            return {
              ...message,
              fullName: updatedUser.full_name,
              avatarUrl: updatedUser.avatar_url,
            };
          });
        }

        return updated;
      });

      setChats((current) =>
        current.map((chat) => ({
          ...chat,
          participants: chat.participants.map((member) => {
            if (member.id !== updatedUser.id) return member;

            return {
              ...member,
              full_name: updatedUser.full_name,
              avatar_url: updatedUser.avatar_url,
              bio: updatedUser.bio || "",
            };
          }),
        }))
      );

      const socket = socketRef.current;
      if (socket?.connected) {
        socket.emit("presence:join", {
          user: {
            ...updatedUser,
            status: getPresenceStatus(),
          },
        });
      }

      setProfileOpen(false);
      if (profileFileInputRef.current) {
        profileFileInputRef.current.value = "";
      }
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to update profile."));
    } finally {
      setProfileBusy(false);
    }
  }

  function logout() {
    clearTimeout(typingTimeoutRef.current);
    if (selectedChatId) {
      emitTyping(selectedChatId, false);
    }

    setToken("");
    setUser(null);
    setChats([]);
    setSelectedChatId(null);
    setMessagesByChat({});
    setTypingByChat({});
    setOnlineUsers([]);
    setContent("");
    setFile(null);
    setProfileOpen(false);
    setProfileBusy(false);
    setProfileForm({ full_name: "", bio: "", avatarFile: null });
    setChatDetailsOpen(false);
    setChatDetails(null);
    setStatusMessage("You are logged out.");
    setErrorMessage("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function signup(event) {
    event.preventDefault();
    if (authBusy) return;

    const form = event.currentTarget;
    const full_name = form.full_name.value.trim();
    const username = form.username.value.trim();
    const password = form.password.value;

    setAuthBusy(true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      await api.post("/signup", { full_name, username, password });
      setStatusMessage("Signup successful. Please login.");
      form.reset();
    } catch (error) {
      setErrorMessage(messageFromError(error, "Signup failed."));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login(event) {
    event.preventDefault();
    if (authBusy) return;

    const form = event.currentTarget;
    const username = form.username.value.trim();
    const password = form.password.value;

    setAuthBusy(true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      const response = await api.post("/login", { username, password });
      if (!response.data?.token || !response.data?.user) {
        throw new Error("Invalid login response");
      }

      setToken(response.data.token);
      setUser(response.data.user);
      setStatusMessage(`Welcome back, ${response.data.user.full_name}.`);
      form.reset();
    } catch (error) {
      setErrorMessage(messageFromError(error, "Login failed."));
    } finally {
      setAuthBusy(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sendBusy) return;

    if (!selectedChatId) {
      setErrorMessage("Pick a chat first.");
      return;
    }

    const trimmed = content.trim();
    if (!trimmed && !file) return;
    if (!user || !token) return;

    const socket = socketRef.current;
    if (!socket?.connected) {
      setErrorMessage("Connection lost. Reconnecting...");
      socket?.connect();
      return;
    }

    setSendBusy(true);
    setErrorMessage("");

    try {
      let mediaUrl = null;
      let mediaType = null;

      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        const upload = await api.post("/upload", formData, {
          headers: { Authorization: `Bearer ${token}` },
        });

        mediaUrl = upload.data?.url ?? null;
        mediaType = upload.data?.type ?? null;
      }

      socket.emit("message", {
        chatId: selectedChatId,
        clientId: getClientId(),
        userId: user.id,
        username: user.username,
        content: trimmed,
        mediaUrl,
        mediaType,
      });

      clearTimeout(typingTimeoutRef.current);
      emitTyping(selectedChatId, false);
      setContent("");
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to send message."));
    } finally {
      setSendBusy(false);
    }
  }

  const typingLabel =
    typingUsers.length === 1
      ? `${typingUsers[0]} is typing...`
      : `${typingUsers.slice(0, 2).join(", ")} are typing...`;

  if (!token || !user) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Azin</h1>

          {statusMessage && <div className="status">{statusMessage}</div>}
          {errorMessage && <div className="status error">{errorMessage}</div>}

          <h3>Create account</h3>
          <form className="auth-form" onSubmit={signup}>
            <input name="full_name" placeholder="Full Name" required minLength={2} />
            <input name="username" placeholder="Username" required minLength={3} />
            <input name="password" type="password" placeholder="Password" required minLength={6} />
            <button className="btn" disabled={authBusy}>
              {authBusy ? "Please wait..." : "Signup"}
            </button>
          </form>

          <h3>Login</h3>
          <form className="auth-form" onSubmit={login}>
            <input name="username" placeholder="Username" required />
            <input name="password" type="password" placeholder="Password" required />
            <button className="btn" disabled={authBusy}>
              {authBusy ? "Please wait..." : "Login"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const detailsData = chatDetails && chatDetails.id === selectedChatId ? chatDetails : selectedChat;

  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <div className="brand-row">
            <div className="brand">Azin</div>
            <button className="btn ghost" onClick={openProfile}>
              Profile
            </button>
          </div>

          <div className="section-title">Chats</div>
          <div className="chat-list">
            {loadingChats && <div className="muted">Loading chats...</div>}
            {!loadingChats && chats.length === 0 && <div className="muted">No chats available.</div>}

            {chats.map((chat, index) => (
              <button
                key={chat.id}
                className={`chat-item ${chat.id === selectedChatId ? "active" : ""}`}
                style={{ "--enter-delay": `${Math.min(index, 9) * 38}ms` }}
                onClick={() => handleChatSelect(chat.id)}
              >
                <div className="chat-item-top">
                  <span className="chat-item-name">{chat.displayName}</span>
                  <span className="chat-item-time">{formatChatItemTime(chat.lastMessageAt)}</span>
                </div>
                <div className="chat-item-bottom">
                  <span className={`chat-badge ${chat.type}`}>{chat.type}</span>
                  <span className="chat-item-preview">{chat.lastMessagePreview || "No messages yet"}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="main">
          {!selectedChat && (
            <div className="chat-empty panel-empty">Pick a chat from the left side to start messaging.</div>
          )}

          {selectedChat && (
            <>
              <button className="chat-topbar" onClick={() => setChatDetailsOpen(true)}>
                <div>
                  <h2>{selectedChat.displayName}</h2>
                  <div className="muted top-meta">
                    {selectedChat.memberCount} people in chat - {selectedOnlineCount} online now
                  </div>
                </div>
                <div className="topbar-right">
                  <div className={`connection-pill ${connectionState}`}>{connectionState}</div>
                  <span className="topbar-hint">Tap for details</span>
                </div>
              </button>

              <div className="chat" ref={chatRef}>
                {loadingMessages && <div className="chat-empty">Loading messages...</div>}
                {!loadingMessages && currentMessages.length === 0 && (
                  <div className="chat-empty">No messages yet. Start the conversation.</div>
                )}

                {currentMessages.map((message, index) => (
                  <div
                    key={message.id || message.clientId || `${message.username}-${index}`}
                    className={`bubble ${message.username === user.username ? "me" : ""}`}
                    style={{ "--enter-delay": `${Math.min(index, 10) * 26}ms` }}
                  >
                    <div className="meta">
                      <div className="meta-user">
                        <Avatar
                          src={message.avatarUrl}
                          label={message.fullName || message.username}
                          className="message-avatar"
                        />
                        <span>{message.fullName || message.username}</span>
                      </div>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    {message.content && <div>{message.content}</div>}
                    {message.mediaUrl && message.mediaType?.startsWith("image") && (
                      <img className="media-thumb" src={message.mediaUrl} alt="attachment" />
                    )}
                    {message.mediaUrl && !message.mediaType?.startsWith("image") && (
                      <a href={message.mediaUrl} target="_blank" rel="noreferrer">
                        View attachment
                      </a>
                    )}
                  </div>
                ))}
              </div>

              {typingUsers.length > 0 && <div className="typing">{typingLabel}</div>}

              <form className="input-bar" onSubmit={sendMessage}>
                <input
                  className="composer-text"
                  type="text"
                  value={content}
                  placeholder={`Message ${selectedChat.displayName}...`}
                  onChange={handleContentChange}
                  onBlur={() => emitTyping(selectedChatId, false)}
                  maxLength={2000}
                />
                <input
                  className="file-input"
                  type="file"
                  ref={fileInputRef}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <button className="btn send-btn" disabled={sendBusy}>
                  {sendBusy ? "Sending..." : "Send"}
                </button>
              </form>
            </>
          )}

          {errorMessage && <div className="inline-error">{errorMessage}</div>}
        </main>
      </div>

      {chatDetailsOpen && selectedChat && (
        <div className="chat-detail-backdrop" onClick={() => setChatDetailsOpen(false)}>
          <section className="chat-detail-card" onClick={(event) => event.stopPropagation()}>
            <div className="chat-detail-header">
              <h3>{selectedChat.displayName}</h3>
              <button className="btn ghost" onClick={() => setChatDetailsOpen(false)}>
                Close
              </button>
            </div>

            {chatDetailsBusy && <div className="muted">Loading details...</div>}

            {!chatDetailsBusy && detailsData && (
              <>
                <div className="chat-detail-summary">
                  <div>
                    <strong>Type:</strong> {detailsData.type}
                  </div>
                  <div>
                    <strong>Members:</strong> {detailsData.memberCount}
                  </div>
                </div>

                <div className="chat-detail-members">
                  {detailsData.participants.map((member) => {
                    const status = presenceByUsername.get(member.username) || "offline";
                    return (
                      <div className="member-row" key={member.id || member.username}>
                        <div className="member-avatar-wrap">
                          <Avatar src={member.avatar_url} label={member.full_name} className="member-avatar" />
                          <span className={`dot ${status}`} />
                        </div>
                        <span>{member.full_name}</span>
                        <span className="member-username">@{member.username}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {profileOpen && user && (
        <div className="chat-detail-backdrop" onClick={() => setProfileOpen(false)}>
          <section className="chat-detail-card profile-card" onClick={(event) => event.stopPropagation()}>
            <div className="chat-detail-header">
              <h3>Your profile</h3>
              <button className="btn ghost" onClick={() => setProfileOpen(false)}>
                Close
              </button>
            </div>

            <form className="profile-form" onSubmit={saveProfile}>
              <div className="profile-avatar-preview">
                <Avatar src={user.avatar_url} label={user.full_name} className="profile-avatar" />
                <div>
                  <div className="profile-name">{user.full_name}</div>
                  <div className="muted">@{user.username}</div>
                </div>
              </div>

              <label className="profile-field">
                <span>Full name</span>
                <input
                  value={profileForm.full_name}
                  onChange={(event) =>
                    setProfileForm((current) => ({
                      ...current,
                      full_name: event.target.value,
                    }))
                  }
                  required
                  minLength={2}
                />
              </label>

              <label className="profile-field">
                <span>Bio</span>
                <textarea
                  value={profileForm.bio}
                  onChange={(event) =>
                    setProfileForm((current) => ({
                      ...current,
                      bio: event.target.value,
                    }))
                  }
                  placeholder="Tell people a little about yourself..."
                  maxLength={260}
                />
              </label>

              <label className="profile-field">
                <span>Profile picture</span>
                <input
                  type="file"
                  accept="image/*"
                  ref={profileFileInputRef}
                  onChange={(event) =>
                    setProfileForm((current) => ({
                      ...current,
                      avatarFile: event.target.files?.[0] ?? null,
                    }))
                  }
                />
                {profileForm.avatarFile && <span className="muted">{profileForm.avatarFile.name}</span>}
              </label>

              <div className="profile-actions">
                <button className="btn" type="submit" disabled={profileBusy}>
                  {profileBusy ? "Saving..." : "Save changes"}
                </button>
                <button className="btn ghost" type="button" onClick={logout}>
                  Logout
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
