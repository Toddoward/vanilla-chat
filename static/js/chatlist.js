import { App, navigateTo, api } from './app.js';
import { loadSidebarChatList } from './sidebar.js';
import { onReady, showToast, applyFavStyle, updateBulkActions, getFileIcon, escapeHtml, formatDate, getDateGroupLabel } from './utils.js';



/**
 * static/js/chatlist.js
 * 채팅 목록 페이지 — 날짜 그룹, 즐겨찾기, 다중 삭제
 */

var clSelected = new Set();

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────
onReady(function() {
  renderChatListPage();
});

document.addEventListener('page:enter', function(e) {
  if (e.detail.page !== 'chatlist') return;
  // 레이아웃이 비어있으면 다시 렌더링
  var page = document.getElementById('page-chatlist');
  if (page && !document.getElementById('cl-body')) renderChatListPage();
  loadChatList();
});

// ──────────────────────────────────────
// 레이아웃
// ──────────────────────────────────────
function renderChatListPage() {
  var page = document.getElementById('page-chatlist');
  if (!page) return;
  page.innerHTML =
    '<div id="cl-header">' +
      '<h2 class="cl-title">💬 채팅 목록</h2>' +
      '<div id="cl-bulk-actions" style="display:none;">' +
        '<span id="cl-selected-count">0개 선택됨</span>' +
        '<button id="cl-delete-btn" class="cl-danger-btn">🗑 선택 삭제</button>' +
      '</div>' +
    '</div>' +
    '<div id="cl-body"></div>';

  document.getElementById('cl-delete-btn')
    ?.addEventListener('click', deleteSelectedChats);
}

// ──────────────────────────────────────
// 목록 로드
// ──────────────────────────────────────
async function loadChatList() {
  var body = document.getElementById('cl-body');
  if (!body) return;
  try {
    var data = await api('GET', '/api/sessions');
    clSelected.clear();
    updateBulkActions('cl-bulk-actions', 'cl-selected-count', clSelected);
    renderChatList(data.sessions || []);
  } catch(e) {
    body.innerHTML = '<div class="cl-empty">채팅 목록 로드 실패</div>';
  }
}

function renderChatList(sessions) {
  var body = document.getElementById('cl-body');
  if (!body) return;

  if (!sessions.length) {
    body.innerHTML = '<div class="cl-empty">아직 채팅 기록이 없습니다.</div>';
    return;
  }

  // 즐겨찾기 / 날짜 그룹 분리
  var favorites = sessions.filter(function(s) { return s.is_favorite; });
  var normals   = sessions.filter(function(s) { return !s.is_favorite; });

  body.innerHTML = '';

  if (favorites.length) {
    body.appendChild(makeGroupLabel('⭐ 즐겨찾기'));
    favorites.forEach(function(s) { body.appendChild(makeChatRow(s)); });
  }

  var groups = {};
  normals.forEach(function(s) {
    var label = getDateGroupLabel(s.updated_at || s.created_at);
    if (!groups[label]) groups[label] = [];
    groups[label].push(s);
  });

  Object.keys(groups).forEach(function(label) {
    body.appendChild(makeGroupLabel(label));
    groups[label].forEach(function(s) { body.appendChild(makeChatRow(s)); });
  });
}

function makeGroupLabel(text) {
  var el = document.createElement('div');
  el.className = 'cl-group-label';
  el.textContent = text;
  return el;
}

function makeChatRow(session) {
  var row = document.createElement('div');
  row.className = 'cl-row';
  row.dataset.sessionId = session.id;

  // 체크 버튼 — 투명 버튼이 클릭 영역, 내부 span이 시각적 체크박스
  var checkBtn = document.createElement('button');
  checkBtn.className = 'cl-check-btn';
  checkBtn.title = '선택';
  var checkIcon = document.createElement('span');
  checkIcon.className = 'cl-check-icon';
  checkBtn.appendChild(checkIcon);
  checkBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var id = String(session.id);
    if (clSelected.has(id)) {
      clSelected.delete(id);
      checkIcon.classList.remove('checked');
    } else {
      clSelected.add(id);
      checkIcon.classList.add('checked');
    }
    updateBulkActions('cl-bulk-actions', 'cl-selected-count', clSelected);
  });

  var favBtn = document.createElement('button');
  favBtn.className = 'cl-fav-btn fav-icon-el';
  favBtn.title = session.is_favorite ? '즐겨찾기 해제' : '즐겨찾기 등록';
  favBtn.style.cssText = 'width:16px;height:16px;padding:0;border:none;cursor:pointer;background:none;flex-shrink:0;';
  if (typeof _applyFavStyle === 'function') {
    _applyFavStyle(favBtn, !!session.is_favorite);
  } else {
    favBtn.textContent = '★';
    favBtn.style.color = session.is_favorite ? 'var(--accent)' : 'var(--text-muted)';
  }
  favBtn.addEventListener('click', async function(e) {
    e.stopPropagation();
    var newFav = session.is_favorite ? 0 : 1;
    try {
      await api('PATCH', '/api/sessions/' + session.id, { is_favorite: newFav });
      session.is_favorite = newFav;
      if (typeof _applyFavStyle === 'function') _applyFavStyle(favBtn, !!newFav);
      else { favBtn.style.color = newFav ? 'var(--accent)' : 'var(--text-muted)'; }
      showToast(newFav ? '즐겨찾기 등록됨' : '즐겨찾기 해제됨');
      loadChatList();
      loadSidebarChatList();
    } catch(e2) { showToast('즐겨찾기 변경 실패', 'error'); }
  });

  var info = document.createElement('div');
  info.className = 'cl-info';
  var title = document.createElement('span');
  title.className = 'cl-title-text';
  title.textContent = session.title || '새 대화';
  var meta = document.createElement('span');
  meta.className = 'cl-meta';
  meta.textContent = formatDate(session.updated_at) +
    (session.message_count ? ' · ' + session.message_count + '개 메시지' : '');
  info.append(title, meta);

  var delBtn = document.createElement('button');
  delBtn.className = 'cl-del-btn';
  delBtn.textContent = '🗑';
  delBtn.title = '삭제';
  delBtn.addEventListener('click', async function(e) {
    e.stopPropagation();
    if (!confirm('"' + (session.title || '새 대화') + '"을 삭제할까요?')) return;
    await api('DELETE', '/api/sessions', { ids: [session.id] });
    showToast('삭제됨');
    loadChatList();
    loadSidebarChatList();
    document.dispatchEvent(new CustomEvent('chat:deleted'));
  });

  row.append(checkBtn, favBtn, info, delBtn);

  // 행 클릭 → 해당 채팅으로 이동
  row.addEventListener('click', function(e) {
    if (['INPUT','BUTTON'].includes(e.target.tagName)) return;
    App.currentSessionId = session.id;
    navigateTo('chat');
    document.dispatchEvent(new CustomEvent('chat:load', { detail: { sessionId: session.id } }));
    document.querySelectorAll('.chat-item').forEach(function(i) { i.classList.remove('active'); });
    var sideItem = document.querySelector('.chat-item[data-session-id="' + session.id + '"]');
    if (sideItem) sideItem.classList.add('active');
    var newChatBtn = document.getElementById('btn-new-chat');
    if (newChatBtn) newChatBtn.classList.remove('active');
  });

  return row;
}

// ──────────────────────────────────────
// 일괄 삭제
// ──────────────────────────────────────
async function deleteSelectedChats() {
  if (!clSelected.size) return;
  if (!confirm(clSelected.size + '개 채팅을 삭제할까요?')) return;
  await api('DELETE', '/api/sessions', { ids: Array.from(clSelected) });
  showToast(clSelected.size + '개 삭제됨');
  clSelected.clear();
  loadChatList();
  loadSidebarChatList();
  document.dispatchEvent(new CustomEvent('chat:deleted'));
}

// ──────────────────────────────────────
// CSS
// ──────────────────────────────────────
var clCSS =
'#page-chatlist.active{display:flex;flex-direction:column;height:100%;overflow:hidden;}' +
'#cl-header{flex-shrink:0;padding:20px 24px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border-subtle);}' +
'.cl-title{font-size:18px;font-weight:600;color:var(--text-primary);flex:1;margin:0;}' +
'#cl-bulk-actions{align-items:center;gap:10px;}' +
'#cl-selected-count{font-size:var(--font-size-sm);color:var(--accent);}' +
'.cl-danger-btn{padding:5px 12px;border-radius:var(--radius-md);background:var(--danger-dim);color:var(--danger);font-size:var(--font-size-xs);border:1px solid var(--danger);cursor:pointer;}' +
'#cl-body{flex:1;overflow-y:auto;padding:8px 24px 24px;}' +
'.cl-group-label{font-size:var(--font-size-xs);font-weight:600;color:var(--text-muted);padding:16px 0 6px;text-transform:uppercase;letter-spacing:0.05em;}' +
'.cl-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--border-subtle);margin-bottom:4px;background:var(--bg-secondary);cursor:pointer;transition:background 0.15s;}' +
'.cl-row:hover{background:var(--surface);}' +
'.cl-check-btn{flex-shrink:0;background:none;border:none;cursor:pointer;padding:8px;margin:-8px;display:flex;align-items:center;justify-content:center;}' +
'.cl-check-icon{display:block;width:16px;height:16px;border:1.5px solid var(--text-muted);border-radius:3px;background:transparent;position:relative;transition:border-color 0.15s,background 0.15s;flex-shrink:0;}' +
'.cl-check-icon.checked{background:var(--accent);border-color:var(--accent);}' +
'.cl-check-icon.checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:2px solid var(--bg-primary);border-top:none;border-left:none;transform:rotate(45deg);}' +
'.cl-fav-btn{flex-shrink:0;background:none;border:none;cursor:pointer;padding:8px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;opacity:0.6;transition:opacity 0.15s;}' +
'.cl-fav-btn:hover{opacity:1;}' +
'.cl-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}' +
'.cl-title-text{font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.cl-meta{font-size:var(--font-size-xs);color:var(--text-muted);}' +
'.cl-del-btn{flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:4px 6px;border-radius:var(--radius-sm);transition:color 0.15s;}' +
'.cl-del-btn:hover{color:var(--danger);}' +
'.cl-empty{text-align:center;padding:60px 20px;color:var(--text-muted);font-size:var(--font-size-sm);}';

var _clStyle = document.createElement('style');
_clStyle.textContent = clCSS;
document.head.appendChild(_clStyle);