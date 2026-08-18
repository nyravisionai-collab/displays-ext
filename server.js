const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ------------------------- Playlist (demo videos) -------------------------
// These are public H.264 MP4 samples that play fine on Android 6.
const SAMPLE_VIDEOS = [
  { title: 'Big Buck Bunny',      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  { title: 'Elephants Dream',     url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
  { title: 'Sintel',              url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
  { title: 'Tears of Steel',      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
  { title: 'For Bigger Blazes',   url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4' },
  { title: 'For Bigger Escapes',  url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4' }
];

// ------------------------- Room management -------------------------
const rooms = new Map(); // code -> { player: ws|null, controller: ws|null, state }

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit code
}

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      player: null,
      controller: null,
      state: {
        playlist: SAMPLE_VIDEOS.slice(),
        index: 0,
        playing: false,
        time: 0,
        duration: 0,
        custom: null
      }
    });
  }
  return rooms.get(code);
}

function getState(room) {
  const s = room.state;
  const current = s.playlist[s.index] || { title: '', url: '' };
  return {
    playlist: s.playlist,
    index: s.index,
    title: current.title,
    url: current.url,
    playing: s.playing,
    time: s.time,
    duration: s.duration
  };
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  if (room.player && room.player.readyState === 1) room.player.send(str);
  if (room.controller && room.controller.readyState === 1) room.controller.send(str);
}

function broadcastState(room) {
  broadcast(room, { type: 'state', state: getState(room) });
}

function peers(room) {
  return {
    player: !!(room.player && room.player.readyState === 1),
    controller: !!(room.controller && room.controller.readyState === 1)
  };
}

function broadcastPeers(room) {
  const p = peers(room);
  if (room.player && room.player.readyState === 1) room.player.send(JSON.stringify({ type: 'peers', peers: p }));
  if (room.controller && room.controller.readyState === 1) room.controller.send(JSON.stringify({ type: 'peers', peers: p }));
}

// ------------------------- WebSocket -------------------------
wss.on('connection', function (ws) {
  let room = null;
  let role = null;
  let code = null;

  ws.on('message', function (data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    // JOIN
    if (msg.type === 'join') {
      code = String(msg.room || '').trim();
      role = msg.role;
      if (!code || (role !== 'player' && role !== 'controller')) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid room or role' }));
        return;
      }
      room = ensureRoom(code);

      if (role === 'player') {
        if (room.player && room.player !== ws && room.player.readyState === 1) {
          room.player.close(4000, 'replaced');
        }
        room.player = ws;
      } else {
        if (room.controller && room.controller !== ws && room.controller.readyState === 1) {
          room.controller.close(4000, 'replaced');
        }
        room.controller = ws;
      }

      ws.send(JSON.stringify({ type: 'hello', role: role, room: code, state: getState(room) }));
      broadcastPeers(room);
      return;
    }

    if (!room) return;

    // COMMANDS FROM CONTROLLER
    if (role === 'controller' && msg.type === 'cmd') {
      const s = room.state;
      switch (msg.cmd) {
        case 'toggle':
          s.playing = !s.playing;
          break;
        case 'play':
          s.playing = true;
          break;
        case 'pause':
          s.playing = false;
          break;
        case 'next': {
          if (s.playlist.length) s.index = (s.index + 1) % s.playlist.length;
          s.playing = true;
          s.time = 0;
          break;
        }
        case 'prev': {
          if (s.playlist.length) s.index = (s.index - 1 + s.playlist.length) % s.playlist.length;
          s.playing = true;
          s.time = 0;
          break;
        }
        case 'seek':
          s.time = Number(msg.value) || 0;
          break;
        case 'volume':
        case 'mute':
          break; // relayed straight to player
        case 'playindex': {
          var i = Number(msg.value) || 0;
          if (s.playlist.length && i >= 0 && i < s.playlist.length) {
            s.index = i;
            s.playing = true;
            s.time = 0;
          }
          break;
        }
        default:
          return;
      }
      // forward command to player
      if (room.player && room.player.readyState === 1) {
        room.player.send(JSON.stringify({ type: 'cmd', cmd: msg.cmd, value: msg.value, state: getState(room) }));
      }
      broadcastState(room);
      return;
    }

    // LOAD A CUSTOM VIDEO FROM CONTROLLER
    if (role === 'controller' && msg.type === 'load') {
      const url = String(msg.url || '').trim();
      if (!url) return;
      const title = (String(msg.title || '').trim()) || 'Custom Video';
      room.state.playlist = [{ title: title, url: url }];
      room.state.index = 0;
      room.state.playing = true;
      room.state.time = 0;
      room.state.duration = 0;
      if (room.player && room.player.readyState === 1) {
        room.player.send(JSON.stringify({ type: 'load', title: title, url: url, playing: true, time: 0 }));
      }
      broadcastState(room);
      return;
    }

    // STATUS FROM PLAYER (time sync)
    if (role === 'player' && msg.type === 'status') {
      const s = room.state;
      if (typeof msg.playing === 'boolean') s.playing = msg.playing;
      if (typeof msg.time === 'number') s.time = msg.time;
      if (typeof msg.duration === 'number') s.duration = msg.duration;
      if (typeof msg.index === 'number') s.index = msg.index;
      // relay to controller only
      if (room.controller && room.controller.readyState === 1) {
        room.controller.send(JSON.stringify({ type: 'status', state: getState(room) }));
      }
      return;
    }

    // PLAYER -> SERVER -> CONTROLLER (progress / ended)
    if (role === 'player' && msg.type === 'progress') {
      if (room.controller && room.controller.readyState === 1) {
        room.controller.send(JSON.stringify({ type: 'progress', time: msg.time, duration: msg.duration, index: msg.index, title: msg.title, playing: msg.playing }));
      }
      return;
    }

    // PLAYER FINISHED A VIDEO -> auto-advance to next
    if (role === 'player' && msg.type === 'ended') {
      const s = room.state;
      if (s.playlist.length) s.index = (s.index + 1) % s.playlist.length;
      s.playing = true;
      s.time = 0;
      s.duration = 0;
      if (room.player && room.player.readyState === 1) {
        room.player.send(JSON.stringify({ type: 'load', title: s.playlist[s.index].title, url: s.playlist[s.index].url, playing: true, time: 0 }));
      }
      broadcastState(room);
      return;
    }
  });

  ws.on('close', function () {
    if (room && role === 'player' && room.player === ws) {
      room.player = null;
      room.state.playing = false;
    }
    if (room && role === 'controller' && room.controller === ws) {
      room.controller = null;
    }
    if (room) broadcastPeers(room);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('Remote Video Control server listening on http://0.0.0.0:' + PORT);
});
