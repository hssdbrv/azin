import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL, api } from "./api";
import { io } from "socket.io-client";

const SOCKET_URL = API_BASE_URL;
const TOKEN_KEY = "azin_token";
const USER_KEY = "azin_user";
const MOBILE_BREAKPOINT = 960;

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
    return normalizeCurrentUser(JSON.parse(raw));
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
    userId: toNumber(message.userId ?? message.user_id),
    username: message.username ?? "Unknown",
    fullName: message.fullName ?? message.full_name ?? message.username ?? "Unknown",
    avatarUrl: resolveAssetUrl(message.avatarUrl ?? message.avatar_url ?? null),
    content: message.content ?? "",
    mediaUrl: resolveAssetUrl(message.mediaUrl ?? message.media_url ?? null),
    mediaType: message.mediaType ?? message.media_type ?? null,
    createdAt: message.createdAt ?? message.created_at ?? null,
    seenAt: message.seenAt ?? message.seen_at ?? null,
    seenBy: toNumber(message.seenBy ?? message.seen_by),
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
            avatar_url: resolveAssetUrl(member?.avatar_url || null),
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
    avatar_url: resolveAssetUrl(user.avatar_url || null),
    bio: user.bio || "",
    status: user.status === "away" ? "away" : "online",
  };
}

function normalizeDirectoryUser(user) {
  if (!user?.username) return null;

  return {
    id: toNumber(user?.id),
    username: user.username,
    full_name: user.full_name || user.username,
    avatar_url: resolveAssetUrl(user.avatar_url || null),
    bio: user.bio || "",
    is_contact: Boolean(user.is_contact ?? user.isContact),
    private_chat_id: toNumber(user.private_chat_id ?? user.privateChatId),
  };
}

function normalizeCurrentUser(user) {
  if (!user?.username) return null;

  return {
    ...user,
    id: toNumber(user.id),
    avatar_url: resolveAssetUrl(user.avatar_url || null),
    bio: user.bio || "",
  };
}

function getUserStatus(username, presenceByUsername) {
  return presenceByUsername.get(username) || "offline";
}

function resolveAssetUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  try {
    const apiUrl = new URL(API_BASE_URL);
    const parsed = new URL(raw, apiUrl.origin);

    if (typeof window !== "undefined") {
      const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      const activeHost = window.location.hostname;
      if (isLocalHost && parsed.hostname !== activeHost) {
        parsed.protocol = apiUrl.protocol;
        parsed.hostname = apiUrl.hostname;
        parsed.port = apiUrl.port;
      }
    }

    return parsed.toString();
  } catch {
    return raw;
  }
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
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (src && !hasError) {
    return <img className={className} src={src} alt={label} onError={() => setHasError(true)} />;
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
  const [unreadByChat, setUnreadByChat] = useState({});

  const [content, setContent] = useState("");
  const [file, setFile] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [contactBusyUsername, setContactBusyUsername] = useState("");
  const [removeContactBusyUsername, setRemoveContactBusyUsername] = useState("");
  const [viewProfileOpen, setViewProfileOpen] = useState(false);
  const [viewProfileBusy, setViewProfileBusy] = useState(false);
  const [viewedProfile, setViewedProfile] = useState(null);
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
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= MOBILE_BREAKPOINT : false
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const socketRef = useRef(null);
  const activeUserRef = useRef(user);
  const activeSelectedChatRef = useRef(selectedChatId);
  const activeChatsRef = useRef(chats);
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
    activeSelectedChatRef.current = selectedChatId;
  }, [selectedChatId]);

  useEffect(() => {
    activeChatsRef.current = chats;
  }, [chats]);

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
    if (typeof window === "undefined") return undefined;

    const handleResize = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileMenuOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [selectedChatId, currentMessages.length]);

  useEffect(() => {
    if (!token) {
      setContacts([]);
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    api
      .get("/contacts", {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (cancelled) return;

        const normalized = Array.isArray(response.data)
          ? response.data.map(normalizeDirectoryUser).filter(Boolean)
          : [];
        setContacts(normalized);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(messageFromError(error, "Failed to load contacts."));
      });

    return () => {
      cancelled = true;
    };
  }, [token, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    if (selectedChatId || chats.length === 0) return;
    setSelectedChatId(chats[0].id);
  }, [isMobile, selectedChatId, chats]);

  useEffect(() => {
    if (!token) return;

    const query = searchInput.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }

    let cancelled = false;
    setSearchBusy(true);

    const timer = setTimeout(() => {
      api
        .get("/users/search", {
          params: { q: query },
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((response) => {
          if (cancelled) return;
          const normalized = Array.isArray(response.data)
            ? response.data.map(normalizeDirectoryUser).filter(Boolean)
            : [];
          setSearchResults(normalized);
        })
        .catch((error) => {
          if (cancelled) return;
          setErrorMessage(messageFromError(error, "Failed to search users."));
        })
        .finally(() => {
          if (!cancelled) {
            setSearchBusy(false);
          }
        });
    }, 260);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchInput, token]);

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

      const chatForMessage = activeChatsRef.current.find((chat) => chat.id === normalized.chatId);
      const isPrivateChat = chatForMessage?.type === "private";
      const activeUserId = toNumber(activeUserRef.current?.id);
      const isIncomingFromOtherUser = activeUserId
        ? normalized.userId !== activeUserId
        : normalized.username !== activeUserRef.current?.username;
      const isActiveChat = activeSelectedChatRef.current === normalized.chatId;

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

      if (isPrivateChat && isIncomingFromOtherUser && !isActiveChat) {
        setUnreadByChat((current) => ({
          ...current,
          [normalized.chatId]: (current[normalized.chatId] || 0) + 1,
        }));
      }

      if (isPrivateChat && isIncomingFromOtherUser && isActiveChat) {
        socket.emit("chat:seen", { chatId: normalized.chatId });
      }
    });

    socket.on("messages:seen", ({ chatId, seenBy, seen }) => {
      const parsedChatId = toNumber(chatId);
      if (!parsedChatId || !Array.isArray(seen) || !seen.length) return;

      const updates = new Map(
        seen
          .map((entry) => ({
            id: toNumber(entry?.id),
            seenAt: entry?.seenAt ?? entry?.seen_at ?? null,
          }))
          .filter((entry) => entry.id)
          .map((entry) => [entry.id, entry.seenAt])
      );
      if (!updates.size) return;

      setMessagesByChat((current) => {
        const forChat = current[parsedChatId] || [];
        if (!forChat.length) return current;

        return {
          ...current,
          [parsedChatId]: forChat.map((message) => {
            if (!updates.has(message.id)) return message;
            return {
              ...message,
              seenAt: updates.get(message.id),
              seenBy: toNumber(seenBy),
            };
          }),
        };
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
      setUnreadByChat({});
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

          if (isMobile) {
            return null;
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
  }, [token, isMobile]);

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
    if (!selectedChatId) return;
    setUnreadByChat((current) => ({
      ...current,
      [selectedChatId]: 0,
    }));
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !selectedChat || selectedChat.type !== "private") return;
    emitSeen(selectedChatId);
  }, [selectedChatId, currentMessages.length, selectedChat?.type]);

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

  function emitSeen(chatId) {
    if (!chatId) return;
    const socket = socketRef.current;
    if (!socket?.connected) return;

    socket.emit("chat:seen", { chatId });
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
    setMobileMenuOpen(false);
    setUnreadByChat((current) => ({
      ...current,
      [chatId]: 0,
    }));
    emitSeen(chatId);
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

      setUser((current) => normalizeCurrentUser({ ...current, ...response.data }));
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

      const updatedUser = normalizeCurrentUser(response.data);
      if (!updatedUser) {
        throw new Error("Invalid profile response");
      }
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
    setUnreadByChat({});
    setContacts([]);
    setSearchInput("");
    setSearchResults([]);
    setSearchBusy(false);
    setContactBusyUsername("");
    setRemoveContactBusyUsername("");
    setViewProfileOpen(false);
    setViewProfileBusy(false);
    setViewedProfile(null);
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
    setMobileMenuOpen(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function upsertChat(chatPayload) {
    const normalized = normalizeChat(chatPayload);
    if (!normalized.id) return null;

    setChats((current) => {
      const exists = current.some((chat) => chat.id === normalized.id);
      const updated = exists
        ? current.map((chat) => (chat.id === normalized.id ? normalized : chat))
        : [normalized, ...current];
      return sortChatsByRecent(updated);
    });
    setSelectedChatId(normalized.id);

    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit("chat:join", { chatId: normalized.id });
    }

    return normalized;
  }

  async function startPrivateChat(username) {
    if (!username || !token) return;

    setErrorMessage("");
    setStatusMessage("");

    try {
      const response = await api.post(
        "/chats/private",
        { username },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const chat = upsertChat(response.data);

      if (chat) {
        setContacts((current) =>
          current.map((contact) =>
            contact.username === username
              ? { ...contact, private_chat_id: contact.private_chat_id || chat.id }
              : contact
          )
        );
        setSearchResults((current) =>
          current.map((entry) =>
            entry.username === username ? { ...entry, private_chat_id: entry.private_chat_id || chat.id } : entry
          )
        );
        setViewedProfile((current) =>
          current?.username === username
            ? { ...current, private_chat_id: current.private_chat_id || chat.id }
            : current
        );
      }
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to open private chat."));
    }
  }

  async function addContact(username) {
    if (!username || !token) return;

    setContactBusyUsername(username);
    setErrorMessage("");
    setStatusMessage("");

    try {
      const response = await api.post(
        "/contacts",
        { username },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const normalized = normalizeDirectoryUser(response.data);
      if (!normalized) return;

      setContacts((current) => {
        const exists = current.some((contact) => contact.username === normalized.username);
        if (exists) {
          return current.map((contact) =>
            contact.username === normalized.username
              ? { ...contact, ...normalized, is_contact: true }
              : contact
          );
        }

        return [...current, { ...normalized, is_contact: true }].sort((a, b) =>
          a.full_name.localeCompare(b.full_name)
        );
      });

      setSearchResults((current) =>
        current.map((result) =>
          result.username === username ? { ...result, is_contact: true } : result
        )
      );
      setViewedProfile((current) =>
        current?.username === username ? { ...current, is_contact: true } : current
      );
      setStatusMessage(`@${username} added to your contacts.`);
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to add contact."));
    } finally {
      setContactBusyUsername("");
    }
  }

  async function removeContact(username) {
    if (!username || !token) return;

    setRemoveContactBusyUsername(username);
    setErrorMessage("");
    setStatusMessage("");

    try {
      await api.delete(`/contacts/${encodeURIComponent(username)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setContacts((current) => current.filter((contact) => contact.username !== username));
      setSearchResults((current) =>
        current.map((result) =>
          result.username === username ? { ...result, is_contact: false } : result
        )
      );
      setViewedProfile((current) =>
        current?.username === username ? { ...current, is_contact: false } : current
      );
      setStatusMessage(`@${username} removed from your contacts.`);
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to remove contact."));
    } finally {
      setRemoveContactBusyUsername("");
    }
  }

  async function openUserProfile(username) {
    if (!username || !token) return;

    setViewProfileOpen(true);
    setViewProfileBusy(true);
    setErrorMessage("");

    try {
      const response = await api.get(`/users/${encodeURIComponent(username)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const normalized = normalizeDirectoryUser(response.data);
      setViewedProfile(normalized);
    } catch (error) {
      setErrorMessage(messageFromError(error, "Failed to load user profile."));
      setViewedProfile(null);
    } finally {
      setViewProfileBusy(false);
    }
  }

  function openPrivateChatFromDirectory(entry) {
    if (!entry?.username) return;

    if (entry.private_chat_id && chats.some((chat) => chat.id === entry.private_chat_id)) {
      handleChatSelect(entry.private_chat_id);
      return;
    }

    startPrivateChat(entry.username);
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

      const nextUser = normalizeCurrentUser(response.data.user);
      if (!nextUser) {
        throw new Error("Invalid user data");
      }

      setToken(response.data.token);
      setUser(nextUser);
      setStatusMessage(`Welcome back, ${nextUser.full_name}.`);
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

  function getPrivateChatPeer(chat) {
    if (!chat || chat.type !== "private") return null;

    return (
      chat.participants.find(
        (member) => member.id !== user.id && member.username !== user.username
      ) || chat.participants[0] || null
    );
  }

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
  const showMobileChatList = isMobile && !selectedChat;

  return (
    <>
      <div className="app">
        <aside className={`sidebar ${mobileMenuOpen ? "open" : ""}`}>
          <div className="brand-row">
            <div className="brand">Azin</div>
            <div className="brand-actions">
              {isMobile && (
                <button className="btn ghost" onClick={() => setMobileMenuOpen(false)}>
                  Close
                </button>
              )}
              <button className="btn ghost" onClick={openProfile}>
                Profile
              </button>
            </div>
          </div>

          <div className="section-title">Start private chat</div>
          <div className="user-search-panel">
            <input
              className="search-input"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by username or name"
            />
            {searchBusy && <div className="muted">Searching users...</div>}
            {!searchBusy && searchInput.trim().length >= 2 && searchResults.length === 0 && (
              <div className="muted">No users found.</div>
            )}

            {searchResults.map((entry) => (
              <div className="user-row" key={entry.username}>
                <button
                  className="user-row-meta profile-trigger"
                  onClick={() => openUserProfile(entry.username)}
                >
                  <Avatar src={entry.avatar_url} label={entry.full_name} className="member-avatar" />
                  <div>
                    <div className="user-row-name">{entry.full_name}</div>
                    <div className="user-row-username">@{entry.username}</div>
                  </div>
                </button>
                <div className="user-row-actions">
                  <button className="btn ghost action-btn" onClick={() => openPrivateChatFromDirectory(entry)}>
                    Chat
                  </button>
                  <button
                    className="btn ghost action-btn"
                    disabled={entry.is_contact || contactBusyUsername === entry.username}
                    onClick={() => addContact(entry.username)}
                  >
                    {entry.is_contact ? "Added" : contactBusyUsername === entry.username ? "Adding..." : "Add"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="section-title">Contacts</div>
          <div className="contact-list">
            {contacts.length === 0 && <div className="muted">No contacts yet.</div>}
            {contacts.map((contact) => (
              <div key={contact.username} className="contact-item">
                <button
                  className="contact-main profile-trigger"
                  onClick={() => openUserProfile(contact.username)}
                >
                  <div className="member-avatar-wrap">
                    <Avatar src={contact.avatar_url} label={contact.full_name} className="member-avatar" />
                    <span className={`dot ${getUserStatus(contact.username, presenceByUsername)}`} />
                  </div>
                  <div>
                    <div className="contact-name">{contact.full_name}</div>
                    <div className="contact-username">@{contact.username}</div>
                  </div>
                </button>
              </div>
            ))}
          </div>

          {!isMobile && (
            <>
              <div className="section-title">Chats</div>
              <div className="chat-list">
                {loadingChats && <div className="muted">Loading chats...</div>}
                {!loadingChats && chats.length === 0 && <div className="muted">No chats available.</div>}

                {chats.map((chat, index) => (
                  (() => {
                    const privatePeer = getPrivateChatPeer(chat);
                    const privatePeerStatus = privatePeer
                      ? getUserStatus(privatePeer.username, presenceByUsername)
                      : "offline";

                    return (
                      <button
                        key={chat.id}
                        className={`chat-item ${chat.id === selectedChatId ? "active" : ""} ${
                          chat.type === "private" && (unreadByChat[chat.id] || 0) > 0 ? "private-unread" : ""
                        }`}
                        style={{ "--enter-delay": `${Math.min(index, 9) * 38}ms` }}
                        onClick={() => handleChatSelect(chat.id)}
                      >
                        <div className="chat-item-top">
                          <div className="chat-item-title">
                            {chat.type === "private" && (
                              <div className="member-avatar-wrap chat-avatar-wrap">
                                <Avatar
                                  src={privatePeer?.avatar_url || null}
                                  label={privatePeer?.full_name || chat.displayName}
                                  className="member-avatar"
                                />
                                <span className={`dot ${privatePeerStatus}`} />
                              </div>
                            )}
                            <span className="chat-item-name">{chat.displayName}</span>
                          </div>
                          <div className="chat-item-time-wrap">
                            <span className="chat-item-time">{formatChatItemTime(chat.lastMessageAt)}</span>
                            {chat.type === "private" && (unreadByChat[chat.id] || 0) > 0 && (
                              <span className="unread-pill">{unreadByChat[chat.id]}</span>
                            )}
                          </div>
                        </div>
                        <div className="chat-item-bottom">
                          <span className={`chat-badge ${chat.type}`}>{chat.type}</span>
                          <span className="chat-item-preview">{chat.lastMessagePreview || "No messages yet"}</span>
                        </div>
                      </button>
                    );
                  })()
                ))}
              </div>
            </>
          )}
        </aside>

        <main className="main">
          {showMobileChatList && (
            <section className="mobile-chat-list">
              <div className="mobile-top">
                <button className="btn ghost" onClick={() => setMobileMenuOpen(true)}>
                  Menu
                </button>
                <button className="btn ghost" onClick={openProfile}>
                  Profile
                </button>
              </div>
              <h2 className="mobile-title">Your chats</h2>
              <div className="chat-list mobile-only-list">
                {loadingChats && <div className="muted">Loading chats...</div>}
                {!loadingChats && chats.length === 0 && <div className="muted">No chats available.</div>}
                {chats.map((chat, index) => (
                  (() => {
                    const privatePeer = getPrivateChatPeer(chat);
                    const privatePeerStatus = privatePeer
                      ? getUserStatus(privatePeer.username, presenceByUsername)
                      : "offline";

                    return (
                      <button
                        key={chat.id}
                        className={`chat-item ${
                          chat.type === "private" && (unreadByChat[chat.id] || 0) > 0 ? "private-unread" : ""
                        }`}
                        style={{ "--enter-delay": `${Math.min(index, 9) * 38}ms` }}
                        onClick={() => handleChatSelect(chat.id)}
                      >
                        <div className="chat-item-top">
                          <div className="chat-item-title">
                            {chat.type === "private" && (
                              <div className="member-avatar-wrap chat-avatar-wrap">
                                <Avatar
                                  src={privatePeer?.avatar_url || null}
                                  label={privatePeer?.full_name || chat.displayName}
                                  className="member-avatar"
                                />
                                <span className={`dot ${privatePeerStatus}`} />
                              </div>
                            )}
                            <span className="chat-item-name">{chat.displayName}</span>
                          </div>
                          <div className="chat-item-time-wrap">
                            <span className="chat-item-time">{formatChatItemTime(chat.lastMessageAt)}</span>
                            {chat.type === "private" && (unreadByChat[chat.id] || 0) > 0 && (
                              <span className="unread-pill">{unreadByChat[chat.id]}</span>
                            )}
                          </div>
                        </div>
                        <div className="chat-item-bottom">
                          <span className={`chat-badge ${chat.type}`}>{chat.type}</span>
                          <span className="chat-item-preview">{chat.lastMessagePreview || "No messages yet"}</span>
                        </div>
                      </button>
                    );
                  })()
                ))}
              </div>
            </section>
          )}

          {!selectedChat && !showMobileChatList && (
            <div className="chat-empty panel-empty">Pick a chat from the left side to start messaging.</div>
          )}

          {selectedChat && (
            <>
              <div className="chat-topbar">
                <div className="topbar-title">
                  {isMobile && (
                    <button
                      className="btn ghost mobile-back"
                      onClick={() => setSelectedChatId(null)}
                    >
                      Back
                    </button>
                  )}
                  <h2>{selectedChat.displayName}</h2>
                  <div className="muted top-meta">
                    {selectedChat.memberCount} people in chat - {selectedOnlineCount} online now
                  </div>
                </div>
                <div className="topbar-right">
                  {isMobile && (
                    <button
                      className="btn ghost mobile-menu-btn"
                      onClick={() => setMobileMenuOpen(true)}
                    >
                      Menu
                    </button>
                  )}
                  <div className={`connection-pill ${connectionState}`}>{connectionState}</div>
                  <button className="topbar-hint profile-trigger" onClick={() => setChatDetailsOpen(true)}>
                    Details
                  </button>
                </div>
              </div>

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
                      <button
                        className="meta-user profile-trigger"
                        onClick={() => openUserProfile(message.username)}
                      >
                        <Avatar
                          src={message.avatarUrl}
                          label={message.fullName || message.username}
                          className="message-avatar"
                        />
                        <span>{message.fullName || message.username}</span>
                      </button>
                      <span>
                        {formatTime(message.createdAt)}
                        {selectedChat?.type === "private" && message.username === user.username && (
                          <> - {message.seenAt ? "Seen" : "Sent"}</>
                        )}
                      </span>
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
                <div className="composer-row">
                  <input
                    className="composer-text"
                    type="text"
                    value={content}
                    placeholder={`Message ${selectedChat.displayName}...`}
                    onChange={handleContentChange}
                    onBlur={() => emitTyping(selectedChatId, false)}
                    maxLength={2000}
                  />
                  <button className="btn send-btn" disabled={sendBusy}>
                    {sendBusy ? "Sending..." : "Send"}
                  </button>
                </div>
                <input
                  className="file-input"
                  type="file"
                  ref={fileInputRef}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </form>
            </>
          )}

          {errorMessage && <div className="inline-error">{errorMessage}</div>}
        </main>
      </div>

      {isMobile && mobileMenuOpen && (
        <button className="mobile-nav-backdrop" onClick={() => setMobileMenuOpen(false)} aria-label="Close menu" />
      )}

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
                      <button
                        className="member-row profile-trigger"
                        key={member.id || member.username}
                        onClick={() => openUserProfile(member.username)}
                      >
                        <div className="member-avatar-wrap">
                          <Avatar src={member.avatar_url} label={member.full_name} className="member-avatar" />
                          <span className={`dot ${status}`} />
                        </div>
                        <span>{member.full_name}</span>
                        <span className="member-username">@{member.username}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {viewProfileOpen && (
        <div className="chat-detail-backdrop" onClick={() => setViewProfileOpen(false)}>
          <section className="chat-detail-card profile-card" onClick={(event) => event.stopPropagation()}>
            <div className="chat-detail-header">
              <h3>User profile</h3>
              <button className="btn ghost" onClick={() => setViewProfileOpen(false)}>
                Close
              </button>
            </div>

            {viewProfileBusy && <div className="muted">Loading profile...</div>}

            {!viewProfileBusy && viewedProfile && (
              <div className="view-profile-body">
                <div className="profile-avatar-preview">
                  <div className="profile-avatar-wrap">
                    <Avatar
                      src={viewedProfile.avatar_url}
                      label={viewedProfile.full_name}
                      className="profile-avatar"
                    />
                    <span className={`dot ${getUserStatus(viewedProfile.username, presenceByUsername)}`} />
                  </div>
                  <div>
                    <div className="profile-name">{viewedProfile.full_name}</div>
                    <div className="muted">@{viewedProfile.username}</div>
                    <div className="contact-status-text">
                      {getUserStatus(viewedProfile.username, presenceByUsername)}
                    </div>
                  </div>
                </div>

                <div className="profile-bio-block">
                  <strong>Bio</strong>
                  <p>{viewedProfile.bio || "No bio yet."}</p>
                </div>

                {viewedProfile.username !== user.username && (
                  <div className="profile-actions">
                    <button
                      className="btn"
                      onClick={() => openPrivateChatFromDirectory(viewedProfile)}
                    >
                      Message
                    </button>
                    {!viewedProfile.is_contact && (
                      <button
                        className="btn ghost"
                        onClick={() => addContact(viewedProfile.username)}
                        disabled={contactBusyUsername === viewedProfile.username}
                      >
                        {contactBusyUsername === viewedProfile.username ? "Adding..." : "Add contact"}
                      </button>
                    )}
                    {viewedProfile.is_contact && (
                      <button
                        className="btn ghost"
                        onClick={() => removeContact(viewedProfile.username)}
                        disabled={removeContactBusyUsername === viewedProfile.username}
                      >
                        {removeContactBusyUsername === viewedProfile.username ? "Removing..." : "Remove contact"}
                      </button>
                    )}
                  </div>
                )}
              </div>
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
