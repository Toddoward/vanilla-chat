/**
 * static/js/app.js
 * 전역 SPA 라우터 + 상태 관리 + 공통 유틸리티
 */

// ──────────────────────────────────────
// 전역 앱 상태
// ──────────────────────────────────────
const App = {
  currentPage: 'chat',
  currentSessionId: null,
  config: {},
  appState: {},         // /api/app-state 응답
  appInfo: {},          // /api/app-info 응답 (이름, 로고)
  themeConfig: {},      // theme_config.json (Greeting 풀 등)
};

// ──────────────────────────────────────
// 페이지 라우터
// ──────────────────────────────────────
function navigateTo(page) {
  // 모든 페이지 비활성화
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sidebar-btn[data-page]').forEach(el => el.classList.remove('active'));

  // 대상 페이지 활성화
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) {
    pageEl.classList.add('active');
    App.currentPage = page;
  }

  // 사이드바 버튼 활성화 (search/chatlist/datahub/settings 전환 시)
  const btnEl = document.querySelector(`.sidebar-btn[data-page="${page}"]`);
  if (btnEl) btnEl.classList.add('active');

  // 페이지 진입 이벤트 발행
  document.dispatchEvent(new CustomEvent('page:enter', { detail: { page } }));
}

// ──────────────────────────────────────
// 공통 API 호출
// ──────────────────────────────────────
async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(path, opts);
  if (!resp.ok) throw new Error(`API ${method} ${path} → ${resp.status}`);
  return resp.json();
}

// ──────────────────────────────────────
// 토스트 알림
// ──────────────────────────────────────
function showToast(message, type = 'default', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ──────────────────────────────────────
// 이스케이프 (XSS 방지)
// ──────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────
// 날짜 그룹 레이블
// ──────────────────────────────────────
function getDateGroupLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - date) / 86400000);

  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays <= 7) return '이번 주';
  if (diffDays <= 30) return '이번 달';
  return '이전';
}

// ──────────────────────────────────────
// 앱 초기화
// ──────────────────────────────────────
async function initApp() {
  // 사이드바 버튼 라우팅 이벤트 등록
  document.querySelectorAll('.sidebar-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (page === 'chat') {
        navigateTo('chat');
        document.dispatchEvent(new CustomEvent('chat:new'));
      } else {
        navigateTo(page);
      }
    });
  });

  // 앱 기본 정보 로드 (이름, 로고)
  try {
    const info = await api('GET', '/api/app-info');
    App.appInfo = info;
    applyAppInfo(info);
  } catch (e) {
    console.warn('app-info 로드 실패, 기본값 사용:', e);
    applyAppInfo({ name: 'Vanilla Chat', logo: '', logo_emoji_fallback: '🍨' });
  }

  // theme_config.json 로드 (Greeting 풀, 추천 질문)
  try {
    const resp = await fetch('/theme_config.json');
    App.themeConfig = await resp.json();
  } catch (e) {
    console.warn('theme_config 로드 실패:', e);
  }

  // 앱 상태 로드 (Greeting 조건)
  try {
    App.appState = await api('GET', '/api/app-state');
  } catch (e) {
    console.warn('app-state 로드 실패:', e);
  }

  // 설정 로드
  try {
    App.config = await api('GET', '/api/config');
  } catch (e) {
    console.warn('config 로드 실패:', e);
  }

  // 기본 페이지: 채팅
  navigateTo('chat');
}

function applyAppInfo(info) {
  const { name, logo, logo_emoji_fallback } = info;

  // 탭 제목
  document.title = name;

  // 앱 이름
  const nameEl = document.getElementById('app-name');
  if (nameEl) nameEl.textContent = name;

  // 로고: 이미지 시도 → 실패 시 이모지 fallback
  const logoEl  = document.getElementById('header-logo');
  const emojiEl = document.getElementById('header-logo-emoji');

  if (logo) {
    logoEl.alt = name;
    logoEl.src = `/${logo}`;
    logoEl.style.display = 'inline';
    logoEl.onerror = () => {
      logoEl.style.display = 'none';
      emojiEl.textContent    = logo_emoji_fallback || '🍨';
      emojiEl.style.display  = 'inline';
    };
  } else {
    emojiEl.textContent   = logo_emoji_fallback || '🍨';
    emojiEl.style.display = 'inline';
  }

  // favicon도 동적 적용
  if (logo) {
    let favicon = document.querySelector("link[rel='icon']");
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.appendChild(favicon);
    }
    favicon.href = `/${logo}`;
  }
}

document.addEventListener('DOMContentLoaded', initApp);
