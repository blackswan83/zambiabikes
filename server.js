/* Zambia Bikes — tiny Express server.
   Serves the static site and two small APIs:
     - /api/join    membership requests (reviewed by the Grown-Up Crew)
     - /api/ghosts  Zambia Rush 3D ghost leaderboard (validated by the real game engine)
   Storage is Postgres when DATABASE_URL is set (Railway), otherwise in-memory
   arrays so local dev and tests work with zero setup.
   Kid-safety notes: we store the minimum, never echo stored data back on the
   public join route, and never log request bodies (they contain parent emails). */

"use strict";

const express = require("express");
const CORE = require("./js/game3d-core.js");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/* ================= storage =================
   One tiny `db` object with the same five methods either way, so the routes
   never care whether Postgres is behind them. */

function isLocalDbUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch (e) {
    return false; /* unparsable → assume remote, use SSL */
  }
}

function makePgDb(url) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: url,
    ssl: isLocalDbUrl(url) ? false : { rejectUnauthorized: false }
  });

  return {
    kind: "postgres",

    async init() {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS join_requests(" +
          "id serial primary key, kid_name text, age int, parent_email text, " +
          "message text, created_at timestamptz default now())"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS ghosts(" +
          "id serial primary key, track text, name text, time_ms int, code text, " +
          "created_at timestamptz default now(), unique(track, name))"
      );
    },

    async addJoin(r) {
      await pool.query(
        "INSERT INTO join_requests(kid_name, age, parent_email, message) VALUES ($1, $2, $3, $4)",
        [r.kidName, r.age, r.parentEmail, r.message]
      );
    },

    async listJoins() {
      const res = await pool.query(
        "SELECT id, kid_name, age, parent_email, message, created_at " +
          "FROM join_requests ORDER BY created_at DESC, id DESC"
      );
      return res.rows;
    },

    /* Keep the faster (smaller) time only. Returns "new" or "existing". */
    async upsertGhost(g) {
      const res = await pool.query(
        "INSERT INTO ghosts(track, name, time_ms, code) VALUES ($1, $2, $3, $4) " +
          "ON CONFLICT (track, name) DO UPDATE " +
          "SET time_ms = EXCLUDED.time_ms, code = EXCLUDED.code, created_at = now() " +
          "WHERE ghosts.time_ms > EXCLUDED.time_ms " +
          "RETURNING id",
        [g.track, g.name, g.timeMs, g.code]
      );
      return res.rowCount > 0 ? "new" : "existing";
    },

    async topGhosts(track, limit) {
      const res = await pool.query(
        "SELECT name, time_ms, code FROM ghosts WHERE track = $1 " +
          "ORDER BY time_ms ASC, created_at ASC LIMIT $2",
        [track, limit]
      );
      return res.rows.map(function (r) {
        return { name: r.name, timeMs: r.time_ms, code: r.code };
      });
    },

    async deleteGhost(track, name) {
      const res = await pool.query(
        "DELETE FROM ghosts WHERE track = $1 AND name = $2",
        [track, name]
      );
      return res.rowCount;
    }
  };
}

function makeMemoryDb() {
  const joins = [];
  const ghosts = [];
  let joinSeq = 0;

  return {
    kind: "memory",

    async init() {},

    async addJoin(r) {
      joins.push({
        id: ++joinSeq,
        kid_name: r.kidName,
        age: r.age,
        parent_email: r.parentEmail,
        message: r.message,
        created_at: new Date().toISOString()
      });
    },

    async listJoins() {
      return joins.slice().reverse();
    },

    async upsertGhost(g) {
      for (let i = 0; i < ghosts.length; i++) {
        if (ghosts[i].track === g.track && ghosts[i].name === g.name) {
          if (ghosts[i].timeMs <= g.timeMs) return "existing";
          ghosts[i].timeMs = g.timeMs;
          ghosts[i].code = g.code;
          ghosts[i].created_at = new Date().toISOString();
          return "new";
        }
      }
      ghosts.push({
        track: g.track,
        name: g.name,
        timeMs: g.timeMs,
        code: g.code,
        created_at: new Date().toISOString()
      });
      return "new";
    },

    async topGhosts(track, limit) {
      return ghosts
        .filter(function (g) { return g.track === track; })
        .sort(function (a, b) { return a.timeMs - b.timeMs; })
        .slice(0, limit)
        .map(function (g) { return { name: g.name, timeMs: g.timeMs, code: g.code }; });
    },

    async deleteGhost(track, name) {
      let removed = 0;
      for (let i = ghosts.length - 1; i >= 0; i--) {
        if (ghosts[i].track === track && ghosts[i].name === name) {
          ghosts.splice(i, 1);
          removed++;
        }
      }
      return removed;
    }
  };
}

const db = DATABASE_URL ? makePgDb(DATABASE_URL) : makeMemoryDb();
if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not set — using in-memory storage; everything is lost on restart.");
}

/* ================= helpers ================= */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(res, msg) {
  return res.status(400).json({ ok: false, error: msg });
}

/* Bearer-token admin gate. 503 when no ADMIN_TOKEN configured, 401 on mismatch. */
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: "admin is not configured" });
  const auth = String(req.headers.authorization || "");
  if (auth !== "Bearer " + ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

/* Simple sliding-window in-memory rate limit (per IP, per route). Resets on restart — fine. */
function makeRateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(function () {
    const now = Date.now();
    hits.forEach(function (list, key) {
      if (!list.length || now - list[list.length - 1] > windowMs) hits.delete(key);
    });
  }, windowMs).unref();
  return function (req, res, next) {
    const key = req.ip + "|" + req.path;
    const now = Date.now();
    const list = (hits.get(key) || []).filter(function (t) { return now - t < windowMs; });
    if (list.length >= max) {
      hits.set(key, list);
      return res.status(429).json({ ok: false, error: "too many requests — take a breather and try again in a minute" });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

const postLimiter = makeRateLimiter(10, 60 * 1000);

/* ================= app ================= */

const app = express();
app.set("trust proxy", 1); /* Railway runs behind a proxy; makes req.ip the client IP */
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

/* ---------- health ---------- */

app.get("/api/health", function (req, res) {
  res.json({ ok: true, db: db.kind });
});

/* ---------- join requests ---------- */

app.post("/api/join", postLimiter, async function (req, res, next) {
  try {
    const body = req.body || {};

    /* Honeypot: real kids never see the "website" field. Bots fill it in.
       Pretend success, store nothing. */
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return res.json({ ok: true });
    }

    const kidName = String(body.kidName == null ? "" : body.kidName)
      .replace(/[^A-Za-z '\-]/g, "").replace(/\s+/g, " ").trim();
    if (kidName.length < 1 || kidName.length > 40) return bad(res, "please give a rider first name (letters only, up to 40 characters)");

    let age = null;
    if (body.age !== null && body.age !== undefined && body.age !== "") {
      age = Number(body.age);
      if (!Number.isInteger(age) || age < 5 || age > 17) return bad(res, "age must be a whole number from 5 to 17");
    }

    const parentEmail = String(body.parentEmail == null ? "" : body.parentEmail).trim();
    if (parentEmail.length > 160 || !EMAIL_RE.test(parentEmail)) return bad(res, "please give a valid parent or guardian email");

    let message = "";
    if (body.message !== null && body.message !== undefined) {
      if (typeof body.message !== "string") return bad(res, "message must be text");
      message = body.message.trim();
      if (message.length > 1000) return bad(res, "message is too long (max 1000 characters)");
    }

    await db.addJoin({ kidName: kidName, age: age, parentEmail: parentEmail, message: message });
    /* Store the minimum, echo nothing back — this is a kids' club. */
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

app.get("/api/admin/requests", requireAdmin, async function (req, res, next) {
  try {
    const rows = await db.listJoins();
    res.json({ ok: true, requests: rows });
  } catch (err) { next(err); }
});

/* ---------- ghost leaderboard ---------- */

app.post("/api/ghosts", postLimiter, async function (req, res, next) {
  try {
    const body = req.body || {};

    const track = body.track;
    if (typeof track !== "string" || CORE.TRACK3_ORDER.indexOf(track) === -1) {
      return bad(res, "unknown track");
    }

    if (typeof body.name !== "string") return bad(res, "name must be text");
    const sanitized = CORE.sanitizeName(body.name);
    if (!sanitized) return bad(res, "name is empty after cleaning");
    const name = sanitized.split(/\s+/)[0].slice(0, 12); /* first name only */
    if (!name) return bad(res, "name is empty after cleaning");

    const timeMs = body.timeMs;
    if (!Number.isInteger(timeMs) || timeMs < 20000 || timeMs > 600000) {
      return bad(res, "timeMs must be a whole number of milliseconds between 20000 and 600000");
    }

    const code = body.code;
    if (typeof code !== "string" || code.length > 40000 || code.indexOf("ZR3G1") !== 0) {
      return bad(res, "that does not look like a Ghost Code");
    }
    const ghost = CORE.unpackGhost3(code);
    if (!ghost || ghost.timeMs !== timeMs || ghost.track !== track) {
      return bad(res, "the Ghost Code does not match this run");
    }
    /* the game records ghost samples at GHOST_HZ — a run whose sample count
       disagrees with its claimed time by more than a few seconds is faked */
    const expectedMs = (ghost.samples ? ghost.samples.length : 0) * (1000 / CORE.GHOST_HZ);
    if (Math.abs(expectedMs - timeMs) > 4000) {
      return bad(res, "the Ghost Code does not match this run");
    }

    const kept = await db.upsertGhost({ track: track, name: name, timeMs: timeMs, code: code });
    res.status(kept === "new" ? 201 : 200).json({ ok: true, kept: kept });
  } catch (err) { next(err); }
});

app.get("/api/ghosts", async function (req, res, next) {
  try {
    const track = String(req.query.track || "");
    if (CORE.TRACK3_ORDER.indexOf(track) === -1) return bad(res, "unknown track");
    const ghosts = await db.topGhosts(track, 10);
    res.json({ ghosts: ghosts });
  } catch (err) { next(err); }
});

app.delete("/api/ghosts/:track/:name", requireAdmin, async function (req, res, next) {
  try {
    const deleted = await db.deleteGhost(String(req.params.track), String(req.params.name));
    res.json({ ok: true, deleted: deleted });
  } catch (err) { next(err); }
});

/* how a client discovers whether live racing is even switched on */
app.get("/api/mp/status", function (req, res) {
  res.json({ ok: true, live: true, rooms: rooms.size, maxPlayers: MP.MAX_PLAYERS });
});

/* ---------- static site ---------- */

app.use(express.static(__dirname, { extensions: ["html"] }));

/* ---------- 404 + errors ---------- */

app.use("/api", function (req, res) {
  res.status(404).json({ ok: false, error: "not found" });
});

/* Never log err with request context — bodies contain parent emails. */
app.use(function (err, req, res, next) { /* eslint-disable-line no-unused-vars */
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    return res.status(400).json({ ok: false, error: "bad request body" });
  }
  console.error("Server error on", req.method, req.path, "-", err && err.message);
  res.status(500).json({ ok: false, error: "server error" });
});

/* ================= live multiplayer =================

   Rooms live in memory and nowhere else: nothing here is written to the
   database, on purpose. A room exists while somebody is in it and is gone
   when they leave, which is exactly the right lifetime for four kids racing
   after school, and it means a race leaves no trace of who played with whom.

   The rules all live in js/mp-core.js, which has no sockets in it. This file
   only moves messages: parse, hand to the core, tell the room what changed.

   There is no message type in this protocol that carries free text. The most
   a player can say to a room is their own first name, once. */

const MP = require("./js/mp-core.js");

const rooms = new Map();          /* code -> room */
const sockets = new Map();        /* id -> { ws, code, rate, miss, ip } */
const perIp = new Map();          /* ip -> how many sockets it is holding open */
let nextClientId = 1;

/* A code is four characters out of an alphabet of 23, so 279,841 of them, and
   the whole safety story is that you cannot be put in a race you were not read
   into. That only holds if nobody can sit there dialling: the ordinary message
   budget would allow thousands of guesses a minute. Wrong codes get their own,
   much smaller budget, and one machine cannot hold open a fleet of sockets to
   widen it. */
const MISSES_PER_SOCKET = 8;
const SOCKETS_PER_IP = 8;
const ALIVE_SWEEP_MS = 30000;

function closeSocket(id, why) {
  const s = sockets.get(id);
  if (!s) return;
  send(s.ws, "err", { why: why });
  try { s.ws.close(4029, "slow down"); } catch (e) { /* already gone */ }
}

function roomOf(id) {
  const s = sockets.get(id);
  return s && s.code ? rooms.get(s.code) : null;
}

function send(ws, type, data) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(Object.assign({ t: type }, data)));
  } catch (e) { /* a socket that died mid-write is not our problem */ }
}

function sendTo(id, type, data) {
  const s = sockets.get(id);
  if (s) send(s.ws, type, data);
}

function broadcast(room, type, data, exceptId) {
  room.players.forEach(function (p) {
    if (p.id !== exceptId) sendTo(p.id, type, data);
  });
}

function pushRoom(room) {
  broadcast(room, "room", { room: MP.roomView(room) });
}

function leaveRoom(id, now) {
  const s = sockets.get(id);
  if (!s || !s.code) return;
  const room = rooms.get(s.code);
  s.code = null;
  if (!room) return;
  MP.removePlayer(room, id, now);
  if (!room.players.length) rooms.delete(room.code);
  else pushRoom(room);
}

/* one message handler, one switch, nothing clever */
function handle(id, msg, now) {
  const s = sockets.get(id);
  if (!s) return;
  const type = String(msg && msg.t || "");

  /* Anybody still connected is a room still in use. Without this the idle sweep
     could clear a room out from under two children who left the lobby open
     while they went to find a snack, and every button afterwards would quietly
     do nothing. */
  if (s.code) {
    const here = rooms.get(s.code);
    if (here) here.touchedAt = now;
    else s.code = null;
  }

  if (type === "ping") {
    /* the client uses this to work out the offset between its clock and
       ours, so a countdown ends at the same instant on every screen */
    sendTo(id, "pong", { c: Number(msg.c) || 0, now: now });
    return;
  }

  if (type === "create") {
    leaveRoom(id, now);
    if (rooms.size >= MP.MAX_ROOMS) return sendTo(id, "err", { why: "the clubhouse is full — try again in a minute" });
    const code = MP.makeCode(function (c) { return rooms.has(c); });
    if (!code) return sendTo(id, "err", { why: "the clubhouse is full — try again in a minute" });
    const room = MP.newRoom(code, { track: msg.track, tod: msg.tod, wx: msg.wx, now: now });
    const add = MP.addPlayer(room, id, msg.name, msg.jersey, now);
    if (add.error) return sendTo(id, "err", { why: add.error });
    rooms.set(code, room);
    s.code = code;
    sendTo(id, "joined", { you: id, room: MP.roomView(room) });
    return;
  }

  if (type === "join") {
    const code = MP.cleanCode(msg.code);
    if (!code) return sendTo(id, "err", { why: "that is not a race code" });
    const room = rooms.get(code);
    if (!room) {
      /* A mistyped code must not cost them the room they are already in, so
         this answers before anybody leaves anything. Dialling for rooms is
         budgeted separately from ordinary chatter. */
      s.miss = (s.miss || 0) + 1;
      if (s.miss > MISSES_PER_SOCKET) return closeSocket(id, "too many wrong codes");
      return sendTo(id, "err", { why: "no race with that code — check it and try again" });
    }
    /* Their own code, typed into the join box — a thing a ten-year-old does.
       Without this, leaving to join the room they are the only member of
       deletes it out from under them and the code stops working. */
    if (s.code === code) return sendTo(id, "joined", { you: id, room: MP.roomView(room) });
    leaveRoom(id, now);
    const add = MP.addPlayer(room, id, msg.name, msg.jersey, now);
    if (add.error) return sendTo(id, "err", { why: add.error });
    s.code = code;
    sendTo(id, "joined", { you: id, room: MP.roomView(room) });
    pushRoom(room);
    return;
  }

  const room = roomOf(id);
  if (!room) return;

  if (type === "leave") { leaveRoom(id, now); return; }

  if (type === "ready") {
    MP.setReady(room, id, msg.ready, now);
    pushRoom(room);
    return;
  }

  if (type === "setup") {
    const r = MP.setTrack(room, id, msg, now);
    if (r.error) return sendTo(id, "err", { why: r.error });
    pushRoom(room);
    return;
  }

  if (type === "start") {
    const r = MP.startRoom(room, id, now);
    if (r.error) return sendTo(id, "err", { why: r.error });
    pushRoom(room);
    return;
  }

  if (type === "pos") {
    if (room.state !== "racing" && room.state !== "countdown") return;
    const p = MP.cleanPos(msg.p);
    if (!p) return;
    p.id = id;
    broadcast(room, "pos", { p: p }, id);
    return;
  }

  if (type === "finish") {
    const what = MP.recordFinish(room, id, msg.r, now);
    if (what) pushRoom(room);
    return;
  }

  if (type === "again") {
    const r = MP.backToLobby(room, id, now);
    if (r.error) return sendTo(id, "err", { why: r.error });
    pushRoom(room);
    return;
  }
}

function attachMultiplayer(server) {
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ server: server, path: "/mp", maxPayload: 4096 });

  wss.on("connection", function (ws, req) {
    /* Same reasoning as `app.set("trust proxy", 1)` above: on Railway every
       socket arrives from the proxy, so the socket address is the same for the
       whole world and a per-address cap would lock everyone out at eight. On a
       laptop on the home wifi there is no forwarded header and this is the
       device's own address, which is what we want. */
    const fwd = req && req.headers && req.headers["x-forwarded-for"];
    const ip = (fwd ? String(fwd).split(",")[0].trim() : "") ||
      (req && req.socket && req.socket.remoteAddress) || "?";
    const held = perIp.get(ip) || 0;
    if (held >= SOCKETS_PER_IP) {
      send(ws, "err", { why: "too many races open from here" });
      try { ws.close(4029, "too many"); } catch (e) { /* already gone */ }
      return;
    }
    perIp.set(ip, held + 1);

    const id = "p" + (nextClientId++);
    sockets.set(id, { ws: ws, code: null, rate: { n: 0, at: 0 }, miss: 0, ip: ip });
    /* Wifi does not always say goodbye. A laptop lid, a walk out of range, a
       hop to a hotspot: the TCP connection can sit there half-open and the room
       keeps a rider who is not coming back — one who can never be ready, so the
       flag can never drop. Something has to actually ask. */
    ws.isAlive = true;
    ws.on("pong", function () { ws.isAlive = true; });
    send(ws, "hello", { you: id, now: Date.now(), posHz: MP.POS_HZ, jerseys: MP.JERSEYS });

    ws.on("message", function (raw) {
      const now = Date.now();
      const s = sockets.get(id);
      if (!s) return;
      ws.isAlive = true;
      /* a fixed budget of messages a second: a rider sends about fifteen */
      const sec = Math.floor(now / 1000);
      if (s.rate.at !== sec) { s.rate.at = sec; s.rate.n = 0; }
      if (++s.rate.n > MP.MSG_PER_SEC) return;
      if (raw && raw.length > 4096) return;
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      if (!msg || typeof msg !== "object") return;
      try { handle(id, msg, now); } catch (e) {
        console.error("mp error:", e && e.message);
      }
    });

    ws.on("close", function () {
      leaveRoom(id, Date.now());
      sockets.delete(id);
      const n = (perIp.get(ip) || 1) - 1;
      if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
    });
    ws.on("error", function () { /* close follows */ });
  });

  const alive = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { /* gone */ } return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* gone */ }
    });
  }, ALIVE_SWEEP_MS);
  alive.unref && alive.unref();

  /* the only clock in the system: it drops the flag and sweeps up */
  const timer = setInterval(function () {
    const now = Date.now();
    rooms.forEach(function (room, code) {
      const moved = MP.tick(room, now);
      if (moved) pushRoom(room);
      if (MP.isIdle(room, now) || !room.players.length) rooms.delete(code);
    });
  }, 250);
  timer.unref && timer.unref();

  return wss;
}

/* ---------- boot ---------- */

db.init()
  .then(function () {
    const server = app.listen(PORT, function () {
      console.log("Zambia Bikes server riding on port " + PORT + " (db: " + db.kind + ")");
      console.log("Live racing on ws://<host>:" + PORT + "/mp (rooms in memory only)");
    });
    attachMultiplayer(server);
  })
  .catch(function (err) {
    console.error("Failed to initialize database:", err && err.message);
    process.exit(1);
  });

module.exports = { app: app, attachMultiplayer: attachMultiplayer, rooms: rooms };
