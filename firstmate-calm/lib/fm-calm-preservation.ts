// Shared Calm policy for deciding whether mid-turn assistant text is substantive.
// Claude Code imports this file directly, while the Pi extension reaches the same
// implementation through its tracked symlink so both harnesses keep one threshold and rule.

/** The minimum trimmed text length preserved from a mid-turn assistant message. */
// 로컬 수정(2026-10-14, 원본 240): 한국어 중간 안내까지 감춰져 0으로 — AI가 쓴 글은 전부 보이고 도구 줄만 감춘다
export const CALM_PRESERVE_MIN_CHARS = 0;

/** Whether mid-turn assistant text is substantive enough to remain visible. */
export function calmTextIsSubstantive(text: string): boolean {
  return text.includes("\n") || text.trim().length >= CALM_PRESERVE_MIN_CHARS;
}
