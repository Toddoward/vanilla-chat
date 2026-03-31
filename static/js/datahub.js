import { App, api } from './app.js';
import { setDatahubBadge } from './sidebar.js';
import { onReady, showToast, getFileIcon, escapeHtml, updateBulkActions } from './utils.js';
import { icon } from './icons.js';



/**
 * static/js/datahub.js
 * Data Hub UI — 파일 관리 탭 + 외부 API 관리 탭
 */

// ──────────────────────────────────────
// 상태
// ──────────────────────────────────────
var dhCurrentTab     = 'files';
var dhSelectedFiles  = new Set();
var dhStatusStream   = null;
var dhEmbedProgress  = {};  // file_id -> pct

// ──────────────────────────────────────
// 초기화 — 레이아웃은 DOMContentLoaded에서 1회만, SSE는 항상 유지
// ──────────────────────────────────────
onReady(function() {
  renderDataHub();
  startEmbedStatusStream();  // 앱 시작 시 전역 유지 (페이지 이동과 무관)
});

document.addEventListener('page:enter', function(e) {
  if (e.detail.page !== 'datahub') return;
  if (dhCurrentTab === 'files') loadFiles();
  if (dhCurrentTab === 'apis')  loadApis();
  checkEmbeddingDimMismatch();
});

// ──────────────────────────────────────
// 임베딩 차원 불일치 감지 + 재임베딩 배너
// ──────────────────────────────────────
async function checkEmbeddingDimMismatch() {
  var panel = document.getElementById('dh-panel-files');
  if (!panel) return;
  var existing = document.getElementById('dh-dim-warning');
  if (existing) existing.remove();
  try {
    var status = await api('GET', '/api/status');
    if (!status.dim_mismatch) return;
    var banner = document.createElement('div');
    banner.id = 'dh-dim-warning';
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--warning-dim,#3a2e00);border:1px solid var(--warning,#f5c400);border-radius:var(--radius-md);margin-bottom:12px;font-size:var(--font-size-sm);color:var(--warning,#f5c400);';
    banner.innerHTML =
      '<i class="bi bi-exclamation-triangle-fill"></i>' +
      '<span style="flex:1;">임베딩 모델이 변경되어 기존 벡터와 차원이 다릅니다. 재임베딩이 필요합니다.</span>' +
      '<button id="dh-reembed-btn" style="padding:4px 10px;border-radius:var(--radius-sm);background:var(--warning,#f5c400);color:#000;border:none;cursor:pointer;font-size:var(--font-size-xs);font-weight:600;">재임베딩 시작</button>';
    panel.insertBefore(banner, panel.firstChild);
    document.getElementById('dh-reembed-btn')?.addEventListener('click', async function() {
      if (!confirm('모든 파일을 재임베딩합니다. 시간이 걸릴 수 있습니다.')) return;
      try {
        await api('POST', '/api/files/reembed', {});
        showToast('재임베딩이 시작됐습니다. 완료 시 뱃지가 갱신됩니다.');
        banner.remove();
      } catch(e) { showToast('재임베딩 시작 실패', 'error'); }
    });
  } catch(e) { /* 상태 조회 실패 시 무시 */ }
}

// ──────────────────────────────────────
// 전체 레이아웃
// ──────────────────────────────────────
function renderDataHub() {
  var page = document.getElementById('page-datahub');
  page.innerHTML =
    '<div id="dh-header">' +
      '<h2 class="dh-title"><i class="bi bi-database"></i> Data Hub</h2>' +
      '<div id="dh-tabs">' +
        '<button class="dh-tab active" data-tab="files"><i class="bi bi-file-earmark-text"></i> 파일 관리</button>' +
        '<button class="dh-tab" data-tab="apis"><i class="bi bi-globe"></i> API 관리</button>' +
      '</div>' +
    '</div>' +
    '<div id="dh-body">' +
      '<div id="dh-panel-files" class="dh-panel active"></div>' +
      '<div id="dh-panel-apis"  class="dh-panel"></div>' +
    '</div>';

  page.querySelectorAll('.dh-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      dhCurrentTab = btn.dataset.tab;
      page.querySelectorAll('.dh-tab').forEach(function(b) { b.classList.remove('active'); });
      page.querySelectorAll('.dh-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('dh-panel-' + dhCurrentTab).classList.add('active');
      if (dhCurrentTab === 'files') loadFiles();
      if (dhCurrentTab === 'apis')  loadApis();
    });
  });

  renderFilesPanel();
  renderApisPanel();
}

// ──────────────────────────────────────
// 파일 관리 탭
// ──────────────────────────────────────
function renderFilesPanel() {
  var panel = document.getElementById('dh-panel-files');
  if (!panel) return;
  panel.innerHTML =
    '<div id="dh-dropzone">' +
      '<div class="dz-icon"><i class="bi bi-folder2-open"></i></div>' +
      '<p class="dz-text">파일을 여기에 드래그하거나</p>' +
      '<div class="dz-btns">' +
        '<label class="dz-btn"><input type="file" id="dh-file-input" multiple style="display:none;"><i class="bi bi-file-earmark-text"></i> 파일 선택</label>' +
      '</div>' +
    '</div>' +
    '<div id="dh-bulk-actions" style="display:none;">' +
      '<span id="dh-selected-count">0개 선택됨</span>' +
      '<button id="dh-delete-selected" class="dh-danger-btn"><i class="bi bi-trash"></i> 선택 삭제</button>' +
    '</div>' +
    '<div id="dh-file-list"></div>';

  // 드롭존 이벤트
  setupDropzone();

  // 파일 선택
  var fi = document.getElementById('dh-file-input');
  if (fi) fi.addEventListener('change', function() {
    Array.from(fi.files).forEach(function(f) { uploadFile(f); });
    fi.value = '';
  });

  // 일괄 삭제
  var delBtn = document.getElementById('dh-delete-selected');
  if (delBtn) delBtn.addEventListener('click', deleteSelectedFiles);
}

function setupDropzone() {
  var dz = document.getElementById('dh-dropzone');
  if (!dz) return;
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', function()  { dz.classList.remove('drag-over'); });
  dz.addEventListener('drop', function(e) {
    e.preventDefault();
    dz.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(function(f) { uploadFile(f); });
  });
}

async function uploadFile(file) {
  // 브라우저에서 절대 경로를 직접 알 수 없으므로
  // 파일을 FormData로 서버에 전송 → 서버가 임시 저장 후 등록
  var form = new FormData();
  form.append('file', file);
  try {
    showToast(file.name + ' 업로드 중...');
    var resp = await fetch('/api/files/upload', { method: 'POST', body: form });
    if (!resp.ok) throw new Error(await resp.text());
    var data = await resp.json();
    showToast(file.name + ' 등록 완료', 'success');
    loadFiles();
    setDatahubBadge('running');
  } catch(e) {
    showToast('업로드 실패: ' + e.message, 'error');
  }
}

async function loadFiles() {
  var list = document.getElementById('dh-file-list');
  if (!list) return;
  try {
    var data = await api('GET', '/api/files');
    var files = data.files || [];
    renderFileList(files);
  } catch(e) {
    list.innerHTML = '<div class="dh-empty">파일 목록 로드 실패</div>';
  }
}

function renderFileList(files) {
  var list = document.getElementById('dh-file-list');
  if (!list) return;
  dhSelectedFiles.clear();
  updateBulkActions('dh-bulk-actions', 'dh-selected-count', dhSelectedFiles);

  if (!files.length) {
    list.innerHTML = '<div class="dh-empty">등록된 파일이 없습니다.<br>파일을 드래그하거나 선택해 등록하세요.</div>';
    return;
  }

  list.innerHTML = '';
  files.forEach(function(f) {
    var pct = dhEmbedProgress[f.id];
    var statusHtml = getStatusBadge(f, pct);

    var row = document.createElement('div');
    row.className = 'dh-file-row';
    row.dataset.fileId = f.id;
    row.innerHTML =
      '<input type="checkbox" class="dh-check" data-id="' + f.id + '"/>' +
      '<span class="dh-file-icon">' + getFileIcon(f.display_name || '') + '</span>' +
      '<div class="dh-file-info">' +
        '<span class="dh-file-name">' + escapeHtml(f.display_name || f.original_path) + '</span>' +
        '<span class="dh-file-path">' + escapeHtml(f.original_path) + '</span>' +
      '</div>' +
      statusHtml +
      (f.status === 'BROKEN'
        ? '<button class="dh-reregister-btn" data-id="' + f.id + '">재등록</button>'
        : '') +
      '<button class="dh-open-btn" data-id="' + f.id + '" title="파일 열기"><i class="bi bi-box-arrow-up-right"></i></button>' +
      '<button class="dh-delete-btn" data-id="' + f.id + '"><i class="bi bi-trash"></i></button>';

    // 체크박스
    row.querySelector('.dh-check').addEventListener('change', function(e) {
      if (e.target.checked) dhSelectedFiles.add(f.id);
      else dhSelectedFiles.delete(f.id);
      updateBulkActions('dh-bulk-actions', 'dh-selected-count', dhSelectedFiles);
    });

    // 파일 열기
    row.querySelector('.dh-open-btn').addEventListener('click', async function() {
      try {
        await api('POST', '/api/files/' + f.id + '/open', {});
      } catch(e) {
        showToast('파일을 열 수 없습니다. 경로를 확인하세요.', 'error');
      }
    });

    // 삭제
    row.querySelector('.dh-delete-btn').addEventListener('click', async function() {
      if (!confirm('"' + (f.display_name || '이 파일') + '"을 등록 해제할까요?')) return;
      await api('DELETE', '/api/files/' + f.id);
      showToast('등록 해제됨');
      loadFiles();
    });

    // 재등록
    var rereg = row.querySelector('.dh-reregister-btn');
    if (rereg) rereg.addEventListener('click', function() { reregisterFile(f.id); });

    list.appendChild(row);
  });
}

function getStatusBadge(f, pct) {
  if (f.status === 'BROKEN') return '<span class="dh-badge broken"><i class="bi bi-exclamation-triangle"></i> 경로 끊김</span>';
  if (f.embedding_status === 'running') {
    var p = pct !== undefined ? pct + '%' : '';
    return '<span class="dh-badge running"><i class="bi bi-arrow-repeat"></i> 임베딩 중... ' + p + '</span>';
  }
  if (f.embedding_status === 'done')  return '<span class="dh-badge done"><i class="bi bi-check-circle-fill"></i> 완료</span>';
  if (f.embedding_status === 'error') return '<span class="dh-badge error"><i class="bi bi-x-circle-fill"></i> 오류</span>';
  return '<span class="dh-badge pending"><i class="bi bi-clock"></i> 대기</span>';
}

async function deleteSelectedFiles() {
  if (!dhSelectedFiles.size) return;
  if (!confirm(dhSelectedFiles.size + '개 파일을 등록 해제할까요?')) return;
  for (var id of dhSelectedFiles) {
    await api('DELETE', '/api/files/' + id);
  }
  showToast(dhSelectedFiles.size + '개 등록 해제됨');
  dhSelectedFiles.clear();
  loadFiles();
}

function reregisterFile(fileId) {
  var input = document.createElement('input');
  input.type = 'file';
  input.onchange = async function() {
    if (!input.files.length) return;
    await api('DELETE', '/api/files/' + fileId);
    uploadFile(input.files[0]);
  };
  input.click();
}

// ──────────────────────────────────────
// 임베딩 진행률 SSE
// ──────────────────────────────────────
function startEmbedStatusStream() {
  if (dhStatusStream) return;
  dhStatusStream = new EventSource('/api/files/status');
  dhStatusStream.onmessage = function(e) {
    try {
      var progress = JSON.parse(e.data);
      var keys = Object.keys(progress);

      // 진행 항목이 없으면 뱃지 숨김
      if (!keys.length) {
        setDatahubBadge('hidden');
        return;
      }

      var changed = false;
      for (var id in progress) {
        if (dhEmbedProgress[id] !== progress[id]) { changed = true; }
        dhEmbedProgress[id] = progress[id];
      }
      if (changed) refreshFileProgress();

      // 모두 100%면 done 뱃지 → 3초 후 hidden
      var allDone = keys.every(function(k) { return progress[k] >= 100; });
      if (allDone) {
        setDatahubBadge('done');
        setTimeout(function() { setDatahubBadge('hidden'); }, 3000);
      } else {
        setDatahubBadge('running');
      }
    } catch(e2) {}
  };
}

function stopEmbedStatusStream() {
  if (dhStatusStream) { dhStatusStream.close(); dhStatusStream = null; }
}

function refreshFileProgress() {
  var completedAny = false;
  document.querySelectorAll('.dh-file-row').forEach(function(row) {
    var id  = parseInt(row.dataset.fileId);
    var pct = dhEmbedProgress[id];
    if (pct === undefined) return;
    var badge = row.querySelector('.dh-badge');
    if (!badge) return;
    if (pct < 100) {
      badge.className = 'dh-badge running';
      badge.innerHTML = '<i class="bi bi-arrow-repeat"></i> 임베딩 중... ' + pct + '%';
    } else {
      if (!badge.classList.contains('done')) {
        badge.className = 'dh-badge done';
        badge.innerHTML = '<i class="bi bi-check-circle-fill"></i> 완료';
        completedAny = true;
      }
    }
  });
  if (completedAny) {
    setTimeout(function() { loadFiles(); }, 1500);
  }
}

// ──────────────────────────────────────
// API 관리 탭
// ──────────────────────────────────────
function renderApisPanel() {
  var panel = document.getElementById('dh-panel-apis');
  if (!panel) return;
  panel.innerHTML =
    '<div id="dh-api-header">' +
      '<span class="dh-section-title">등록된 외부 API</span>' +
      '<button id="dh-add-api-btn" class="dh-primary-btn">+ API 등록</button>' +
    '</div>' +
    '<div id="dh-api-form" style="display:none;">' +
      '<div class="dh-form-row"><label>API 이름</label><input id="af-name" placeholder="공공데이터 날씨 API"/></div>' +
      '<div class="dh-form-row"><label>엔드포인트</label><input id="af-url" placeholder="https://api.example.com/data"/></div>' +
      '<div class="dh-form-row"><label>TTL</label>' +
        '<select id="af-ttl">' +
          '<option value="600">10분</option>' +
          '<option value="1800">30분</option>' +
          '<option value="3600" selected>1시간</option>' +
          '<option value="21600">6시간</option>' +
          '<option value="86400">24시간</option>' +
        '</select>' +
      '</div>' +
      '<div class="dh-form-row"><label>인증 헤더 <span class="optional">(선택)</span></label><input id="af-auth" placeholder="Bearer token..."/></div>' +
      '<div class="dh-form-actions"><button id="af-cancel" class="dh-ghost-btn">취소</button><button id="af-submit" class="dh-primary-btn">등록</button></div>' +
    '</div>' +
    '<div id="dh-api-list"></div>';

  // 등록 버튼
  document.getElementById('dh-add-api-btn').addEventListener('click', function() {
    document.getElementById('dh-api-form').style.display = 'block';
    document.getElementById('af-name').focus();
  });
  document.getElementById('af-cancel').addEventListener('click', function() {
    document.getElementById('dh-api-form').style.display = 'none';
  });
  document.getElementById('af-submit').addEventListener('click', submitApiForm);
}

async function loadApis() {
  var list = document.getElementById('dh-api-list');
  if (!list) return;
  try {
    var data = await api('GET', '/api/external-apis');
    renderApiList(data.apis || []);
  } catch(e) {
    list.innerHTML = '<div class="dh-empty">API 목록 로드 실패</div>';
  }
}

function renderApiList(apis) {
  var list = document.getElementById('dh-api-list');
  if (!list) return;
  if (!apis.length) {
    list.innerHTML = '<div class="dh-empty">등록된 외부 API가 없습니다.</div>';
    return;
  }
  list.innerHTML = '';
  apis.forEach(function(a) {
    var ttlLabel = formatTtl(a.ttl_seconds);
    var row = document.createElement('div');
    row.className = 'dh-api-row';
    row.innerHTML =
      '<div class="dh-api-info">' +
        '<span class="dh-api-name">' + escapeHtml(a.name) + '</span>' +
        '<span class="dh-api-url">' + escapeHtml(a.endpoint) + '</span>' +
      '</div>' +
      '<span class="dh-api-ttl">TTL: ' + ttlLabel + '</span>' +
      '<span class="dh-badge done"><i class="bi bi-check-circle-fill"></i> 정상</span>' +
      '<div class="dh-api-menu">' +
        '<button class="dh-menu-btn" data-id="' + a.id + '">···</button>' +
        '<div class="dh-dropdown" style="display:none;">' +
          '<button data-action="test" data-id="' + a.id + '">즉시 테스트</button>' +
          '<button data-action="delete" data-id="' + a.id + '">삭제</button>' +
        '</div>' +
      '</div>';

    // 드롭다운 토글
    var menuBtn  = row.querySelector('.dh-menu-btn');
    var dropdown = row.querySelector('.dh-dropdown');
    menuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function() { dropdown.style.display = 'none'; });

    // 액션
    dropdown.querySelectorAll('button').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        dropdown.style.display = 'none';
        if (btn.dataset.action === 'delete') {
          if (!confirm('"' + a.name + '" API를 삭제할까요?')) return;
          await api('DELETE', '/api/external-apis/' + a.id);
          showToast('API 삭제됨'); loadApis();
        } else if (btn.dataset.action === 'test') {
          showToast(a.name + ' 테스트 중...');
          try {
            await api('POST', '/api/external-apis/' + a.id + '/test');
            showToast('테스트 성공', 'success');
          } catch(e2) { showToast('테스트 실패: ' + e2.message, 'error'); }
        }
      });
    });
    list.appendChild(row);
  });
}

async function submitApiForm() {
  var name = document.getElementById('af-name').value.trim();
  var url  = document.getElementById('af-url').value.trim();
  var ttl  = parseInt(document.getElementById('af-ttl').value);
  var auth = document.getElementById('af-auth').value.trim();
  if (!name || !url) { showToast('이름과 엔드포인트는 필수입니다', 'error'); return; }
  try {
    await api('POST', '/api/external-apis', { name, endpoint: url, ttl_seconds: ttl, auth_header: auth || null });
    showToast('API 등록 완료', 'success');
    document.getElementById('dh-api-form').style.display = 'none';
    document.getElementById('af-name').value = '';
    document.getElementById('af-url').value  = '';
    document.getElementById('af-auth').value = '';
    loadApis();
  } catch(e) { showToast('등록 실패: ' + e.message, 'error'); }
}

function formatTtl(sec) {
  if (sec < 3600)  return (sec / 60) + '분';
  if (sec < 86400) return (sec / 3600) + '시간';
  return (sec / 86400) + '일';
}

// ──────────────────────────────────────
// CSS
// ──────────────────────────────────────
var dhCSS =
'#page-datahub.active{display:flex;flex-direction:column;height:100%;overflow:hidden;}' +
'#dh-header{flex-shrink:0;padding:20px 24px 0;border-bottom:1px solid var(--border-subtle);}' +
'.dh-title{font-size:18px;font-weight:600;color:var(--text-primary);margin-bottom:12px;}' +
'#dh-tabs{display:flex;gap:0;}' +
'.dh-tab{padding:8px 18px;background:none;border:none;border-bottom:2px solid transparent;color:var(--text-muted);font-size:var(--font-size-sm);font-weight:500;cursor:pointer;transition:all 0.15s;}' +
'.dh-tab.active{color:var(--accent);border-bottom-color:var(--accent);}' +
'.dh-tab:hover:not(.active){color:var(--text-secondary);}' +
'#dh-body{flex:1;overflow:hidden;position:relative;}' +
'.dh-panel{display:none;height:100%;overflow-y:auto;padding:20px 24px;}' +
'.dh-panel.active{display:block;}' +

/* 드롭존 */
'#dh-dropzone{border:2px dashed var(--border);border-radius:var(--radius-lg);padding:32px;text-align:center;margin-bottom:16px;transition:all 0.15s;cursor:pointer;}' +
'#dh-dropzone.drag-over{border-color:var(--accent);background:var(--accent-dim);}' +
'.dz-icon{font-size:32px;margin-bottom:8px;}' +
'.dz-text{color:var(--text-muted);font-size:var(--font-size-sm);margin-bottom:12px;}' +
'.dz-btns{display:flex;gap:8px;justify-content:center;}' +
'.dz-btn{padding:6px 14px;border-radius:var(--radius-md);background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-secondary);font-size:var(--font-size-sm);cursor:pointer;transition:all 0.15s;}' +
'.dz-btn:hover{border-color:var(--accent);color:var(--accent);}' +

/* 일괄 삭제 바 */
'#dh-bulk-actions{display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--accent-dim);border:1px solid rgba(232,201,122,0.3);border-radius:var(--radius-md);margin-bottom:12px;}' +
'#dh-selected-count{font-size:var(--font-size-sm);color:var(--accent);flex:1;}' +

/* 파일 행 */
'.dh-file-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--border-subtle);margin-bottom:6px;background:var(--bg-secondary);transition:background 0.15s;}' +
'.dh-file-row:hover{background:var(--surface);}' +
'.dh-check{flex-shrink:0;cursor:pointer;accent-color:var(--accent);}' +
'.dh-file-icon{font-size:18px;flex-shrink:0;}' +
'.dh-file-info{flex:1;min-width:0;}' +
'.dh-file-name{display:block;font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.dh-file-path{display:block;font-size:var(--font-size-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +

/* 뱃지 */
'.dh-badge{flex-shrink:0;font-size:var(--font-size-xs);padding:2px 8px;border-radius:var(--radius-full);font-weight:500;}' +
'.dh-badge.done{background:var(--success-dim);color:var(--success);}' +
'.dh-badge.running{background:var(--warning-dim);color:var(--warning);}' +
'.dh-badge.broken{background:var(--danger-dim);color:var(--danger);}' +
'.dh-badge.pending{background:var(--bg-tertiary);color:var(--text-muted);}' +
'.dh-badge.error{background:var(--danger-dim);color:var(--danger);}' +

/* 버튼 */
'.dh-primary-btn{padding:6px 14px;border-radius:var(--radius-md);background:var(--accent);color:var(--bg-primary);font-size:var(--font-size-sm);font-weight:500;border:none;cursor:pointer;transition:all 0.15s;}' +
'.dh-primary-btn:hover{background:var(--accent-hover);}' +
'.dh-ghost-btn{padding:6px 14px;border-radius:var(--radius-md);background:none;color:var(--text-secondary);font-size:var(--font-size-sm);border:1px solid var(--border);cursor:pointer;transition:all 0.15s;}' +
'.dh-ghost-btn:hover{border-color:var(--text-secondary);}' +
'.dh-danger-btn{padding:5px 12px;border-radius:var(--radius-md);background:var(--danger-dim);color:var(--danger);font-size:var(--font-size-xs);border:1px solid var(--danger);cursor:pointer;}' +
'.dh-open-btn{flex-shrink:0;padding:4px 8px;border-radius:var(--radius-sm);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;transition:color 0.15s;}' +
'.dh-open-btn:hover{color:var(--accent);}' +
'.dh-delete-btn{flex-shrink:0;padding:4px 8px;border-radius:var(--radius-sm);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;transition:color 0.15s;}' +
'.dh-delete-btn:hover{color:var(--danger);}' +
'.dh-reregister-btn{flex-shrink:0;padding:3px 8px;border-radius:var(--radius-sm);background:var(--warning-dim);color:var(--warning);border:1px solid var(--warning);font-size:var(--font-size-xs);cursor:pointer;}' +

/* 빈 상태 */
'.dh-empty{text-align:center;padding:40px 20px;color:var(--text-muted);font-size:var(--font-size-sm);line-height:1.8;}' +

/* API 탭 */
'#dh-api-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}' +
'.dh-section-title{font-size:var(--font-size-md);font-weight:600;color:var(--text-primary);}' +
'#dh-api-form{background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;margin-bottom:16px;}' +
'.dh-form-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;}' +
'.dh-form-row label{flex-shrink:0;width:90px;font-size:var(--font-size-sm);color:var(--text-secondary);}' +
'.optional{font-size:var(--font-size-xs);color:var(--text-muted);}' +
'.dh-form-row input,.dh-form-row select{flex:1;padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text-primary);font-size:var(--font-size-sm);}' +
'.dh-form-row input:focus,.dh-form-row select:focus{outline:none;border-color:var(--accent);}' +
'.dh-form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px;}' +
'.dh-api-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--border-subtle);margin-bottom:6px;background:var(--bg-secondary);}' +
'.dh-api-info{flex:1;min-width:0;}' +
'.dh-api-name{display:block;font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);}' +
'.dh-api-url{display:block;font-size:var(--font-size-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
'.dh-api-ttl{flex-shrink:0;font-size:var(--font-size-xs);color:var(--text-muted);}' +
'.dh-api-menu{position:relative;flex-shrink:0;}' +
'.dh-menu-btn{padding:4px 8px;background:none;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-muted);cursor:pointer;font-size:13px;}' +
'.dh-dropdown{position:absolute;right:0;top:calc(100% + 4px);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:var(--shadow-md);z-index:50;min-width:120px;}' +
'.dh-dropdown button{display:block;width:100%;padding:8px 14px;background:none;border:none;text-align:left;color:var(--text-secondary);font-size:var(--font-size-sm);cursor:pointer;}' +
'.dh-dropdown button:hover{background:var(--surface-hover);color:var(--text-primary);}';

var _dhStyle = document.createElement('style');
_dhStyle.textContent = dhCSS;
document.head.appendChild(_dhStyle);