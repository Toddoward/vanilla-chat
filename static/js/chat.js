/**
 * static/js/chat.js — Phase 2 완성본 v3
 */
import { App, navigateTo, api } from './app.js';
import { loadSidebarChatList, setDatahubBadge } from './sidebar.js';
import { escapeHtml, renderMarkdown, getFileIcon, showToast, applyFavStyle, onReady } from './utils.js';

// ──────────────────────────────────────
// Greeting
// ──────────────────────────────────────
function pickGreeting(appState, themeConfig) {
  var g = (themeConfig && themeConfig.greetings) || {
    morning:   ['좋은 아침이에요. 오늘은 무엇을 도와드릴까요?'],
    afternoon: ['안녕하세요. 궁금한 게 있으신가요?'],
    evening:   ['오늘 하루도 수고하셨어요. 무엇이든 물어보세요.'],
    returning: ['다시 오셨군요. 이어서 도와드릴게요.'],
  };
  if (appState && appState.is_returning) {
    var p = g.returning || [];
    return p[Math.floor(Math.random() * p.length)] || '다시 오셨군요!';
  }
  var hour = new Date().getHours();
  var key  = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  var p2 = g[key] || [];
  return p2[Math.floor(Math.random() * p2.length)] || '무엇이든 물어보세요.';
}

// ──────────────────────────────────────
// 헤더 채팅 제목 + 즐겨찾기
// ──────────────────────────────────────

function setHeaderChatTitle(title, loading) {
  var el  = document.getElementById('header-chat-title');
  var sep = document.getElementById('header-title-sep');
  if (!el) {
    var left = document.querySelector('.header-left');
    if (!left) return;
    sep = document.createElement('span');
    sep.id = 'header-title-sep';
    sep.textContent = '/';
    el = document.createElement('span');
    el.id = 'header-chat-title';
    // 즐겨찾기 버튼 — 제목 오른쪽
    var favBtn = document.createElement('button');
    favBtn.id = 'header-fav-btn';
    favBtn.title = '즐겨찾기';
    favBtn.className = 'fav-icon-el';
    favBtn.style.cssText = 'display:none;width:16px;height:16px;padding:0;border:none;cursor:pointer;background:none;vertical-align:middle;margin-left:6px;flex-shrink:0;';
    applyFavStyle(favBtn, false);
    favBtn.addEventListener('click', toggleFavorite);
    left.appendChild(sep);
    left.appendChild(el);
    left.appendChild(favBtn);
  }
  var show = title && title.trim() !== '';
  if (show) {
    el.innerHTML = loading ? '<span class="title-loading">···</span>' : escapeHtml(title);
    el.style.display = 'inline';
    var s = document.getElementById('header-title-sep');
    if (s) s.style.display = 'inline';
    var fb = document.getElementById('header-fav-btn');
    if (fb && !loading) fb.style.display = 'inline-block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
    var s2 = document.getElementById('header-title-sep');
    if (s2) s2.style.display = 'none';
    var fb2 = document.getElementById('header-fav-btn');
    if (fb2) fb2.style.display = 'none';
  }
}

function setHeaderFavorite(isFavorite) {
  var btn = document.getElementById('header-fav-btn');
  if (!btn) return;
  applyFavStyle(btn, isFavorite);
  btn.dataset.fav = isFavorite ? '1' : '0';
}

async function toggleFavorite() {
  if (!currentSessionId) return;
  var btn    = document.getElementById('header-fav-btn');
  var isFav  = btn && btn.dataset.fav === '1';
  var newFav = isFav ? 0 : 1;
  try {
    await api('PATCH', '/api/sessions/' + currentSessionId, { is_favorite: newFav });
    setHeaderFavorite(newFav === 1);
    loadSidebarChatList();
  } catch(e) {
    showToast('즐겨찾기 변경 실패', 'error');
  }
}

// ──────────────────────────────────────
// 파일 첨부 칩 UI (3-7)
// ──────────────────────────────────────
var attachedFiles = [];

function setupFileAttach() {
  var fileInput = document.getElementById('file-input');
  if (!fileInput) return;
  fileInput.addEventListener('change', function() {
    Array.from(fileInput.files).forEach(function(f) {
      attachedFiles.push(f);
      renderAttachChips();
    });
    fileInput.value = '';
  });
}

function renderAttachChips() {
  var container = document.getElementById('chat-attachments');
  if (!container) return;
  container.innerHTML = '';
  attachedFiles.forEach(function(f, idx) {
    var chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML =
      '<span class="chip-icon">' + getFileIcon(f.name) + '</span>' +
      '<span class="chip-name">' + escapeHtml(f.name) + '</span>' +
      '<button class="chip-remove" data-idx="' + idx + '">✕</button>';
    chip.querySelector('.chip-remove').addEventListener('click', function() {
      attachedFiles.splice(idx, 1);
      renderAttachChips();
    });
    container.appendChild(chip);
  });
}

function clearAttachments() {
  attachedFiles = [];
  renderAttachChips();
}

// ──────────────────────────────────────
// 에이전트 상태 인라인 표시 (3-8)
// ──────────────────────────────────────
var AGENT_STATUS = {
  rag:     '🔍 저장된 문서 검색 중...',
  vision:  '👁️ 이미지 분석 중...',
  api:     '🌐 데이터 수집 중...',
};

function showAgentStatus(type) {
  var label = document.getElementById('indicator-label');
  if (label && AGENT_STATUS[type]) label.textContent = AGENT_STATUS[type];
}

// ──────────────────────────────────────
// RAG 출처 목록 (3-9)
// ──────────────────────────────────────
function appendSources(wrap, sources) {
  if (!sources || !sources.length) return;
  var div = document.createElement('div');
  div.className = 'rag-sources';
  div.innerHTML = '<span class="sources-label">출처</span>' +
    sources.map(function(s) {
      return '<span class="source-item" title="' + escapeHtml(s.path || '') + '">' +
        getFileIcon(s.name || '') + ' ' + escapeHtml(s.name || s.path || '알 수 없음') +
        '</span>';
    }).join('');
  wrap.appendChild(div);
}
function makeLogoImg() {
  var logoSrc = ((App.appInfo && App.appInfo.logo) || 'static/images/logo_color.png')
    .replace('logo_color', 'logo_mono');
  var emoji = (App.appInfo && App.appInfo.logo_emoji_fallback) || '🍨';
  var img = document.createElement('img');
  img.src = '/' + logoSrc;
  img.className = 'bubble-logo-img';
  img.alt = '';
  img.onerror = function() {
    var sp = document.createElement('span');
    sp.className = 'bubble-logo-emoji';
    sp.textContent = emoji;
    img.parentNode && img.parentNode.replaceChild(sp, img);
  };
  return img;
}

// 모든 슬롯 비우고, 마지막 assistant wrap 슬롯에만 로고 표시
function updateLatestLogo() {
  var slots = document.querySelectorAll('.bubble-logo-slot');
  slots.forEach(function(s) { s.innerHTML = ''; });
  var wraps = document.querySelectorAll('.message-wrap.assistant:not(#logo-indicator-wrap)');
  if (!wraps.length) return;
  var lastSlot = wraps[wraps.length - 1].querySelector('.bubble-logo-slot');
  if (lastSlot) lastSlot.appendChild(makeLogoImg());
}

function removeLatestLogo() {
  document.querySelectorAll('.bubble-logo-slot').forEach(function(s) { s.innerHTML = ''; });
}

// ──────────────────────────────────────
// 상태
// ──────────────────────────────────────
var currentSessionId = null;
var abortController  = null;
var isStreaming       = false;
var streamStateMap   = {};
var titlePollTimer   = null;

// ──────────────────────────────────────
// 채팅 페이지 DOM
// ──────────────────────────────────────
function renderChatPage() {
  var chatPage = document.getElementById('page-chat');
  chatPage.innerHTML =
    '<div id="chat-messages"></div>' +
    '<div id="chat-input-area">' +
      '<div id="chat-attachments"></div>' +
      '<div id="chat-input-row">' +
        '<label id="attach-btn" title="파일 첨부">\uD83D\uDCCE' +
          '<input type="file" id="file-input" multiple style="display:none;"/>' +
        '</label>' +
        '<textarea id="chat-input" placeholder="\uba54\uc2dc\uc9c0\ub97c \uc785\ub825\ud558\uc138\uc694..." rows="1"></textarea>' +
        '<button id="send-btn" title="\uc804\uc1a1">\u25B6</button>' +
        '<button id="stop-btn" title="\uc911\ub2e8" style="display:none;">\u25A0</button>' +
      '</div>' +
    '</div>';
  setupInputEvents();
  setupFileAttach();
}

// ──────────────────────────────────────
// Greeting 화면
// ──────────────────────────────────────
function showGreeting() {
  var el = document.getElementById('chat-messages');
  if (!el) return;
  var greeting  = pickGreeting(App.appState, App.themeConfig);
  var suggested = (App.themeConfig && App.themeConfig.suggested_questions) ||
    ['저장된 파일 검색해줘', '이 문서 요약해줘', '간단하게 소개해줘'];
  var emoji = (App.appInfo && App.appInfo.logo_emoji_fallback) || '🍨';
  el.innerHTML =
    '<div id="greeting-screen">' +
      '<div id="greeting-logo"><span style="font-size:48px;">' + emoji + '</span></div>' +
      '<p id="greeting-text">' + escapeHtml(greeting) + '</p>' +
      '<div id="suggested-cards">' +
        suggested.map(function(q) {
          return '<button class="suggest-card" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>';
        }).join('') +
      '</div>' +
    '</div>';
  el.querySelectorAll('.suggest-card').forEach(function(card) {
    card.addEventListener('click', function() {
      document.getElementById('chat-input').value = card.dataset.q;
      sendMessage();
    });
  });
}

// ──────────────────────────────────────
// 새 채팅 초기화
// ──────────────────────────────────────
function initNewChat() {
  currentSessionId = null;
  App.currentSessionId = null;
  if (titlePollTimer) { clearInterval(titlePollTimer); titlePollTimer = null; }
  var el = document.getElementById('chat-messages');
  if (el) el.innerHTML = '';
  setHeaderChatTitle('');
  showGreeting();
  document.querySelectorAll('.chat-item').forEach(function(i) { i.classList.remove('active'); });
}

// ──────────────────────────────────────
// 세션 생성
// ──────────────────────────────────────
async function ensureSession() {
  if (currentSessionId) return currentSessionId;
  var session = await api('POST', '/api/sessions', { title: '새 대화' });
  currentSessionId = session.id;
  App.currentSessionId = session.id;
  // 헤더 스켈레톤 즉시
  setHeaderChatTitle('···', true);
  // 새 채팅 버튼 active 해제
  var nb = document.getElementById('btn-new-chat');
  if (nb) nb.classList.remove('active');
  // 사이드바 갱신
  await loadSidebarChatList();
  document.querySelectorAll('.chat-item').forEach(function(item) {
    item.classList.toggle('active', String(item.dataset.sessionId) === String(session.id));
  });
  document.dispatchEvent(new CustomEvent('chat:created'));
  return session.id;
}

// ──────────────────────────────────────
// 기존 세션 로드
// ──────────────────────────────────────
async function loadSession(sessionId) {
  try {
    var data = await api('GET', '/api/sessions/' + sessionId);
    currentSessionId = sessionId;
    App.currentSessionId = sessionId;
    // 새 채팅 버튼 active 해제
    var newChatBtn = document.getElementById('btn-new-chat');
    if (newChatBtn) newChatBtn.classList.remove('active');
    var el = document.getElementById('chat-messages');
    el.innerHTML = '';
    setHeaderChatTitle(data.title && data.title !== '새 대화' ? data.title : '');
    setHeaderFavorite(data.is_favorite === 1);
    var st = streamStateMap[sessionId];
    if (st && !st.done) {
      if (data.messages) {
        data.messages.forEach(function(msg) {
          if (msg.role === 'system') return;
          appendMessage(msg.role, msg.content, false);
        });
      }
      if (st.thinking && !st.thinkDone) {
        var tp = createThinkingPanel();
        tp.classList.add('thinking-active');
        tp.querySelector('.thinking-content').innerHTML = '<pre>' + escapeHtml(st.thinking) + '</pre>';
        tp.querySelector('.thinking-label').textContent = '추론 중... (' + st.thinking.length + '자)';
        el.appendChild(tp);
        st._panel = tp;
      }
      if (st.response) {
        removeLatestLogo();
        var res = appendStreamingBubble();
        res.bubble.innerHTML = renderMarkdown(st.response);
        st._wrap = res.wrap; st._bubble = res.bubble;
      } else {
        showLogoIndicator();
      }
      setHeaderChatTitle('···', true);
      scrollToBottom();
      return;
    }
    if (!data.messages || !data.messages.length) { showGreeting(); return; }
    data.messages.forEach(function(msg) {
      if (msg.role === 'system') return;
      appendMessage(msg.role, msg.content, false);
    });
    updateLatestLogo();
    scrollToBottom();
  } catch(e) { showToast('대화 로드 실패', 'error'); }
}

// ──────────────────────────────────────
// 로고 인디케이터
// ──────────────────────────────────────
function showLogoIndicator() {
  var el = document.getElementById('chat-messages');
  if (!el || document.getElementById('logo-indicator-wrap')) return null;
  document.getElementById('greeting-screen') && document.getElementById('greeting-screen').remove();

  var logoSrc = ((App.appInfo && App.appInfo.logo) || 'static/images/logo_color.png')
    .replace('logo_color', 'logo_mono');
  var emoji = (App.appInfo && App.appInfo.logo_emoji_fallback) || '🍨';

  var wrap = document.createElement('div');
  wrap.id = 'logo-indicator-wrap';
  wrap.className = 'message-wrap assistant';

  var inner = document.createElement('div');
  inner.className = 'logo-indicator-inner';

  var maskWrap = document.createElement('div');
  maskWrap.className = 'logo-anim-wrap';

  // 로고 존재 확인 후 그라데이션 orb 마스크 적용
  var testImg = new Image();
  testImg.onload = function() {
    var gradContainer = document.createElement('div');
    gradContainer.className = 'logo-gradient-mask';
    gradContainer.style.webkitMaskImage = 'url(/' + logoSrc + ')';
    gradContainer.style.maskImage       = 'url(/' + logoSrc + ')';
    for (var i = 1; i <= 5; i++) {
      var orb = document.createElement('div');
      orb.className = 'logo-orb logo-orb-' + i;
      gradContainer.appendChild(orb);
    }
    maskWrap.appendChild(gradContainer);
  };
  testImg.onerror = function() {
    var sp = document.createElement('span');
    sp.className = 'logo-emoji-anim';
    sp.textContent = emoji;
    maskWrap.appendChild(sp);
  };
  testImg.src = '/' + logoSrc;

  var label = document.createElement('span');
  label.id = 'indicator-label';
  label.className = 'indicator-label';
  label.textContent = '입력 생성 중...';

  inner.appendChild(maskWrap);
  inner.appendChild(label);
  wrap.appendChild(inner);
  el.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function removeLogoIndicator() {
  var wrap = document.getElementById('logo-indicator-wrap');
  if (!wrap) return;
  wrap.classList.add('fade-out');
  setTimeout(function() { if (wrap.parentNode) wrap.remove(); }, 350);
}

// ──────────────────────────────────────
// 추론 패널
// ──────────────────────────────────────
function createThinkingPanel() {
  var panel = document.createElement('div');
  panel.className = 'thinking-panel collapsed';
  panel.innerHTML =
    '<button class="thinking-toggle">' +
      '<span class="thinking-icon">💭</span>' +
      '<span class="thinking-label">추론 중...</span>' +
      '<span class="thinking-chevron">›</span>' +
    '</button>' +
    '<div class="thinking-content"></div>';
  panel.querySelector('.thinking-toggle').addEventListener('click', function() {
    panel.classList.toggle('collapsed');
    panel.querySelector('.thinking-chevron').textContent =
      panel.classList.contains('collapsed') ? '›' : '⌄';
  });
  return panel;
}

function finalizeThinkingPanel(panel, thinkText) {
  panel.querySelector('.thinking-label').textContent = '추론 과정 (' + thinkText.length + '자)';
  panel.querySelector('.thinking-content').innerHTML = '<pre>' + escapeHtml(thinkText) + '</pre>';
  panel.classList.remove('thinking-active');
}

// ──────────────────────────────────────
// 말풍선
// ──────────────────────────────────────
function makeActions(content, isAssistant) {
  var div = document.createElement('div');
  div.className = 'msg-actions';
  div.innerHTML =
    '<button class="msg-action-btn" title="복사">⎘</button>' +
    (isAssistant ? '<button class="msg-action-btn regen-btn" title="재생성">↺</button>' : '');
  var btns = div.querySelectorAll('.msg-action-btn');
  btns[0].addEventListener('click', function() {
    navigator.clipboard.writeText(content).then(function() { showToast('복사됨'); });
  });
  if (isAssistant && btns[1]) btns[1].addEventListener('click', regenerateLast);
  return div;
}

function appendMessage(role, content, animate) {
  if (animate === undefined) animate = true;
  var el = document.getElementById('chat-messages');
  document.getElementById('greeting-screen') && document.getElementById('greeting-screen').remove();
  if (role === 'assistant') removeLatestLogo();
  var wrap = document.createElement('div');
  wrap.className = 'message-wrap ' + role;

  // assistant는 항상 로고 슬롯 포함 (공간 고정)
  if (role === 'assistant') {
    var slot = document.createElement('div');
    slot.className = 'bubble-logo-slot';
    wrap.appendChild(slot);
  }

  var bubble = document.createElement('div');
  bubble.className = 'bubble ' + role;
  bubble.innerHTML = role === 'assistant' ? renderMarkdown(content) : '<p>' + escapeHtml(content) + '</p>';
  wrap.appendChild(bubble);
  wrap.appendChild(makeActions(content, role === 'assistant'));
  el.appendChild(wrap);
  if (role === 'assistant') updateLatestLogo();
  if (animate) scrollToBottom();
  return bubble;
}

function appendStreamingBubble() {
  var el = document.getElementById('chat-messages');
  document.getElementById('greeting-screen') && document.getElementById('greeting-screen').remove();
  removeLatestLogo();
  var wrap = document.createElement('div');
  wrap.className = 'message-wrap assistant';
  wrap.id = 'streaming-bubble';

  // 로고 슬롯 (항상 고정 공간 확보)
  var slot = document.createElement('div');
  slot.className = 'bubble-logo-slot';
  wrap.appendChild(slot);

  var bubble = document.createElement('div');
  bubble.className = 'bubble assistant';
  wrap.appendChild(bubble);
  el.appendChild(wrap);
  scrollToBottom();
  return { wrap: wrap, bubble: bubble };
}

// ──────────────────────────────────────
// 사이드바 제목 아이템 찾기
// ──────────────────────────────────────
function getSidebarItemSpan(sessionId) {
  var item = document.querySelector('.chat-item[data-session-id="' + sessionId + '"]');
  return item ? item.querySelector('span:not(.fav-icon)') : null;
}

// ──────────────────────────────────────
// 제목 폴링
// ──────────────────────────────────────
function startTitlePolling(sessionId, fallbackText) {
  if (titlePollTimer) clearInterval(titlePollTimer);
  var sp = getSidebarItemSpan(sessionId);
  if (sp) sp.textContent = '···';
  var count = 0;
  titlePollTimer = setInterval(async function() {
    count++;
    try {
      var updated = await api('GET', '/api/sessions/' + sessionId);
      if (updated.title && updated.title !== '새 대화') {
        clearInterval(titlePollTimer); titlePollTimer = null;
        if (String(currentSessionId) === String(sessionId)) setHeaderChatTitle(updated.title, false);
        var s = getSidebarItemSpan(sessionId);
        if (s) s.textContent = updated.title;
        document.dispatchEvent(new CustomEvent('chat:titled'));
        return;
      }
    } catch(e) {}
    if (count >= 60) {
      clearInterval(titlePollTimer); titlePollTimer = null;
      var fin = fallbackText.slice(0, 20);
      if (String(currentSessionId) === String(sessionId)) setHeaderChatTitle(fin, false);
      var s2 = getSidebarItemSpan(sessionId);
      if (s2) s2.textContent = fin;
      document.dispatchEvent(new CustomEvent('chat:titled'));
    }
  }, 1000);
}

// ──────────────────────────────────────
// 메시지 전송
// ──────────────────────────────────────
async function sendMessage(isRegenerate) {
  var input = document.getElementById('chat-input');
  var text  = input ? input.value.trim() : '';
  if (!text || isStreaming) return;
  var sessionId = await ensureSession();
  var isFirst   = (document.querySelectorAll('.message-wrap.user').length === 0);
  input.value = '';
  input.style.height = 'auto';
  removeLatestLogo();
  appendMessage('user', text);
  setStreamingMode(true);
  streamStateMap[sessionId] = { thinking:'', response:'', thinkDone:false, done:false };
  var st = streamStateMap[sessionId];
  showLogoIndicator();
  abortController = new AbortController();
  var inThinking=false, thinkPanel=null, streamBubble=null, streamWrap=null, rawBuffer='';

  try {
    var resp = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ session_id: sessionId, message: text, is_regenerate: !!isRegenerate }),
      signal: abortController.signal,
    });
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var lineBuf = '';
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      lineBuf += decoder.decode(r.value, { stream: true });
      var lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        var data; try { data = JSON.parse(line.slice(6)); } catch(e) { continue; }
        if (data.type === 'chunk') {
          rawBuffer += data.content;
          var isActive = String(currentSessionId) === String(sessionId);
          processBuffer(isActive);
        } else if (data.type === 'done') {
          if (rawBuffer) {
            var ia = String(currentSessionId) === String(sessionId);
            if (inThinking) { st.thinking += rawBuffer; rawBuffer=''; finalizeThinkingPanel(thinkPanel, st.thinking); inThinking=false; st.thinkDone=true; }
            else { flushResponse(rawBuffer, ia); rawBuffer=''; }
          }
          st.done = true;
          removeLogoIndicator();
          if (streamBubble) streamBubble.innerHTML = renderMarkdown(st.response);
          if (streamWrap) {
            streamWrap.removeAttribute('id');
            streamWrap.appendChild(makeActions(st.response, true));
            updateLatestLogo();
          }
          if (isFirst) startTitlePolling(sessionId, text);
        } else if (data.type === 'error') {
          st.done = true;
          removeLogoIndicator();
          var errMsg = '오류: ' + escapeHtml(data.message || '알 수 없는 오류');
          if (streamBubble) { streamBubble.innerHTML = '<span style="color:var(--danger)">' + errMsg + '</span>'; updateLatestLogo(); }
          else appendMessage('assistant', data.message || '오류');
        }
      }
    }
  } catch(e) {
    st.done = true;
    removeLogoIndicator();
    // 추론 중이던 패널 강제 종료
    if (thinkPanel) finalizeThinkingPanel(thinkPanel, st.thinking || '(중단됨)');
    if (e.name === 'AbortError') {
      if (streamBubble) {
        streamBubble.innerHTML = renderMarkdown(st.response || '');
        streamWrap && streamWrap.removeAttribute('id');
        streamWrap && streamWrap.appendChild(makeActions(st.response, true));
        updateLatestLogo();
      } else {
        appendMessage('assistant', '_(응답이 중단되었습니다)_');
        updateLatestLogo();
      }
    } else {
      if (streamBubble) {
        streamBubble.innerHTML = '<span style="color:var(--danger)">연결 오류가 발생했습니다.</span>';
        updateLatestLogo();
      } else {
        appendMessage('assistant', '연결 오류가 발생했습니다.');
        updateLatestLogo();
      }
    }
  } finally { setStreamingMode(false); scrollToBottom(); }

  function processBuffer(isActive) {
    while (true) {
      if (!inThinking) {
        var si = rawBuffer.indexOf('<think>');
        if (si === -1) { if (rawBuffer) { flushResponse(rawBuffer, isActive); rawBuffer=''; } break; }
        if (si > 0) flushResponse(rawBuffer.slice(0, si), isActive);
        rawBuffer = rawBuffer.slice(si + 7); inThinking = true;
        if (!thinkPanel && isActive) {
          thinkPanel = createThinkingPanel();
          thinkPanel.classList.add('thinking-active');
          var ind = document.getElementById('logo-indicator-wrap');
          var msgs = document.getElementById('chat-messages');
          if (ind) ind.before(thinkPanel);
          else if (msgs) msgs.appendChild(thinkPanel);
          st._panel = thinkPanel;
          var lbl = document.getElementById('indicator-label');
          if (lbl) lbl.remove();
        }
      }
      if (inThinking) {
        var ei = rawBuffer.indexOf('</think>');
        if (ei === -1) {
          st.thinking += rawBuffer; rawBuffer = '';
          if (thinkPanel && isActive) {
            thinkPanel.querySelector('.thinking-content').innerHTML = '<pre>' + escapeHtml(st.thinking) + '</pre>';
            thinkPanel.querySelector('.thinking-label').textContent = '추론 중... (' + st.thinking.length + '자)';
          }
          break;
        }
        st.thinking += rawBuffer.slice(0, ei);
        rawBuffer = rawBuffer.slice(ei + 8);
        inThinking = false; st.thinkDone = true;
        if (thinkPanel && isActive) finalizeThinkingPanel(thinkPanel, st.thinking);
      }
    }
  }

  function flushResponse(chunk, isActive) {
    if (!chunk) return;
    st.response += chunk;
    if (!isActive) return;
    if (!streamBubble) {
      removeLogoIndicator();
      var res = appendStreamingBubble();
      streamWrap = res.wrap; streamBubble = res.bubble;
      st._wrap = streamWrap; st._bubble = streamBubble;
      // 인디케이터 제거 즉시 버블 로고 표시
      updateLatestLogo();
    }
    streamBubble.innerHTML = renderMarkdown(st.response);
    scrollToBottom();
  }
}

// ──────────────────────────────────────
// 재생성
// ──────────────────────────────────────
async function regenerateLast() {
  var uWraps = document.querySelectorAll('.message-wrap.user');
  if (!uWraps.length) return;
  var lastText = uWraps[uWraps.length-1].querySelector('.bubble');
  lastText = lastText ? lastText.textContent.trim() : '';
  if (!lastText) return;
  var aWraps = document.querySelectorAll('.message-wrap.assistant');
  if (aWraps.length) aWraps[aWraps.length-1].remove();
  var tPanels = document.querySelectorAll('.thinking-panel');
  if (tPanels.length) tPanels[tPanels.length-1].remove();
  uWraps[uWraps.length-1].remove();
  removeLatestLogo();
  document.getElementById('chat-input').value = lastText;
  await sendMessage(true); // isRegenerate=true
}

function setStreamingMode(active) {
  isStreaming = active;
  var send      = document.getElementById('send-btn');
  var stop      = document.getElementById('stop-btn');
  var inp       = document.getElementById('chat-input');
  var attachBtn = document.getElementById('attach-btn');
  var fileInput = document.getElementById('file-input');

  if (send) send.style.display = active ? 'none' : 'flex';
  if (stop) stop.style.display = active ? 'flex' : 'none';
  if (inp) {
    inp.disabled = active;
    inp.placeholder = active
      ? '응답 생성 중... (완료 후 입력 가능합니다)'
      : '메시지를 입력하세요...';
  }
  if (attachBtn) {
    attachBtn.style.opacity       = active ? '0.35' : '1';
    attachBtn.style.pointerEvents = active ? 'none'  : 'auto';
    attachBtn.style.cursor        = active ? 'not-allowed' : 'pointer';
  }
  if (fileInput) fileInput.disabled = active;
}

function setupInputEvents() {
  var input = document.getElementById('chat-input');
  var send  = document.getElementById('send-btn');
  var stop  = document.getElementById('stop-btn');
  if (input) {
    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }
  if (send) send.addEventListener('click', sendMessage);
  if (stop) stop.addEventListener('click', function() { if (abortController) abortController.abort(); });
}

function scrollToBottom() {
  var el = document.getElementById('chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// ──────────────────────────────────────
// CSS
// ──────────────────────────────────────
var chatCSS =
'#page-chat.active{display:flex;flex-direction:column;height:100%;overflow:hidden;}' +
'#chat-messages{flex:1;overflow-y:auto;padding:24px 20px 8px;display:flex;flex-direction:column;gap:0;}' +

/* Greeting */
'#greeting-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:16px;padding:40px 16px;}' +
'#greeting-text{font-size:18px;font-weight:500;color:var(--text-primary);text-align:center;}' +
'#suggested-cards{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:4px;}' +
'.suggest-card{padding:8px 16px;border:1px solid var(--border);border-radius:var(--radius-full);background:var(--bg-tertiary);color:var(--text-secondary);font-size:var(--font-size-sm);cursor:pointer;transition:all 0.15s;}' +
'.suggest-card:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim);}' +

/* 헤더 제목 */
'#header-title-sep{color:var(--text-muted);margin:0 6px;font-size:var(--font-size-sm);display:none;}' +
'#header-chat-title{font-size:var(--font-size-sm);color:var(--text-secondary);font-weight:400;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;}' +
'#header-fav-btn{display:none;align-items:center;justify-content:center;margin-left:6px;padding:2px 4px;background:none;border:none;cursor:pointer;font-size:14px;opacity:0.6;transition:opacity 0.15s;}' +
'#header-fav-btn:hover{opacity:1;}' +
'.title-loading{color:var(--text-muted);animation:title-blink 0.9s ease-in-out infinite;letter-spacing:3px;}' +
'@keyframes title-blink{0%,100%{opacity:1;}50%{opacity:0.2;}}' +

/* 말풍선 래퍼 */
'.message-wrap{display:flex;flex-direction:row;align-items:flex-start;max-width:760px;position:relative;gap:0;padding-bottom:32px;}' +
'.message-wrap.user{align-self:flex-end;flex-direction:row-reverse;}' +
'.message-wrap.assistant{align-self:flex-start;}' +

/* 로고 슬롯 — 항상 고정 너비, 내용 유무와 무관 */
'.bubble-logo-slot{flex-shrink:0;width:34px;display:flex;align-items:flex-start;padding-top:6px;justify-content:center;}' +
'.bubble-logo-img{width:22px;height:22px;object-fit:contain;opacity:0.8;}' +
'.bubble-logo-emoji{font-size:16px;line-height:1;opacity:0.75;}' +

/* 말풍선 */
'.bubble{padding:10px 14px;border-radius:var(--radius-lg);font-size:var(--font-size-md);line-height:1.65;word-break:break-word;min-width:0;flex:1;}' +
'.bubble p{margin:0 0 6px;}.bubble p:last-child{margin-bottom:0;}' +
'.bubble h1,.bubble h2,.bubble h3{margin:8px 0 4px;font-weight:600;}' +
'.bubble ul{padding-left:18px;}' +
'.bubble pre{background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px;overflow-x:auto;font-family:var(--font-mono);font-size:var(--font-size-sm);margin:6px 0;}' +
'.bubble code{font-family:var(--font-mono);font-size:0.9em;background:var(--bg-tertiary);padding:1px 4px;border-radius:3px;}' +
'.bubble pre code{background:none;padding:0;}' +
'.bubble.user{background:var(--accent-dim);border:1px solid rgba(232,201,122,0.2);color:var(--text-primary);max-width:580px;}' +
'.bubble.assistant{background:var(--bg-secondary);border:1px solid var(--border-subtle);color:var(--text-primary);}' +

/* 액션 버튼 — absolute, 레이아웃 영향 없음 */
'.msg-actions{' +
  'position:absolute;' +
  'bottom:4px;left:34px;' +
  'display:flex;gap:4px;' +
  'opacity:0;pointer-events:none;' +
  'transition:opacity 0.15s;' +
  'z-index:10;' +
'}' +
'.message-wrap.user .msg-actions{left:auto;right:0;}' +
'.message-wrap:hover .msg-actions{opacity:1;pointer-events:auto;}' +
'.msg-action-btn{padding:3px 8px;border-radius:var(--radius-sm);background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-muted);font-size:var(--font-size-xs);cursor:pointer;transition:all 0.15s;white-space:nowrap;}' +
'.msg-action-btn:hover{color:var(--text-primary);border-color:var(--accent);}' +

/* 로고 인디케이터 */
'#logo-indicator-wrap{align-self:flex-start;margin:4px 0;flex-direction:row !important;}' +
'.logo-indicator-inner{display:flex;align-items:center;gap:10px;}' +
'.logo-anim-wrap{flex-shrink:0;width:34px;height:34px;display:flex;align-items:center;justify-content:center;}' +

/* 그라데이션 마스크 컨테이너 */
'.logo-gradient-mask{' +
  'width:22px;height:22px;position:relative;overflow:hidden;' +
  '-webkit-mask-size:contain;mask-size:contain;' +
  '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;' +
  '-webkit-mask-position:center;mask-position:center;' +
  'animation:logo-appear 0.5s ease forwards;opacity:0;' +
'}' +
'@keyframes logo-appear{from{opacity:0;transform:scale(0.8);}to{opacity:1;transform:scale(1);}}' +

/* orb 공통 */
'.logo-orb{position:absolute;border-radius:50%;mix-blend-mode:hard-light;opacity:0.9;}' +

/* orb 1 — vanilla gold */
'.logo-orb-1{' +
  'width:120%;height:120%;top:-10%;left:-10%;' +
  'background:radial-gradient(circle at center,rgba(232,201,122,0.9) 0,rgba(232,201,122,0) 60%) no-repeat;' +
  'animation:orb-vertical 6s ease infinite;' +
'}' +
'.logo-orb-2{' +
  'width:140%;height:140%;top:-20%;left:-20%;' +
  'background:radial-gradient(circle at center,rgba(245,140,149,0.85) 0,rgba(245,140,149,0) 55%) no-repeat;' +
  'animation:orb-circle 8s ease infinite;transform-origin:calc(50% - 20px) calc(50%);' +
'}' +
'.logo-orb-3{' +
  'width:130%;height:130%;top:-15%;left:-15%;' +
  'background:radial-gradient(circle at center,rgba(100,220,185,0.8) 0,rgba(100,220,185,0) 50%) no-repeat;' +
  'animation:orb-horizontal 7s ease infinite;' +
'}' +
'.logo-orb-4{' +
  'width:150%;height:150%;top:-25%;left:-25%;' +
  'background:radial-gradient(circle at center,rgba(190,120,240,0.75) 0,rgba(190,120,240,0) 50%) no-repeat;' +
  'animation:orb-circle 10s ease infinite reverse;transform-origin:calc(50% + 15px) calc(50% - 10px);' +
'}' +
'.logo-orb-5{' +
  'width:120%;height:120%;top:-10%;left:-10%;' +
  'background:radial-gradient(circle at center,rgba(255,165,100,0.7) 0,rgba(255,165,100,0) 55%) no-repeat;' +
  'animation:orb-vertical 9s ease infinite reverse;' +
'}' +

'@keyframes orb-vertical{' +
  '0%{transform:translateY(-30%);}' +
  '50%{transform:translateY(30%);}' +
  '100%{transform:translateY(-30%);}' +
'}' +
'@keyframes orb-horizontal{' +
  '0%{transform:translateX(-30%);}' +
  '50%{transform:translateX(30%);}' +
  '100%{transform:translateX(-30%);}' +
'}' +
'@keyframes orb-circle{' +
  '0%{transform:rotate(0deg);}' +
  '100%{transform:rotate(360deg);}' +
'}' +

'.logo-emoji-anim{font-size:22px;animation:logo-appear 0.5s ease forwards,logo-pulse 1.8s ease-in-out 0.5s infinite;opacity:0;}' +
'@keyframes logo-pulse{0%,100%{opacity:0.9;}50%{opacity:0.3;}}' +
'#logo-indicator-wrap.fade-out{animation:fadeout 0.35s ease forwards;}' +
'@keyframes fadeout{to{opacity:0;transform:scale(0.85);}}' +
'.indicator-label{font-size:var(--font-size-sm);color:var(--text-muted);animation:label-pulse 1.4s ease-in-out infinite;}' +
'@keyframes label-pulse{0%,100%{opacity:0.8;}50%{opacity:0.3;}}' +

/* 추론 패널 */
'.thinking-panel{' +
  'width:100%;max-width:760px;' +
  'align-self:flex-start;' +
  'border:none;background:none;' +
  'margin:0 0 8px 34px;' +
  'box-sizing:border-box;' +
'}' +
'.thinking-toggle{display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;color:var(--text-muted);font-size:var(--font-size-xs);background:none;border:none;text-align:left;}' +
'.thinking-toggle:hover{color:var(--text-secondary);}' +
'.thinking-icon{font-size:12px;flex-shrink:0;}' +
'.thinking-label{font-weight:500;}' +
'.thinking-chevron{font-size:14px;color:var(--text-muted);transition:transform 0.2s;display:inline-block;margin-left:2px;}' +
'.thinking-panel:not(.collapsed) .thinking-chevron{transform:rotate(90deg);}' +
'.thinking-panel.thinking-active .thinking-icon{animation:think-pulse 1.2s ease-in-out infinite;}' +
'@keyframes think-pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}' +
'.thinking-content{' +
  'height:0;overflow:hidden;' +
  'transition:height 0.25s ease;' +
'}' +
'.thinking-panel:not(.collapsed) .thinking-content{' +
  'height:auto;max-height:280px;overflow-y:auto;' +
'}' +
'.thinking-content pre{' +
  'margin:6px 0 0;padding:0;' +
  'font-family:var(--font-mono);' +
  'font-size:var(--font-size-xs);' +
  'color:var(--text-muted);' +
  'white-space:pre-wrap;word-break:break-word;line-height:1.6;' +
  'background:none;border:none;' +
'}' +

/* 파일 첨부 칩 */
'#chat-attachments{display:flex;flex-wrap:wrap;gap:6px;padding:0 4px 6px;}' +
'.attach-chip{display:flex;align-items:center;gap:4px;padding:4px 8px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-full);font-size:var(--font-size-xs);color:var(--text-secondary);}' +
'.chip-icon{font-size:13px;}' +
'.chip-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.chip-remove{background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0 2px;line-height:1;}' +
'.chip-remove:hover{color:var(--danger);}' +

/* RAG 출처 */
'.rag-sources{margin-top:6px;margin-left:34px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;}' +
'.sources-label{font-size:var(--font-size-xs);color:var(--text-muted);font-weight:500;}' +
'.source-item{font-size:var(--font-size-xs);color:var(--text-muted);background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:default;}' +
'.source-item:hover{color:var(--text-secondary);}' +
'#chat-input-area{padding:8px 16px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-primary);flex-shrink:0;}' +
'#chat-input-row{display:flex;align-items:flex-end;gap:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-xl);padding:8px 12px;transition:border-color 0.15s;}' +
'#chat-input-row:focus-within{border-color:var(--accent);}' +
'#attach-btn{cursor:pointer;font-size:18px;color:var(--text-muted);padding:2px;flex-shrink:0;transition:color 0.15s;}' +
'#attach-btn:hover{color:var(--accent);}' +
'#chat-input{flex:1;background:none;border:none;outline:none;color:var(--text-primary);font-size:var(--font-size-md);resize:none;min-height:24px;max-height:160px;line-height:1.5;}' +
'#chat-input::placeholder{color:var(--text-muted);}' +
'#chat-input:disabled{opacity:0.5;}' +
'#send-btn,#stop-btn{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;transition:all 0.15s;}' +
'#send-btn{background:var(--accent);color:var(--bg-primary);}' +
'#send-btn:hover{background:var(--accent-hover);}' +
'#stop-btn{background:var(--danger-dim);color:var(--danger);border:1px solid var(--danger);}';

var _chatStyle = document.createElement('style');
_chatStyle.textContent = chatCSS;
document.head.appendChild(_chatStyle);

// ──────────────────────────────────────
// 이벤트
// ──────────────────────────────────────
onReady(function() {
  renderChatPage();
  initNewChat();
});
document.addEventListener('chat:new',  function() { initNewChat(); });
document.addEventListener('chat:load', function(e) { loadSession(e.detail.sessionId); });