import { App, navigateTo, api } from './app.js';
import { loadSidebarChatList } from './sidebar.js';
import { onReady, showToast, updateBulkActions, getFileIcon, escapeHtml, formatDate, getDateGroupLabel } from './utils.js';
import { icon, favIcon } from './icons.js';

var clSelected = new Set();

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────
onReady(function() {
  if (document.getElementById('page-chatlist')) renderChatListPage();
});

document.addEventListener('page:enter', function(e) {
  if (e.detail.page !== 'chatlist') return;
  if (!document.getElementById('cl-body')) renderChatListPage();
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
      '<h2 class="cl-title"><i class="bi bi-chat-square-dots"></i> 채팅 목록</h2>' +
      '<div id="cl-bulk-actions" style="display:none;">' +
        '<button id="cl-select-all-btn" class="cl-action-btn"><i class="bi bi-check-all"></i> 전체 선택</button>' +
        '<button id="cl-deselect-btn" class="cl-action-btn" style="display:none;"><i class="bi bi-x-lg"></i> 전체 해제</button>' +
        '<span id="cl-selected-count">0개 선택됨</span>' +
        '<button id="cl-delete-btn" class="cl-danger-btn"><i class="bi bi-trash"></i> 선택 삭제</button>' +
      '</div>' +
    '</div>' +
    '<div id="cl-body"></div>';

  document.getElementById('cl-delete-btn')
    ?.addEventListener('click', deleteSelectedChats);

  document.getElementById('cl-select-all-btn')
    ?.addEventListener('click', function() {
      document.querySelectorAll('.cl-row').forEach(function(row) {
        var id = String(row.dataset.sessionId);
        clSelected.add(id);
        var chk = row.querySelector('.cl-check-icon');
        if (chk) chk.classList.add('checked');
      });
      updateBulkActions('cl-bulk-actions', 'cl-selected-count', clSelected);
      updateSelectButtons();
    });

  document.getElementById('cl-deselect-btn')
    ?.addEventListener('click', function() {
      clSelected.clear();
      document.querySelectorAll('.cl-check-icon').forEach(function(chk) {
        chk.classList.remove('checked');
      });
      updateBulkActions('cl-bulk-actions', 'cl-selected-count', clSelected);
      updateSelectButtons();
    });
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
  var favorites = sessions.filter(function(s) { return s.is_favorite; });
  var normals   = sessions.filter(function(s) { return !s.is_favorite; });
  body.innerHTML = '';
  if (favorites.length) {
    body.appendChild(makeGroupLabel('즐겨찾기', 'bi bi-star-fill fav-active'));
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

// ──────────────────────────────────────
// 전체 선택/해제 버튼 상태 갱신
// ──────────────────────────────────────
function updateSelectButtons() {
  var total   = document.querySelectorAll('.cl-row').length;
  var allBtn  = document.getElementById('cl-select-all-btn');
  var desBtn  = document.getElementById('cl-deselect-btn');
  if (!allBtn || !desBtn) return;
  var allSelected = total > 0 && clSelected.size >= total;
  allBtn.style.display = allSelected ? 'none'        : 'inline-flex';
  desBtn.style.display = allSelected ? 'inline-flex' : 'none';
}

// ──────────────────────────────────────
// 그룹 레이블
// ──────────────────────────────────────
function makeGroupLabel(text, iconClass) {
  var el = document.createElement('div');
  el.className = 'cl-group-label';
  if (iconClass) {
    var i = document.createElement('i');
    i.className = iconClass;
    i.style.marginRight = '4px';
    el.appendChild(i);
  }
  el.appendChild(document.createTextNode(text));
  return el;
}

// ──────────────────────────────────────
// 채팅 행
// ──────────────────────────────────────
function makeChatRow(session) {
  var row = document.createElement('div');
  row.className = 'cl-row';
  row.dataset.sessionId = session.id;

  // 체크 버튼
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
    updateSelectButtons();
  });

  // 즐겨찾기 버튼
  var favBtn = document.createElement('button');
  favBtn.className = 'cl-fav-btn';
  favBtn.title = session.is_favorite ? '즐겨찾기 해제' : '즐겨찾기 등록';
  favBtn.style.cssText = 'width:32px;height:32px;padding:8px;border:none;cursor:pointer;background:none;flex-shrink:0;display:flex;align-items:center;justify-content:center;';
  favBtn.innerHTML = favIcon(!!session.is_favorite);
  favBtn.addEventListener('click', async function(e) {
    e.stopPropagation();
    var newFav = session.is_favorite ? 0 : 1;
    try {
      await api('PATCH', '/api/sessions/' + session.id, { is_favorite: newFav });
      session.is_favorite = newFav;
      favBtn.innerHTML = favIcon(!!newFav);
      showToast(newFav ? '즐겨찾기 등록됨' : '즐겨찾기 해제됨');
      loadChatList();
      loadSidebarChatList();
    } catch(e2) { showToast('즐겨찾기 변경 실패', 'error'); }
  });

  // 정보 영역
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

  // 수정 버튼
  var editBtn = document.createElement('button');
  editBtn.className = 'cl-edit-btn';
  editBtn.innerHTML = '<i class="bi bi-pencil"></i>';
  editBtn.title = '제목 수정';
  editBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (title.querySelector('input')) return;
    var current = session.title || '새 대화';
    var input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'cl-title-input';
    title.textContent = '';
    title.appendChild(input);
    input.focus();
    input.select();
    async function saveTitle() {
      var newTitle = input.value.trim();
      if (!newTitle) newTitle = current;
      title.textContent = newTitle;
      session.title = newTitle;
      if (newTitle !== current) {
        try {
          await api('PATCH', '/api/sessions/' + session.id, { title: newTitle });
          loadSidebarChatList();
          showToast('제목 변경됨');
        } catch(err) {
          showToast('제목 변경 실패', 'error');
          title.textContent = current;
          session.title = current;
        }
      }
    }
    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', function(e2) {
      if (e2.key === 'Enter')  { e2.preventDefault(); input.blur(); }
      if (e2.key === 'Escape') { title.textContent = current; }
    });
  });

  // 삭제 버튼
  var delBtn = document.createElement('button');
  delBtn.className = 'cl-del-btn';
  delBtn.innerHTML = '<i class="bi bi-trash"></i>';
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

  row.append(checkBtn, favBtn, info, editBtn, delBtn);

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
'.cl-action-btn{padding:5px 10px;border-radius:var(--radius-md);background:var(--bg-tertiary);color:var(--text-secondary);font-size:var(--font-size-xs);border:1px solid var(--border);cursor:pointer;transition:color 0.15s;}' +
'.cl-action-btn:hover{color:var(--text-primary);}' +
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
'.cl-title-input{background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:var(--radius-sm);color:var(--text-primary);font-size:var(--font-size-sm);padding:2px 6px;width:180px;outline:none;}' +
'.cl-meta{font-size:var(--font-size-xs);color:var(--text-muted);}' +
'.cl-edit-btn{flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:4px 6px;border-radius:var(--radius-sm);transition:color 0.15s;opacity:0;}' +
'.cl-row:hover .cl-edit-btn{opacity:1;}' +
'.cl-edit-btn:hover{color:var(--accent);}' +
'.cl-del-btn{flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:4px 6px;border-radius:var(--radius-sm);transition:color 0.15s;}' +
'.cl-del-btn:hover{color:var(--danger);}' +
'.cl-empty{text-align:center;padding:60px 20px;color:var(--text-muted);font-size:var(--font-size-sm);}';

var _clStyle = document.createElement('style');
_clStyle.textContent = clCSS;
document.head.appendChild(_clStyle);