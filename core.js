/* ずれっこ：共通の定数・小道具・汎用UI（ほかの画面スクリプトより先に読み込む）
 * 構成：WebRTC（PeerJS）による P2P。ホストのブラウザが唯一の正（authoritative）で、お題配り・進行・NPCの思考はホストが行います。
 * 参加者に送るのは「その人のお題」と公開情報だけ（他人のお題・NPCの頭の中は結果発表まで送りません）。
 */
'use strict';
var $ = function (id) { return document.getElementById(id); };
var B = window.WWB, L = window.WWL;
var DB = B.build(window.WW_WORDS || []);
var PW = (window.WW_WEIGHTS && window.WW_WEIGHTS.P) || B.HAND;   // 学習済みの重み（なければ手作りの初期値）
var Q = new URLSearchParams(location.search);
var CFG = window.ZK_CONFIG || {};
var ICE = (CFG.iceServers && CFG.iceServers.length) ? CFG.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
if (Q.get('ice')) ICE = Q.get('ice').split(',').map(function (u) { return { urls: u }; });   // テスト・独自環境用
var PEER_OPTS = Object.assign({ debug: 1, config: { iceServers: ICE } }, CFG.peer || {});
var ID_PREFIX = 'zurekko-v1-', CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var TURBO = Q.has('turbo');
var MAX_HUMANS = 6, MAX_TOTAL = 8, HB_MS = 3000, LOST_MS = 10000;
var LS_ID = 'zk-client-id', LS_NAME = 'zk-name', LS_HOST = 'zk-host-room', SS_CLIENT = 'zk-joined', LS_SOUND = 'zk-sound-off', LS_HIDE = 'zk-hide-word';
var host = null, client = null, lastView = null, pending = '';
function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {} }
function load(k, json) { try { var v = localStorage.getItem(k); return json ? JSON.parse(v) : v; } catch (e) { return null; } }
function sstore(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function sload(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } }
function rid(n) { var s = ''; for (var i = 0; i < n; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]; return s; }
var myId = load(LS_ID) || (function () { var v = rid(16); store(LS_ID, v); return v; })();
var soundOff = load(LS_SOUND) === '1';
function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8); }
var PARTY = window.FuuParty && window.FuuParty.info;   // ひろばの「みんなの部屋」から来たとき
function genCode() { if (PARTY && PARTY.host) return PARTY.code; var c = ''; for (var i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1').slice(0, 4); }
function inviteUrl(code) { var u = location.origin + location.pathname + '?room=' + code; if (Q.get('ice')) u += '&ice=' + encodeURIComponent(Q.get('ice')); return u; }
var NPC_NAMES = window.WW_CHARS.map(function (c) { return c.name; });
function avHtml(pl, cls) {
  if (pl.kind === 'npc') return '<span class="av npc ' + (cls || '') + '" style="--ac:' + pl.col + '">' + pl.e + '</span>';
  var hue = 0; for (var i = 0; i < pl.name.length; i++) hue = (hue * 31 + pl.name.charCodeAt(i)) % 360;
  return '<span class="av ' + (cls || '') + '" style="--ac:hsl(' + hue + ',55%,48%)">' + esc(pl.name.slice(0, 1)) + '</span>';
}
function dispName(pl) { return pl.kind === 'npc' ? pl.name + pl.e : pl.name; }

// ---------- 汎用UI ----------
function show(id) { ['title', 'lobby', 'game', 'end'].forEach(function (s) { $(s).classList.toggle('active', s === id); }); document.body.classList.toggle('in-game', id === 'game'); }
function overlay(id, on) { $(id).classList.toggle('active', on); }
var toastT;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 3000); }
function banner(msg) { var b = $('banner'); b.textContent = msg || ''; b.classList.toggle('show', !!msg); }
function confirmBox(title, text, yes, cb) {
  $('cfTitle').textContent = title; $('cfText').textContent = text; $('cfYes').textContent = yes; $('cfNo').style.display = ''; $('cfNo').textContent = 'やめる';
  overlay('confirmModal', true);
  $('cfYes').onclick = function () { overlay('confirmModal', false); cb(); };
  $('cfNo').onclick = function () { overlay('confirmModal', false); };
}
function alertBox(msg) { confirmBox('お知らせ', msg, 'OK', function () {}); $('cfNo').style.display = 'none'; }
function connecting(on, title, text, onCancel) {
  overlay('connecting', on);
  if (on) { $('connTitle').textContent = title || '接続中…'; $('connText').textContent = text || ''; $('connCancel').onclick = onCancel || function () { location.href = location.pathname; }; }
}
$('rulesBtn1').onclick = $('rulesBtn2').onclick = function () { overlay('rulesModal', true); };
$('rulesClose').onclick = function () { overlay('rulesModal', false); };
['rulesModal', 'menuModal', 'charModal'].forEach(function (id) { $(id).addEventListener('click', function (e) { if (e.target === this) overlay(id, false); }); });
$('rulesList').innerHTML = [
  'みんなに<b>ひみつのお題</b>が配られます。でも<b>1人だけ（ウルフ）</b>は、少しちがうお題です（例：みんな「うどん」、ウルフだけ「そば」）。<b>自分がウルフかどうかは、自分でもわかりません！</b>',
  '<b>ヒントラウンド</b>（2〜3回）：順番に、自分のお題についての<b>ヒントを1つ</b>出します（短い言葉で）。お題そのものは言えません。候補ボタンから選んでもOK。',
  '各ラウンドのあとは<b>話し合いタイム</b>。口で話してもいいし、チャットに書いてもOK。NPCたちもチャットで疑ったり、言い返したりします（名前を呼ぶと返事をくれます）。',
  '<b>コツ</b>：具体的すぎるヒントは、ウルフにお題がバレます。ふんわりすぎると、自分が疑われます。<b>みんなのヒントが自分のお題とズレていたら…ウルフはあなたかも？</b> そのときは、みんなに合わせて まぎれましょう。',
  '最後に<b>投票</b>。いちばん票が多い人がつかまります（同数なら1回だけ決選投票。それでも同数なら、だれもつかまりません）。',
  'つかまった人が<b>ウルフ</b>なら、市民の勝ち！ ただし<b>逆転ルール「あり」</b>のときは<b>逆転チャンス</b>：ウルフが<b>みんなのお題</b>を当てたらウルフの勝ち（ウルフ有利になるので、なれてきたら どうぞ）。',
  'つかまった人が<b>市民</b>だったり、だれもつかまらなかったら、<b>ウルフの勝ち</b>。',
  '勝ち点：市民が勝ったら市民全員に +1、ウルフが勝ったらウルフに +3。',
  '<b>🎤 音声入力</b>：入力欄の🎤をタップして話す→もう一度タップで送信（長押しなら、はなすと送信）。話した言葉はチャットになり、NPCもちゃんと読みます。自分の番なら ヒントとして確認してから出せます（iPhoneはSafari、Android・PCはChrome）。',
  '<b>NPC</b>（ふーさん🐻・ミミ🐰・ニャコ😺・ポチ太🐶・ロボミ🤖・コンタ🦊）は、自分のお題と、みんなに公開されたヒントだけで考えます。<b>他の人のお題は見ていません</b>。強さは やさしい／ふつう／かしこい／アストラウルトラ😎。'
].map(function (t) { return '<li>' + t + '</li>'; }).join('');
