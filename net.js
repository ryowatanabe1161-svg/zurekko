/* ずれっこ：通信（PeerJS）。ホストの受付・参加者の接続・ロビー操作 */
'use strict';
// ================= ホスト側の通信 =================
function openHostPeer() {
  var R = host.room, peer = new Peer(hostId(R.code), PEER_OPTS);
  host.peer = peer;
  peer.on('open', function () { host.opened = true; host.tries = 0; connecting(false); banner(''); hostRender(); saveHost(); });
  peer.on('connection', function (conn) {
    conn.on('data', function (msg) { hostOnMessage(conn, msg); });
    conn.on('close', function () { hostConnClosed(conn); });
    conn.on('error', function () { hostConnClosed(conn); });
  });
  peer.on('disconnected', function () { if (!peer.destroyed) setTimeout(function () { try { peer.reconnect(); } catch (e) {} }, 2000); });
  peer.on('error', function (e) {
    if (e.type === 'unavailable-id') {
      try { peer.destroy(); } catch (x) {}
      if (!host.opened && R.phase === 'lobby' && !host.resuming && !PARTY) { R.code = genCode(); openHostPeer(); return; }
      if (++host.tries > 25) { connecting(false); toast('部屋を再開できませんでした'); return; }
      connecting(true, '部屋を再開しています…', '少し時間がかかることがあります（' + host.tries + '）');
      setTimeout(openHostPeer, 3000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(e.type) >= 0) {
      if (!host.opened) { connecting(true, 'サーバーに接続できません', '通信環境を確認してください。再試行しています…（ひとりで遊ぶなら「やめる」→「NPCと ひとりで遊ぶ」）'); setTimeout(function () { try { peer.destroy(); } catch (x) {} openHostPeer(); }, 4000); }
      else banner('シグナリングサーバーとの接続が不安定です（ゲームは続行できます）');
    } else if (e.type === 'browser-incompatible') connecting(true, 'このブラウザは対応していません', 'Chrome / Safari の最新版でお試しください');
  });
}
function hostOnMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  var R = host.room;
  if (msg.t === 'join') return hostJoin(conn, msg);
  var seat = conn.clientId && seatByClient(conn.clientId);
  if (!seat || host.conns[conn.clientId] !== conn) return;
  host.lastSeen[conn.clientId] = Date.now();
  if (msg.t === 'ping') return;
  if (msg.t === 'lobbyReq') return hostLobbyReq(seat);
  if (msg.t === 'leave') {
    if (R.phase === 'lobby') R.seats.splice(R.seats.indexOf(seat), 1); else { seat.connected = false; seat.left = true; seat.lostAt = Date.now(); }
    delete host.conns[conn.clientId]; try { conn.close(); } catch (e) {}
    if (R.phase !== 'lobby') toastAll(seat.name + 'が退出しました（おまかせで代わりに進めます）');
    hostBroadcast(); return;
  }
  if (msg.t !== 'act' || (R.phase !== 'game' && R.phase !== 'end') || msg.g !== R.gameNo) return;
  var err = hostAction(seat.sid, msg);
  if (err) { try { conn.send({ t: 'error', msg: err }); conn.send(viewFor(seat.sid)); } catch (e) {} }
}
function hostJoin(conn, msg) {
  var R = host.room, name = cleanName(msg.name), cid = String(msg.clientId || '').slice(0, 40);
  function reject(text) { conn.send({ t: 'reject', msg: text }); setTimeout(function () { try { conn.close(); } catch (e) {} }, 500); }
  if (!name || !cid) return reject('ニックネームを入力してください');
  if (cid === myId) return reject('ホストと同じ端末・ブラウザからは参加できません');
  var seat = seatByClient(cid);
  if (!seat) { seat = R.seats.filter(function (s) { return s.name === name && s.kind === 'remote' && !s.connected; })[0]; if (seat) seat.clientId = cid; }
  if (seat) {
    if (seat.kind !== 'remote') return reject('この名前は使えません');
    var old = host.conns[cid]; if (old && old !== conn) { try { old.close(); } catch (e) {} }
    seat.connected = true; seat.left = false;
  } else {
    if (R.phase !== 'lobby') return reject('この部屋はゲーム中です。前に参加していた人は、同じニックネームで入ると元の席に戻れます。');
    if (R.seats.length >= MAX_HUMANS) return reject('満員です（最大' + MAX_HUMANS + '人）');
    if (R.seats.some(function (s) { return s.name === name; }) || NPC_NAMES.indexOf(name) >= 0) return reject('その名前は使えません。別のニックネームにしてください。');
    seat = { sid: R.nextSid++, name: name, kind: 'remote', clientId: cid, connected: true };
    R.seats.push(seat);
    while (R.seats.length + R.opts.npcs.length > MAX_TOTAL && R.opts.npcs.length) R.opts.npcs.pop();
  }
  conn.clientId = cid; host.conns[cid] = conn; host.lastSeen[cid] = Date.now();
  conn.send({ t: 'welcome', code: R.code, sid: seat.sid });
  hostBroadcast();
}
function hostConnClosed(conn) {
  if (!conn.clientId || host.conns[conn.clientId] !== conn) return;
  delete host.conns[conn.clientId];
  var seat = seatByClient(conn.clientId);
  if (seat && seat.connected) { seat.connected = false; seat.lostAt = Date.now(); hostBroadcast(); }
}
function hostHeartbeat() {
  if (!host) return;
  var now = Date.now();
  Object.keys(host.conns).forEach(function (cid) {
    var c = host.conns[cid];
    try { c.send({ t: 'hb' }); } catch (e) {}
    if (now - (host.lastSeen[cid] || 0) > LOST_MS) { try { c.close(); } catch (e) {} hostConnClosed(c); }
  });
}

// ================= 参加者（クライアント） =================
function startClient(code, name) {
  document.body.classList.remove('is-host');
  client = { code: code, name: name, joined: false, lastMsg: Date.now(), everJoined: false };
  connecting(true, '部屋 ' + code + ' に接続中…', 'しばらくお待ちください', function () { leaveClient(true); });
  var peer = new Peer(PEER_OPTS);
  client.peer = peer;
  if (PARTY) client.watch = setInterval(function () { if (!client) return; if (client.everJoined) { clearInterval(client.watch); return; } if (client.peer.open && !(client.conn && client.conn.open)) clientConnect(); }, FuuParty.watchMs);   // みんなの部屋：ホストより先に着いたときの取りこぼし対策
  peer.on('open', function () { clientConnect(); });
  peer.on('disconnected', function () { if (!peer.destroyed) setTimeout(function () { try { peer.reconnect(); } catch (e) {} }, 2000); });
  peer.on('error', function (e) {
    if (e.type === 'peer-unavailable') { if (PARTY && !client.everJoined && (client.ptries = (client.ptries || 0) + 1) < FuuParty.retries) { connecting(true, 'ホストを待っています…', '部屋 ' + client.code); setTimeout(clientConnect, FuuParty.retryMs); return; } if (!client.everJoined) { connecting(false); toast('部屋が見つかりません。コードを確認してください。'); leaveClient(false); } else clientLost(); }
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(e.type) >= 0) { if (!client.everJoined) connecting(true, 'サーバーに接続できません', '通信環境を確認してください。再試行しています…'); }
    else if (e.type === 'browser-incompatible') connecting(true, 'このブラウザは対応していません', 'Chrome / Safari の最新版でお試しください');
  });
  clearInterval(client.hbTimer); client.hbTimer = setInterval(clientHeartbeat, HB_MS);
  setTimeout(function () { if (client && !client.everJoined && $('connecting').classList.contains('active')) $('connText').textContent = 'つながりにくいようです。コードが正しいか、ホストが部屋を開いているか確認してください。（通信環境によっては接続できない場合があります）'; }, 15000);
}
function clientConnect() {
  if (!client || !client.peer || client.peer.destroyed) return;
  if (client.conn) { try { client.conn.close(); } catch (e) {} }
  var conn = client.peer.connect(hostId(client.code), { reliable: true });
  client.conn = conn;
  conn.on('open', function () { conn.send({ t: 'join', name: client.name, clientId: myId }); });
  conn.on('data', function (m) { if (client && client.conn === conn) clientOnMessage(m); });
  conn.on('close', function () { if (client && client.conn === conn) clientLost(); });
  conn.on('error', function () { if (client && client.conn === conn) clientLost(); });
}
function clientOnMessage(m) {
  if (!m || typeof m !== 'object') return;
  client.lastMsg = Date.now();
  if (m.t === 'welcome') { client.joined = true; client.everJoined = true; connecting(false); banner(''); sstore(SS_CLIENT, { code: client.code, name: client.name }); }
  else if (m.t === 'fuu-goto') { if (PARTY) { try { sstore(SS_CLIENT, null); } catch (e) {} FuuParty.handle(m); } } else if (m.t === 'state') { pending = ''; render(m); }
  else if (m.t === 'reject') { connecting(false); leaveClient(false); alertBox(m.msg); }
  else if (m.t === 'kicked') { sstore(SS_CLIENT, null); leaveClient(false); alertBox('ホストによって部屋から外されました。'); }
  else if (m.t === 'closed') { sstore(SS_CLIENT, null); leaveClient(false); alertBox('ホストが部屋を閉じました。'); }
  else if (m.t === 'error') { pending = ''; toast(m.msg); if (lastView) render(lastView); }
}
function clientHeartbeat() {
  if (!client) return;
  if (client.conn && client.conn.open) { try { client.conn.send({ t: 'ping' }); } catch (e) {} }
  if (client.everJoined && Date.now() - client.lastMsg > LOST_MS) clientLost();
}
function clientLost() {
  if (!client || !client.everJoined) return;
  client.joined = false; banner('ホストとの接続が切れました。再接続しています…');
  clearTimeout(client.retryT);
  client.retryT = setTimeout(function () {
    if (!client) return; client.lastMsg = Date.now();
    if (client.peer.disconnected && !client.peer.destroyed) { try { client.peer.reconnect(); } catch (e) {} }
    clientConnect();
  }, 3000);
}
function leaveClient(sendLeave) {
  if (!client) return;
  if (sendLeave && client.conn && client.conn.open) { try { client.conn.send({ t: 'leave' }); } catch (e) {} }
  clearInterval(client.hbTimer); clearTimeout(client.retryT);
  var p = client.peer; client = null;
  setTimeout(function () { try { p.destroy(); } catch (e) {} }, 300);
  banner(''); connecting(false); show('title'); renderTitle();
}
function send(m) { if (client && client.conn && client.conn.open) { client.conn.send(m); return true; } toast('接続が切れています'); return false; }
