/**
 * static/js/icons.js
 * Bootstrap Icons 헬퍼 — CSS 클래스 기반, HTML 문자열에 직접 삽입 가능
 * CDN: index.html에 아래 링크 추가 필요
 * <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11/font/bootstrap-icons.min.css">
 *
 * 사용법:
 *   import { icon, favIcon } from './icons.js';
 *   el.innerHTML = icon('trash');          // <i class="bi bi-trash"></i>
 *   el.innerHTML = icon('star-fill', 'text-accent'); // 클래스 추가
 *   el.innerHTML = favIcon(true);          // 즐겨찾기 활성(fill) / 비활성(outline)
 */

// ──────────────────────────────────────
// 기본 헬퍼 — HTML 문자열 반환
// ──────────────────────────────────────
export function icon(name, cls = '') {
  return `<i class="bi bi-${name}${cls ? ' ' + cls : ''}"></i>`;
}

// ──────────────────────────────────────
// 즐겨찾기 아이콘 — fill/outline 상태 처리
// ──────────────────────────────────────
export function favIcon(active) {
  return active
    ? icon('star-fill',  'fav-active')
    : icon('star',       'fav-inactive');
}

// ──────────────────────────────────────
// 전체 아이콘 목록 (참고용)
// 각 파일에서 icon() 헬퍼를 import해서 직접 사용
// ──────────────────────────────────────

// 사이드바
// icon('list')              → 토글 (☰)
// icon('pencil-square')     → 새 채팅 (✏️)
// icon('search')            → 검색 (🔍)
// icon('chat-square-dots')  → 채팅 목록 (💬)
// icon('database')          → Data Hub (🗄️)
// icon('gear')              → 설정 (⚙️)

// chat.js
// icon('paperclip')         → 파일 첨부 (📎)
// icon('x')                 → 제거 (✕)
// icon('patch-question')    → 추론 패널 (💭) — MessageCircleQuestion 대응
// icon('chevron-right')     → 패널 접힘 (›)
// icon('chevron-down')      → 패널 펼침 (⌄)
// icon('copy')              → 복사 (⎘)
// icon('arrow-counterclockwise') → 재생성 (↺)
// icon('search')            → RAG 에이전트
// icon('eye')               → Vision 에이전트
// icon('globe')             → API 에이전트

// chatlist.js
// favIcon(active)           → 즐겨찾기 (⭐/★)
// icon('trash')             → 삭제 (🗑)
// icon('chat-square-dots')  → 채팅 목록 제목

// datahub.js
// icon('database')          → Data Hub 제목
// icon('file-earmark-text') → 파일 관리 탭
// icon('globe')             → API 관리 탭
// icon('folder2-open')      → 드롭존
// icon('exclamation-triangle') → 경고 (⚠️)
// icon('check-circle-fill') → 완료 (✅)
// icon('x-circle-fill')     → 오류 (❌)
// icon('clock')             → 대기 (⏳)
// icon('arrow-repeat')      → 임베딩 중 (🟡)

// search.js
// icon('search')            → 검색창
// icon('x-lg')              → 초기화 (✕)
// icon('chat-square-dots')  → 채팅 섹션
// icon('check-circle-fill') → 임베딩 완료
// icon('clock')             → 임베딩 대기

// settings.js
// icon('cpu')               → 모델 섹션 (🤖)
// icon('brain')             → 추론 섹션 (🧠)
// icon('hdd')               → 컨텍스트 섹션 (💾)
// icon('book')              → RAG 섹션 (📚)
// icon('chat-square-text')  → 시스템 프롬프트 섹션 (💬)
// icon('palette')           → 앱 외관 섹션 (🎨)
// icon('link-45deg')        → 확장 섹션 (🔗)
// icon('eye')               → vision capability
// icon('tools')             → tools capability

// utils.js — getFileIcon
// icon('file-earmark-image') → 이미지 (🖼)
// icon('file-earmark-pdf')   → PDF (📄)
// icon('file-earmark-word')  → DOCX (📝)
// icon('file-earmark-text')  → TXT/MD (📃)
// icon('paperclip')          → 기타 (📎)