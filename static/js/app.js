/**
 * static/js/app.js
 * 전역 SPA 라우터 + 상태 관리
 */
import { onReady } from './utils.js';

// ──────────────────────────────────────
// 전역 앱 상태
// ──────────────────────────────────────
export const App = {
  currentPage: 'chat',
  currentSessionId: null,
  config: {},
  appState: {},
  appInfo: {},
  themeConfig: {},
};

// ──────────────────────────────────────
// 페이지 라우터
// ──────────────────────────────────────
export function navigateTo(page) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sidebar-btn[data-page]').forEach(el => el.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) {
    pageEl.classList.add('active');
    App.currentPage = page;
  }

  const btnEl = document.querySelector(`.sidebar-btn[data-page="${page}"]`);
  if (btnEl) btnEl.classList.add('active');

  if (page !== 'chat') {
    const titleEl = document.getElementById('header-chat-title');
    const sepEl   = document.getElementById('header-title-sep');
    const favEl   = document.getElementById('header-fav-btn');
    if (titleEl) titleEl.style.display = 'none';
    if (sepEl)   sepEl.style.display   = 'none';
    if (favEl)   favEl.style.display   = 'none';
  }

  document.dispatchEvent(new CustomEvent('page:enter', { detail: { page } }));
}

// ──────────────────────────────────────
// 공통 API 호출
// ──────────────────────────────────────
export async function api(method, path, body = null) {
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
// 앱 초기화
// ──────────────────────────────────────
async function initApp() {
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

  try {
    const info = await api('GET', '/api/app-info');
    App.appInfo = info;
    applyAppInfo(info);
  } catch (e) {
    console.warn('app-info 로드 실패:', e);
    applyAppInfo({ name: 'Vanilla Chat', logo: '', logo_emoji_fallback: '🍨' });
  }

  try {
    const resp = await fetch('/theme_config.json');
    App.themeConfig = await resp.json();
  } catch (e) {
    console.warn('theme_config 로드 실패:', e);
  }

  try {
    App.appState = await api('GET', '/api/app-state');
  } catch (e) {
    console.warn('app-state 로드 실패:', e);
  }

  try {
    App.config = await api('GET', '/api/config');
  } catch (e) {
    console.warn('config 로드 실패:', e);
  }

  navigateTo('chat');

  // 모델 연결 상태 — navigateTo 이후 호출해야 model_manager 초기화 완료 시점
  refreshModelStatus();
  setInterval(refreshModelStatus, 30000);

  // Settings에서 모델 변경 시 즉시 갱신
  document.addEventListener('model:changed', () => {
    const dot  = document.querySelector('.status-dot');
    const text = document.querySelector('#status-text');
    if (dot)  dot.style.background = 'var(--warning)';
    if (text) text.textContent = '연결 중...';
    refreshModelStatus();
  });
}

async function refreshModelStatus() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('#status-text');
  try {
    const data = await api('GET', '/api/status');
    const connected = data.connected === true;
    if (dot)  dot.style.background  = connected ? 'var(--success)' : 'var(--danger)';
    if (text) text.textContent = connected ? (data.model || 'connected') : '연결 중...';
  } catch (e) {
    if (dot)  dot.style.background  = 'var(--danger)';
    if (text) text.textContent = '연결 중...';
  }
}

function applyAppInfo(info) {
  const { name, logo, logo_emoji_fallback } = info;
  document.title = name;

  const nameEl = document.getElementById('app-name');
  if (nameEl) nameEl.textContent = name;

  const logoEl  = document.getElementById('header-logo');
  const emojiEl = document.getElementById('header-logo-emoji');

  if (logo) {
    logoEl.alt = name;
    logoEl.src = `/${logo}`;
    logoEl.style.display = 'inline';
    logoEl.onerror = () => {
      logoEl.style.display = 'none';
      emojiEl.textContent   = logo_emoji_fallback || '🍨';
      emojiEl.style.display = 'inline';
    };
  } else {
    emojiEl.textContent   = logo_emoji_fallback || '🍨';
    emojiEl.style.display = 'inline';
  }

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

onReady(initApp);