/**
 * static/js/sidebar.js
 * 사이드바 — 채팅 목록, 즐겨찾기, 뱃지, 토글
 */
import { App, navigateTo, api } from './app.js';
import { getDateGroupLabel, applyFavStyle, onReady } from './utils.js';



// ──────────────────────────────────────
// 사이드바 토글
// ──────────────────────────────────────
function _applyBtnLabels(visible) {
  document.querySelectorAll('.btn-label').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

export function toggleSidebar() {
  // 좁은 화면에서는 확장 차단
  if (window.innerWidth <= 768) return;
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  _applyBtnLabels(!isCollapsed);
  const label = document.querySelector('#btn-toggle .btn-label');
  if (label) label.textContent = isCollapsed ? '' : '접기';
}

document.getElementById('btn-toggle')?.addEventListener('click', toggleSidebar);

// 화면 폭 변화 자동 감지 — 좁아지면 collapse, 넓어지면 restore
const _mq = window.matchMedia('(max-width: 768px)');
function _handleBreakpoint(e) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (e.matches) {
    // 좁아짐 → collapse
    sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
    _applyBtnLabels(false);
  } else {
    // 넓어짐 → restore
    sidebar.classList.remove('collapsed');
    document.body.classList.remove('sidebar-collapsed');
    _applyBtnLabels(true);
    const label = document.querySelector('#btn-toggle .btn-label');
    if (label) label.textContent = '접기';
  }
}
_mq.addEventListener('change', _handleBreakpoint);
// 초기 상태 즉시 적용
_handleBreakpoint(_mq);

// ──────────────────────────────────────
// 채팅 목록 로드 + 렌더링
// ──────────────────────────────────────
const chatListEl = document.getElementById('sidebar-chat-list');

export async function loadSidebarChatList() {
  if (!chatListEl) return;
  try {
    const data = await api('GET', '/api/sessions');
    renderSidebarChatList(data.sessions || []);
  } catch (e) {
    console.warn('사이드바 목록 로드 실패:', e);
  }
}

function renderSidebarChatList(sessions) {
  chatListEl.innerHTML = '';

  if (!sessions.length) {
    chatListEl.innerHTML = '<div class="sidebar-empty">대화 없음</div>';
    return;
  }

  const favorites = sessions.filter(s => s.is_favorite);
  const normals   = sessions.filter(s => !s.is_favorite);

  favorites.forEach(s => chatListEl.appendChild(createChatItem(s)));

  const groups = {};
  normals.forEach(s => {
    const label = getDateGroupLabel(s.updated_at);
    if (!groups[label]) groups[label] = [];
    groups[label].push(s);
  });

  ['오늘', '어제', '이번 주', '이번 달', '이전'].forEach(label => {
    if (!groups[label]) return;
    chatListEl.appendChild(createGroupLabel(label));
    groups[label].forEach(s => chatListEl.appendChild(createChatItem(s)));
  });
}

function createGroupLabel(text) {
  const el = document.createElement('div');
  el.className = 'chat-group-label';
  el.textContent = text;
  return el;
}

function createChatItem(session) {
  const el = document.createElement('div');
  el.className = 'chat-item';
  if (session.id === App.currentSessionId && App.currentPage === 'chat') {
    el.classList.add('active');
  }
  el.dataset.sessionId = session.id;

  const title = document.createElement('span');
  title.className = 'chat-item-title';
  title.textContent = session.title || '새 대화';
  el.appendChild(title);

  if (session.is_favorite) {
    const fav = document.createElement('span');
    fav.className = 'sidebar-fav-icon';
    fav.title = '즐겨찾기';
    fav.style.cssText = 'display:inline-block;width:12px;height:12px;flex-shrink:0;margin-left:4px;vertical-align:middle;';
    applyFavStyle(fav, true);
    el.appendChild(fav);
  }

  el.addEventListener('click', () => {
    App.currentSessionId = session.id;
    navigateTo('chat');
    document.dispatchEvent(new CustomEvent('chat:load', { detail: { sessionId: session.id } }));
    document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    const newChatBtn = document.getElementById('btn-new-chat');
    if (newChatBtn) newChatBtn.classList.remove('active');
  });

  return el;
}

// ──────────────────────────────────────
// Data Hub 뱃지
// ──────────────────────────────────────
const datahubBadge = document.getElementById('datahub-badge');

export function setDatahubBadge(state, tooltip) {
  const btn = document.getElementById('btn-datahub');
  datahubBadge.className = 'badge';
  if (state === 'hidden') {
    datahubBadge.style.display = 'none';
    if (btn) btn.removeAttribute('data-tooltip');
    return;
  }
  datahubBadge.style.display = '';
  datahubBadge.classList.add('visible', state);
  if (btn && tooltip) btn.setAttribute('data-tooltip', tooltip);
  else if (btn) {
    const labels = {
      running: '임베딩 진행 중...',
      done:    '임베딩 완료',
      error:   '오류 발생 — 클릭하여 확인',
    };
    btn.setAttribute('data-tooltip', labels[state] || '');
  }
}

// ──────────────────────────────────────
// 이벤트 리스닝
// ──────────────────────────────────────
document.addEventListener('chat:created', loadSidebarChatList);
document.addEventListener('chat:deleted', loadSidebarChatList);
document.addEventListener('chat:titled',  loadSidebarChatList);

document.addEventListener('page:enter', ({ detail }) => {
  if (detail.page === 'chat' || detail.page === 'chatlist') {
    loadSidebarChatList();
  }
  if (detail.page !== 'chat') {
    document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
  }
});

onReady(() => {
  setTimeout(loadSidebarChatList, 100);
});