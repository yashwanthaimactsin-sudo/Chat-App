/**
 * ChatWave - Real-time 2-way Chat App
 * Run: npm install && node server.js
 * Then open: http://localhost:3000
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ExcelJS = require("exceljs");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const JWT_SECRET = "chatwave_secret_key_2024";
const PORT = 3000;

// ─── Google Sheets Config ─────────────────────────────────────────────────────
// ⚠️  Fill in your Sheet ID below (from the Google Sheet URL)
const GOOGLE_SHEET_ID = "185agnpe9htY1XjrLcZJ7Ye6HmTRvE2AMHo56554_h8w";
const SHEET_NAME      = "Sheet1"; // Change if your sheet tab has a different name

// Authenticates using the service-account.json file in the project root
async function getSheetClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// Appends one row [Name, Email, Timestamp] to the Google Sheet
async function appendUserToSheet(username, email, createdAt) {
  try {
    const sheets = await getSheetClient();
    const timestamp = new Date(createdAt).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day:   "2-digit",
      month: "short",
      year:  "numeric",
      hour:  "2-digit",
      minute:"2-digit",
      second:"2-digit",
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range:         `${SHEET_NAME}!A:C`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[username, email, timestamp]],
      },
    });
    console.log(`📊 Google Sheet updated — new user: ${username} (${email})`);
  } catch (err) {
    // Log but don't crash the server if Sheets update fails
    console.error("⚠️  Google Sheets update failed:", err.message);
  }
}

// ─── Database Setup ────────────────────────────────────────────────────────────
const db = new sqlite3.Database("./chatwave.db", (err) => {
  if (err) console.error("DB error:", err);
  else console.log("✅ SQLite connected");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#6366f1',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    participant1_id TEXT NOT NULL,
    participant2_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant1_id) REFERENCES users(id),
    FOREIGN KEY (participant2_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )`);
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const AVATAR_COLORS = [
  "#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6",
  "#8b5cf6","#ef4444","#14b8a6","#f97316","#06b6d4",
];

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// SIGN UP — name + unique email, no password
app.post("/api/signup", (req, res) => {
  const { email, username } = req.body;
  if (!email || !username)
    return res.status(400).json({ error: "Name and email are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address" });
  if (username.trim().length < 2)
    return res.status(400).json({ error: "Name must be at least 2 characters" });

  const id = uuidv4();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  db.run(
    "INSERT INTO users (id, email, username, avatar_color) VALUES (?, ?, ?, ?)",
    [id, email.toLowerCase().trim(), username.trim(), color],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE"))
          return res.status(400).json({ error: "This email is already registered. Please sign in instead." });
        return res.status(500).json({ error: "Server error" });
      }
      const token = jwt.sign(
        { id, email: email.toLowerCase().trim(), username: username.trim() },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      // Auto-update Google Sheet with new user details
      const now = new Date().toISOString();
      appendUserToSheet(username.trim(), email.toLowerCase().trim(), now);

      res.json({ token, user: { id, email: email.toLowerCase().trim(), username: username.trim(), avatar_color: color } });
    }
  );
});

// LOGIN — email + name (must match what was used at signup)
app.post("/api/login", (req, res) => {
  const { email, username } = req.body;
  if (!email || !username)
    return res.status(400).json({ error: "Email and name are required" });

  db.get(
    "SELECT * FROM users WHERE email = ?",
    [email.toLowerCase().trim()],
    (err, user) => {
      if (err || !user)
        return res.status(400).json({ error: "No account found with that email. Please sign up first." });

      // Name must match (case-insensitive)
      if (user.username.toLowerCase() !== username.trim().toLowerCase())
        return res.status(400).json({ error: "Name does not match our records for this email." });

      db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username },
        JWT_SECRET,
        { expiresIn: "30d" }
      );
      res.json({
        token,
        user: { id: user.id, email: user.email, username: user.username, avatar_color: user.avatar_color },
      });
    }
  );
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get("/api/users/search", authenticate, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  db.all(
    "SELECT id, email, username, avatar_color FROM users WHERE (email LIKE ? OR username LIKE ?) AND id != ? LIMIT 10",
    [`%${q}%`, `%${q}%`, req.user.id],
    (err, rows) => res.json(rows || [])
  );
});

app.get("/api/users/me", authenticate, (req, res) => {
  db.get("SELECT id, email, username, avatar_color FROM users WHERE id = ?", [req.user.id], (err, user) => {
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(user);
  });
});

// ─── Conversation Routes ──────────────────────────────────────────────────────
app.get("/api/conversations", authenticate, (req, res) => {
  db.all(
    `SELECT c.id, c.created_at, c.last_message_at,
      u1.id as p1_id, u1.email as p1_email, u1.username as p1_username, u1.avatar_color as p1_color,
      u2.id as p2_id, u2.email as p2_email, u2.username as p2_username, u2.avatar_color as p2_color,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) as unread_count
    FROM conversations c
    JOIN users u1 ON c.participant1_id = u1.id
    JOIN users u2 ON c.participant2_id = u2.id
    WHERE c.participant1_id = ? OR c.participant2_id = ?
    ORDER BY c.last_message_at DESC`,
    [req.user.id, req.user.id, req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Server error" });
      const formatted = (rows || []).map((row) => {
        const other = row.p1_id === req.user.id
          ? { id: row.p2_id, email: row.p2_email, username: row.p2_username, avatar_color: row.p2_color }
          : { id: row.p1_id, email: row.p1_email, username: row.p1_username, avatar_color: row.p1_color };
        return {
          id: row.id,
          other_user: other,
          last_message: row.last_message,
          last_message_at: row.last_message_at,
          unread_count: row.unread_count,
        };
      });
      res.json(formatted);
    }
  );
});

app.post("/api/conversations", authenticate, (req, res) => {
  const { recipient_id } = req.body;
  if (!recipient_id) return res.status(400).json({ error: "recipient_id required" });

  // Check existing conversation
  db.get(
    `SELECT id FROM conversations WHERE 
      (participant1_id = ? AND participant2_id = ?) OR 
      (participant1_id = ? AND participant2_id = ?)`,
    [req.user.id, recipient_id, recipient_id, req.user.id],
    (err, existing) => {
      if (existing) return res.json({ id: existing.id, existing: true });

      const id = uuidv4();
      db.run(
        "INSERT INTO conversations (id, participant1_id, participant2_id) VALUES (?, ?, ?)",
        [id, req.user.id, recipient_id],
        (err) => {
          if (err) return res.status(500).json({ error: "Server error" });
          res.json({ id, existing: false });
        }
      );
    }
  );
});

// ─── Message Routes ───────────────────────────────────────────────────────────
app.get("/api/conversations/:id/messages", authenticate, (req, res) => {
  const { id } = req.params;
  const { before, limit = 50 } = req.query;

  // Verify user is participant
  db.get(
    "SELECT id FROM conversations WHERE id = ? AND (participant1_id = ? OR participant2_id = ?)",
    [id, req.user.id, req.user.id],
    (err, conv) => {
      if (!conv) return res.status(403).json({ error: "Access denied" });

      // Mark messages as read
      db.run(
        "UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL",
        [id, req.user.id]
      );

      let query = `SELECT m.*, u.username, u.email, u.avatar_color 
        FROM messages m JOIN users u ON m.sender_id = u.id 
        WHERE m.conversation_id = ?`;
      const params = [id];

      if (before) {
        query += " AND m.created_at < ?";
        params.push(before);
      }
      query += ` ORDER BY m.created_at DESC LIMIT ?`;
      params.push(parseInt(limit));

      db.all(query, params, (err, rows) => {
        res.json((rows || []).reverse());
      });
    }
  );
});


// ─── Admin Export Route ───────────────────────────────────────────────────────
// Only the app creator can access this using the secret key below.
// Visit: http://localhost:3000/api/admin/users-export?key=YOUR_ADMIN_KEY

const ADMIN_KEY = "chatwave_admin_2024"; // ← Change this to your own secret key

app.get("/api/admin/users-export", async (req, res) => {
  // Check secret key
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send("Access denied. Invalid admin key.");
  }

  try {
    db.all(
      "SELECT username, email, created_at FROM users ORDER BY created_at ASC",
      [],
      async (err, rows) => {
        if (err) return res.status(500).send("Database error");

        const wb = new ExcelJS.Workbook();
        wb.creator = "ChatWave Admin";
        wb.created = new Date();

        const ws = wb.addWorksheet("Registered Users");

        // ── Column definitions ──
        ws.columns = [
          { header: "Name",         key: "username",   width: 28 },
          { header: "Email ID",     key: "email",      width: 36 },
          { header: "Joined On",    key: "created_at", width: 24 },
        ];

        // ── Header row style ──
        const headerRow = ws.getRow(1);
        headerRow.height = 30;
        headerRow.eachCell((cell) => {
          cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D2060" } };
          cell.font   = { bold: true, color: { argb: "FFE8E0FF" }, name: "Arial", size: 12 };
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = {
            top:    { style: "thin", color: { argb: "FF7C6AF5" } },
            bottom: { style: "thin", color: { argb: "FF7C6AF5" } },
            left:   { style: "thin", color: { argb: "FF7C6AF5" } },
            right:  { style: "thin", color: { argb: "FF7C6AF5" } },
          };
        });

        // ── Data rows ──
        rows.forEach((user, idx) => {
          const row = ws.addRow({
            username:   user.username,
            email:      user.email,
            created_at: new Date(user.created_at).toLocaleString(),
          });
          row.height = 22;
          const fillColor = idx % 2 === 0 ? "FFF0EEFF" : "FFFFFFFF";
          row.eachCell((cell) => {
            cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
            cell.font      = { name: "Arial", size: 11, color: { argb: "FF1A1A24" } };
            cell.alignment = { vertical: "middle" };
            cell.border    = {
              top:    { style: "thin", color: { argb: "FFDDDDEE" } },
              bottom: { style: "thin", color: { argb: "FFDDDDEE" } },
              left:   { style: "thin", color: { argb: "FFDDDDEE" } },
              right:  { style: "thin", color: { argb: "FFDDDDEE" } },
            };
          });
        });

        // ── Summary row at the bottom ──
        ws.addRow([]);
        const totalRow = ws.addRow(["Total Users", rows.length, ""]);
        totalRow.height = 22;
        totalRow.getCell(1).font = { bold: true, name: "Arial", size: 11 };
        totalRow.getCell(2).font = { bold: true, name: "Arial", size: 11, color: { argb: "FF7C6AF5" } };

        // Freeze header
        ws.views = [{ state: "frozen", ySplit: 1 }];

        // Stream as download
        const filename = "chatwave_users_" + new Date().toISOString().slice(0, 10) + ".xlsx";
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
        await wb.xlsx.write(res);
        res.end();
      }
    );
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).send("Export failed");
  }
});


// ─── Socket.IO ────────────────────────────────────────────────────────────────
const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);

  console.log(`🟢 User connected: ${socket.user.username} (${userId})`);

  // Broadcast online status
  socket.broadcast.emit("user_online", { userId });

  // Join personal room
  socket.join(`user:${userId}`);

  // Get online users list
  socket.emit("online_users", Array.from(onlineUsers.keys()));

  // Join conversation room
  socket.on("join_conversation", (conversationId) => {
    socket.join(`conv:${conversationId}`);
  });

  socket.on("leave_conversation", (conversationId) => {
    socket.leave(`conv:${conversationId}`);
  });

  // Send message
  socket.on("send_message", (data, callback) => {
    const { conversation_id, content, type = "text" } = data;
    if (!conversation_id || !content?.trim()) {
      return callback?.({ error: "Invalid message" });
    }

    // Verify participant
    db.get(
      "SELECT * FROM conversations WHERE id = ? AND (participant1_id = ? OR participant2_id = ?)",
      [conversation_id, userId, userId],
      (err, conv) => {
        if (!conv) return callback?.({ error: "Access denied" });

        const msgId = uuidv4();
        const now = new Date().toISOString();

        db.run(
          "INSERT INTO messages (id, conversation_id, sender_id, content, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [msgId, conversation_id, userId, content.trim(), type, now],
          (err) => {
            if (err) return callback?.({ error: "Failed to save message" });

            db.run(
              "UPDATE conversations SET last_message_at = ? WHERE id = ?",
              [now, conversation_id]
            );

            const message = {
              id: msgId,
              conversation_id,
              sender_id: userId,
              username: socket.user.username,
              email: socket.user.email,
              content: content.trim(),
              type,
              created_at: now,
              read_at: null,
            };

            // Emit to conversation room
            io.to(`conv:${conversation_id}`).emit("new_message", message);

            // Notify the other user
            const otherUserId = conv.participant1_id === userId ? conv.participant2_id : conv.participant1_id;
            io.to(`user:${otherUserId}`).emit("conversation_updated", {
              conversation_id,
              last_message: content.trim(),
              last_message_at: now,
              sender_id: userId,
            });

            callback?.({ success: true, message });
          }
        );
      }
    );
  });

  // Typing indicator
  socket.on("typing_start", ({ conversation_id }) => {
    socket.to(`conv:${conversation_id}`).emit("typing_start", {
      userId,
      username: socket.user.username,
      conversation_id,
    });
  });

  socket.on("typing_stop", ({ conversation_id }) => {
    socket.to(`conv:${conversation_id}`).emit("typing_stop", { userId, conversation_id });
  });

  // Disconnect
  socket.on("disconnect", () => {
    onlineUsers.delete(userId);
    db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
    socket.broadcast.emit("user_offline", { userId });
    console.log(`🔴 User disconnected: ${socket.user.username}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 ChatWave running at http://localhost:${PORT}\n`);
});
