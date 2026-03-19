/* ══════════════════════════════════════════════════════════════
   ChatWave — Frontend Application
   ══════════════════════════════════════════════════════════════ */

const API = "";
let socket = null;
let currentUser = null;
let currentConversation = null;
let conversations = [];
let onlineUsers = new Set();
let typingTimer = null;
let isTyping = false;
let oldestMessageDate = null;
let hasMoreMessages = false;
const PAGE_SIZE = 50;

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const authScreen   = $("auth-screen");
const appScreen    = $("app-screen");
const loginForm    = $("login-form");
const signupForm   = $("signup-form");
const loginError   = $("login-error");
const signupError  = $("signup-error");

// ── Utilities ─────────────────────────────────────────────────
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icons = { success: "✅", error: "❌", info: "💬" };
  el.innerHTML = `<span>${icons[type] || "💬"}</span><span>${msg}</span>`;
  $("toast-container").appendChild(el);
  setTimeout(() => {
    el.style.animation = "toast-out 0.3s forwards";
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function getInitials(name) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function setAvatar(el, name, color) {
  el.textContent = getInitials(name);
  el.style.background = color || "#6366f1";
  el.style.color = "#fff";
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatConvTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setLoading(btn, loading) {
  const span = btn.querySelector("span");
  const loader = btn.querySelector(".btn-loader");
  if (loading) {
    span.classList.add("hidden");
    loader.classList.remove("hidden");
    btn.disabled = true;
  } else {
    span.classList.remove("hidden");
    loader.classList.add("hidden");
    btn.disabled = false;
  }
}

async function api(path, method = "GET", body) {
  const token = localStorage.getItem("cw_token");
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Auth ──────────────────────────────────────────────────────
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
    tab.classList.add("active");
    $(`${tab.dataset.tab}-form`).classList.add("active");
    loginError.textContent = "";
    signupError.textContent = "";
  });
});

$("login-btn").addEventListener("click", async () => {
  const username = $("login-username").value.trim();
  const email = $("login-email").value.trim();
  loginError.textContent = "";
  if (!username || !email) return (loginError.textContent = "Please enter your name and email");

  setLoading($("login-btn"), true);
  try {
    const data = await api("/api/login", "POST", { email, username });
    localStorage.setItem("cw_token", data.token);
    localStorage.setItem("cw_user", JSON.stringify(data.user));
    currentUser = data.user;
    await initApp();
    toast(`Welcome back, ${data.user.username}! Your chats have been restored.`, "success");
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    setLoading($("login-btn"), false);
  }
});

$("signup-btn").addEventListener("click", async () => {
  const username = $("signup-username").value.trim();
  const email = $("signup-email").value.trim();
  signupError.textContent = "";
  if (!username || !email) return (signupError.textContent = "Please enter your name and email");
  if (username.length < 2) return (signupError.textContent = "Name must be at least 2 characters");

  setLoading($("signup-btn"), true);
  try {
    const data = await api("/api/signup", "POST", { username, email });
    localStorage.setItem("cw_token", data.token);
    localStorage.setItem("cw_user", JSON.stringify(data.user));
    currentUser = data.user;
    await initApp();
    toast(`Account created! Welcome, ${data.user.username}!`, "success");
  } catch (err) {
    signupError.textContent = err.message;
  } finally {
    setLoading($("signup-btn"), false);
  }
});

// Enter key on login fields
[$("login-username"), $("login-email")].forEach((el) => {
  el?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });
});

// Enter key on signup fields
[$("signup-username"), $("signup-email")].forEach((el) => {
  el?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("signup-btn").click(); });
});

$("logout-btn").addEventListener("click", () => {
  if (socket) socket.disconnect();
  localStorage.removeItem("cw_token");
  localStorage.removeItem("cw_user");
  currentUser = null;
  currentConversation = null;
  conversations = [];
  onlineUsers.clear();
  authScreen.classList.add("active");
  appScreen.classList.remove("active");
  $("login-username").value = "";
  $("login-email").value = "";
});

// ── App Initialization ────────────────────────────────────────
async function initApp() {
  authScreen.classList.remove("active");
  appScreen.classList.add("active");

  // Set user info in sidebar
  const myAvatar = $("my-avatar");
  setAvatar(myAvatar, currentUser.username, currentUser.avatar_color);
  $("my-username").textContent = currentUser.username;
  $("my-email").textContent = currentUser.email;

  // Connect socket
  connectSocket();

  // Load all conversations (restores full chat history from DB on login)
  await loadConversations();
}

// ── Socket Connection ─────────────────────────────────────────
function connectSocket() {
  const token = localStorage.getItem("cw_token");
  socket = io({ auth: { token } });

  socket.on("connect", () => {
    console.log("🔗 Socket connected");
  });

  socket.on("online_users", (users) => {
    onlineUsers = new Set(users);
    updateOnlineStatus();
  });

  socket.on("user_online", ({ userId }) => {
    onlineUsers.add(userId);
    updateOnlineStatus();
    if (currentConversation?.other_user?.id === userId) {
      $("chat-status").textContent = "Online";
      $("chat-status").className = "chat-status online";
    }
  });

  socket.on("user_offline", ({ userId }) => {
    onlineUsers.delete(userId);
    updateOnlineStatus();
    if (currentConversation?.other_user?.id === userId) {
      $("chat-status").textContent = "Offline";
      $("chat-status").className = "chat-status";
    }
  });

  socket.on("new_message", (message) => {
    // Skip own messages — optimistic UI already displayed them instantly
    if (message.sender_id === currentUser.id) return;

    if (currentConversation && message.conversation_id === currentConversation.id) {
      appendMessage(message, false);
      scrollToBottom();
      // Mark as read via API
      api(`/api/conversations/${currentConversation.id}/messages`).catch(() => {});
    }
    // Update conversation preview
    updateConvPreview(message.conversation_id, message.content, message.created_at);
  });

  socket.on("conversation_updated", ({ conversation_id, last_message, last_message_at, sender_id }) => {
    updateConvPreview(conversation_id, last_message, last_message_at, sender_id !== currentUser.id);
  });

  socket.on("typing_start", ({ userId, username, conversation_id }) => {
    if (currentConversation?.id === conversation_id) {
      $("typing-indicator").classList.remove("hidden");
    }
  });

  socket.on("typing_stop", ({ userId, conversation_id }) => {
    if (currentConversation?.id === conversation_id) {
      $("typing-indicator").classList.add("hidden");
    }
  });

  socket.on("disconnect", () => {
    console.log("🔌 Socket disconnected");
  });
}

function updateOnlineStatus() {
  // Update conversation list dots
  document.querySelectorAll(".conversation-item").forEach((item) => {
    const userId = item.dataset.userId;
    const dot = item.querySelector(".online-dot");
    if (userId && onlineUsers.has(userId)) {
      if (!dot) {
        const newDot = document.createElement("div");
        newDot.className = "online-dot";
        item.querySelector(".avatar").appendChild(newDot);
      }
    } else if (dot) {
      dot.remove();
    }
  });
}

// ── Conversations ─────────────────────────────────────────────
async function loadConversations() {
  try {
    conversations = await api("/api/conversations");
    renderConversations();
  } catch (err) {
    toast("Failed to load conversations", "error");
  }
}

function renderConversations() {
  const list = $("conversations-list");
  if (!conversations.length) {
    list.innerHTML = `
      <div class="empty-state-small">
        <p>No conversations yet</p>
        <span>Search for a user to start chatting</span>
      </div>`;
    return;
  }

  list.innerHTML = conversations
    .map((conv) => {
      const isOnline = onlineUsers.has(conv.other_user.id);
      const isActive = currentConversation?.id === conv.id;
      const avatarInitials = getInitials(conv.other_user.username);
      const unread = conv.unread_count > 0
        ? `<span class="unread-badge">${conv.unread_count}</span>`
        : "";

      return `
      <div class="conversation-item ${isActive ? "active" : ""}" 
           data-id="${conv.id}" 
           data-user-id="${conv.other_user.id}"
           onclick="openConversation('${conv.id}')">
        <div class="avatar" style="background:${conv.other_user.avatar_color};color:#fff;font-family:'Syne',sans-serif;font-weight:700;">
          ${avatarInitials}
          ${isOnline ? '<div class="online-dot"></div>' : ""}
        </div>
        <div class="conv-info">
          <div class="conv-header">
            <span class="conv-name">${conv.other_user.username}</span>
            <span class="conv-time">${conv.last_message_at ? formatConvTime(conv.last_message_at) : ""}</span>
          </div>
          <div class="conv-preview">${conv.last_message || "No messages yet"}</div>
        </div>
        ${unread}
      </div>`;
    })
    .join("");
}

function updateConvPreview(convId, lastMessage, lastMessageAt, incrementUnread = false) {
  const idx = conversations.findIndex((c) => c.id === convId);
  if (idx !== -1) {
    conversations[idx].last_message = lastMessage;
    conversations[idx].last_message_at = lastMessageAt;
    if (incrementUnread && currentConversation?.id !== convId) {
      conversations[idx].unread_count = (conversations[idx].unread_count || 0) + 1;
    }
    // Move to top
    const conv = conversations.splice(idx, 1)[0];
    conversations.unshift(conv);
  } else {
    // New conversation — reload
    loadConversations();
    return;
  }
  renderConversations();
}

// ── Open / Load Chat ──────────────────────────────────────────
async function openConversation(convId) {
  const conv = conversations.find((c) => c.id === convId);
  if (!conv) return;

  if (currentConversation?.id === convId) return;

  // Leave old room
  if (currentConversation) {
    socket.emit("leave_conversation", currentConversation.id);
  }

  currentConversation = conv;
  conv.unread_count = 0;
  renderConversations();

  // Update UI
  $("chat-empty").classList.add("hidden");
  $("chat-window").classList.remove("hidden");

  const chatAvatar = $("chat-avatar");
  setAvatar(chatAvatar, conv.other_user.username, conv.other_user.avatar_color);
  $("chat-username").textContent = conv.other_user.username;

  const isOnline = onlineUsers.has(conv.other_user.id);
  $("chat-status").textContent = isOnline ? "Online" : "Offline";
  $("chat-status").className = `chat-status ${isOnline ? "online" : ""}`;

  // Join socket room
  socket.emit("join_conversation", convId);

  // Load messages
  oldestMessageDate = null;
  hasMoreMessages = false;
  $("messages-list").innerHTML = "";
  $("load-more-btn").classList.add("hidden");

  await loadMessages(convId);
}

async function loadMessages(convId, before = null) {
  try {
    let url = `/api/conversations/${convId}/messages?limit=${PAGE_SIZE}`;
    if (before) url += `&before=${encodeURIComponent(before)}`;

    const messages = await api(url);

    if (before) {
      // Prepend older messages
      const list = $("messages-list");
      const prevHeight = list.scrollHeight;
      renderMessages(messages, true);
      const messagesContainer = list;
      messagesContainer.scrollTop = messagesContainer.scrollHeight - prevHeight;
    } else {
      renderMessages(messages, false);
      scrollToBottom();
    }

    hasMoreMessages = messages.length >= PAGE_SIZE;
    if (hasMoreMessages) {
      $("load-more-btn").classList.remove("hidden");
      oldestMessageDate = messages[0]?.created_at || null;
    } else {
      $("load-more-btn").classList.add("hidden");
    }
  } catch (err) {
    toast("Failed to load messages", "error");
  }
}

$("load-more-btn").addEventListener("click", () => {
  if (currentConversation && oldestMessageDate) {
    loadMessages(currentConversation.id, oldestMessageDate);
  }
});

function renderMessages(messages, prepend = false) {
  const list = $("messages-list");
  let lastDate = null;
  let lastSenderId = null;
  const fragment = document.createDocumentFragment();

  if (!prepend) {
    // Find last displayed sender
    const lastMsg = list.lastElementChild;
    lastSenderId = lastMsg?.dataset?.senderId || null;
  }

  messages.forEach((msg, idx) => {
    const msgDate = formatDate(msg.created_at);

    // Date separator
    if (msgDate !== lastDate) {
      const sep = document.createElement("div");
      sep.className = "date-separator";
      sep.innerHTML = `<span>${msgDate}</span>`;
      fragment.appendChild(sep);
      lastDate = msgDate;
      lastSenderId = null;
    }

    const el = createMessageEl(msg, lastSenderId !== msg.sender_id);
    el.dataset.senderId = msg.sender_id;
    fragment.appendChild(el);
    lastSenderId = msg.sender_id;
  });

  if (prepend) {
    list.prepend(fragment);
  } else {
    list.appendChild(fragment);
  }
}

function appendMessage(msg, prepend = false) {
  const list = $("messages-list");
  const lastSenderId = list.lastElementChild?.dataset?.senderId || null;

  // Date check
  const msgDate = formatDate(msg.created_at);
  const lastDateEl = list.querySelector(".date-separator:last-of-type span");
  if (!lastDateEl || lastDateEl.textContent !== msgDate) {
    const sep = document.createElement("div");
    sep.className = "date-separator";
    sep.innerHTML = `<span>${msgDate}</span>`;
    list.appendChild(sep);
  }

  const el = createMessageEl(msg, lastSenderId !== msg.sender_id);
  el.dataset.senderId = msg.sender_id;
  list.appendChild(el);
}

function createMessageEl(msg, showAvatar = true) {
  const isSent = msg.sender_id === currentUser.id;
  const row = document.createElement("div");
  row.className = `message-row ${isSent ? "sent" : "received"}`;
  row.dataset.msgId = msg.id;
  row.dataset.senderId = msg.sender_id;

  const readCheck = isSent
    ? `<span class="message-read-check">${msg.read_at ? "✓✓" : "✓"}</span>`
    : "";

  row.innerHTML = `
    <div class="message-bubble">
      ${escapeHtml(msg.content)}
      <div class="message-meta">
        <span class="message-time">${formatTime(msg.created_at)}</span>
        ${readCheck}
      </div>
    </div>`;

  return row;
}

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function scrollToBottom() {
  const list = $("messages-list");
  list.scrollTop = list.scrollHeight;
}

// ── Send Message ──────────────────────────────────────────────
const msgInput = $("message-input");
const sendBtn  = $("send-btn");
const charCount = $("char-count");

msgInput.addEventListener("input", () => {
  // Auto-resize
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";

  // Char count
  charCount.textContent = `${msgInput.value.length} / 2000`;

  // Typing indicator
  if (!isTyping && currentConversation) {
    isTyping = true;
    socket.emit("typing_start", { conversation_id: currentConversation.id });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    if (currentConversation) {
      socket.emit("typing_stop", { conversation_id: currentConversation.id });
    }
  }, 1500);
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

function sendMessage() {
  const content = msgInput.value.trim();
  if (!content || !currentConversation || !socket) return;

  // Optimistic UI
  const tempMsg = {
    id: `temp_${Date.now()}`,
    conversation_id: currentConversation.id,
    sender_id: currentUser.id,
    username: currentUser.username,
    content,
    type: "text",
    created_at: new Date().toISOString(),
    read_at: null,
  };

  appendMessage(tempMsg);
  scrollToBottom();

  msgInput.value = "";
  msgInput.style.height = "auto";
  charCount.textContent = "0 / 2000";

  // Stop typing
  clearTimeout(typingTimer);
  isTyping = false;
  socket.emit("typing_stop", { conversation_id: currentConversation.id });

  socket.emit("send_message", {
    conversation_id: currentConversation.id,
    content,
  }, (res) => {
    if (res?.error) {
      toast(res.error, "error");
    }
  });
}

// ── User Search ────────────────────────────────────────────────
let searchDebounce = null;

$("user-search").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchDebounce);

  if (!q) {
    $("search-results").innerHTML = "";
    $("search-results").style.display = "none";
    return;
  }

  searchDebounce = setTimeout(async () => {
    try {
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      renderSearchResults(users);
    } catch {
      // silent
    }
  }, 300);
});

function renderSearchResults(users) {
  const results = $("search-results");
  if (!users.length) {
    results.innerHTML = `<div style="padding:16px;text-align:center;font-size:13px;color:var(--text-muted)">No users found</div>`;
    results.style.display = "block";
    return;
  }

  results.style.display = "block";
  results.innerHTML = users.map((u) => `
    <div class="search-result-item" onclick="startConversation('${u.id}', '${escapeAttr(u.username)}', '${escapeAttr(u.email)}', '${u.avatar_color}')">
      <div class="avatar" style="background:${u.avatar_color};color:#fff;font-family:'Syne',sans-serif;font-weight:700;width:36px;height:36px;font-size:13px;">
        ${getInitials(u.username)}
        ${onlineUsers.has(u.id) ? '<div class="online-dot"></div>' : ""}
      </div>
      <div class="search-result-info">
        <div class="search-result-name">${u.username}</div>
        <div class="search-result-email">${u.email}</div>
      </div>
    </div>
  `).join("");
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// Close search on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".sidebar-search")) {
    $("search-results").style.display = "none";
    $("search-results").innerHTML = "";
  }
});

async function startConversation(userId, username, email, avatarColor) {
  $("user-search").value = "";
  $("search-results").style.display = "none";

  try {
    const data = await api("/api/conversations", "POST", { recipient_id: userId });

    // Check if already in list
    const existing = conversations.find((c) => c.id === data.id);
    if (!existing) {
      // Add to list
      conversations.unshift({
        id: data.id,
        other_user: { id: userId, username, email, avatar_color: avatarColor },
        last_message: null,
        last_message_at: new Date().toISOString(),
        unread_count: 0,
      });
      renderConversations();
    }

    openConversation(data.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

// ── Auto-login on page load ───────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  const token = localStorage.getItem("cw_token");
  const user = localStorage.getItem("cw_user");
  if (token && user) {
    currentUser = JSON.parse(user);
    // Always fetch fresh user data from server to ensure name/email are current
    try {
      const freshUser = await api("/api/users/me");
      currentUser = freshUser;
      localStorage.setItem("cw_user", JSON.stringify(freshUser));
    } catch {
      // Token expired — send back to login
      localStorage.removeItem("cw_token");
      localStorage.removeItem("cw_user");
      return;
    }
    await initApp();
  }
});
