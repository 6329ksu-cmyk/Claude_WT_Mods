// Local change (2026-10-21, user: "돛단배 위치에 돛단배처럼 기능하는 펫을 원했던거임"): while
// Claude works, the pets mod's dog walks back and forth in the boat's place and is gone when
// the turn ends. Each Raster cell stacks two pixels (▀/▄ with foreground and background), so
// the 11×6 sprite takes three rows, the boat's size. It steps and wags as it walks and blinks.
// 2026-10-21 사용자 요청 순서: "줄여봐·알록달록 말고" → "흰검이나 회색으로" → "돛단배처럼 3줄 정도로,
// 너무 커": 처음 claude-pets 앞모습(12×12)에서 옆모습 11×6(3줄)으로, 색은 흰·회색·검정만.
// 백그라운드 조사를 기다릴 때는 같은 강아지가 입력창 위에 서서 꼬리만 흔든다(sitting).
//
// First drawn after the dog in claude-pets (https://github.com/uppinote20/claude-pets,
// hooks/species.ts at 1f8027d), Copyright (c) 2026 uppinote, MIT License: see LICENSE-claude-pets.
import { CALM_SHIP_RASTER_DEFAULT_COLOR as NONE, encodeBase64 } from "./fm-calm-ship-raster.ts";

/** false draws this dog walking in the boat's place; true brings the boat back. */
export const SHOW_BOAT = false;

const INK: Readonly<Record<string, number>> = { o: 0xdedede, d: 0x8e8e8e, k: 0x262626 };
// Side view facing right: tail up, floppy ear, eye, grey nose. Mirrored on the way left.
const DOG = [
  ".......d...",
  "o.....dooo.",
  "o.....doko.",
  ".oooooooood",
  ".oooooooo..",
  ".o.o...o.o.",
];
const EYES_SHUT: Readonly<Record<number, string>> = { 2: "o.....dooo." };
const FEET_APART: Readonly<Record<number, string>> = { 5: "..oo....oo." };
const TAIL_DOWN: Readonly<Record<number, string>> = { 1: "......dooo.", 3: "ooooooooood" };
export const PET_WIDTH = DOG[0]!.length;
export const PET_ROWS = DOG.length / 2;
const WIDTH = PET_WIDTH;
const ROWS = PET_ROWS;
/** Ticks between columns (the scheduler ticks every 220 ms). */
const TICKS_PER_STEP = 2;
/** One blink, one tick long, every this many ticks. */
const BLINK_EVERY = 18;

function pose(apart: boolean, shut: boolean, facingLeft: boolean): string[] {
  return DOG.map((row, i) => {
    const drawn = (shut ? EYES_SHUT[i] : undefined) ?? (apart ? FEET_APART[i] : undefined) ?? row;
    return facingLeft ? Array.from(drawn).reverse().join("") : drawn;
  });
}

/** Raster cells `columns` wide with the pixel rows placed at column `at`. */
function pack(pixels: readonly string[], columns: number, at: number): string {
  const words = new Uint32Array(columns * ROWS * 3);
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const top = INK[pixels[row * 2]![column - at] ?? "."];
      const bottom = INK[pixels[row * 2 + 1]![column - at] ?? "."];
      const offset = (row * columns + column) * 3;
      words[offset] = top !== undefined ? 0x2580 : bottom !== undefined ? 0x2584 : 0x20;
      words[offset + 1] = top ?? bottom ?? NONE;
      words[offset + 2] = top !== undefined && bottom !== undefined ? bottom : NONE;
    }
  }
  return encodeBase64(new Uint8Array(words.buffer));
}

export function createPet() {
  let x = 0;
  let direction = 1;
  let ticks = 0;
  let span = 0;
  return {
    reset(): void {
      x = 0;
      direction = 1;
      ticks = 0;
    },
    tick(): void {
      ticks += 1;
      if (ticks % TICKS_PER_STEP !== 0 || span <= 0) return;
      x = Math.max(0, Math.min(span, x + direction));
      if (x >= span) direction = -1;
      else if (x <= 0) direction = 1;
    },
    /** Sitting still, PET_WIDTH columns: only the tail wags and the eyes blink. */
    sitting(): { rows: number; cells: string } {
      const down = Math.floor(ticks / TICKS_PER_STEP) % 2 === 1;
      const shut = ticks % BLINK_EVERY === BLINK_EVERY - 1;
      const rows = DOG.map((row, i) => (shut ? EYES_SHUT[i] : undefined) ?? (down ? TAIL_DOWN[i] : undefined) ?? row);
      return { rows: ROWS, cells: pack(rows, WIDTH, 0) };
    },
    cells(columns: number): { rows: number; cells: string } {
      span = Math.max(0, columns - WIDTH);
      x = Math.min(x, span);
      const apart = Math.floor(ticks / TICKS_PER_STEP) % 2 === 1;
      const shut = ticks % BLINK_EVERY === BLINK_EVERY - 1;
      return { rows: ROWS, cells: pack(pose(apart, shut, direction < 0), columns, x) };
    },
  };
}
