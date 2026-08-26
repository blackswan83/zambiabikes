/* ==========================================================================
   ZAMBIA RUSH — the wire

   A small WebSocket client. It knows how to open a room, join one, keep the
   clock in step with the server, push where this rider is, and hand the game
   a list of everybody else. It knows nothing about Three.js and nothing about
   the game loop; game3d.js reads `mp.room` and `mp.peers` and draws them.

   The site is static-first: if there is no server behind it (GitHub Pages),
   nothing here ever connects and the game is exactly what it was. Live racing
   is an extra that appears when a server is there, never a requirement.
   ========================================================================== */

(function () {
  "use strict";

  var MPC = window.ZR_MP;

  /* ---------- clock ----------
     A countdown has to end at the same instant on both screens, so we work
     out the offset between this device's clock and the server's the same way
     everything else does: send a stamp, see how long the round trip took,
     assume half of it each way, keep the best sample. */
  function Clock() {
    this.offset = 0;
    this.bestRtt = 1e9;
    this.samples = 0;
  }
  Clock.prototype.sample = function (sentAt, serverNow, gotAt) {
    var rtt = gotAt - sentAt;
    if (rtt < 0 || rtt > 4000) return;
    if (rtt <= this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = serverNow + rtt / 2 - gotAt;
      this.samples++;
    }
  };
  Clock.prototype.serverNow = function () { return Date.now() + this.offset; };
  /* how long until a server timestamp arrives, in this device's terms */
  Clock.prototype.until = function (serverAt) { return serverAt - this.serverNow(); };

  function Net() {
    this.ws = null;
    this.state = "off";      /* off | connecting | open | closed */
    this.you = null;
    this.room = null;
    this.peers = {};         /* id -> the latest sample we have of them */
    this.clock = new Clock();
    this.lastErr = "";
    this.onEvent = null;     /* the game hands us one callback */
    this.posHz = MPC ? MPC.POS_HZ : 15;
    this._lastSent = 0;
    this._pingTimer = null;
    this._retry = 0;
    this._wantOpen = false;
  }

  Net.prototype.url = function () {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/mp";
  };

  Net.prototype.fire = function (type, data) {
    if (this.onEvent) {
      try { this.onEvent(type, data || {}); } catch (e) { /* the UI is not our problem */ }
    }
  };

  Net.prototype.connect = function () {
    if (this.state === "connecting" || this.state === "open") return;
    if (!window.WebSocket) { this.lastErr = "this browser cannot do live racing"; this.fire("state"); return; }
    this._wantOpen = true;
    this.state = "connecting";
    this.fire("state");
    var self = this;
    var ws;
    try { ws = new WebSocket(this.url()); }
    catch (e) { this.state = "closed"; this.lastErr = "could not reach the club server"; this.fire("state"); return; }
    this.ws = ws;

    ws.onopen = function () {
      self.state = "open";
      self._retry = 0;
      self.fire("state");
      self.ping();
      self._pingTimer = setInterval(function () { self.ping(); }, 5000);
    };
    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      self.handle(m);
    };
    ws.onerror = function () { self.lastErr = "lost the club server"; };
    ws.onclose = function () {
      clearInterval(self._pingTimer);
      self._pingTimer = null;
      self.state = "closed";
      self.ws = null;
      self.room = null;
      self.peers = {};
      self.fire("state");
      /* come back on our own if the game still wants a connection */
      if (self._wantOpen && self._retry < 5) {
        self._retry++;
        setTimeout(function () { self.connect(); }, 700 * self._retry);
      }
    };
  };

  Net.prototype.disconnect = function () {
    this._wantOpen = false;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already gone */ } }
  };

  Net.prototype.send = function (type, data) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(Object.assign({ t: type }, data || {})));
      return true;
    } catch (e) { return false; }
  };

  Net.prototype.ping = function () { this.send("ping", { c: Date.now() }); };

  Net.prototype.handle = function (m) {
    var type = m && m.t;
    if (type === "hello") {
      this.you = m.you;
      this.posHz = m.posHz || this.posHz;
      this.clock.sample(Date.now(), m.now, Date.now());
      this.fire("state");
      return;
    }
    if (type === "pong") {
      this.clock.sample(Number(m.c) || 0, Number(m.now) || 0, Date.now());
      return;
    }
    if (type === "joined") {
      this.you = m.you;
      this.room = m.room;
      this.peers = {};
      this.fire("room", { joined: true });
      return;
    }
    if (type === "room") {
      var wasState = this.room && this.room.state;
      this.room = m.room;
      /* anybody who left stops being drawn */
      var live = {};
      (this.room.players || []).forEach(function (p) { live[p.id] = 1; });
      Object.keys(this.peers).forEach(function (id) { if (!live[id]) delete this.peers[id]; }, this);
      if (wasState !== this.room.state) this.fire("phase", { from: wasState, to: this.room.state });
      this.fire("room", {});
      return;
    }
    if (type === "pos") {
      var p = m.p;
      if (!p || !p.id || p.id === this.you) return;
      var prev = this.peers[p.id];
      /* keep the one before, so the game can draw the line between them
         instead of teleporting a rider fifteen times a second */
      this.peers[p.id] = {
        id: p.id,
        from: prev ? { x: prev.x, y: prev.y, z: prev.z, yaw: prev.yaw } : { x: p.x, y: p.y, z: p.z, yaw: p.yaw },
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, t: p.t, sp: p.sp,
        air: p.air, dwn: p.dwn,
        at: performance.now(),
        prevAt: prev ? prev.at : performance.now()
      };
      return;
    }
    if (type === "err") {
      this.lastErr = String(m.why || "something went wrong");
      this.fire("error", { why: this.lastErr });
      return;
    }
  };

  /* ---------- what the game asks for ---------- */

  Net.prototype.create = function (name, jersey, setup) {
    this.send("create", { name: name, jersey: jersey, track: setup.track, tod: setup.tod, wx: setup.wx });
  };
  Net.prototype.join = function (code, name, jersey) {
    this.send("join", { code: code, name: name, jersey: jersey });
  };
  Net.prototype.leave = function () { this.send("leave", {}); this.room = null; this.peers = {}; this.fire("room", {}); };
  Net.prototype.ready = function (v) { this.send("ready", { ready: !!v }); };
  Net.prototype.setup = function (o) { this.send("setup", o); };
  Net.prototype.start = function () { this.send("start", {}); };
  Net.prototype.again = function () { this.send("again", {}); };
  Net.prototype.finish = function (r) { this.send("finish", { r: r }); };

  /* Called every frame while racing; it does its own rate limiting so the
     game loop does not have to care. */
  Net.prototype.pushPos = function (st) {
    var nowMs = performance.now();
    if (nowMs - this._lastSent < 1000 / this.posHz) return;
    this._lastSent = nowMs;
    this.send("pos", {
      p: {
        x: st.x, y: st.y, z: st.z, yaw: st.yaw,
        t: st.t, sp: Math.sqrt(st.vx * st.vx + st.vz * st.vz),
        air: st.onGround ? 0 : 1,
        dwn: st.crashT > 0 ? 1 : 0
      }
    });
  };

  /* Where a rider is right now, as far as we know: walk on from the last
     sample at the speed they were doing, so a friend on a slow connection
     glides instead of stuttering. */
  Net.prototype.peerAt = function (id, nowMs) {
    var p = this.peers[id];
    if (!p) return null;
    var age = (nowMs - p.at) / 1000;
    /* one second with no word and we stop guessing */
    if (age > 1.0) return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, sp: 0, air: p.air, dwn: p.dwn, stale: true };
    var step = Math.min(0.35, age);
    return {
      x: p.x + Math.sin(p.yaw) * p.sp * step,
      y: p.y,
      z: p.z + Math.cos(p.yaw) * p.sp * step,
      yaw: p.yaw,
      sp: p.sp, air: p.air, dwn: p.dwn, stale: false
    };
  };

  Net.prototype.others = function () {
    if (!this.room) return [];
    var you = this.you;
    return this.room.players.filter(function (p) { return p.id !== you; });
  };
  Net.prototype.me = function () {
    if (!this.room) return null;
    var you = this.you;
    return this.room.players.filter(function (p) { return p.id === you; })[0] || null;
  };
  Net.prototype.isHost = function () { return !!(this.room && this.room.hostId === this.you); };
  Net.prototype.racing = function () {
    return !!(this.room && (this.room.state === "racing" || this.room.state === "countdown"));
  };

  window.ZR_NET = new Net();

  /* Is there even a server behind this page? One request, and if it fails we
     never mention live racing again. */
  window.ZR_NET.probe = function (done) {
    if (!window.fetch) return done(false);
    fetch("/api/mp/status")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { done(!!(j && j.live)); })
      .catch(function () { done(false); });
  };
})();
