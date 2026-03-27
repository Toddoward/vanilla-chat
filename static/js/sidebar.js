/**
 * static/js/sidebar.js
 * 사이드바 Collapse/Expand + 헤더 모델 연결 상태 + 채팅 목록 렌더링
 */

// ──────────────────────────────────────
// 사이드바 토글
// ──────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const btnToggle = document.getElementById('btn-toggle');

let sidebarCollapsed = false;

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);

  // 토글 버튼 레이블 변경
  const label = btnToggle.querySelector('.btn-label');
  if (label) label.textContent = sidebarCollapsed ? '펼치기' : '접기';

  // 상태 저장
  localStorage.setItem('sidebar_collapsed', sidebarCollapsed ? '1' : '0');
}

btnToggle.addEventListener('click', toggleSidebar);

// 이전 상태 복원
if (localStorage.getItem('sidebar_collapsed') === '1') {
  toggleSidebar();
}

// ──────────────────────────────────────
// 헤더 모델 연결 상태
// ──────────────────────────────────────
const modelStatusEl = document.getElementById('model-status');
const statusTextEl  = document.getElementById('status-text');

async function refreshModelStatus() {
  try {
    const data = await api('GET', '/api/status');
    modelStatusEl.className = `model-status ${data.connected ? 'connected' : 'error'}`;
    statusTextEl.textContent = data.connected
      ? data.model
      : 'Ollama 연결 안 됨';
  } catch {
    modelStatusEl.className = 'model-status error';
    statusTextEl.textContent = '연결 오류';
  }
}

// 앱 시작 시 + 30초마다 상태 갱신
refreshModelStatus();
setInterval(refreshModelStatus, 30_000);

// ──────────────────────────────────────
// 채팅 목록 렌더링
// ──────────────────────────────────────
const chatListEl = document.getElementById('sidebar-chat-list');

async function loadSidebarChatList() {
  try {
    const data = await api('GET', '/api/sessions');
    renderSidebarChatList(data.sessions || []);
  } catch (e) {
    console.warn('채팅 목록 로드 실패:', e);
  }
}

function renderSidebarChatList(sessions) {
  chatListEl.innerHTML = '';

  if (!sessions.length) {
    chatListEl.innerHTML = '<div style="padding:12px 10px; color:var(--text-muted); font-size:12px;">대화 없음</div>';
    return;
  }

  // 즐겨찾기 상단 고정
  const favorites = sessions.filter(s => s.is_favorite);
  const normals   = sessions.filter(s => !s.is_favorite);

  if (favorites.length) {
    chatListEl.appendChild(createGroupLabel('⭐ 즐겨찾기'));
    favorites.forEach(s => chatListEl.appendChild(createChatItem(s)));
  }

  // 날짜 그룹
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
  if (session.id === App.currentSessionId) el.classList.add('active');
  el.dataset.sessionId = session.id;

  if (session.is_favorite) {
    const fav = document.createElement('span');
    fav.className = 'fav-icon';
    fav.textContent = '⭐';
    el.appendChild(fav);
  }

  const title = document.createElement('span');
  title.textContent = session.title || '새 대화';
  el.appendChild(title);

  el.addEventListener('click', () => {
    App.currentSessionId = session.id;
    navigateTo('chat');
    document.dispatchEvent(new CustomEvent('chat:load', { detail: { sessionId: session.id } }));
    // 활성 항목 표시
    document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    // 새 채팅 버튼 active 해제 (기존 채팅 로드이므로)
    const newChatBtn = document.getElementById('btn-new-chat');
    if (newChatBtn) newChatBtn.classList.remove('active');
  });

  return el;
}

// ──────────────────────────────────────
// Data Hub 뱃지
// ──────────────────────────────────────
const datahubBadge = document.getElementById('datahub-badge');

function setDatahubBadge(state, tooltip) {
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

// 새 채팅 생성 후 목록 갱신
document.addEventListener('chat:created', loadSidebarChatList);
document.addEventListener('chat:deleted', loadSidebarChatList);
document.addEventListener('chat:titled',  loadSidebarChatList);

// 페이지 진입 시 목록 갱신
document.addEventListener('page:enter', ({ detail }) => {
  if (detail.page === 'chat' || detail.page === 'chatlist') {
    loadSidebarChatList();
  }
});

// 앱 초기화 후 목록 로드
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadSidebarChatList, 100);
});