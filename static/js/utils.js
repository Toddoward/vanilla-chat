/**
 * static/js/utils.js
 * 공용 유틸리티 — 모든 모듈이 import해서 사용
 */

// ──────────────────────────────────────
// XSS 방지
// ──────────────────────────────────────
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────
// 마크다운 렌더링 (경량)
// ──────────────────────────────────────
export function renderMarkdown(text) {
  if (!text) return '';
  var html = escapeHtml(text);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre><code class="lang-' + lang + '">' + code.trim() + '</code></pre>';
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return '<p>' + html + '</p>';
}

// ──────────────────────────────────────
// 파일 아이콘
// ──────────────────────────────────────
export function getFileIcon(name) {
  var ext = (name || '').split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','webp','gif'].includes(ext)) return '<i class="bi bi-file-earmark-image"></i>';
  if (ext === 'pdf')  return '<i class="bi bi-file-earmark-pdf"></i>';
  if (ext === 'docx') return '<i class="bi bi-file-earmark-word"></i>';
  if (ext === 'txt' || ext === 'md') return '<i class="bi bi-file-earmark-text"></i>';
  return '<i class="bi bi-paperclip"></i>';
}

// ──────────────────────────────────────
// 날짜 포맷
// ──────────────────────────────────────
export function formatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  return d.toLocaleDateString('ko-KR', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export function getDateGroupLabel(dateStr) {
  if (!dateStr) return '이전';
  var d    = new Date(dateStr);
  var now  = new Date();
  var diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  if (diff < 7)  return '이번 주';
  if (diff < 30) return '이번 달';
  return '이전';
}

// ──────────────────────────────────────
// 토스트 알림
// ──────────────────────────────────────
export function showToast(message, type = 'default', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
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
// 일괄 선택 액션 바 갱신
// ──────────────────────────────────────
export function updateBulkActions(barId, countId, selectedSet) {
  var bar   = document.getElementById(barId);
  var count = document.getElementById(countId);
  if (!bar) return;
  if (selectedSet.size > 0) {
    bar.style.display = 'flex';
    if (count) count.textContent = selectedSet.size + '개 선택됨';
  } else {
    bar.style.display = 'none';
  }
}

// ──────────────────────────────────────
// 안전한 DOM 초기화 헬퍼
// ──────────────────────────────────────
export function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}