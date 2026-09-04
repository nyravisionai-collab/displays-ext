/*
  transfer.js — ફોનમાંથી પસંદ કરેલો વિડિયો PeerJS (WebRTC DataConnection) દ્વારા
  કંટ્રોલર → પ્લેયર મોકલવાનો કોડ. controller.html અને player.html બન્ને આ વાપરે છે.

  Protocol (everything travels over the SAME ordered + reliable PeerJS data connection
  that is already used for play/pause commands, so no extra server is needed):

    controller → player : { type:'file-start', fileId, name, size, mime, chunk }
    controller → player : <ArrayBuffer>  × N          raw binary chunks, in order
    controller → player : { type:'file-end', fileId }
    controller → player : { type:'file-cancel', fileId }          (optional)

    player → controller : { type:'file-progress', fileId, received }   (every ~300 ms)
    player → controller : { type:'file-done', fileId, size }
    player → controller : { type:'file-error', fileId, message }

  Design notes
  - Chunks are 16 000 bytes so that, after PeerJS' BinaryPack framing (+3 bytes), a
    message stays below PeerJS' own 16 300-byte chunking threshold. PeerJS therefore
    never re-chunks/re-assembles, and 16 KB messages work on every WebRTC browser.
  - Back-pressure: we watch RTCDataChannel.bufferedAmount and pause while more than
    HIGH_WATER bytes are queued (Chrome closes the channel if its queue overflows).
  - The receiver never keeps the whole file as JS ArrayBuffers: every FLUSH_BYTES it
    folds the received chunks into a Blob (browsers can page Blobs to disk), and at
    the end builds one Blob out of those parts. This keeps old, low-RAM phones alive.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.RVTransfer = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHUNK_SIZE = 16000;              // bytes per data-channel message
  var READ_BLOCK = 1024 * 1024;        // read the source file 1 MB at a time
  var HIGH_WATER = 2 * 1024 * 1024;    // pause sending above this bufferedAmount
  var LOW_WATER = 512 * 1024;          // resume when the channel drains below this
  var FLUSH_BYTES = 4 * 1024 * 1024;   // receiver folds chunks into a Blob every 4 MB
  var PROGRESS_INTERVAL = 300;         // ms between file-progress reports
  var DONE_TIMEOUT = 120000;           // ms to wait for the receiver's file-done

  var MIME_BY_EXT = {
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
    mkv: 'video/x-matroska', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ogv: 'video/ogg',
    avi: 'video/x-msvideo', ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg'
  };

  function genId() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function guessMime(name, type) {
    if (type && /^video\//i.test(type)) return type;
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    if (m && MIME_BY_EXT[m[1].toLowerCase()]) return MIME_BY_EXT[m[1].toLowerCase()];
    return type || 'video/mp4';
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function mkErr(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function isBinary(x) {
    if (!x || typeof x !== 'object') return false;
    if (x instanceof ArrayBuffer) return true;
    if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(x)) return true;
    var tag = Object.prototype.toString.call(x); // works across realms / iframes
    return tag === '[object ArrayBuffer]' || tag === '[object Uint8Array]';
  }

  function toArrayBuffer(x) {
    if (x instanceof ArrayBuffer || Object.prototype.toString.call(x) === '[object ArrayBuffer]') return x;
    // copy the view so we never keep a reference to a larger underlying buffer
    return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
  }

  function readBlob(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /* ------------------------------------------------------------------ sender */

  /**
   * sendFile(conn, file, opts) → { fileId, done, cancel(), handleMessage(msg) }
   *   conn  : an OPEN PeerJS DataConnection (binary serialization, reliable)
   *   file  : File / Blob
   *   opts  : { fileId?, onProgress?({fileId, sent, received, total}) }
   * The page must forward every incoming message to handleMessage(); it returns true
   * when the message belonged to this transfer (file-progress / file-done / file-error).
   * `done` resolves with {fileId,size} once the receiver confirmed the whole file,
   * or rejects with an Error whose .code is one of:
   *   'not-connected' | 'disconnected' | 'cancelled' | 'read-failed' | 'timeout' | 'remote'
   */
  function sendFile(conn, file, opts) {
    opts = opts || {};
    var fileId = String(opts.fileId || genId());
    var total = file.size;
    var state = { sent: 0, received: 0, cancelled: false, finished: false, remoteDone: false, failed: null };
    var resolveDone, rejectDone;
    var done = new Promise(function (res, rej) { resolveDone = res; rejectDone = rej; });
    done.catch(function () {}); // the caller may attach handlers later

    function isOpen() { return !!(conn && conn.open === true); }
    function channel() { return conn && conn.dataChannel ? conn.dataChannel : null; }
    function report() {
      if (!opts.onProgress) return;
      try { opts.onProgress({ fileId: fileId, sent: state.sent, received: state.received, total: total }); } catch (e) {}
    }

    // Resolves once the data channel has room for more data (or the transfer must stop).
    function waitForDrain() {
      if (state.cancelled || !isOpen()) return Promise.resolve();
      var ch = channel();
      if (!ch) return sleep(4); // no visibility into the queue → gentle pacing
      if (ch.bufferedAmount <= HIGH_WATER) return Promise.resolve();
      return new Promise(function (resolve) {
        var timer = null;
        function fin() {
          clearTimeout(timer);
          try { ch.removeEventListener('bufferedamountlow', fin); } catch (e) {}
          resolve();
        }
        try {
          ch.bufferedAmountLowThreshold = LOW_WATER;
          ch.addEventListener('bufferedamountlow', fin);
        } catch (e) {}
        timer = setTimeout(fin, 100);
      }).then(waitForDrain);
    }

    async function run() {
      if (!isOpen()) throw mkErr('not-connected');
      conn.send({
        type: 'file-start', fileId: fileId, name: file.name || 'video',
        size: total, mime: guessMime(file.name, file.type), chunk: CHUNK_SIZE
      });
      var offset = 0;
      while (offset < total) {
        var end = Math.min(total, offset + READ_BLOCK);
        var buf;
        try { buf = await readBlob(file.slice(offset, end)); }
        catch (e) { throw mkErr('read-failed', e && e.message); }
        var u8 = new Uint8Array(buf);
        for (var p = 0; p < u8.length; p += CHUNK_SIZE) {
          await waitForDrain();
          if (state.cancelled) throw mkErr('cancelled');
          if (!isOpen()) throw mkErr('disconnected');
          var piece = u8.subarray(p, Math.min(u8.length, p + CHUNK_SIZE));
          conn.send(piece);
          state.sent += piece.byteLength;
        }
        offset = end;
        report();
      }
      if (state.cancelled) throw mkErr('cancelled');
      if (!isOpen()) throw mkErr('disconnected');
      conn.send({ type: 'file-end', fileId: fileId });

      var t0 = Date.now();
      while (!state.remoteDone) {
        if (state.failed) throw state.failed;
        if (state.cancelled) throw mkErr('cancelled');
        if (!isOpen()) throw mkErr('disconnected');
        if (Date.now() - t0 > DONE_TIMEOUT) throw mkErr('timeout');
        await sleep(100);
      }
      return { fileId: fileId, size: total };
    }

    function handleMessage(m) {
      if (!m || typeof m !== 'object' || String(m.fileId) !== fileId) return false;
      if (m.type === 'file-progress') { state.received = Number(m.received) || 0; report(); return true; }
      if (m.type === 'file-done') { state.remoteDone = true; state.received = total; report(); return true; }
      if (m.type === 'file-error') { state.failed = mkErr('remote', String(m.message || 'error')); return true; }
      return false;
    }

    function cancel() {
      if (state.finished || state.cancelled) return;
      state.cancelled = true;
      if (isOpen()) { try { conn.send({ type: 'file-cancel', fileId: fileId }); } catch (e) {} }
    }

    run().then(function (r) {
      state.finished = true;
      resolveDone(r);
    }, function (e) {
      state.finished = true;
      // tell the receiver to drop the partial file (unless we already sent a cancel)
      if (!state.cancelled && e && e.code !== 'remote' && isOpen()) {
        try { conn.send({ type: 'file-cancel', fileId: fileId }); } catch (e2) {}
      }
      rejectDone(e);
    });

    return {
      fileId: fileId,
      done: done,
      cancel: cancel,
      handleMessage: handleMessage,
      getState: function () { return { sent: state.sent, received: state.received, total: total, finished: state.finished, cancelled: state.cancelled }; }
    };
  }

  /* ---------------------------------------------------------------- receiver */

  /**
   * createReceiver(opts) → { handleMessage(msg) → bool, cancel(reason), isActive(), info() }
   *   opts.send(msg)              : function that sends a message back to the sender
   *   opts.onStart(info)          : a transfer began
   *   opts.onProgress(info)       : info.received / info.size
   *   opts.onDone(info, blob)     : file complete — blob is ready for URL.createObjectURL
   *   opts.onError(info, reason)  : transfer failed (already reported to the sender)
   *   opts.onCancel(info)         : the sender cancelled
   * The page forwards every incoming message to handleMessage(); it returns true when
   * the message was part of a file transfer (binary chunk or file-* control message).
   */
  function createReceiver(opts) {
    opts = opts || {};
    var rx = null;

    function send(msg) { if (opts.send) { try { opts.send(msg); } catch (e) {} } }
    function emit(name, a, b) { if (opts[name]) { try { opts[name](a, b); } catch (e) {} } }
    function info() {
      return rx ? { fileId: rx.fileId, name: rx.name, size: rx.size, mime: rx.mime, received: rx.received } : null;
    }

    function flush() {
      if (rx && rx.parts.length) {
        rx.blobParts.push(new Blob(rx.parts));
        rx.parts = [];
        rx.partBytes = 0;
      }
    }

    function abort(reason, notifyPeer) {
      if (!rx) return;
      var i = info();
      rx = null;
      if (notifyPeer) send({ type: 'file-error', fileId: i.fileId, message: reason });
      emit('onError', i, reason);
    }

    function start(m) {
      if (rx) abort('replaced', false);
      rx = {
        fileId: String(m.fileId), name: String(m.name || 'video'), size: Number(m.size) || 0,
        mime: String(m.mime || ''), received: 0, parts: [], partBytes: 0, blobParts: [],
        lastProgress: Date.now()
      };
      emit('onStart', info());
    }

    function chunk(data) {
      if (!rx) return; // stray chunk (e.g. after a cancel) — ignore
      var buf = toArrayBuffer(data);
      rx.parts.push(buf);
      rx.partBytes += buf.byteLength;
      rx.received += buf.byteLength;
      if (rx.received > rx.size) { abort('size-overflow', true); return; }
      if (rx.partBytes >= FLUSH_BYTES) {
        try { flush(); } catch (e) { abort('storage-failed', true); return; }
      }
      var now = Date.now();
      if (now - rx.lastProgress >= PROGRESS_INTERVAL) {
        rx.lastProgress = now;
        send({ type: 'file-progress', fileId: rx.fileId, received: rx.received });
        emit('onProgress', info());
      }
    }

    function finish(m) {
      if (!rx || String(m.fileId) !== rx.fileId) return;
      var blob;
      try {
        flush();
        blob = new Blob(rx.blobParts, { type: rx.mime || 'video/mp4' });
      } catch (e) { abort('storage-failed', true); return; }
      if (blob.size !== rx.size) { abort('size-mismatch', true); return; }
      var i = info();
      rx = null;
      send({ type: 'file-done', fileId: i.fileId, size: blob.size });
      emit('onDone', i, blob);
    }

    function handleMessage(m) {
      if (isBinary(m)) { chunk(m); return true; }
      if (!m || typeof m !== 'object') return false;
      if (m.type === 'file-start') { start(m); return true; }
      if (m.type === 'file-end') { finish(m); return true; }
      if (m.type === 'file-cancel') {
        if (rx && String(m.fileId) === rx.fileId) { var i = info(); rx = null; emit('onCancel', i); }
        return true;
      }
      return false;
    }

    return {
      handleMessage: handleMessage,
      cancel: function (reason) { abort(reason || 'cancelled', false); },
      isActive: function () { return !!rx; },
      info: info
    };
  }

  return {
    CHUNK_SIZE: CHUNK_SIZE,
    HIGH_WATER: HIGH_WATER,
    sendFile: sendFile,
    createReceiver: createReceiver,
    genId: genId,
    fmtBytes: fmtBytes,
    guessMime: guessMime,
    isBinary: isBinary
  };
}));
