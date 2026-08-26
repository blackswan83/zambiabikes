/* ==========================================================================
   ZAMBIA RUSH — live multiplayer, the rules of a room

   Pure logic: no sockets, no timers, no I/O. The WebSocket server in
   server.js is thin glue over this, which means every rule about who may
   join what, what a name may contain and when a race may start is testable
   in node without opening a port.

   HOW A RACE WORKS. Every rider simulates themselves, exactly as they do
   in single player, and broadcasts where they are about fifteen times a
   second. The server relays those samples to the rest of the room and keeps
   the finishing order. Nobody's bike is simulated on the server and nobody's
   input crosses the wire, so a laggy connection costs you a smooth view of
   your friend — never control of your own bike. The trade is that a rider
   could lie about their position, which is exactly why a multiplayer race
   sets no personal bests, wins no medals and never reaches the club board:
   those still come only from a solo run whose ghost the server re-simulates.

   KID SAFETY. This is a room you can only reach if somebody read you a
   four-character code out loud. There is no lobby, no matchmaking, no
   directory, no way to search for a room and no way to be put in one with a
   stranger. There is no chat: this file defines every message the protocol
   accepts and none of them carry free text. The only thing a player sends
   about themselves is a first name, sanitized to a small character set and
   capped at twelve characters, and a jersey colour from a fixed list.
   ========================================================================== */

(function () {
  "use strict";

  var CORE = typeof require !== "undefined" ? require("./game3d-core.js") : window.ZR3;

  /* ---------- limits ----------
     Every one of these exists to stop a room, a name or a message being used
     as a channel for something other than racing. */
  var MAX_PLAYERS = 6;         /* a room is a few friends, not a crowd */
  var MAX_ROOMS = 400;         /* the whole thing lives in memory */
  var MAX_NAME = 12;
  var CODE_LEN = 4;
  var MSG_PER_SEC = 40;        /* ~15 position samples/s leaves plenty of room */
  var POS_HZ = 15;
  var COUNTDOWN_MS = 4000;     /* long enough for the slowest phone to load */
  var ROOM_IDLE_MS = 30 * 60 * 1000;
  var FINISH_GRACE_MS = 60 * 1000;

  /* No 0/O, 1/I/L, 5/S, 8/B, or U/V: a code has to survive being read out
     loud by one ten-year-old to another over a kitchen table. */
  var CODE_ALPHABET = "ACDEFGHJKMNPQRTWXY34679";

  var JERSEYS = ["#1F7A48", "#E8791D", "#2A9D8F", "#8E44AD", "#F7B733", "#D64533"];

  /* ---------- validation ---------- */

  function cleanName(raw) {
    var n = CORE.sanitizeName(String(raw == null ? "" : raw));
    return n.slice(0, MAX_NAME);
  }

  function cleanJersey(raw) {
    var j = String(raw == null ? "" : raw).toUpperCase();
    for (var i = 0; i < JERSEYS.length; i++) {
      if (JERSEYS[i].toUpperCase() === j) return JERSEYS[i];
    }
    return null;
  }

  /* We GENERATE codes from a confusable-free alphabet, but we ACCEPT any four
     letters or digits. A child who mishears a code and types a Z should be
     told "no race with that code — check it and try again", which tells them
     what to do, rather than "that is not a race code", which does not. */
  function cleanCode(raw) {
    var c = String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return c.length === CODE_LEN ? c : null;
  }

  function cleanTrack(raw) {
    var t = String(raw == null ? "" : raw);
    return CORE.TRACK3_ORDER.indexOf(t) >= 0 ? t : null;
  }

  var TODS = ["auto", "dawn", "day", "sunset", "dusk"];
  var WXS = ["clear", "rain", "storm"];
  function cleanTod(raw) { var v = String(raw || "auto"); return TODS.indexOf(v) >= 0 ? v : "auto"; }
  function cleanWx(raw) { var v = String(raw || "clear"); return WXS.indexOf(v) >= 0 ? v : "clear"; }

  /* ---------- codes ---------- */

  function makeCode(isTaken, rand) {
    rand = rand || Math.random;
    for (var attempt = 0; attempt < 500; attempt++) {
      var c = "";
      for (var i = 0; i < CODE_LEN; i++) {
        c += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
      }
      if (!isTaken || !isTaken(c)) return c;
    }
    return null;   /* the caller turns this into "the clubhouse is full" */
  }

  /* ---------- rooms ---------- */

  function newRoom(code, opts) {
    opts = opts || {};
    return {
      code: code,
      track: cleanTrack(opts.track) || CORE.TRACK3_ORDER[0],
      tod: cleanTod(opts.tod),
      wx: cleanWx(opts.wx),
      hostId: null,
      players: [],          /* [{id, name, jersey, ready, finished, result, joinedAt}] */
      state: "lobby",       /* lobby | countdown | racing | done */
      startAt: 0,           /* server clock, when the flag drops */
      raceEndsAt: 0,
      finishOrder: [],
      createdAt: opts.now || 0,
      touchedAt: opts.now || 0
    };
  }

  function findPlayer(room, id) {
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === id) return room.players[i];
    }
    return null;
  }

  /* A colour nobody in the room is already wearing, so two riders are never
     the same colour on screen. */
  function freeJersey(room, wanted) {
    var used = {};
    room.players.forEach(function (p) { used[p.jersey] = 1; });
    if (wanted && !used[wanted]) return wanted;
    for (var i = 0; i < JERSEYS.length; i++) {
      if (!used[JERSEYS[i]]) return JERSEYS[i];
    }
    return JERSEYS[room.players.length % JERSEYS.length];
  }

  function addPlayer(room, id, name, jersey, now) {
    if (room.players.length >= MAX_PLAYERS) return { error: "room full" };
    if (findPlayer(room, id)) return { error: "already in" };
    /* Joining mid-race would drop you onto a hill with everyone gone. The
       room simply says "they have started" and the code stays valid for the
       next race, so a late friend waits rather than being turned away. */
    if (room.state !== "lobby") return { error: "race already started" };
    var p = {
      id: id,
      name: cleanName(name) || "Rider",
      jersey: freeJersey(room, cleanJersey(jersey)),
      ready: false,
      finished: false,
      result: null,
      joinedAt: now || 0
    };
    room.players.push(p);
    if (!room.hostId) room.hostId = id;
    room.touchedAt = now || 0;
    return { player: p };
  }

  function removePlayer(room, id, now) {
    var before = room.players.length;
    room.players = room.players.filter(function (p) { return p.id !== id; });
    /* Their finish is NOT struck from the order. A rider who wins and then shuts
       the lid still won: strike them out and the crown, which is handed out by
       position in this list, drops onto the child who came second and tells them
       they won a race they watched somebody else win. */
    room.touchedAt = now || 0;
    /* the room outlives its founder: whoever has been there longest takes over */
    if (room.hostId === id) {
      room.hostId = room.players.length ? room.players[0].id : null;
    }
    /* everyone left mid-race means there is no race — and if the only rider
       still out on the hill is the one who just left, the race is over for the
       people who are still here rather than hanging on a shut laptop */
    if (room.state !== "lobby" && room.players.length === 0) room.state = "done";
    else if (room.state === "racing" &&
             room.players.every(function (q) { return q.finished; })) {
      room.state = "done";
      room.raceEndsAt = 0;
    }
    return before !== room.players.length;
  }

  function setReady(room, id, ready, now) {
    var p = findPlayer(room, id);
    if (!p) return false;
    p.ready = !!ready;
    room.touchedAt = now || 0;
    return true;
  }

  function setTrack(room, id, opts, now) {
    if (room.hostId !== id) return { error: "only the host picks the mountain" };
    if (room.state !== "lobby") return { error: "the race has started" };
    var t = cleanTrack(opts.track);
    if (t) room.track = t;
    if (opts.tod !== undefined) room.tod = cleanTod(opts.tod);
    if (opts.wx !== undefined) room.wx = cleanWx(opts.wx);
    /* a changed mountain un-readies everyone: nobody agrees to a race they
       have not seen */
    room.players.forEach(function (p) { p.ready = false; });
    room.touchedAt = now || 0;
    return { ok: true };
  }

  function startCheck(room, id) {
    if (room.hostId !== id) return "only the host starts the race";
    if (room.state !== "lobby") return "the race has already started";
    if (room.players.length < 2) return "you need somebody to race";
    for (var i = 0; i < room.players.length; i++) {
      if (!room.players[i].ready) return "everybody has to be ready";
    }
    return null;
  }

  function startRoom(room, id, now) {
    var err = startCheck(room, id);
    if (err) return { error: err };
    room.state = "countdown";
    room.startAt = now + COUNTDOWN_MS;
    room.raceEndsAt = 0;
    room.finishOrder = [];
    room.players.forEach(function (p) { p.finished = false; p.result = null; });
    room.touchedAt = now;
    return { startAt: room.startAt };
  }

  /* the server calls this on its tick; it is the only thing that moves a
     room from counting down to racing */
  function tick(room, now) {
    if (room.state === "countdown" && now >= room.startAt) {
      room.state = "racing";
      room.raceEndsAt = 0;
      return "racing";
    }
    if (room.state === "racing" && room.raceEndsAt && now >= room.raceEndsAt) {
      room.state = "done";
      return "done";
    }
    return null;
  }

  function recordFinish(room, id, result, now) {
    /* "done" counts too. The minute's grace exists so a room cannot hang on a
       child who wandered off for a snack — not to throw away the run of the one
       who was simply slower. Cross the line late and you still get your time and
       your place; only a room that has gone back to the start line stops
       listening. */
    if (room.state !== "racing" && room.state !== "done") return null;
    var p = findPlayer(room, id);
    if (!p || p.finished) return null;
    p.finished = true;
    /* THE CLOCK IS OURS. A rider's own timer is their own frame loop, and a
       frame loop stops: switch tabs, take a call, lock the iPad, and it freezes
       while everybody else keeps riding. Read the time off that and the child
       who paused posts the quicker run — which is also why place (arrival here)
       and time (measured there) could disagree on the same screen. So the race
       is timed from the moment the flag dropped to the moment the finish
       reached us, on one clock, for everybody. Coins and crashes are the
       rider's own count: they decide nothing, so there is nothing to win by
       fibbing about them. */
    p.result = {
      timeMs: Math.max(0, Math.min(3600000, Math.round(
        room.startAt ? (now || 0) - room.startAt
                     : Number(result && result.timeMs) || 0))),
      coins: Math.max(0, Math.min(9999, Math.round(Number(result && result.coins) || 0))),
      crashes: Math.max(0, Math.min(999, Math.round(Number(result && result.crashes) || 0)))
    };
    room.finishOrder.push({ id: id, name: p.name, jersey: p.jersey, place: room.finishOrder.length + 1, result: p.result });
    room.touchedAt = now || 0;
    /* once the first rider is home the rest get a minute, so a race can never
       hang on somebody who wandered off to find a snack */
    if (room.finishOrder.length === 1) room.raceEndsAt = (now || 0) + FINISH_GRACE_MS;
    if (room.players.every(function (q) { return q.finished; })) {
      room.state = "done";
      room.raceEndsAt = 0;
      return "done";
    }
    return "finished";
  }

  function backToLobby(room, id, now) {
    if (!findPlayer(room, id)) return { error: "you are not in this race" };
    /* Not while somebody is still coming down. The host finishing first and
       reaching for "race again" would otherwise yank their friend off the
       mountain mid-descent and bin the run they were in the middle of. */
    if (room.state !== "done") return { error: "wait for everybody to get down" };
    room.state = "lobby";
    room.startAt = 0;
    room.raceEndsAt = 0;
    room.finishOrder = [];
    room.players.forEach(function (p) { p.ready = false; p.finished = false; p.result = null; });
    room.touchedAt = now || 0;
    return { ok: true };
  }

  /* what a client is told about the room — no ids beyond the ephemeral
     socket ids, nothing stored, nothing about anybody's device */
  function roomView(room) {
    return {
      code: room.code,
      track: room.track,
      tod: room.tod,
      wx: room.wx,
      hostId: room.hostId,
      state: room.state,
      startAt: room.startAt,
      players: room.players.map(function (p) {
        return {
          id: p.id, name: p.name, jersey: p.jersey,
          ready: p.ready, finished: p.finished, result: p.result
        };
      }),
      finishOrder: room.finishOrder
    };
  }

  function isIdle(room, now) { return now - room.touchedAt > ROOM_IDLE_MS; }

  /* ---------- position samples ----------
     Deliberately the only high-rate message, and deliberately fixed shape:
     six numbers and two flags. There is nowhere in here to put a sentence. */
  function cleanPos(raw) {
    if (!raw || typeof raw !== "object") return null;
    function num(v, lo, hi) {
      var n = Number(v);
      if (!isFinite(n)) return null;
      return Math.max(lo, Math.min(hi, n));
    }
    var x = num(raw.x, -4000, 4000), y = num(raw.y, -4000, 4000), z = num(raw.z, -4000, 4000);
    var yaw = num(raw.yaw, -100, 100), t = num(raw.t, 0, 3600), sp = num(raw.sp, 0, 200);
    if (x === null || y === null || z === null || yaw === null) return null;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      z: Math.round(z * 10) / 10,
      yaw: Math.round(yaw * 100) / 100,
      t: t === null ? 0 : Math.round(t * 10) / 10,
      sp: sp === null ? 0 : Math.round(sp),
      air: raw.air ? 1 : 0,
      dwn: raw.dwn ? 1 : 0
    };
  }

  var API = {
    MAX_PLAYERS: MAX_PLAYERS, MAX_ROOMS: MAX_ROOMS, MAX_NAME: MAX_NAME,
    CODE_LEN: CODE_LEN, CODE_ALPHABET: CODE_ALPHABET, JERSEYS: JERSEYS,
    MSG_PER_SEC: MSG_PER_SEC, POS_HZ: POS_HZ, COUNTDOWN_MS: COUNTDOWN_MS,
    ROOM_IDLE_MS: ROOM_IDLE_MS, FINISH_GRACE_MS: FINISH_GRACE_MS,
    cleanName: cleanName, cleanJersey: cleanJersey, cleanCode: cleanCode,
    cleanTrack: cleanTrack, cleanTod: cleanTod, cleanWx: cleanWx, cleanPos: cleanPos,
    makeCode: makeCode, newRoom: newRoom, findPlayer: findPlayer, freeJersey: freeJersey,
    addPlayer: addPlayer, removePlayer: removePlayer, setReady: setReady, setTrack: setTrack,
    startCheck: startCheck, startRoom: startRoom, tick: tick, recordFinish: recordFinish,
    backToLobby: backToLobby, roomView: roomView, isIdle: isIdle
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ZR_MP = API;
})();
