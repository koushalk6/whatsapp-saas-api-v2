import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const BUSINESS_ID = process.env.WHATSAPP_BUSINESS_ID;

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !BUSINESS_ID) {
  console.warn("WARNING: Missing WhatsApp env vars. API calls will fail.");
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// -------- In-memory stores (replace with DB later) ----------
const users = new Map();
const broadcasts = [];

// -------- Auth helpers ----------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// -------- Auth routes ----------
app.post("/api/auth/signup", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  if (users.has(email)) return res.status(409).json({ error: "User exists" });
  users.set(email, { email, passwordPlain: password });
  return res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.get(email);
  if (!user || user.passwordPlain !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ sub: email }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ token });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ email: req.user.sub });
});

// -------- WhatsApp Graph helper ----------
const GRAPH_BASE = "https://graph.facebook.com/v20.0";

async function graphRequest(path, options = {}) {
  const url = `${GRAPH_BASE}${path}`;
  const headers = {
    "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Graph API error", res.status, data);
    throw new Error(data.error?.message || "Graph API error");
  }
  return data;
}

// -------- Template endpoints ----------
app.get("/api/templates", requireAuth, async (req, res) => {
  try {
    const data = await graphRequest(`/${BUSINESS_ID}/message_templates?limit=200`, {
      method: "GET"
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/templates", requireAuth, async (req, res) => {
  const payload = req.body; // raw payload passthrough
  try {
    const data = await graphRequest(`/${BUSINESS_ID}/message_templates`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- Session messages (24h window) ----------

// Simple text session
app.post("/api/messages/session/text", requireAuth, async (req, res) => {
  const { to, body, preview_url = true } = req.body;
  if (!to || !body) return res.status(400).json({ error: "Missing to/body" });
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url }
  };
  try {
    const data = await graphRequest(`/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic session message RAW (for all types including CTAs, media, interactive)
app.post("/api/messages/session/raw", requireAuth, async (req, res) => {
  const { to, ...rest } = req.body;
  if (!to || !rest.type) {
    return res.status(400).json({ error: "Must include 'to' and 'type' in payload" });
  }
  const payload = {
    messaging_product: "whatsapp",
    to,
    ...rest
  };
  try {
    const data = await graphRequest(`/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- Template messages ----------
app.post("/api/messages/template", requireAuth, async (req, res) => {
  const { to, template_name, language_code = "en", components } = req.body;
  if (!to || !template_name) {
    return res.status(400).json({ error: "Missing to/template_name" });
  }
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template_name,
      language: { code: language_code },
      ...(components ? { components } : {})
    }
  };
  try {
    const data = await graphRequest(`/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- Template broadcast ----------
app.post("/api/broadcasts/template", requireAuth, async (req, res) => {
  const { to, template_name, language_code = "en", components } = req.body;
  if (!Array.isArray(to) || to.length === 0) {
    return res.status(400).json({ error: "to must be non-empty array" });
  }
  const startedAt = new Date().toISOString();
  const record = {
    id: `bc_${Date.now()}`,
    template_name,
    count: to.length,
    startedAt,
    results: []
  };
  broadcasts.push(record);

  for (const num of to) {
    const payload = {
      messaging_product: "whatsapp",
      to: num,
      type: "template",
      template: {
        name: template_name,
        language: { code: language_code },
        ...(components ? { components } : {})
      }
    };
    try {
      const data = await graphRequest(`/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      record.results.push({ to: num, success: true, response: data });
    } catch (e) {
      record.results.push({ to: num, success: false, error: e.message });
    }
  }

  res.json(record);
});

app.get("/api/broadcasts", requireAuth, (req, res) => {
  res.json({ items: broadcasts });
});

// -------- Health ----------
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
