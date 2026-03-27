import { App, navigateTo, api } from './app.js';
import { escapeHtml, getFileIcon, showToast, onReady } from './utils.js';



/**
 * static/js/search.js
 * 통합 검색 페이지 — 채팅 + 파일, 인크리멘탈, 하이라이트
 */

var srDebounceTimer = null;

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────
onReady(function() {
  renderSearchPage();
});

document.addEventListener('page:enter', function(e) {
  if (e.detail.page !== 'search') return;
  // 레이아웃이 비어있으면 다시 렌더링
  var page = document.getElementById('page-search');
  if (page && !document.getElementById('sr-input')) renderSearchPage();
  var input = document.getElementById('sr-input');
  if (input) input.focus();
  doSearch('');
});

// ──────────────────────────────────────
// 레이아웃
// ──────────────────────────────────────
function renderSearchPage() {
  var page = document.getElementById('page-search');
  if (!page) return;
  page.innerHTML =
    '<div id="sr-header">' +
      '<div id="sr-input-wrap">' +
        '<span id="sr-icon">🔍</span>' +
        '<input id="sr-input" type="text" placeholder="채팅, 파일 내용 검색..."/>' +
        '<button id="sr-clear" style="display:none;">✕</button>' +
      '</div>' +
    '</div>' +
    '<div id="sr-body">' +
      '<div id="sr-section-sessions"></div>' +
      '<div id="sr-section-files"></div>' +
    '</div>';

  var input   = document.getElementById('sr-input');
  var clearBtn = document.getElementById('sr-clear');

  input.addEventListener('input', function() {
    var q = input.value.trim();
    clearBtn.style.display = q ? 'flex' : 'none';
    clearTimeout(srDebounceTimer);
    srDebounceTimer = setTimeout(function() { doSearch(q); }, 200);
  });

  clearBtn.addEventListener('click', function() {
    input.value = '';
    clearBtn.style.display = 'none';
    doSearch('');
    input.focus();
  });
}

// ──────────────────────────────────────
// 검색 실행
// ──────────────────────────────────────
async function doSearch(q) {
  try {
    var data = await api('GET', '/api/search?q=' + encodeURIComponent(q) + '&limit=20');
    renderSessions(data.sessions || [], q);
    renderFiles(data.files || [], q);
  } catch(e) {
    document.getElementById('sr-section-sessions').innerHTML =
      '<div class="sr-empty">검색 오류가 발생했습니다.</div>';
  }
}

// ──────────────────────────────────────
// 채팅 섹션
// ──────────────────────────────────────
function renderSessions(sessions, q) {
  var el = document.getElementById('sr-section-sessions');
  if (!el) return;
  if (!sessions.length) {
    el.innerHTML = q
      ? '<div class="sr-section-label">💬 채팅</div><div class="sr-empty">결과 없음</div>'
      : '';
    return;
  }
  var html = '<div class="sr-section-label">💬 채팅 <span class="sr-count">' + sessions.length + '</span></div>';
  sessions.forEach(function(s) {
    var title   = highlight(s.title || '새 대화', q);
    var snippet = s.snippet ? highlight(s.snippet.slice(0, 100), q) : '';
    html +=
      '<div class="sr-item" data-session-id="' + s.session_id + '" data-type="session">' +
        '<div class="sr-item-icon">💬</div>' +
        '<div class="sr-item-info">' +
          '<span class="sr-item-title">' + title + '</span>' +
          (snippet ? '<span class="sr-item-snippet">' + snippet + '</span>' : '') +
        '</div>' +
        '<span class="sr-item-date">' + formatSrDate(s.updated_at) + '</span>' +
      '</div>';
  });
  el.innerHTML = html;
  el.querySelectorAll('.sr-item[data-type="session"]').forEach(function(item) {
    item.addEventListener('click', function() {
      var sid = parseInt(item.dataset.sessionId);
      App.currentSessionId = sid;
      navigateTo('chat');
      document.dispatchEvent(new CustomEvent('chat:load', { detail: { sessionId: sid } }));
      var sideItem = document.querySelector('.chat-item[data-session-id="' + sid + '"]');
      if (sideItem) {
        document.querySelectorAll('.chat-item').forEach(function(i) { i.classList.remove('active'); });
        sideItem.classList.add('active');
      }
      var nb = document.getElementById('btn-new-chat');
      if (nb) nb.classList.remove('active');
    });
  });
}

// ──────────────────────────────────────
// 파일 섹션
// ──────────────────────────────────────
function renderFiles(files, q) {
  var el = document.getElementById('sr-section-files');
  if (!el) return;
  if (!files.length) {
    el.innerHTML = q
      ? '<div class="sr-section-label">📁 파일</div><div class="sr-empty">결과 없음</div>'
      : '';
    return;
  }
  var html = '<div class="sr-section-label">📁 파일 <span class="sr-count">' + files.length + '</span></div>';
  files.forEach(function(f) {
    var name    = highlight(f.display_name || f.original_path || '', q);
    var snippet = f.snippet ? highlight(f.snippet.slice(0, 100), q) : '';
    var icon    = getFileIcon(f.display_name || '');
    html +=
      '<div class="sr-item" data-path="' + escapeHtml(f.original_path || '') + '" data-type="file">' +
        '<div class="sr-item-icon">' + icon + '</div>' +
        '<div class="sr-item-info">' +
          '<span class="sr-item-title">' + name + '</span>' +
          (snippet ? '<span class="sr-item-snippet">' + snippet + '</span>' : '') +
          '<span class="sr-item-path">' + escapeHtml(f.original_path || '') + '</span>' +
        '</div>' +
        '<span class="sr-badge ' + (f.embedding_status === 'done' ? 'done' : 'pending') + '">' +
          (f.embedding_status === 'done' ? '✅' : '⏳') +
        '</span>' +
      '</div>';
  });
  el.innerHTML = html;
  // 파일 항목 클릭 → 경로 클립보드 복사
  el.querySelectorAll('.sr-item[data-type="file"]').forEach(function(item) {
    item.addEventListener('click', function() {
      var path = item.dataset.path;
      if (path) navigator.clipboard.writeText(path).then(function() { showToast('경로 복사됨'); });
    });
  });
}

// ──────────────────────────────────────
// 유틸
// ──────────────────────────────────────
function highlight(text, q) {
  if (!q || !text) return escapeHtml(text || '');
  var escaped = escapeHtml(text);
  var escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + escapedQ + ')', 'gi'),
    '<mark class="sr-mark">$1</mark>');
}

function formatSrDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

// ──────────────────────────────────────
// CSS
// ──────────────────────────────────────
var srCSS =
'#page-search.active{display:flex;flex-direction:column;height:100%;overflow:hidden;}' +
'#sr-header{flex-shrink:0;padding:20px 24px 12px;border-bottom:1px solid var(--border-subtle);}' +
'#sr-input-wrap{display:flex;align-items:center;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-xl);padding:10px 16px;transition:border-color 0.15s;}' +
'#sr-input-wrap:focus-within{border-color:var(--accent);}' +
'#sr-icon{color:var(--text-muted);font-size:16px;flex-shrink:0;}' +
'#sr-input{flex:1;background:none;border:none;outline:none;color:var(--text-primary);font-size:var(--font-size-md);}' +
'#sr-input::placeholder{color:var(--text-muted);}' +
'#sr-clear{background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;display:flex;align-items:center;padding:0;}' +
'#sr-clear:hover{color:var(--text-primary);}' +
'#sr-body{flex:1;overflow-y:auto;padding:8px 24px 24px;}' +
'.sr-section-label{font-size:var(--font-size-xs);font-weight:600;color:var(--text-muted);padding:16px 0 6px;text-transform:uppercase;letter-spacing:0.05em;display:flex;align-items:center;gap:6px;}' +
'.sr-count{background:var(--bg-tertiary);color:var(--text-muted);border-radius:var(--radius-full);padding:1px 7px;font-size:var(--font-size-xs);}' +
'.sr-item{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--border-subtle);margin-bottom:4px;background:var(--bg-secondary);cursor:pointer;transition:background 0.15s;}' +
'.sr-item:hover{background:var(--surface);}' +
'.sr-item-icon{flex-shrink:0;font-size:18px;margin-top:1px;}' +
'.sr-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}' +
'.sr-item-title{font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);}' +
'.sr-item-snippet{font-size:var(--font-size-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.sr-item-path{font-size:var(--font-size-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.sr-item-date{flex-shrink:0;font-size:var(--font-size-xs);color:var(--text-muted);}' +
'.sr-badge{flex-shrink:0;font-size:12px;}' +
'.sr-mark{background:rgba(232,201,122,0.35);color:var(--accent);border-radius:2px;padding:0 1px;}' +
'.sr-empty{text-align:center;padding:20px;color:var(--text-muted);font-size:var(--font-size-sm);}';

var _srStyle = document.createElement('style');
_srStyle.textContent = srCSS;
document.head.appendChild(_srStyle);