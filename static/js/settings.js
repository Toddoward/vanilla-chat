/**
 * static/js/settings.js
 * Settings UI — 좌측 메뉴 + 우측 스크롤, 즉시 자동 저장
 */
import { api } from './app.js';
import { onReady, showToast } from './utils.js';
import { icon } from './icons.js';

// ──────────────────────────────────────
// 상태
// ──────────────────────────────────────
let _config = {};
let _models  = [];
let _saveTimers = {};  // path별 독립 타이머
let _promptTimer = null;

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────
onReady(() => renderSettingsPage());

document.addEventListener('page:enter', ({ detail }) => {
  if (detail.page !== 'settings') return;
  if (!document.getElementById('st-layout')) renderSettingsPage();
  loadSettings();
});

// ──────────────────────────────────────
// 레이아웃 렌더링 (1회)
// ──────────────────────────────────────
function renderSettingsPage() {
  const page = document.getElementById('page-settings');
  if (!page) return;

  const menus = [
    { id: 'sec-models',    icon: '<i class="bi bi-cpu"></i>',             label: '모델' },
    { id: 'sec-inference', icon: '<i class="bi bi-brain"></i>',           label: '추론 파라미터' },
    { id: 'sec-context',   icon: '<i class="bi bi-hdd"></i>',             label: '컨텍스트' },
    { id: 'sec-rag',       icon: '<i class="bi bi-book"></i>',            label: 'RAG' },
    { id: 'sec-prompt',    icon: '<i class="bi bi-chat-square-text"></i>', label: '시스템 프롬프트' },
    { id: 'sec-app',       icon: '<i class="bi bi-palette"></i>',         label: '앱 외관' },
    { id: 'sec-ext',       icon: '<i class="bi bi-link-45deg"></i>',      label: '확장' },
  ];

  page.innerHTML =
    '<div id="st-layout">' +
      '<nav id="st-nav">' +
        menus.map(m =>
          `<button class="st-nav-btn" data-target="${m.id}">` +
            `<span class="st-nav-icon">${m.icon}</span>` +
            `<span class="st-nav-label">${m.label}</span>` +
          `</button>`
        ).join('') +
      '</nav>' +
      '<div id="st-body">' +
        menus.map(m =>
          `<section class="st-section" id="${m.id}">` +
            `<h3 class="st-section-title">${m.icon} ${m.label}</h3>` +
            `<div class="st-section-content" id="${m.id}-content">` +
              `<div class="st-loading">불러오는 중...</div>` +
            `</div>` +
          `</section>`
        ).join('') +
      '</div>' +
    '</div>';

  // 아이콘 주입
  page.querySelectorAll('[data-section]').forEach(el => {
    const icon = SECTION_ICONS[el.dataset.section];
    if (icon) el.appendChild(createIcon(icon, 16));
  });

  // 좌측 메뉴 클릭 → 해당 섹션 스크롤
  page.querySelectorAll('.st-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // 우측 스크롤 → 좌측 하이라이트 연동
  const body = document.getElementById('st-body');
  if (body) {
    body.addEventListener('scroll', () => {
      const sections = body.querySelectorAll('.st-section');
      let activeId = null;
      sections.forEach(sec => {
        if (sec.offsetTop - body.scrollTop <= 60) activeId = sec.id;
      });
      page.querySelectorAll('.st-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.target === activeId);
      });
    });
  }

  // st-layout 폭 감지 → st-nav 축소/복원
  const layout = document.getElementById('st-layout');
  if (layout && window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      const nav = document.getElementById('st-nav');
      if (!nav) return;
      const width = entries[0].contentRect.width;
      nav.classList.toggle('st-nav-collapsed', width < 500);
    });
    ro.observe(layout);
  }
}

// ──────────────────────────────────────
// 설정 로드
// ──────────────────────────────────────
async function loadSettings() {
  try {
    [_config, { models: _models }] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/api/models'),
    ]);
    renderModelsSection();
    renderInferenceSection();
    renderContextSection();
    renderRagSection();
    renderPromptSection();
    renderAppSection();
    renderExtSection();
  } catch (e) {
    showToast('설정 로드 실패', 'error');
  }
}

// ──────────────────────────────────────
// 즉시 저장 (debounce 600ms)
// ──────────────────────────────────────
function scheduleSave(path, value, onSaved = null) {
  const update = setNestedValue({}, path, value);
  clearTimeout(_saveTimers[path]);
  _saveTimers[path] = setTimeout(async () => {
    try {
      await api('PATCH', '/api/config', update);
      setNestedValue(_config, path, value);
      if (onSaved) onSaved();
    } catch (e) {
      showToast('저장 실패', 'error');
    }
  }, 600);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ──────────────────────────────────────
// 유틸 — 컨트롤 빌더
// ──────────────────────────────────────
function makeSelect(id, options, current, onChange) {
  const sel = document.createElement('select');
  sel.id = id;
  sel.className = 'st-select';
  options.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === current) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    const result = onChange(sel.value);
    if (result instanceof Promise) result.catch(() => showToast('오류 발생', 'error'));
  });
  return sel;
}

function makeSlider(id, min, max, step, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'st-slider-wrap';
  const input = document.createElement('input');
  input.type = 'range'; input.id = id;
  input.min = min; input.max = max; input.step = step;
  input.value = value; input.className = 'st-slider';
  const display = document.createElement('span');
  display.className = 'st-slider-val';
  display.textContent = value;
  input.addEventListener('input', () => {
    display.textContent = input.value;
    onChange(parseFloat(input.value));
  });
  wrap.append(input, display);
  return wrap;
}

function makeNumberInput(id, value, min, max, onChange) {
  const input = document.createElement('input');
  input.type = 'number'; input.id = id;
  input.value = value; input.min = min; input.max = max;
  input.className = 'st-number';
  input.addEventListener('change', () => onChange(parseInt(input.value)));
  return input;
}

function makeToggle(id, checked, disabled, onChange) {
  const label = document.createElement('label');
  label.className = 'st-toggle' + (disabled ? ' disabled' : '');
  const input = document.createElement('input');
  input.type = 'checkbox'; input.id = id;
  input.checked = checked; input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const track = document.createElement('span');
  track.className = 'st-toggle-track';
  label.append(input, track);
  return label;
}

function makeRow(label, desc, control) {
  const row = document.createElement('div');
  row.className = 'st-row';
  const info = document.createElement('div');
  info.className = 'st-row-info';
  const lbl = document.createElement('span');
  lbl.className = 'st-label'; lbl.textContent = label;
  info.appendChild(lbl);
  if (desc) {
    const d = document.createElement('span');
    d.className = 'st-desc'; d.textContent = desc;
    info.appendChild(d);
  }
  row.append(info, control);
  return row;
}

// ──────────────────────────────────────
// 6-B2: 🤖 모델 섹션
// ──────────────────────────────────────
async function renderModelsSection() {
  const el = document.getElementById('sec-models-content');
  if (!el) return;
  el.innerHTML = '';

  const modelNames = _models.map(m => m.name || m);
  const modCfg = _config.models || {};

  const slots = [
    { key: 'response',  label: '응답 모델',   desc: '텍스트 생성에 사용' },
    { key: 'vision',    label: '시각 모델',   desc: 'response와 동일하면 인스턴스 공유' },
    { key: 'embedding', label: '임베딩 모델', desc: 'BGE-M3 권장' },
    { key: 'reranker',  label: '리랭커 모델', desc: 'BGE-Reranker-v2-M3 권장 (FlagEmbedding)' },
  ];

  for (const slot of slots) {
    const current = modCfg[slot.key] || '';
    const sel = makeSelect(
      `st-model-${slot.key}`,
      modelNames,
      current,
      async (val) => {
        scheduleSave(`models.${slot.key}`, val, () => {
          showModelChangeNotice();
        });
        if (slot.key === 'response') {
          await updateVisionHint(val);
        }
      }
    );
    el.appendChild(makeRow(slot.label, slot.desc, sel));
  }

  // 현재 response 모델 capabilities 표시
  const capBadge = document.createElement('div');
  capBadge.id = 'st-cap-badge';
  capBadge.className = 'st-cap-badge';
  el.appendChild(capBadge);
  await updateVisionHint(modCfg.response || '');
}

async function updateVisionHint(modelName) {
  const badge = document.getElementById('st-cap-badge');
  if (!badge || !modelName) return;
  badge.innerHTML = '<i class="bi bi-clock"></i> capabilities 확인 중...';
  try {
    const caps = await api('GET', `/api/models/capabilities?model=${encodeURIComponent(modelName)}`);
    const tags = [];
    if (caps.thinking) tags.push('<i class="bi bi-brain"></i> thinking');
    if (caps.vision)   tags.push('<i class="bi bi-eye"></i> vision');
    if (caps.tools)    tags.push('<i class="bi bi-tools"></i> tools');
    badge.innerHTML = tags.length
      ? `${modelName}: ${tags.join(' · ')}`
      : `${modelName}: completion only`;

    // thinking 지원 여부에 따라 추론 섹션 think 토글 상태 업데이트
    updateThinkToggleState(caps.thinking);

    // vision 지원 시 vision 슬롯에 동일 모델 자동 제안
    if (caps.vision) {
      const visSel = document.getElementById('st-model-vision');
      if (visSel && visSel.value !== modelName) {
        const hint = document.createElement('p');
        hint.className = 'st-hint';
        hint.innerHTML = `<i class="bi bi-lightbulb"></i> ${modelName}이 vision을 지원합니다. 시각 모델을 동일하게 설정하면 인스턴스를 공유합니다.`;
        hint.id = 'st-vision-hint';
        const old = document.getElementById('st-vision-hint');
        if (old) old.remove();
        document.getElementById('sec-models-content')?.appendChild(hint);
      }
    }
  } catch {
    badge.textContent = 'capabilities 조회 실패';
  }
}

function showModelChangeNotice() {
  document.dispatchEvent(new CustomEvent('model:changed'));
  const el = document.getElementById('sec-models-content');
  if (!el) return;
  let notice = document.getElementById('st-model-notice');
  if (!notice) {
    notice = document.createElement('p');
    notice.id = 'st-model-notice';
    notice.className = 'st-notice';
    el.appendChild(notice);
  }
  notice.innerHTML = '<i class="bi bi-exclamation-triangle"></i> 모델 변경은 새 채팅부터 적용됩니다.';
  clearTimeout(notice._timer);
  notice._timer = setTimeout(() => notice.remove(), 5000);
}

// ──────────────────────────────────────
// 6-B3: 🧠 추론 파라미터 섹션
// ──────────────────────────────────────
async function renderInferenceSection() {
  const el = document.getElementById('sec-inference-content');
  if (!el) return;
  el.innerHTML = '';

  const inf = _config.inference || {};

  // think 토글 (capabilities 기반 활성/비활성)
  let thinkCaps = false;
  try {
    const model = _config.models?.response || '';
    if (model) {
      const caps = await api('GET', `/api/models/capabilities?model=${encodeURIComponent(model)}`);
      thinkCaps = caps.thinking;
    }
  } catch {}

  const thinkToggle = makeToggle(
    'st-think',
    !!inf.think && thinkCaps,
    !thinkCaps,
    (val) => scheduleSave('inference.think', val)
  );
  el.appendChild(makeRow(
    'Thinking Mode',
    thinkCaps ? 'Qwen3 등 thinking 지원 모델에서 활성화 가능' : '현재 모델이 thinking을 지원하지 않습니다',
    thinkToggle
  ));

  // temperature
  el.appendChild(makeRow(
    'Temperature',
    '생성 다양성 (Qwen3 권장: 0.6)',
    makeSlider('st-temperature', 0, 2, 0.05, inf.temperature ?? 0.6,
      (v) => scheduleSave('inference.temperature', v))
  ));

  // num_predict
  el.appendChild(makeRow(
    'Max Tokens',
    '최대 생성 토큰 수 (thinking 포함)',
    makeNumberInput('st-num-predict', inf.num_predict ?? 2048, 128, 32768,
      (v) => scheduleSave('inference.num_predict', v))
  ));

  // top_p
  el.appendChild(makeRow(
    'Top P',
    '누적 확률 기반 샘플링',
    makeSlider('st-top-p', 0, 1, 0.01, inf.top_p ?? 0.9,
      (v) => scheduleSave('inference.top_p', v))
  ));

  // repeat_penalty
  el.appendChild(makeRow(
    'Repeat Penalty',
    '반복 억제 (1.0 = 없음)',
    makeSlider('st-repeat-penalty', 1, 2, 0.01, inf.repeat_penalty ?? 1.1,
      (v) => scheduleSave('inference.repeat_penalty', v))
  ));
}

function updateThinkToggleState(thinkingSupported) {
  const toggle = document.getElementById('st-think');
  if (!toggle) return;
  toggle.disabled = !thinkingSupported;
  const label = toggle.closest('.st-toggle');
  if (label) label.classList.toggle('disabled', !thinkingSupported);
  // 지원 안 하면 강제 off
  if (!thinkingSupported && toggle.checked) {
    toggle.checked = false;
    scheduleSave('inference.think', false);
  }
  // 설명 텍스트 업데이트
  const desc = toggle.closest('.st-row')?.querySelector('.st-desc');
  if (desc) {
    desc.textContent = thinkingSupported
      ? 'Thinking 지원 모델 — 활성화 가능'
      : '현재 모델이 thinking을 지원하지 않습니다';
  }
}

// ──────────────────────────────────────
// 6-C1: 💾 컨텍스트 섹션
// ──────────────────────────────────────
function renderContextSection() {
  const el = document.getElementById('sec-context-content');
  if (!el) return;
  el.innerHTML = '';
  const ctx = _config.context || {};

  el.appendChild(makeRow(
    '사용자 입력 비율',
    '전체 컨텍스트 중 사용자 입력에 할당할 비율',
    makeSlider('st-user-input-ratio', 0.05, 0.5, 0.05,
      ctx.user_input_ratio ?? 0.2,
      (v) => scheduleSave('context.user_input_ratio', v))
  ));

  el.appendChild(makeRow(
    '요약 트리거',
    '컨텍스트 사용량이 이 비율에 도달하면 백그라운드 요약 실행',
    makeSlider('st-summary-trigger', 0.5, 0.95, 0.05,
      ctx.summary_trigger ?? 0.8,
      (v) => scheduleSave('context.summary_trigger', v))
  ));
}

// ──────────────────────────────────────
// 6-C1: 📚 RAG + 파일 섹션
// ──────────────────────────────────────
function renderRagSection() {
  const el = document.getElementById('sec-rag-content');
  if (!el) return;
  el.innerHTML = '';
  const rag = _config.rag || {};
  const fl  = _config.file_links || {};

  el.appendChild(makeRow(
    'Chunk Size',
    '파일 청킹 크기 (토큰 수)',
    makeNumberInput('st-chunk-size', rag.chunk_size ?? 512, 128, 2048,
      (v) => scheduleSave('rag.chunk_size', v))
  ));

  el.appendChild(makeRow(
    'Chunk Overlap',
    '청크 간 겹침 토큰 수',
    makeNumberInput('st-chunk-overlap', rag.chunk_overlap ?? 64, 0, 512,
      (v) => scheduleSave('rag.chunk_overlap', v))
  ));

  el.appendChild(makeRow(
    'Top K',
    'RAG 검색 결과 상위 개수',
    makeNumberInput('st-top-k', rag.top_k ?? 5, 1, 20,
      (v) => scheduleSave('rag.top_k', v))
  ));

  el.appendChild(makeRow(
    '파일 경로 검증 주기',
    '등록된 파일 경로 유효성 백그라운드 확인 주기 (분)',
    makeNumberInput('st-verify-interval', fl.verify_interval_minutes ?? 10, 1, 1440,
      (v) => scheduleSave('file_links.verify_interval_minutes', v))
  ));
}

// ──────────────────────────────────────
// 6-C2: 💬 시스템 프롬프트 섹션
// ──────────────────────────────────────
function renderPromptSection() {
  const el = document.getElementById('sec-prompt-content');
  if (!el) return;
  el.innerHTML = '';

  // $(name) 안내
  const hint = document.createElement('div');
  hint.className = 'st-hint';
  hint.textContent = '$(name) 플레이스홀더를 사용하면 앱 이름이 자동으로 치환됩니다.';
  el.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.id = 'st-system-prompt';
  textarea.className = 'st-textarea';
  textarea.value = _config.system_prompt || '';
  textarea.rows = 16;

  textarea.addEventListener('input', () => {
    clearTimeout(_promptTimer);
    _promptTimer = setTimeout(async () => {
      try {
        await api('PATCH', '/api/config', { system_prompt: textarea.value });
        setNestedValue(_config, 'system_prompt', textarea.value);
        showToast('시스템 프롬프트 저장됨', 'success');
      } catch {
        showToast('저장 실패', 'error');
      }
    }, 1000);
  });

  el.appendChild(textarea);
}

// ──────────────────────────────────────
// 6-C3: 🎨 앱 외관 섹션
// ──────────────────────────────────────
// 6-C3: 🎨 앱 외관 섹션
// ──────────────────────────────────────
function renderAppSection() {
  const el = document.getElementById('sec-app-content');
  if (!el) return;
  el.innerHTML = '';
  const appCfg = _config.app || {};

  // 앱 이름
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'st-app-name';
  nameInput.className = 'st-text-input';
  nameInput.value = appCfg.name || 'Vanilla Chat';
  nameInput.placeholder = 'Vanilla Chat';
  nameInput.addEventListener('input', () => {
    scheduleSave('app.name', nameInput.value, () => {
      document.title = nameInput.value;
      const nameEl = document.getElementById('app-name');
      if (nameEl) nameEl.textContent = nameInput.value;
    });
  });
  el.appendChild(makeRow('앱 이름', '헤더, 탭 제목, 시스템 프롬프트 $(name)에 반영', nameInput));

  // 이모지 폴백
  const emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.id = 'st-logo-emoji';
  emojiInput.className = 'st-text-input';
  emojiInput.style.width = '60px';
  emojiInput.value = appCfg.logo_emoji_fallback || '🍨';
  emojiInput.addEventListener('input', () =>
    scheduleSave('app.logo_emoji_fallback', emojiInput.value)
  );
  el.appendChild(makeRow('로고 이모지 폴백', '로고 이미지 없을 때 표시', emojiInput));
}

// ──────────────────────────────────────
// 6-C4: 🔗 확장 섹션
// ──────────────────────────────────────
function renderExtSection() {
  const el = document.getElementById('sec-ext-content');
  if (!el) return;
  el.innerHTML = '';
  const ext = _config.extensions || {};

  el.appendChild(makeRow(
    '외부 API 수집 (Collector)',
    'Data Hub에서 등록한 외부 API 온디맨드 수집 활성화',
    makeToggle('st-collector', !!ext.collector, false,
      (v) => scheduleSave('extensions.collector', v))
  ));

  el.appendChild(makeRow(
    '클라우드 AI 연동',
    'OpenAI, Anthropic 등 클라우드 Provider 연동 활성화',
    makeToggle('st-cloud', !!ext.cloud_providers, false,
      (v) => scheduleSave('extensions.cloud_providers', v))
  ));
}

// ──────────────────────────────────────
// CSS
// ──────────────────────────────────────
const stCSS =
'#page-settings.active{display:flex;height:100%;overflow:hidden;}' +
'#st-layout{display:flex;width:100%;height:100%;overflow:hidden;}' +

/* 좌측 메뉴 */
'#st-nav{flex-shrink:0;width:160px;padding:20px 8px;border-right:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:2px;overflow-y:auto;transition:width 0.2s;}' +
'#st-nav.st-nav-collapsed{width:48px;padding:20px 4px;}' +
'#st-nav.st-nav-collapsed .st-nav-label{display:none;}' +
'.st-nav-btn{display:flex;align-items:center;gap:6px;padding:8px 12px;border:none;background:none;color:var(--text-secondary);font-size:var(--font-size-sm);border-radius:var(--radius-md);cursor:pointer;text-align:left;transition:all 0.15s;width:100%;}' +
'#st-nav.st-nav-collapsed .st-nav-btn{justify-content:center;padding:8px 4px;}' +
'.st-nav-btn:hover{background:var(--surface-hover);color:var(--text-primary);}' +
'.st-nav-btn.active{background:var(--accent-dim);color:var(--accent);font-weight:500;}' +

/* 우측 스크롤 */
'#st-body{flex:1;overflow-y:auto;padding:20px 32px 60px;}' +
'.st-section{margin-bottom:48px;}' +
'.st-section-title{font-size:16px;font-weight:600;color:var(--text-primary);margin:0 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border-subtle);}' +
'.st-section-content{display:flex;flex-direction:column;gap:12px;}' +

/* 행 */
'.st-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--border-subtle);}' +
'.st-row:last-child{border-bottom:none;}' +
'.st-row-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}' +
'.st-label{font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);}' +
'.st-desc{font-size:var(--font-size-xs);color:var(--text-muted);}' +

/* 컨트롤 */
'.st-select{padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text-primary);font-size:var(--font-size-sm);width:100%;max-width:220px;cursor:pointer;}' +
'.st-select:focus{outline:none;border-color:var(--accent);}' +
'.st-number{width:100px;padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text-primary);font-size:var(--font-size-sm);}' +
'.st-number:focus{outline:none;border-color:var(--accent);}' +

/* 슬라이더 */
'.st-slider-wrap{display:flex;align-items:center;gap:10px;width:100%;max-width:240px;}' +
'.st-slider{flex:1;accent-color:var(--accent);cursor:pointer;}' +
'.st-slider-val{font-size:var(--font-size-xs);color:var(--accent);font-weight:500;min-width:32px;text-align:right;}' +

/* 토글 */
'.st-toggle{display:inline-flex;align-items:center;cursor:pointer;gap:8px;}' +
'.st-toggle.disabled{opacity:0.4;cursor:not-allowed;pointer-events:none;}' +
'.st-toggle input{display:none;}' +
'.st-toggle-track{width:40px;height:22px;background:var(--border);border-radius:11px;position:relative;transition:background 0.2s;}' +
'.st-toggle input:checked + .st-toggle-track{background:var(--accent);}' +
'.st-toggle-track::after{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;}' +
'.st-toggle input:checked + .st-toggle-track::after{left:21px;}' +

/* 뱃지/힌트 */
'.st-cap-badge{margin-top:8px;padding:6px 10px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-size:var(--font-size-xs);color:var(--text-secondary);}' +
'.st-hint{margin-top:8px;padding:8px 12px;background:var(--accent-dim);border-radius:var(--radius-md);font-size:var(--font-size-xs);color:var(--accent);}' +
'.st-loading{color:var(--text-muted);font-size:var(--font-size-sm);padding:20px 0;}' +
'.st-coming{color:var(--text-muted);font-size:var(--font-size-sm);padding:20px 0;font-style:italic;}' +
'.st-textarea{width:100%;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text-primary);font-size:var(--font-size-sm);font-family:var(--font-mono);line-height:1.6;resize:vertical;margin-top:8px;}' +
'.st-textarea:focus{outline:none;border-color:var(--accent);}' +
'.st-text-input{padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text-primary);font-size:var(--font-size-sm);width:100%;max-width:220px;}' +
'.st-notice{margin-top:8px;padding:8px 12px;background:var(--warning-dim,rgba(255,180,0,0.1));border-radius:var(--radius-md);font-size:var(--font-size-xs);color:var(--warning,#f0a500);}' +
'.st-text-input:focus{outline:none;border-color:var(--accent);}';

const _stStyle = document.createElement('style');
_stStyle.textContent = stCSS;
document.head.appendChild(_stStyle);