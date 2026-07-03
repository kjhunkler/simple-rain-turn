/* SimpleChess.
 * Phase 5: full chess rules on the pond board — legal move generation with
 * check, castling, en passant, and promotion; host-validated turn taking on
 * top of the seat claims and live drag sharing from earlier phases.
 */
(function () {
  "use strict";

  const GAME_ID = "simple-chess";
  const SNAPSHOT_HEARTBEAT_MS = 2500;
  const MAX_RIPPLES = 28;
  const FILES = "abcdefgh";
  const START_ROWS = ["rnbqkbnr", "pppppppp", "", "", "", "", "PPPPPPPP", "RNBQKBNR"];
  const PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
  const LIGHT_SQUARE = "#dce6c4";
  const DARK_SQUARE = "#356b78";
  const FRAME_WOOD = "#4a3a2c";
  const FRAME_EDGE = "#6b573f";
  const LABEL_COLOR = "#e8dfc8";
  const MIN_ZOOM = 0.55;
  const MAX_ZOOM = 3.2;
  const SPRITE_UNIT_W = 100;
  const SPRITE_UNIT_H = 122;
  const SPRITE_SCALE = 2.6;
  const DESKTOP_RENDER_FRAME_MS = 1000 / 30;
  const MOBILE_RENDER_FRAME_MS = 1000 / 24;
  const MOBILE_REMOTE_RENDER_FRAME_MS = 1000 / 20;
  const DESKTOP_DPR_CAP = 2;
  const MOBILE_DPR_CAP = 1.35;

  function now() { return performance.now(); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function seeded(seed, i) {
    const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function colorWithAlpha(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return `rgba(140, 232, 188, ${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function startingBoard() {
    const board = new Array(64).fill("");
    for (let row = 0; row < 8; row++) {
      const rowStr = START_ROWS[row];
      for (let col = 0; col < rowStr.length; col++) board[row * 8 + col] = rowStr[col];
    }
    return board;
  }

  function isWhitePiece(letter) { return letter === letter.toUpperCase(); }
  function squareName(idx) { return FILES[idx % 8] + String(8 - Math.floor(idx / 8)); }

  // ---- rules engine -------------------------------------------------------
  // Moves are objects: { from, to, promo?, castle?: "k"|"q", ep?: true, double?: true }.

  const PROMO_LETTERS = ["q", "r", "n", "b"];
  const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function pieceColor(letter) { return isWhitePiece(letter) ? "w" : "b"; }

  function pushSlides(board, from, color, dirs, out) {
    const col = from % 8;
    const row = Math.floor(from / 8);
    for (const [dc, dr] of dirs) {
      let c = col + dc, r = row + dr;
      while (c >= 0 && c < 8 && r >= 0 && r < 8) {
        const idx = r * 8 + c;
        const target = board[idx];
        if (!target) out.push({ from, to: idx });
        else {
          if (pieceColor(target) !== color) out.push({ from, to: idx });
          break;
        }
        c += dc;
        r += dr;
      }
    }
  }

  function pawnMoves(board, from, color, ep, out) {
    const col = from % 8;
    const row = Math.floor(from / 8);
    const dir = color === "w" ? -1 : 1;
    const startRow = color === "w" ? 6 : 1;
    const lastRow = color === "w" ? 0 : 7;
    const addPawn = (to, extra) => {
      if (Math.floor(to / 8) === lastRow) {
        for (const promo of PROMO_LETTERS) out.push({ from, to, promo, ...extra });
      } else out.push({ from, to, ...extra });
    };
    const r1 = row + dir;
    if (r1 >= 0 && r1 < 8 && !board[r1 * 8 + col]) {
      addPawn(r1 * 8 + col);
      const r2 = row + dir * 2;
      if (row === startRow && !board[r2 * 8 + col]) out.push({ from, to: r2 * 8 + col, double: true });
    }
    for (const dc of [-1, 1]) {
      const c = col + dc;
      if (c < 0 || c > 7 || r1 < 0 || r1 > 7) continue;
      const idx = r1 * 8 + c;
      if (board[idx] && pieceColor(board[idx]) !== color) addPawn(idx, {});
      else if (idx === ep && !board[idx]) out.push({ from, to: idx, ep: true });
    }
  }

  function pseudoMoves(board, from, castling, ep) {
    const letter = board[from];
    if (!letter) return [];
    const color = pieceColor(letter);
    const type = letter.toLowerCase();
    const out = [];
    const col = from % 8;
    const row = Math.floor(from / 8);
    if (type === "p") pawnMoves(board, from, color, ep, out);
    else if (type === "n" || type === "k") {
      for (const [dc, dr] of type === "n" ? KNIGHT_STEPS : KING_STEPS) {
        const c = col + dc, r = row + dr;
        if (c < 0 || c > 7 || r < 0 || r > 7) continue;
        const idx = r * 8 + c;
        if (!board[idx] || pieceColor(board[idx]) !== color) out.push({ from, to: idx });
      }
      if (type === "k") {
        const home = color === "w" ? 60 : 4;
        const rights = castling || {};
        const kSide = color === "w" ? rights.K : rights.k;
        const qSide = color === "w" ? rights.Q : rights.q;
        if (from === home) {
          const rookK = board[home + 3];
          if (kSide && !board[home + 1] && !board[home + 2] && rookK && rookK.toLowerCase() === "r" && pieceColor(rookK) === color) {
            out.push({ from, to: home + 2, castle: "k" });
          }
          const rookQ = board[home - 4];
          if (qSide && !board[home - 1] && !board[home - 2] && !board[home - 3] && rookQ && rookQ.toLowerCase() === "r" && pieceColor(rookQ) === color) {
            out.push({ from, to: home - 2, castle: "q" });
          }
        }
      }
    } else if (type === "b") pushSlides(board, from, color, BISHOP_DIRS, out);
    else if (type === "r") pushSlides(board, from, color, ROOK_DIRS, out);
    else if (type === "q") pushSlides(board, from, color, [...BISHOP_DIRS, ...ROOK_DIRS], out);
    return out;
  }

  function squareAttacked(board, byColor, idx) {
    const col = idx % 8;
    const row = Math.floor(idx / 8);
    const pdir = byColor === "w" ? 1 : -1;
    for (const dc of [-1, 1]) {
      const c = col + dc, r = row + pdir;
      if (c < 0 || c > 7 || r < 0 || r > 7) continue;
      const p = board[r * 8 + c];
      if (p && p.toLowerCase() === "p" && pieceColor(p) === byColor) return true;
    }
    for (const [dc, dr] of KNIGHT_STEPS) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c > 7 || r < 0 || r > 7) continue;
      const p = board[r * 8 + c];
      if (p && p.toLowerCase() === "n" && pieceColor(p) === byColor) return true;
    }
    for (const [dc, dr] of KING_STEPS) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c > 7 || r < 0 || r > 7) continue;
      const p = board[r * 8 + c];
      if (p && p.toLowerCase() === "k" && pieceColor(p) === byColor) return true;
    }
    for (const [dirs, matches] of [[BISHOP_DIRS, "bq"], [ROOK_DIRS, "rq"]]) {
      for (const [dc, dr] of dirs) {
        let c = col + dc, r = row + dr;
        while (c >= 0 && c < 8 && r >= 0 && r < 8) {
          const p = board[r * 8 + c];
          if (p) {
            if (pieceColor(p) === byColor && matches.includes(p.toLowerCase())) return true;
            break;
          }
          c += dc;
          r += dr;
        }
      }
    }
    return false;
  }

  function findKing(board, color) {
    const target = color === "w" ? "K" : "k";
    for (let i = 0; i < 64; i++) if (board[i] === target) return i;
    return -1;
  }

  function inCheck(board, color) {
    const kingIdx = findKing(board, color);
    return kingIdx >= 0 && squareAttacked(board, color === "w" ? "b" : "w", kingIdx);
  }

  function execMove(board, move) {
    const letter = board[move.from];
    const color = pieceColor(letter);
    let captured = board[move.to] || "";
    board[move.to] = move.promo ? (color === "w" ? move.promo.toUpperCase() : move.promo) : letter;
    board[move.from] = "";
    if (move.ep) {
      const capIdx = move.to + (color === "w" ? 8 : -8);
      captured = board[capIdx];
      board[capIdx] = "";
    }
    if (move.castle) {
      const home = color === "w" ? 60 : 4;
      if (move.castle === "k") { board[home + 1] = board[home + 3]; board[home + 3] = ""; }
      else { board[home - 1] = board[home - 4]; board[home - 4] = ""; }
    }
    return captured;
  }

  function legalMovesFrom(st, from) {
    const board = st.board;
    const letter = board[from];
    if (!letter) return [];
    const color = pieceColor(letter);
    const out = [];
    for (const move of pseudoMoves(board, from, st.castling, st.ep)) {
      if (move.castle) {
        if (inCheck(board, color)) continue;
        const mid = from + (move.castle === "k" ? 1 : -1);
        const test0 = board.slice();
        test0[mid] = letter;
        test0[from] = "";
        if (inCheck(test0, color)) continue;
      }
      const test = board.slice();
      execMove(test, move);
      if (!inCheck(test, color)) out.push(move);
    }
    return out;
  }

  function sideHasLegalMove(st, color) {
    for (let i = 0; i < 64; i++) {
      const letter = st.board[i];
      if (!letter || pieceColor(letter) !== color) continue;
      if (legalMovesFrom(st, i).length) return true;
    }
    return false;
  }

  function insufficientMaterial(board) {
    const extras = [];
    for (const letter of board) {
      if (!letter || letter.toLowerCase() === "k") continue;
      extras.push(letter.toLowerCase());
      if (extras.length > 1) return false;
    }
    return extras.length === 0 || extras[0] === "b" || extras[0] === "n";
  }

  function applyMoveFull(st, move) {
    const letter = st.board[move.from];
    const color = pieceColor(letter);
    const captured = execMove(st.board, move);
    const c = st.castling;
    if (letter === "K") { c.K = false; c.Q = false; }
    else if (letter === "k") { c.k = false; c.q = false; }
    if (move.from === 63 || move.to === 63) c.K = false;
    if (move.from === 56 || move.to === 56) c.Q = false;
    if (move.from === 7 || move.to === 7) c.k = false;
    if (move.from === 0 || move.to === 0) c.q = false;
    st.ep = move.double ? move.from + (color === "w" ? -8 : 8) : -1;
    st.halfmove = letter.toLowerCase() === "p" || captured ? 0 : (st.halfmove || 0) + 1;
    if (color === "b") st.fullmove = (st.fullmove || 1) + 1;
    st.turn = color === "w" ? "b" : "w";
    st.rev = (st.rev || 0) + 1;
    const check = inCheck(st.board, st.turn);
    const hasMove = sideHasLegalMove(st, st.turn);
    let result = null;
    if (!hasMove) result = check ? (color === "w" ? "white" : "black") : "draw";
    else if ((st.halfmove || 0) >= 100 || insufficientMaterial(st.board)) result = "draw";
    st.over = !!result;
    st.result = result;
    return { letter, color, captured, check, mate: check && !hasMove, stalemate: !check && !hasMove, result };
  }

  function moveMessage(move, info) {
    const colorName = info.color === "w" ? "White" : "Black";
    const piece = PIECE_NAMES[info.letter.toLowerCase()] || "piece";
    let text;
    if (move.castle) text = `${colorName} castles ${move.castle === "k" ? "kingside" : "queenside"}.`;
    else if (move.promo) text = `${colorName} pawn blossoms into a ${PIECE_NAMES[move.promo]} on ${squareName(move.to)}.`;
    else if (info.captured) text = `${colorName} ${piece} takes on ${squareName(move.to)}.`;
    else text = `${colorName} ${piece} glides to ${squareName(move.to)}.`;
    if (info.mate) text += ` Checkmate — ${colorName} wins!`;
    else if (info.stalemate) text += " Stalemate — the pond stills to a draw.";
    else if (info.result === "draw") text += " A quiet draw settles over the pond.";
    else if (info.check) text += " Check!";
    return text;
  }

  // ---- notation & clocks ---------------------------------------------------

  const CLOCK_BANK_MS = 10 * 60 * 1000;

  function sanForMove(st, move) {
    const letter = st.board[move.from];
    const type = letter.toLowerCase();
    if (move.castle) return move.castle === "k" ? "O-O" : "O-O-O";
    const target = squareName(move.to);
    const capture = !!st.board[move.to] || !!move.ep;
    if (type === "p") {
      let san = capture ? FILES[move.from % 8] + "x" + target : target;
      if (move.promo) san += "=" + move.promo.toUpperCase();
      return san;
    }
    let sameFile = false, sameRank = false, needDisamb = false;
    for (let i = 0; i < 64; i++) {
      if (i === move.from || st.board[i] !== letter) continue;
      if (!legalMovesFrom(st, i).some((m) => m.to === move.to)) continue;
      needDisamb = true;
      if (i % 8 === move.from % 8) sameFile = true;
      if (Math.floor(i / 8) === Math.floor(move.from / 8)) sameRank = true;
    }
    let disamb = "";
    if (needDisamb) {
      if (!sameFile) disamb = FILES[move.from % 8];
      else if (!sameRank) disamb = String(8 - Math.floor(move.from / 8));
      else disamb = squareName(move.from);
    }
    return type.toUpperCase() + disamb + (capture ? "x" : "") + target;
  }

  function applyAndRecord(st, move) {
    const san = sanForMove(st, move);
    const info = applyMoveFull(st, move);
    if (!Array.isArray(st.history)) st.history = [];
    st.history.push({
      from: move.from,
      to: move.to,
      promo: move.promo || null,
      san: san + (info.mate ? "#" : info.check ? "+" : ""),
    });
    return info;
  }

  function describePly(history, ply) {
    const h = history?.[ply];
    if (!h) return "that move";
    return `move ${Math.floor(ply / 2) + 1}${ply % 2 ? "… " : ". "}${h.san}`;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  // ---- piece sprites ------------------------------------------------------
  // Pieces are drawn once per letter into an offscreen canvas (100x122 unit
  // box, base line at y=112) and scaled onto the board every frame.

  const spriteCache = new Map();

  function pieceSprite(letter) {
    let sprite = spriteCache.get(letter);
    if (!sprite) {
      sprite = renderPieceSprite(letter);
      spriteCache.set(letter, sprite);
    }
    return sprite;
  }

  function renderPieceSprite(letter) {
    const cv = document.createElement("canvas");
    cv.width = Math.round(SPRITE_UNIT_W * SPRITE_SCALE);
    cv.height = Math.round(SPRITE_UNIT_H * SPRITE_SCALE);
    const c = cv.getContext("2d");
    c.scale(SPRITE_SCALE, SPRITE_SCALE);
    c.lineJoin = "round";
    c.lineCap = "round";
    drawPieceArt(c, letter.toLowerCase(), isWhitePiece(letter));
    return cv;
  }

  function piecePalette(white) {
    return white
      ? { top: "#faf4e2", bottom: "#d6c9a2", line: "#41372a", detail: "rgba(65, 55, 42, 0.55)", rim: "rgba(255, 252, 240, 0.85)" }
      : { top: "#41586d", bottom: "#131e28", line: "#0a1118", detail: "rgba(185, 214, 234, 0.42)", rim: "rgba(185, 214, 234, 0.55)" };
  }

  function shapeDone(c, pal, y0, y1) {
    const g = c.createLinearGradient(32, y0, 72, y1);
    g.addColorStop(0, pal.top);
    g.addColorStop(1, pal.bottom);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 3.4;
    c.strokeStyle = pal.line;
    c.stroke();
  }

  function drawGloss(c, pal, x, y, r) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, pal.rim);
    g.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  function drawBase(c, pal) {
    c.beginPath();
    c.moveTo(20, 100);
    c.quadraticCurveTo(50, 92, 80, 100);
    c.quadraticCurveTo(85, 106, 80, 111);
    c.quadraticCurveTo(50, 117, 20, 111);
    c.quadraticCurveTo(15, 106, 20, 100);
    shapeDone(c, pal, 92, 117);
  }

  function drawPawnArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(36, 100);
    c.quadraticCurveTo(40, 72, 43, 58);
    c.lineTo(57, 58);
    c.quadraticCurveTo(60, 72, 64, 100);
    c.closePath();
    shapeDone(c, pal, 58, 100);
    c.beginPath();
    c.ellipse(50, 57, 13, 5, 0, 0, Math.PI * 2);
    shapeDone(c, pal, 52, 62);
    c.beginPath();
    c.arc(50, 40, 14, 0, Math.PI * 2);
    shapeDone(c, pal, 26, 54);
    drawGloss(c, pal, 45, 34, 6);
  }

  function drawRookArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(35, 100);
    c.lineTo(38, 54);
    c.lineTo(62, 54);
    c.lineTo(65, 100);
    c.closePath();
    shapeDone(c, pal, 54, 100);
    c.beginPath();
    c.moveTo(31, 54);
    c.lineTo(31, 26);
    c.lineTo(41, 26);
    c.lineTo(41, 34);
    c.lineTo(46, 34);
    c.lineTo(46, 26);
    c.lineTo(54, 26);
    c.lineTo(54, 34);
    c.lineTo(59, 34);
    c.lineTo(59, 26);
    c.lineTo(69, 26);
    c.lineTo(69, 54);
    c.closePath();
    shapeDone(c, pal, 26, 54);
    c.strokeStyle = pal.detail;
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(50, 64);
    c.lineTo(50, 78);
    c.stroke();
    drawGloss(c, pal, 43, 32, 6);
  }

  function drawKnightArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(33, 100);
    c.quadraticCurveTo(30, 78, 36, 58);
    c.quadraticCurveTo(28, 56, 21, 48);
    c.quadraticCurveTo(17, 43, 19, 38);
    c.quadraticCurveTo(26, 33, 35, 30);
    c.lineTo(40, 17);
    c.lineTo(46, 27);
    c.lineTo(54, 16);
    c.lineTo(57, 28);
    c.quadraticCurveTo(68, 38, 69, 56);
    c.quadraticCurveTo(70, 78, 67, 100);
    c.closePath();
    shapeDone(c, pal, 16, 100);
    c.fillStyle = pal.line;
    c.beginPath();
    c.arc(33, 40, 2.3, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(23, 42, 1.6, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = pal.detail;
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(58, 34);
    c.quadraticCurveTo(63, 48, 61, 62);
    c.moveTo(61, 44);
    c.quadraticCurveTo(65, 58, 63, 74);
    c.stroke();
    drawGloss(c, pal, 42, 34, 7);
  }

  function drawBishopArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(37, 100);
    c.quadraticCurveTo(42, 76, 44, 62);
    c.lineTo(56, 62);
    c.quadraticCurveTo(58, 76, 63, 100);
    c.closePath();
    shapeDone(c, pal, 62, 100);
    c.beginPath();
    c.ellipse(50, 61, 12, 4.6, 0, 0, Math.PI * 2);
    shapeDone(c, pal, 56, 66);
    c.beginPath();
    c.moveTo(50, 20);
    c.quadraticCurveTo(64, 32, 62, 46);
    c.quadraticCurveTo(60, 56, 50, 58);
    c.quadraticCurveTo(40, 56, 38, 46);
    c.quadraticCurveTo(36, 32, 50, 20);
    shapeDone(c, pal, 20, 58);
    c.strokeStyle = pal.detail;
    c.lineWidth = 2.6;
    c.beginPath();
    c.moveTo(53, 28);
    c.lineTo(44, 44);
    c.stroke();
    c.beginPath();
    c.arc(50, 14, 4.4, 0, Math.PI * 2);
    shapeDone(c, pal, 10, 19);
    drawGloss(c, pal, 45, 32, 6);
  }

  function drawQueenArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(33, 100);
    c.quadraticCurveTo(40, 76, 43, 58);
    c.lineTo(57, 58);
    c.quadraticCurveTo(60, 76, 67, 100);
    c.closePath();
    shapeDone(c, pal, 58, 100);
    c.beginPath();
    c.ellipse(50, 57, 13, 4.8, 0, 0, Math.PI * 2);
    shapeDone(c, pal, 52, 62);
    c.beginPath();
    c.moveTo(36, 54);
    c.lineTo(30, 24);
    c.lineTo(41, 38);
    c.lineTo(50, 18);
    c.lineTo(59, 38);
    c.lineTo(70, 24);
    c.lineTo(64, 54);
    c.closePath();
    shapeDone(c, pal, 18, 54);
    for (const [px, py] of [[30, 24], [50, 18], [70, 24]]) {
      c.beginPath();
      c.arc(px, py, 3.2, 0, Math.PI * 2);
      shapeDone(c, pal, py - 3, py + 3);
    }
    drawGloss(c, pal, 44, 36, 7);
  }

  function drawKingArt(c, pal) {
    drawBase(c, pal);
    c.beginPath();
    c.moveTo(33, 100);
    c.quadraticCurveTo(40, 76, 43, 56);
    c.lineTo(57, 56);
    c.quadraticCurveTo(60, 76, 67, 100);
    c.closePath();
    shapeDone(c, pal, 56, 100);
    c.beginPath();
    c.ellipse(50, 55, 13, 4.8, 0, 0, Math.PI * 2);
    shapeDone(c, pal, 50, 60);
    c.beginPath();
    c.moveTo(37, 52);
    c.quadraticCurveTo(34, 38, 38, 30);
    c.lineTo(62, 30);
    c.quadraticCurveTo(66, 38, 63, 52);
    c.closePath();
    shapeDone(c, pal, 30, 52);
    c.strokeStyle = pal.line;
    c.lineWidth = 5.4;
    c.beginPath();
    c.moveTo(50, 8);
    c.lineTo(50, 26);
    c.moveTo(43, 15);
    c.lineTo(57, 15);
    c.stroke();
    c.strokeStyle = pal.top;
    c.lineWidth = 2.4;
    c.beginPath();
    c.moveTo(50, 8);
    c.lineTo(50, 26);
    c.moveTo(43, 15);
    c.lineTo(57, 15);
    c.stroke();
    drawGloss(c, pal, 44, 36, 7);
  }

  function drawPieceArt(c, type, white) {
    const pal = piecePalette(white);
    if (type === "p") drawPawnArt(c, pal);
    else if (type === "r") drawRookArt(c, pal);
    else if (type === "n") drawKnightArt(c, pal);
    else if (type === "b") drawBishopArt(c, pal);
    else if (type === "q") drawQueenArt(c, pal);
    else drawKingArt(c, pal);
  }

  function create(host, initialState) {
    const canvas = host.canvas;
    const ctx = canvas.getContext("2d");
    const isHost = () => !!host.isHost?.();
    const myId = host.myId;

    let rafId = 0;
    let frameTimer = null;
    let nextFrameAt = 0;
    let W = 0;
    let H = 0;
    let lastHeartbeatAt = 0;
    let lastTapAt = 0;
    let boardGesture = null;
    let ripples = [];
    let drag = null;
    let dropAnim = null;
    let glides = [];
    let sinks = [];
    let audioCtx = null;
    let localNotice = null;
    let lastDragSentAt = 0;
    let remoteSettles = [];
    let recentRemoteDrops = [];
    let promoPick = null;
    let checkIdx = -1;
    let clockAnchor = 0;
    let snapshotAt = 0;
    let notationScroll = 0;
    let notationCollapsed = false;
    let lastHistLen = 0;
    let panelDrag = null;
    let flipped = false;
    const remoteDrags = new Map();
    let state = defaultState();
    const view = { zoom: 1, rot: 0, panX: 0, panY: 0 };
    const activePointers = new Map();
    const padSeed = Math.floor(Math.random() * 1_000_000_000);
    const pads = makePads();
    const bgLayer = { canvas: null, w: 0, h: 0 };
    const vignetteLayer = { canvas: null, w: 0, h: 0 };

    function isMobileLike() {
      return (window.matchMedia?.("(pointer: coarse)").matches || Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 760);
    }

    function hasRemotePeers() {
      return host.getPlayers?.().some((p) => p.id !== myId) || false;
    }

    function targetFrameMs() {
      if (!isMobileLike()) return DESKTOP_RENDER_FRAME_MS;
      return hasRemotePeers() ? MOBILE_REMOTE_RENDER_FRAME_MS : MOBILE_RENDER_FRAME_MS;
    }

    function effectiveDevicePixelRatio() {
      return Math.min(window.devicePixelRatio || 1, isMobileLike() ? MOBILE_DPR_CAP : DESKTOP_DPR_CAP);
    }

    function defaultState() {
      return {
        game: GAME_ID,
        rev: 0,
        createdAt: Date.now(),
        board: startingBoard(),
        seats: { white: null, black: null },
        turn: "w",
        castling: { K: true, Q: true, k: true, q: true },
        ep: -1,
        halfmove: 0,
        fullmove: 1,
        over: false,
        result: null,
        history: [],
        clockW: CLOCK_BANK_MS,
        clockB: CLOCK_BANK_MS,
        undoReq: null,
        message: "The pond settles into sixty-four squares.",
      };
    }

    function resetHostState() {
      const rev = (state.rev || 0) + 1;
      const keepSeats = state.seats ? { ...state.seats } : { white: null, black: null };
      state = defaultState();
      state.rev = rev;
      state.seats = keepSeats;
      glides = [];
      sinks = [];
      remoteSettles = [];
      promoPick = null;
      clockAnchor = 0;
      refreshCheck();
    }

    function makeSnapshot() {
      return {
        ...state,
        board: state.board.slice(),
        seats: { ...seats() },
        castling: { ...state.castling },
        history: (state.history || []).map((h) => ({ ...h })),
        undoReq: state.undoReq ? { ...state.undoReq } : null,
        full: true,
      };
    }

    function applySnapshot(snapshot) {
      if (!snapshot || snapshot.game !== GAME_ID) return;
      const before = Array.isArray(state.board) && state.board.length === 64 ? state.board.slice() : null;
      state = { ...defaultState(), ...snapshot };
      if (!Array.isArray(state.board) || state.board.length !== 64) state.board = startingBoard();
      state.board = state.board.map((cell) => (typeof cell === "string" && /^[prnbqk]$/i.test(cell) ? cell : ""));
      const rawSeats = state.seats && typeof state.seats === "object" ? state.seats : {};
      state.seats = {
        white: typeof rawSeats.white === "string" ? rawSeats.white : null,
        black: typeof rawSeats.black === "string" ? rawSeats.black : null,
      };
      state.turn = state.turn === "b" ? "b" : "w";
      const rc = state.castling && typeof state.castling === "object" ? state.castling : {};
      state.castling = { K: rc.K !== false, Q: rc.Q !== false, k: rc.k !== false, q: rc.q !== false };
      state.ep = Number.isInteger(state.ep) && state.ep >= 0 && state.ep < 64 ? state.ep : -1;
      state.halfmove = Number.isInteger(state.halfmove) && state.halfmove >= 0 ? state.halfmove : 0;
      state.fullmove = Number.isInteger(state.fullmove) && state.fullmove >= 1 ? state.fullmove : 1;
      state.over = !!state.over;
      state.result = ["white", "black", "draw"].includes(state.result) ? state.result : null;
      state.history = Array.isArray(state.history)
        ? state.history.filter((h) => h && Number.isInteger(h.from) && Number.isInteger(h.to) && typeof h.san === "string")
            .map((h) => ({ from: h.from, to: h.to, promo: typeof h.promo === "string" ? h.promo : null, san: h.san }))
        : [];
      state.clockW = Number.isFinite(state.clockW) ? clamp(state.clockW, 0, CLOCK_BANK_MS) : CLOCK_BANK_MS;
      state.clockB = Number.isFinite(state.clockB) ? clamp(state.clockB, 0, CLOCK_BANK_MS) : CLOCK_BANK_MS;
      const ur = state.undoReq;
      state.undoReq = ur && typeof ur === "object" && typeof ur.by === "string" && Number.isInteger(ur.ply) && ur.ply >= 0
        ? { by: ur.by, ply: ur.ply, color: ur.color === "b" ? "b" : "w" }
        : null;
      snapshotAt = now();
      if (promoPick && (state.over || state.turn !== promoPick.color || state.board[promoPick.from] !== (promoPick.color === "w" ? "P" : "p"))) promoPick = null;
      if (before) spawnMoveAnimations(before, state.board);
      refreshCheck();
    }

    function spawnMoveAnimations(before, after) {
      if (drag || dropAnim) return;
      const vacated = [];
      const appeared = [];
      for (let i = 0; i < 64; i++) {
        if (before[i] === after[i]) continue;
        if (before[i] && !after[i]) vacated.push(i);
        if (after[i] && before[i] !== after[i]) appeared.push(i);
      }
      if (!appeared.length) return;
      if (appeared.length > 6) { glides = []; sinks = []; return; }
      let moved = false;
      let capturedAny = false;
      for (const to of appeared) {
        const letter = after[to];
        let fromPos = vacated.findIndex((idx) => before[idx] === letter);
        if (fromPos < 0) fromPos = vacated.findIndex((idx) => before[idx] && pieceColor(before[idx]) === pieceColor(letter));
        if (fromPos < 0) continue;
        const from = vacated.splice(fromPos, 1)[0];
        if (before[to]) {
          sinks.push({ letter: before[to], idx: to, start: now(), dur: 260 });
          capturedAny = true;
        }
        if (!consumeRemoteDrop(from, to)) glides.push({ letter, from, to, start: now(), dur: 200 });
        moved = true;
        if (glides.length >= 6) break;
      }
      for (const idx of vacated) {
        if (!before[idx]) continue;
        sinks.push({ letter: before[idx], idx, start: now(), dur: 260 });
        capturedAny = true;
      }
      if (moved) playSound(capturedAny ? "capture" : "place", 0.55);
    }

    function handleAction(id, input) {
      if (!isHost() || !input || typeof input !== "object") return;
      if (input.type === "reset") resetHostState();
      else if (input.type === "seat") claimSeat(id, input.seat);
      else if (input.type === "undo-request") handleUndoRequest(id, input.ply | 0);
      else if (input.type === "undo-response") handleUndoResponse(id, !!input.accept);
      else if (input.type === "move") {
        const from = input.from | 0;
        const to = input.to | 0;
        const promo = typeof input.promo === "string" && PROMO_LETTERS.includes(input.promo) ? input.promo : null;
        const letter = state.board[from];
        const move = letter ? findLegalMove(id, from, to, promo) : null;
        if (!move) {
          host.broadcastState(makeSnapshot());
          return;
        }
        const captured = state.board[to];
        const info = applyAndRecord(state, move);
        state.message = moveMessage(move, info);
        state.undoReq = null;
        clockAnchor = now();
        refreshCheck();
        if (id !== myId) {
          if (info.captured) {
            const sinkIdx = move.ep ? move.to + (info.color === "w" ? 8 : -8) : to;
            sinks.push({ letter: info.captured, idx: sinkIdx, start: now(), dur: 260 });
          }
          if (!consumeRemoteDrop(from, to)) glides.push({ letter: state.board[to], from, to, start: now(), dur: 200 });
          if (move.castle) {
            const home = info.color === "w" ? 60 : 4;
            const rFrom = move.castle === "k" ? home + 3 : home - 4;
            const rTo = move.castle === "k" ? home + 1 : home - 1;
            glides.push({ letter: state.board[rTo], from: rFrom, to: rTo, start: now(), dur: 200 });
          }
          playSound(info.captured || captured ? "capture" : "place", 0.55);
        } else {
          if (move.castle) {
            const home = info.color === "w" ? 60 : 4;
            const rFrom = move.castle === "k" ? home + 3 : home - 4;
            const rTo = move.castle === "k" ? home + 1 : home - 1;
            glides.push({ letter: state.board[rTo], from: rFrom, to: rTo, start: now(), dur: 200 });
          }
          if (move.ep && info.captured) {
            sinks.push({ letter: info.captured, idx: move.to + (info.color === "w" ? 8 : -8), start: now(), dur: 260 });
          }
        }
      }
      host.broadcastState(makeSnapshot());
    }

    function findLegalMove(id, from, to, promo) {
      const letter = state.board[from];
      if (!letter || state.over) return null;
      if (!canMovePiece(id, letter)) return null;
      if (pieceColor(letter) !== state.turn) return null;
      const moves = legalMovesFrom(state, from).filter((m) => m.to === to);
      if (!moves.length) return null;
      if (moves[0].promo) return moves.find((m) => m.promo === (promo || "q")) || moves[0];
      return moves[0];
    }

    function handleUndoRequest(id, ply) {
      const s = seats();
      const color = s.white === id ? "w" : s.black === id ? "b" : null;
      const hist = state.history || [];
      if (!color || state.undoReq || !hist.length || ply < 0 || ply >= hist.length) return;
      const oppId = color === "w" ? s.black : s.white;
      if (!oppId) {
        performUndo(ply, id);
      } else {
        state.undoReq = { by: id, ply, color };
        state.message = `${playerName(id)} asks to take back ${describePly(hist, ply)}.`;
        state.rev = (state.rev || 0) + 1;
      }
    }

    function handleUndoResponse(id, accept) {
      const req = state.undoReq;
      if (!req) return;
      const s = seats();
      const oppId = req.color === "w" ? s.black : s.white;
      if (id === req.by) {
        if (!accept) {
          state.undoReq = null;
          state.message = `${playerName(id)} withdraws the take-back request.`;
          state.rev = (state.rev || 0) + 1;
        }
      } else if (id === oppId) {
        if (accept) performUndo(req.ply, req.by);
        else {
          state.undoReq = null;
          state.message = `${playerName(id)} declines the take-back.`;
          state.rev = (state.rev || 0) + 1;
        }
      }
    }

    function performUndo(ply, byId) {
      const oldHist = state.history || [];
      const target = clamp(ply, 0, oldHist.length);
      const fresh = defaultState();
      fresh.rev = (state.rev || 0) + 1;
      fresh.seats = { ...seats() };
      fresh.clockW = state.clockW;
      fresh.clockB = state.clockB;
      for (const h of oldHist.slice(0, target)) {
        const moves = legalMovesFrom(fresh, h.from).filter((m) => m.to === h.to);
        const move = h.promo ? moves.find((m) => m.promo === h.promo) || moves[0] : moves[0];
        if (!move) break;
        applyAndRecord(fresh, move);
      }
      fresh.message = `${playerName(byId)} takes back ${describePly(oldHist, target)}. The ripples rewind.`;
      state = fresh;
      glides = [];
      sinks = [];
      remoteSettles = [];
      promoPick = null;
      dropAnim = null;
      clockAnchor = 0;
      playSound("reset", 0.5);
      refreshCheck();
    }

    function clocksRunning() {
      const s = seats();
      return !state.over && !!s.white && !!s.black && (state.history?.length || 0) > 0;
    }

    function tickClocks() {
      if (!isHost()) return;
      if (state.undoReq) {
        const s = seats();
        const oppId = state.undoReq.color === "w" ? s.black : s.white;
        if (!oppId) {
          performUndo(state.undoReq.ply, state.undoReq.by);
          host.broadcastState(makeSnapshot());
        }
      }
      if (!clocksRunning()) { clockAnchor = 0; return; }
      const t = now();
      if (!clockAnchor) { clockAnchor = t; return; }
      const elapsed = t - clockAnchor;
      clockAnchor = t;
      const key = state.turn === "w" ? "clockW" : "clockB";
      state[key] = Math.max(0, state[key] - elapsed);
      if (state[key] === 0) {
        state.over = true;
        state.result = state.turn === "w" ? "black" : "white";
        state.message = `${state.turn === "w" ? "White" : "Black"}'s time drains into the pond — ${state.result} wins on time.`;
        state.rev = (state.rev || 0) + 1;
        refreshCheck();
        host.broadcastState(makeSnapshot());
      }
    }

    function displayClock(color) {
      let ms = color === "w" ? state.clockW : state.clockB;
      if (!isHost() && clocksRunning() && state.turn === color && snapshotAt) {
        ms -= now() - snapshotAt;
      }
      return clamp(ms, 0, CLOCK_BANK_MS);
    }

    function refreshCheck() {
      checkIdx = !state.over && inCheck(state.board, state.turn) ? findKing(state.board, state.turn) : -1;
      if (state.over && state.result) {
        const kIdx = state.result === "draw" ? -1 : findKing(state.board, state.result === "white" ? "b" : "w");
        checkIdx = kIdx;
      }
    }

    function seats() {
      if (!state.seats || typeof state.seats !== "object") state.seats = { white: null, black: null };
      return state.seats;
    }

    function playerName(id) {
      const p = (host.getPlayers?.() || []).find((pl) => pl.id === id) || host.getProfile?.(id);
      return p?.name || "A player";
    }

    function canMovePiece(id, letter) {
      const seat = isWhitePiece(letter) ? seats().white : seats().black;
      return !seat || seat === id;
    }

    function pickupBlockReason(letter) {
      if (state.over) {
        return state.result === "draw"
          ? "The game ended in a draw. Tap reset to play again."
          : `Checkmate — ${state.result} won. Tap reset to play again.`;
      }
      if (!canMovePiece(myId, letter)) {
        const owner = isWhitePiece(letter) ? seats().white : seats().black;
        return `${playerName(owner)} holds the ${isWhitePiece(letter) ? "white" : "black"} pieces.`;
      }
      if (pieceColor(letter) !== state.turn) {
        return `${state.turn === "w" ? "White" : "Black"} to move — wait for your turn.`;
      }
      return null;
    }

    function claimSeat(id, seat) {
      const s = seats();
      if (seat === "white" || seat === "black") {
        if (s[seat] && s[seat] !== id) return;
        if (s.white === id) s.white = null;
        if (s.black === id) s.black = null;
        s[seat] = id;
        state.message = `${playerName(id)} takes the ${seat} pieces.`;
      } else {
        if (s.white !== id && s.black !== id) return;
        if (s.white === id) s.white = null;
        if (s.black === id) s.black = null;
        state.message = `${playerName(id)} settles back to watch.`;
      }
      state.rev = (state.rev || 0) + 1;
    }

    function notice(text) {
      localNotice = { text, until: now() + 2000 };
    }

    function sendAction(input) {
      if (isHost()) handleAction(myId, input);
      else host.sendInput(input);
    }

    function consumeRemoteDrop(from, to) {
      const t = now();
      recentRemoteDrops = recentRemoteDrops.filter((d) => t - d.at < 1000);
      const i = recentRemoteDrops.findIndex((d) => d.from === from && d.to === to);
      if (i < 0) return false;
      recentRemoteDrops.splice(i, 1);
      return true;
    }

    function handlePeerEvent(id, event) {
      if (!event || typeof event !== "object" || id === myId) return;
      if (event.kind === "drag") {
        const letter = typeof event.letter === "string" && /^[prnbqk]$/i.test(event.letter) ? event.letter : "";
        const from = event.from | 0;
        if (!letter || from < 0 || from > 63) return;
        remoteDrags.set(id, { letter, from, bx: +event.bx || 0, by: +event.by || 0, at: now() });
      } else if (event.kind === "drop") {
        const d = remoteDrags.get(id);
        remoteDrags.delete(id);
        if (!d) return;
        const to = event.to | 0;
        if (to < 0 || to > 63) return;
        remoteSettles.push({ letter: d.letter, from: d.from, to, x0: d.bx, y0: d.by - 0.3, start: now(), dur: 150 });
        recentRemoteDrops.push({ from: d.from, to, at: now() });
      }
    }

    function applyLocalMove(move) {
      const info = applyAndRecord(state, move);
      state.message = moveMessage(move, info);
      state.undoReq = null;
      refreshCheck();
      if (move.castle) {
        const home = info.color === "w" ? 60 : 4;
        const rFrom = move.castle === "k" ? home + 3 : home - 4;
        const rTo = move.castle === "k" ? home + 1 : home - 1;
        glides.push({ letter: state.board[rTo], from: rFrom, to: rTo, start: now(), dur: 200 });
      }
      if (move.ep && info.captured) {
        sinks.push({ letter: info.captured, idx: move.to + (info.color === "w" ? 8 : -8), start: now(), dur: 260 });
      }
      return info;
    }

    function sendMove(move) {
      if (isHost()) {
        handleAction(myId, { type: "move", from: move.from, to: move.to, promo: move.promo || null });
      } else {
        applyLocalMove(move);
        host.sendInput({ type: "move", from: move.from, to: move.to, promo: move.promo || null });
      }
    }

    function playSound(kind, gainMul = 1) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        const t = audioCtx.currentTime;
        const tones = {
          pickup: [[520, 0.09, 0.020], [700, 0.12, 0.012]],
          place: [[330, 0.10, 0.026], [440, 0.16, 0.018]],
          capture: [[220, 0.16, 0.030], [160, 0.22, 0.024], [440, 0.10, 0.012]],
          reset: [[260, 0.18, 0.020], [390, 0.24, 0.018]],
        };
        for (const [freq, dur, vol] of tones[kind] || tones.place) {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, t);
          osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + dur);
          gain.gain.setValueAtTime(vol * gainMul, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t);
          osc.stop(t + dur);
        }
      } catch {}
    }

    function easeOutCubic(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }

    function squareIndexAt(bx, by) {
      const col = Math.floor(bx);
      const row = Math.floor(by);
      if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
      return row * 8 + col;
    }

    function squareCenter(idx) {
      return { x: (idx % 8) + 0.5, y: Math.floor(idx / 8) + 0.5 };
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = effectiveDevicePixelRatio();
      W = rect.width;
      H = rect.height;
      const w = Math.max(1, Math.round(W * dpr));
      const h = Math.max(1, Math.round(H * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ---- camera ----------------------------------------------------------
    // Board space: 8x8 cells, x/y in [0, 8), board centre at (4, 4).

    function baseScale() {
      return Math.max(24, (Math.min(W, H) * 0.86) / 9.7);
    }

    function cellPx() { return baseScale() * view.zoom; }
    function centerX() { return W / 2 + view.panX; }
    function centerY() { return H / 2 + view.panY; }

    function boardToScreen(bx, by) {
      const s = cellPx();
      const gx = (bx - 4) * s;
      const gy = (by - 4) * s;
      const c = Math.cos(view.rot), n = Math.sin(view.rot);
      return { x: centerX() + gx * c - gy * n, y: centerY() + gx * n + gy * c };
    }

    function screenToBoard(px, py) {
      const s = cellPx();
      const dx = px - centerX();
      const dy = py - centerY();
      const c = Math.cos(-view.rot), n = Math.sin(-view.rot);
      return { x: (dx * c - dy * n) / s + 4, y: (dx * n + dy * c) / s + 4 };
    }

    function overFrame(b) {
      const pad = 0.62;
      return b.x >= -pad && b.x < 8 + pad && b.y >= -pad && b.y < 8 + pad;
    }

    function resetView() {
      view.zoom = 1;
      view.rot = flipped ? Math.PI : 0;
      view.panX = 0;
      view.panY = 0;
    }

    // ---- gestures ---------------------------------------------------------

    function pointerPoint(e) {
      const r = canvas.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      return { x: touch.clientX - r.left, y: touch.clientY - r.top };
    }

    function eventPoint(e) {
      if (e.offsetX !== undefined && e.offsetY !== undefined) return { x: e.offsetX, y: e.offsetY };
      return pointerPoint(e);
    }

    function gestureMetrics(points) {
      const a = points[0], b = points[1];
      return {
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }

    function startBoardGesture() {
      const points = [...activePointers.values()];
      if (!points.length) return;
      if (points.length >= 2) {
        const g = gestureMetrics(points);
        boardGesture = { mode: "pinch", start: g, zoom: view.zoom, rot: view.rot, panX: view.panX, panY: view.panY };
      } else {
        const p = points[0];
        boardGesture = { mode: "pan", x: p.x, y: p.y, panX: view.panX, panY: view.panY };
      }
    }

    function updateBoardGesture() {
      if (!boardGesture) return;
      const points = [...activePointers.values()];
      if (points.length >= 2) {
        if (boardGesture.mode !== "pinch") startBoardGesture();
        const g = gestureMetrics(points);
        view.zoom = clamp(boardGesture.zoom * (g.dist / boardGesture.start.dist), MIN_ZOOM, MAX_ZOOM);
        view.rot = boardGesture.rot + g.angle - boardGesture.start.angle;
        view.panX = boardGesture.panX + g.cx - boardGesture.start.cx;
        view.panY = boardGesture.panY + g.cy - boardGesture.start.cy;
      } else if (points.length === 1) {
        if (boardGesture.mode !== "pan") startBoardGesture();
        const p = points[0];
        view.panX = boardGesture.panX + p.x - boardGesture.x;
        view.panY = boardGesture.panY + p.y - boardGesture.y;
      }
    }

    function addRipple(bx, by, faint = false) {
      ripples.push({ x: bx, y: by, start: now(), faint });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    }

    // ---- seat bar (screen space) ------------------------------------------

    function seatBarRects() {
      const bw = Math.min(390, W - 24);
      const bh = 34;
      const x = (W - bw) / 2;
      const y = 10;
      const third = bw / 3;
      return {
        bar: { x, y, w: bw, h: bh },
        white: { x, y, w: third, h: bh },
        black: { x: x + third, y, w: third, h: bh },
        watch: { x: x + third * 2, y, w: third, h: bh },
      };
    }

    function pointIn(r, x, y) { return r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h; }

    function mySeat() {
      const s = seats();
      if (s.white === myId) return "white";
      if (s.black === myId) return "black";
      return null;
    }

    function seatTapAt(x, y) {
      const r = seatBarRects();
      if (!pointIn(r.bar, x, y)) return false;
      const s = seats();
      if (pointIn(r.white, x, y)) {
        if (s.white && s.white !== myId) notice(`${playerName(s.white)} holds the white pieces.`);
        else {
          const claiming = s.white !== myId;
          sendAction({ type: "seat", seat: claiming ? "white" : "spectator" });
          if (claiming) { flipped = false; fitView(); }
        }
      } else if (pointIn(r.black, x, y)) {
        if (s.black && s.black !== myId) notice(`${playerName(s.black)} holds the black pieces.`);
        else {
          const claiming = s.black !== myId;
          sendAction({ type: "seat", seat: claiming ? "black" : "spectator" });
          if (claiming) { flipped = true; fitView(); }
        }
      } else if (pointIn(r.watch, x, y)) {
        if (mySeat()) sendAction({ type: "seat", seat: "spectator" });
      }
      return true;
    }

    // ---- notation panel -----------------------------------------------------

    const NOTE_ROW_H = 18;
    const NOTE_HEADER_H = 22;
    const NOTE_PAD = 6;

    function notationRect() {
      const hist = state.history || [];
      if (!hist.length) return null;
      if (notationCollapsed) {
        const w = 86;
        return { x: W - w - 10, y: 56, w, h: NOTE_HEADER_H + 4, collapsed: true };
      }
      const w = Math.min(126, Math.max(98, W * 0.22));
      const y = 56;
      const h = Math.max(90, Math.min(H - y - 112, NOTE_HEADER_H + NOTE_PAD * 2 + Math.ceil(hist.length / 2) * NOTE_ROW_H));
      return { x: W - w - 10, y, w, h };
    }

    function notationMaxScroll(r) {
      const rows = Math.ceil((state.history || []).length / 2);
      return Math.max(0, rows * NOTE_ROW_H - (r.h - NOTE_HEADER_H - NOTE_PAD * 2));
    }

    function toggleNotation() {
      notationCollapsed = !notationCollapsed;
      if (!notationCollapsed) {
        const r = notationRect();
        if (r) notationScroll = notationMaxScroll(r);
      }
    }

    function notationPointerDown(p, pointerId) {
      const r = notationRect();
      if (!r || !pointIn(r, p.x, p.y)) return false;
      panelDrag = { pointerId, startY: p.y, startScroll: notationScroll, moved: false };
      return true;
    }

    function notationTapAt(x, y) {
      const r = notationRect();
      if (!r || !pointIn(r, x, y)) return;
      if (r.collapsed || y <= r.y + NOTE_HEADER_H) { toggleNotation(); return; }
      const hist = state.history || [];
      const localY = y - (r.y + NOTE_HEADER_H + NOTE_PAD) + notationScroll;
      const row = Math.floor(localY / NOTE_ROW_H);
      if (row < 0) return;
      const numW = 24;
      const colW = (r.w - numW - NOTE_PAD * 2) / 2;
      const localX = x - (r.x + NOTE_PAD + numW);
      const ply = row * 2 + (localX >= colW ? 1 : 0);
      if (localX < 0 || ply >= hist.length) return;
      requestUndoAt(ply);
    }

    function requestUndoAt(ply) {
      if (!mySeat()) { notice("Claim a seat to request a take-back."); return; }
      if (state.undoReq) { notice("A take-back is already pending."); return; }
      notice(`Asking to take back ${describePly(state.history, ply)}…`);
      sendAction({ type: "undo-request", ply });
    }

    function respondUndo(accept) {
      sendAction({ type: "undo-response", accept });
    }

    // ---- undo pill ----------------------------------------------------------

    function undoPillLayout() {
      const req = state.undoReq;
      if (!req) return null;
      const s = seats();
      const mine = req.by === myId;
      const approver = (req.color === "w" ? s.black : s.white) === myId;
      const buttons = mine
        ? [{ id: "cancel", label: "Cancel" }]
        : approver
          ? [{ id: "allow", label: "Allow" }, { id: "decline", label: "Decline" }]
          : [];
      const bw = Math.min(430, W - 20);
      const bh = 30;
      const x = (W - bw) / 2;
      const y = 52;
      const btnW = 58, btnH = 22, gap = 6;
      let bx = x + bw - NOTE_PAD;
      const rects = [];
      for (let i = buttons.length - 1; i >= 0; i--) {
        bx -= btnW;
        rects.unshift({ ...buttons[i], x: bx, y: y + (bh - btnH) / 2, w: btnW, h: btnH });
        bx -= gap;
      }
      return { bar: { x, y, w: bw, h: bh }, buttons: rects, req, mine, approver };
    }

    function undoTapAt(x, y) {
      const l = undoPillLayout();
      if (!l || !pointIn(l.bar, x, y)) return false;
      for (const b of l.buttons) {
        if (pointIn(b, x, y)) {
          respondUndo(b.id === "allow");
          return true;
        }
      }
      return true;
    }

    // ---- fit / flip controls ------------------------------------------------

    function controlRects() {
      const h = 26, w = 52, gap = 8;
      const y = H - h - 12;
      return {
        fit: { x: 12, y, w, h },
        flip: { x: 12 + w + gap, y, w, h },
      };
    }

    function fitView() { resetView(); }

    function flipBoard() {
      flipped = !flipped;
      view.rot = flipped ? Math.PI : 0;
    }

    function controlTapAt(x, y) {
      const r = controlRects();
      if (pointIn(r.fit, x, y)) { fitView(); return true; }
      if (pointIn(r.flip, x, y)) { flipBoard(); return true; }
      return false;
    }

    function onPointerDown(e) {
      if (drag) { e.preventDefault(); return; }
      const p = pointerPoint(e);
      const pointerId = e.pointerId ?? "mouse";
      e.preventDefault();
      if (promoPick) { promoTapAt(p.x, p.y); return; }
      if (!activePointers.size) {
        if (undoTapAt(p.x, p.y)) return;
        if (seatTapAt(p.x, p.y)) return;
        if (controlTapAt(p.x, p.y)) return;
        if (notationPointerDown(p, pointerId)) {
          if (e.pointerId !== undefined) canvas.setPointerCapture?.(e.pointerId);
          return;
        }
      }
      const b = screenToBoard(p.x, p.y);
      const idx = squareIndexAt(b.x, b.y);
      const letter = idx >= 0 ? state.board[idx] : "";
      if (letter && !activePointers.size && !dropAnim) {
        const blocked = pickupBlockReason(letter);
        if (blocked) {
          notice(blocked);
          addRipple(b.x, b.y);
        } else {
          if (e.pointerId !== undefined) canvas.setPointerCapture?.(e.pointerId);
          const touch = (e.pointerType || (e.touches ? "touch" : "mouse")) === "touch";
          const legal = legalMovesFrom(state, idx);
          drag = { pointerId, letter, from: idx, bx: b.x, by: b.y, start: now(), lift: touch ? 0.52 : 0.14, legal, targets: new Set(legal.map((m) => m.to)) };
          addRipple(b.x, b.y);
          playSound("pickup");
          sendDragEvent(true);
          lastTapAt = 0;
          return;
        }
      }
      activePointers.set(pointerId, { x: p.x, y: p.y });
      if (e.pointerId !== undefined) canvas.setPointerCapture?.(e.pointerId);
      addRipple(b.x, b.y);
      if (activePointers.size === 1 && (!e.touches || e.touches.length <= 1)) {
        const t = now();
        if (!overFrame(b) && t - lastTapAt < 320) { resetView(); lastTapAt = 0; }
        else lastTapAt = overFrame(b) ? 0 : t;
      } else {
        lastTapAt = 0;
      }
      startBoardGesture();
    }

    function sendDragEvent(force = false) {
      if (!drag || !host.sendEvent) return;
      const t = now();
      if (!force && t - lastDragSentAt < 66) return;
      lastDragSentAt = t;
      host.sendEvent({
        kind: "drag",
        letter: drag.letter,
        from: drag.from,
        bx: Math.round(drag.bx * 100) / 100,
        by: Math.round((drag.by - dragLift(t)) * 100) / 100,
      });
    }

    function onPointerMove(e) {
      const pointerId = e.pointerId ?? "mouse";
      if (panelDrag && pointerId === panelDrag.pointerId) {
        e.preventDefault();
        const p = pointerPoint(e);
        const dy = p.y - panelDrag.startY;
        if (Math.abs(dy) > 4) panelDrag.moved = true;
        const r = notationRect();
        if (r && !r.collapsed) notationScroll = clamp(panelDrag.startScroll - dy, 0, notationMaxScroll(r));
        return;
      }
      if (drag && pointerId === drag.pointerId) {
        e.preventDefault();
        const p = pointerPoint(e);
        const b = screenToBoard(p.x, p.y);
        drag.bx = b.x;
        drag.by = b.y;
        sendDragEvent();
        return;
      }
      if (!activePointers.has(pointerId)) return;
      activePointers.set(pointerId, pointerPoint(e));
      updateBoardGesture();
      if (boardGesture) e.preventDefault();
    }

    function onPointerUp(e) {
      const pointerId = e.pointerId ?? "mouse";
      if (panelDrag && pointerId === panelDrag.pointerId) {
        e.preventDefault();
        const p = pointerPoint(e);
        if (!panelDrag.moved) notationTapAt(p.x, p.y);
        panelDrag = null;
        if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (drag && pointerId === drag.pointerId) {
        e.preventDefault();
        finishDrag(true);
        if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      activePointers.delete(pointerId);
      if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (!activePointers.size) boardGesture = null;
      else startBoardGesture();
    }

    function onLostPointerCapture(e) {
      const pointerId = e.pointerId ?? "mouse";
      if (panelDrag && pointerId === panelDrag.pointerId) { panelDrag = null; return; }
      if (drag && pointerId === drag.pointerId) { finishDrag(false); return; }
      activePointers.delete(pointerId);
      if (!activePointers.size) boardGesture = null;
    }

    function dragLift(ts) {
      if (!drag) return 0;
      return drag.lift * easeOutCubic((ts - drag.start) / 130);
    }

    function finishDrag(commit) {
      if (!drag) return;
      const held = drag;
      drag = null;
      const lift = held.lift * easeOutCubic((now() - held.start) / 130);
      const dropX = held.bx;
      const dropY = held.by - lift;
      const target = commit ? squareIndexAt(dropX, dropY) : -1;
      const stillMine = state.board[held.from] === held.letter && !state.over
        && pieceColor(held.letter) === state.turn && canMovePiece(myId, held.letter);
      const move = target >= 0 && target !== held.from && stillMine
        ? legalMovesFrom(state, held.from).find((m) => m.to === target)
        : null;
      if (commit && target >= 0 && target !== held.from && !move && !state.over) notice("That square lies beyond this piece's reach.");
      const to = move ? target : held.from;
      const captured = move ? state.board[to] : "";
      dropAnim = { letter: held.letter, to, x0: dropX, y0: dropY, start: now(), dur: 150, captured: !!captured };
      host.sendEvent?.({ kind: "drop", to });
      if (!move) return;
      if (move.promo) {
        promoPick = { from: held.from, to, color: pieceColor(held.letter) };
        return;
      }
      if (captured) {
        sinks.push({ letter: captured, idx: to, start: now(), dur: 260 });
      }
      sendMove(move);
    }

    // ---- promotion picker ---------------------------------------------------

    function promoRects() {
      if (!promoPick) return null;
      const size = Math.min(64, Math.max(48, W * 0.11));
      const gap = 10;
      const total = PROMO_LETTERS.length * size + (PROMO_LETTERS.length - 1) * gap;
      const x = (W - total) / 2;
      const y = H / 2 - size / 2;
      return PROMO_LETTERS.map((letter, i) => ({ letter, x: x + i * (size + gap), y, w: size, h: size }));
    }

    function promoTapAt(x, y) {
      const rects = promoRects();
      if (!rects) return;
      for (const r of rects) {
        if (pointIn(r, x, y)) {
          const pick = promoPick;
          promoPick = null;
          const move = (legalMovesFrom(state, pick.from) || []).find((m) => m.to === pick.to && m.promo === r.letter);
          if (move) {
            const captured = state.board[move.to];
            if (captured) sinks.push({ letter: captured, idx: move.to, start: now(), dur: 260 });
            sendMove(move);
          }
          return;
        }
      }
      promoPick = null;
      notice("The pawn waits at the bank — drag it again to promote.");
    }

    function onWheel(e) {
      e.preventDefault();
      const p = eventPoint(e);
      const nr = notationRect();
      if (nr && !nr.collapsed && pointIn(nr, p.x, p.y)) {
        notationScroll = clamp(notationScroll + e.deltaY * 0.5, 0, notationMaxScroll(nr));
        return;
      }
      const oldZoom = view.zoom;
      const nextZoom = clamp(view.zoom * Math.exp(-e.deltaY * 0.0014), MIN_ZOOM, MAX_ZOOM);
      const k = nextZoom / oldZoom;
      view.panX = p.x - W / 2 - (p.x - W / 2 - view.panX) * k;
      view.panY = p.y - H / 2 - (p.y - H / 2 - view.panY) * k;
      view.zoom = nextZoom;
    }

    function onKeyDown(e) {
      const target = document.activeElement || e.target;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "q" || e.key === "Q") { e.preventDefault(); view.rot -= Math.PI / 12; }
      else if (e.key === "e" || e.key === "E") { e.preventDefault(); view.rot += Math.PI / 12; }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); flipBoard(); }
      else if (e.key === "0") { e.preventDefault(); fitView(); }
      else if (e.key === "Escape" && drag) { e.preventDefault(); finishDrag(false); }
      else if (e.key === "Escape" && promoPick) { e.preventDefault(); promoPick = null; }
    }

    // ---- pond ambiance ----------------------------------------------------

    function makePads() {
      const list = [];
      for (let i = 0; i < 11; i++) {
        const angle = seeded(padSeed, i * 7 + 1) * Math.PI * 2;
        const dist = 5.4 + seeded(padSeed, i * 7 + 2) * 2.4;
        list.push({
          x: 4 + Math.cos(angle) * dist,
          y: 4 + Math.sin(angle) * dist,
          r: 0.26 + seeded(padSeed, i * 7 + 3) * 0.34,
          rot: seeded(padSeed, i * 7 + 4) * Math.PI * 2,
          spin: (seeded(padSeed, i * 7 + 5) - 0.5) * 0.00012,
          driftA: seeded(padSeed, i * 7 + 6) * Math.PI * 2,
          driftR: 0.05 + seeded(padSeed, i * 7 + 7) * 0.12,
          driftSpeed: 0.00004 + seeded(padSeed, i * 7 + 8) * 0.00005,
          shade: 0.82 + seeded(padSeed, i * 7 + 9) * 0.3,
        });
      }
      return list;
    }

    function spawnAmbientRipples() {
      if (Math.random() >= (isMobileLike() ? 0.015 : 0.03)) return;
      const b = screenToBoard(Math.random() * W, Math.random() * H);
      if (!overFrame(b)) addRipple(b.x, b.y, true);
    }

    // ---- drawing ----------------------------------------------------------

    function withCamera(fn) {
      ctx.save();
      ctx.translate(centerX(), centerY());
      ctx.rotate(view.rot);
      fn();
      ctx.restore();
    }

    function drawBackground() {
      if (!bgLayer.canvas || bgLayer.w !== W || bgLayer.h !== H) {
        bgLayer.canvas = document.createElement("canvas");
        bgLayer.canvas.width = Math.max(1, Math.round(W));
        bgLayer.canvas.height = Math.max(1, Math.round(H));
        bgLayer.w = W;
        bgLayer.h = H;
        const c = bgLayer.canvas.getContext("2d");
        const grad = c.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#10283a");
        grad.addColorStop(0.45, "#173d4d");
        grad.addColorStop(1, "#0d202d");
        c.fillStyle = grad;
        c.fillRect(0, 0, W, H);
      }
      ctx.drawImage(bgLayer.canvas, 0, 0, W, H);
    }

    function drawVignette() {
      if (!vignetteLayer.canvas || vignetteLayer.w !== W || vignetteLayer.h !== H) {
        vignetteLayer.canvas = document.createElement("canvas");
        vignetteLayer.canvas.width = Math.max(1, Math.round(W));
        vignetteLayer.canvas.height = Math.max(1, Math.round(H));
        vignetteLayer.w = W;
        vignetteLayer.h = H;
        const c = vignetteLayer.canvas.getContext("2d");
        const r = Math.hypot(W, H) * 0.62;
        const grad = c.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
        grad.addColorStop(0, "rgba(4, 12, 18, 0)");
        grad.addColorStop(1, "rgba(4, 12, 18, 0.42)");
        c.fillStyle = grad;
        c.fillRect(0, 0, W, H);
      }
      ctx.drawImage(vignetteLayer.canvas, 0, 0, W, H);
    }

    function drawRipples(ts) {
      const s = cellPx();
      const keep = [];
      for (const ripple of ripples) {
        const t = (ts - ripple.start) / 1400;
        if (t >= 1) continue;
        keep.push(ripple);
        const alpha = (1 - t) * (ripple.faint ? 0.14 : 0.38);
        ctx.strokeStyle = `rgba(180, 226, 244, ${alpha.toFixed(3)})`;
        ctx.lineWidth = Math.max(1, s * 0.028);
        const px = (ripple.x - 4) * s;
        const py = (ripple.y - 4) * s;
        for (let ring = 0; ring < 2; ring++) {
          const radius = (0.14 + t * 0.9) * s * (1 + ring * 0.55);
          ctx.beginPath();
          ctx.arc(px, py, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ripples = keep;
    }

    function drawPads(ts) {
      const s = cellPx();
      for (const pad of pads) {
        const wob = pad.driftA + ts * pad.driftSpeed;
        const px = (pad.x + Math.cos(wob) * pad.driftR - 4) * s;
        const py = (pad.y + Math.sin(wob) * pad.driftR - 4) * s;
        const pr = pad.r * s;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(pad.rot + ts * pad.spin);
        ctx.fillStyle = `rgba(47, 105, 74, ${(0.62 * pad.shade).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, pr, 0.34, Math.PI * 2 - 0.34);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(196, 232, 190, 0.22)";
        ctx.lineWidth = Math.max(1, pr * 0.08);
        ctx.stroke();
        ctx.strokeStyle = "rgba(20, 54, 40, 0.35)";
        ctx.lineWidth = Math.max(0.8, pr * 0.05);
        for (let v = 0; v < 4; v++) {
          const va = 0.75 + v * 1.35;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(va) * pr * 0.82, Math.sin(va) * pr * 0.82);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    function drawRoundRect(x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    function drawFrame() {
      const s = cellPx();
      const pad = s * 0.42;
      const o = -4 * s - pad;
      const size = 8 * s + pad * 2;
      ctx.fillStyle = "rgba(4, 12, 18, 0.34)";
      drawRoundRect(o + s * 0.08, o + s * 0.14, size, size, pad * 1.25);
      ctx.fill();
      const wood = ctx.createLinearGradient(o, o, o + size, o + size);
      wood.addColorStop(0, "#55432f");
      wood.addColorStop(0.5, FRAME_WOOD);
      wood.addColorStop(1, "#3c2f23");
      ctx.fillStyle = wood;
      drawRoundRect(o, o, size, size, pad * 1.25);
      ctx.fill();
      ctx.strokeStyle = FRAME_EDGE;
      ctx.lineWidth = Math.max(1.2, s * 0.05);
      ctx.stroke();
      const labelSize = Math.max(8, pad * 0.56);
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `700 ${labelSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < 8; i++) {
        const c = (i - 3.5) * s;
        ctx.fillText(FILES[i], c, 4 * s + pad * 0.52);
        ctx.fillText(FILES[i], c, -4 * s - pad * 0.52);
        ctx.fillText(String(8 - i), -4 * s - pad * 0.52, c);
        ctx.fillText(String(8 - i), 4 * s + pad * 0.52, c);
      }
    }

    function drawSquares() {
      const s = cellPx();
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          ctx.fillStyle = (row + col) % 2 === 0 ? LIGHT_SQUARE : DARK_SQUARE;
          ctx.fillRect((col - 4) * s, (row - 4) * s, s + 0.5, s + 0.5);
        }
      }
      const sheen = ctx.createLinearGradient(-4 * s, -4 * s, 4 * s, 4 * s);
      sheen.addColorStop(0, "rgba(255, 255, 255, 0.06)");
      sheen.addColorStop(0.5, "rgba(255, 255, 255, 0)");
      sheen.addColorStop(1, "rgba(9, 26, 34, 0.18)");
      ctx.fillStyle = sheen;
      ctx.fillRect(-4 * s, -4 * s, 8 * s, 8 * s);
    }

    function drawSquareGlow(idx, style, width) {
      const s = cellPx();
      const col = idx % 8;
      const row = Math.floor(idx / 8);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.strokeRect((col - 4) * s + width / 2, (row - 4) * s + width / 2, s - width, s - width);
    }

    function drawHighlights(ts) {
      if (checkIdx >= 0) {
        const pulse = 0.5 + Math.sin(ts * 0.008) * 0.2;
        drawSquareGlow(checkIdx, `rgba(255, 120, 96, ${pulse.toFixed(3)})`, Math.max(2, cellPx() * 0.07));
      }
      if (!drag) return;
      const lift = dragLift(ts);
      const idx = squareIndexAt(drag.bx, drag.by - lift);
      drawSquareGlow(drag.from, "rgba(180, 226, 244, 0.5)", Math.max(1.6, cellPx() * 0.045));
      if (idx >= 0 && idx !== drag.from) {
        const legal = drag.targets?.has(idx);
        const pulse = 0.62 + Math.sin(ts * 0.012) * 0.18;
        const color = legal ? `rgba(140, 232, 188, ${pulse.toFixed(3)})` : `rgba(232, 140, 122, ${(pulse * 0.7).toFixed(3)})`;
        drawSquareGlow(idx, color, Math.max(2, cellPx() * 0.07));
      }
    }

    function drawPieceShadow(bx, by, s, scale, lift) {
      const px = (bx - 4) * s;
      const py = (by - 4) * s;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-view.rot);
      ctx.beginPath();
      ctx.ellipse(0, s * 0.34, s * 0.30 * scale * (1 + lift * 0.4), s * 0.10 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(6, 16, 22, ${(0.26 / (1 + lift * 1.6)).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    }

    function drawPieceSprite(letter, bx, by, scale = 1, alpha = 1) {
      const s = cellPx();
      const sprite = pieceSprite(letter);
      const dw = s * 1.04 * scale;
      const dh = dw * (SPRITE_UNIT_H / SPRITE_UNIT_W);
      const px = (bx - 4) * s;
      const py = (by - 4) * s;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-view.rot);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, -dw / 2, s * 0.36 - dh * (112 / SPRITE_UNIT_H), dw, dh);
      ctx.restore();
    }

    function drawSinks(ts) {
      const keep = [];
      for (const sink of sinks) {
        const t = (ts - sink.start) / sink.dur;
        if (t >= 1) continue;
        keep.push(sink);
        const c = squareCenter(sink.idx);
        const ease = easeOutCubic(t);
        drawPieceSprite(sink.letter, c.x, c.y + ease * 0.22, 1 - ease * 0.34, 1 - ease);
      }
      sinks = keep;
    }

    function drawPieces(ts) {
      const s = cellPx();
      const skip = new Set();
      if (drag) skip.add(drag.from);
      if (dropAnim) skip.add(dropAnim.to);
      if (promoPick) skip.add(promoPick.from);
      for (const g of glides) skip.add(g.to);
      for (const r of remoteSettles) {
        skip.add(r.to);
        if (state.board[r.from] === r.letter) skip.add(r.from);
      }
      for (const d of remoteDrags.values()) skip.add(d.from);
      for (let idx = 0; idx < 64; idx++) {
        const letter = state.board[idx];
        if (!letter || skip.has(idx)) continue;
        const c = squareCenter(idx);
        drawPieceShadow(c.x, c.y, s, 1, 0);
        drawPieceSprite(letter, c.x, c.y);
      }
      if (promoPick && !dropAnim) {
        const c = squareCenter(promoPick.to);
        const pawn = promoPick.color === "w" ? "P" : "p";
        drawPieceShadow(c.x, c.y, s, 1, 0);
        drawPieceSprite(pawn, c.x, c.y, 1, 0.85);
      }
    }

    function drawRemoteDrags(ts) {
      const s = cellPx();
      for (const [id, d] of remoteDrags) {
        if (ts - d.at > 4000) { remoteDrags.delete(id); continue; }
        const color = host.getProfile?.(id)?.color || "#8ce8bc";
        drawSquareGlow(d.from, colorWithAlpha(color, 0.5), Math.max(1.6, s * 0.045));
        const hoverIdx = squareIndexAt(d.bx, d.by);
        if (hoverIdx >= 0 && hoverIdx !== d.from) {
          const pulse = 0.5 + Math.sin(ts * 0.012) * 0.16;
          drawSquareGlow(hoverIdx, colorWithAlpha(color, pulse), Math.max(2, s * 0.06));
        }
        drawPieceShadow(d.bx, d.by + 0.3, s, 1.1, 0.5);
        drawPieceSprite(d.letter, d.bx, d.by, 1.12, 0.88);
      }
    }

    function drawRemoteSettles(ts) {
      const s = cellPx();
      const keep = [];
      for (const r of remoteSettles) {
        const t = (ts - r.start) / r.dur;
        const to = squareCenter(r.to);
        if (t >= 1) {
          if (!r.settled) {
            r.settled = true;
            addRipple(to.x, to.y, true);
          }
          const applied = state.board[r.to] === r.letter && state.board[r.from] !== r.letter;
          if (!applied && ts - r.start < 1500) {
            keep.push(r);
            drawPieceShadow(to.x, to.y, s, 1, 0);
            drawPieceSprite(r.letter, to.x, to.y);
          }
          continue;
        }
        keep.push(r);
        const ease = easeOutCubic(t);
        const bx = r.x0 + (to.x - r.x0) * ease;
        const by = r.y0 + (to.y - r.y0) * ease;
        const scale = 1.12 - ease * 0.12;
        drawPieceShadow(bx, by, s, scale, 1 - ease);
        drawPieceSprite(r.letter, bx, by, scale);
      }
      remoteSettles = keep;
    }

    function drawGlides(ts) {
      const s = cellPx();
      const keep = [];
      for (const g of glides) {
        const t = (ts - g.start) / g.dur;
        const from = squareCenter(g.from);
        const to = squareCenter(g.to);
        if (t >= 1) {
          addRipple(to.x, to.y, true);
          drawPieceShadow(to.x, to.y, s, 1, 0);
          drawPieceSprite(g.letter, to.x, to.y);
          continue;
        }
        keep.push(g);
        const ease = easeOutCubic(t);
        const bx = from.x + (to.x - from.x) * ease;
        const by = from.y + (to.y - from.y) * ease;
        const hop = Math.sin(Math.PI * ease) * 0.16;
        drawPieceShadow(bx, by, s, 1, hop);
        drawPieceSprite(g.letter, bx, by - hop, 1 + hop * 0.4);
      }
      glides = keep;
    }

    function drawDropAnim(ts) {
      if (!dropAnim) return;
      const s = cellPx();
      const t = (ts - dropAnim.start) / dropAnim.dur;
      const to = squareCenter(dropAnim.to);
      if (t >= 1) {
        addRipple(to.x, to.y);
        playSound(dropAnim.captured ? "capture" : "place");
        const letter = dropAnim.letter;
        dropAnim = null;
        drawPieceShadow(to.x, to.y, s, 1, 0);
        drawPieceSprite(letter, to.x, to.y);
        return;
      }
      const ease = easeOutCubic(t);
      const bx = dropAnim.x0 + (to.x - dropAnim.x0) * ease;
      const by = dropAnim.y0 + (to.y - dropAnim.y0) * ease;
      const scale = 1.12 - ease * 0.12;
      drawPieceShadow(bx, by, s, scale, 1 - ease);
      drawPieceSprite(dropAnim.letter, bx, by, scale);
    }

    function drawDragPiece(ts) {
      if (!drag) return;
      const s = cellPx();
      const lift = dragLift(ts);
      const wob = Math.sin(ts * 0.006) * 0.012;
      drawPieceShadow(drag.bx, drag.by, s, 1.12, lift + 0.2);
      drawPieceSprite(drag.letter, drag.bx + wob, drag.by - lift, 1.14);
    }

    function drawPromoPicker() {
      const rects = promoRects();
      if (!rects) return;
      ctx.save();
      ctx.fillStyle = "rgba(6, 16, 22, 0.55)";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#eaf6ff";
      ctx.font = "700 15px system-ui, sans-serif";
      ctx.fillText("Your pawn reaches the far bank — choose its bloom", W / 2, rects[0].y - 30);
      for (const r of rects) {
        ctx.fillStyle = "rgba(19, 42, 54, 0.92)";
        drawRoundRect(r.x, r.y, r.w, r.h, 10);
        ctx.fill();
        ctx.strokeStyle = "rgba(140, 232, 188, 0.5)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        const letter = promoPick.color === "w" ? r.letter.toUpperCase() : r.letter;
        const sprite = pieceSprite(letter);
        const dw = r.w * 0.72;
        const dh = dw * (SPRITE_UNIT_H / SPRITE_UNIT_W);
        ctx.drawImage(sprite, r.x + (r.w - dw) / 2, r.y + r.h - dh * (112 / SPRITE_UNIT_H) - r.h * 0.08, dw, dh);
      }
      ctx.restore();
    }

    function seatLabel(id, fallback) {
      if (!id) return fallback;
      if (id === myId) return "You";
      const name = playerName(id);
      return name.length > 8 ? name.slice(0, 7) + "…" : name;
    }

    function drawSeatSegment(r, active, mine, label, sub, dotColor) {
      ctx.fillStyle = mine ? "rgba(140, 232, 188, 0.16)" : active ? "rgba(19, 42, 54, 0.72)" : "rgba(13, 30, 40, 0.62)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (dotColor) {
        ctx.beginPath();
        ctx.arc(r.x + 13, r.y + r.h / 2, 4.4, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.strokeStyle = "rgba(10, 22, 30, 0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#eaf6ff";
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillText(label, r.x + (dotColor ? 23 : 12), r.y + r.h / 2 - (sub ? 6 : 0));
      if (sub) {
        ctx.fillStyle = "rgba(199, 222, 234, 0.72)";
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.fillText(sub, r.x + (dotColor ? 23 : 12), r.y + r.h / 2 + 7);
      }
    }

    function drawSeatBar() {
      const r = seatBarRects();
      const s = seats();
      ctx.save();
      ctx.fillStyle = "rgba(9, 22, 30, 0.55)";
      ctx.beginPath();
      ctx.roundRect ? (ctx.roundRect(r.bar.x - 4, r.bar.y - 4, r.bar.w + 8, r.bar.h + 8, 12), ctx.fill()) : ctx.fillRect(r.bar.x - 4, r.bar.y - 4, r.bar.w + 8, r.bar.h + 8);
      drawSeatSegment(r.white, !!s.white, s.white === myId, "White", seatLabel(s.white, "Open seat"), "#f2ecd8");
      drawSeatSegment(r.black, !!s.black, s.black === myId, "Black", seatLabel(s.black, "Open seat"), "#26333e");
      drawSeatSegment(r.watch, false, !mySeat(), "Watch", mySeat() ? "Tap to release" : "Spectating", null);
      drawSeatClock(r.white, "w");
      drawSeatClock(r.black, "b");
      ctx.strokeStyle = "rgba(120, 160, 180, 0.25)";
      ctx.lineWidth = 1;
      ctx.strokeRect(r.bar.x, r.bar.y, r.bar.w, r.bar.h);
      ctx.restore();
    }

    function drawSeatClock(r, color) {
      const ms = displayClock(color);
      const running = clocksRunning() && state.turn === color;
      const low = ms < 60_000;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.font = running ? "700 12px ui-monospace, monospace" : "600 11px ui-monospace, monospace";
      ctx.fillStyle = low && running ? "#ff9d88" : running ? "#c9f5de" : "rgba(199, 222, 234, 0.55)";
      ctx.fillText(formatClock(ms), r.x + r.w - 8, r.y + r.h / 2);
    }

    function drawNotation() {
      const r = notationRect();
      if (!r) return;
      const hist = state.history || [];
      ctx.save();
      ctx.fillStyle = "rgba(9, 22, 30, 0.62)";
      drawRoundRect(r.x, r.y, r.w, r.h, 10);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 160, 180, 0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(199, 222, 234, 0.85)";
      ctx.font = "700 10px system-ui, sans-serif";
      const headerY = r.y + (r.collapsed ? r.h : NOTE_HEADER_H) / 2 + 1;
      ctx.fillText(r.collapsed ? `MOVES · ${hist.length}` : "MOVES", r.x + NOTE_PAD + 2, headerY);
      ctx.textAlign = "right";
      ctx.fillText(r.collapsed ? "◂" : "▸", r.x + r.w - NOTE_PAD - 2, headerY);
      if (r.collapsed) {
        lastHistLen = hist.length;
        ctx.restore();
        return;
      }
      if (hist.length !== lastHistLen) {
        lastHistLen = hist.length;
        notationScroll = notationMaxScroll(r);
      }
      notationScroll = clamp(notationScroll, 0, notationMaxScroll(r));
      ctx.textAlign = "left";
      ctx.beginPath();
      ctx.rect(r.x, r.y + NOTE_HEADER_H, r.w, r.h - NOTE_HEADER_H);
      ctx.clip();
      const numW = 24;
      const colW = (r.w - numW - NOTE_PAD * 2) / 2;
      const top = r.y + NOTE_HEADER_H + NOTE_PAD - notationScroll;
      const rows = Math.ceil(hist.length / 2);
      const pendingPly = state.undoReq?.ply ?? -1;
      for (let row = 0; row < rows; row++) {
        const y = top + row * NOTE_ROW_H + NOTE_ROW_H / 2;
        if (y < r.y + NOTE_HEADER_H - NOTE_ROW_H || y > r.y + r.h + NOTE_ROW_H) continue;
        ctx.fillStyle = "rgba(150, 180, 196, 0.5)";
        ctx.font = "600 11px ui-monospace, monospace";
        ctx.fillText(`${row + 1}.`, r.x + NOTE_PAD, y);
        for (const half of [0, 1]) {
          const ply = row * 2 + half;
          if (ply >= hist.length) continue;
          const x = r.x + NOTE_PAD + numW + half * colW;
          if (ply === pendingPly) {
            ctx.fillStyle = "rgba(255, 197, 138, 0.22)";
            ctx.fillRect(x - 3, y - NOTE_ROW_H / 2 + 1, colW, NOTE_ROW_H - 2);
          }
          ctx.fillStyle = ply === hist.length - 1 ? "#c9f5de" : "#eaf6ff";
          ctx.font = ply === hist.length - 1 ? "700 11.5px ui-monospace, monospace" : "600 11.5px ui-monospace, monospace";
          ctx.fillText(hist[ply].san, x, y);
        }
      }
      ctx.restore();
    }

    function drawUndoPill() {
      const l = undoPillLayout();
      if (!l) return;
      const { bar, buttons, req } = l;
      ctx.save();
      ctx.fillStyle = "rgba(40, 34, 18, 0.85)";
      drawRoundRect(bar.x, bar.y, bar.w, bar.h, 15);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 197, 138, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffd9a8";
      ctx.font = "700 11.5px system-ui, sans-serif";
      const label = l.mine
        ? `Take-back requested (${describePly(state.history, req.ply)})…`
        : `${seatLabel(req.by, "A player")} asks to take back ${describePly(state.history, req.ply)}`;
      const maxLabelW = bar.w - NOTE_PAD * 2 - buttons.length * 64 - 8;
      let text = label;
      while (ctx.measureText(text).width > maxLabelW && text.length > 8) text = text.slice(0, -2);
      if (text !== label) text += "…";
      ctx.fillText(text, bar.x + 12, bar.y + bar.h / 2);
      for (const b of buttons) {
        const allow = b.id === "allow";
        ctx.fillStyle = allow ? "rgba(140, 232, 188, 0.2)" : "rgba(232, 140, 122, 0.16)";
        drawRoundRect(b.x, b.y, b.w, b.h, 11);
        ctx.fill();
        ctx.strokeStyle = allow ? "rgba(140, 232, 188, 0.55)" : "rgba(232, 160, 140, 0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.fillStyle = allow ? "#c9f5de" : "#ffcfc2";
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
      }
      ctx.restore();
    }

    function drawControls() {
      const r = controlRects();
      ctx.save();
      for (const [key, label] of [["fit", "Fit"], ["flip", "Flip"]]) {
        const b = r[key];
        ctx.fillStyle = "rgba(9, 22, 30, 0.6)";
        drawRoundRect(b.x, b.y, b.w, b.h, 13);
        ctx.fill();
        ctx.strokeStyle = "rgba(120, 160, 180, 0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = key === "flip" && flipped ? "#c9f5de" : "#dcecf5";
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
      }
      ctx.restore();
    }

    function drawBanner(ts) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const showNotice = localNotice && ts < localNotice.until && localNotice.text;
      ctx.fillStyle = showNotice ? "#ffd9a8" : "#eaf6ff";
      ctx.font = "700 16px system-ui, sans-serif";
      ctx.fillText(showNotice ? localNotice.text : (state.message || ""), W / 2, H - 64);
      ctx.fillStyle = "rgba(199, 222, 234, 0.62)";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillText(mySeat() ? "Drag your pieces to move" : "Claim a seat above to play", W / 2, H - 42);
    }

    function scheduleNextFrame(ts) {
      if (frameTimer !== null || rafId) return;
      const frameMs = targetFrameMs();
      nextFrameAt = Math.max(ts + frameMs / 2, nextFrameAt + frameMs);
      const delay = Math.max(0, Math.min(frameMs, nextFrameAt - ts));
      frameTimer = setTimeout(() => {
        frameTimer = null;
        rafId = requestAnimationFrame(loop);
      }, delay);
    }

    function startLoop() {
      if (rafId || frameTimer !== null || document.hidden) return;
      nextFrameAt = 0;
      rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
    }

    function onVisibilityChange() {
      if (document.hidden) stopLoop();
      else startLoop();
    }

    function loop(ts) {
      rafId = 0;
      if (!W || !H) resize();
      if (drag && ts - lastDragSentAt > 1200) sendDragEvent(true);
      tickClocks();
      drawBackground();
      spawnAmbientRipples();
      withCamera(() => {
        drawRipples(ts);
        drawPads(ts);
        drawFrame();
        drawSquares();
        drawHighlights(ts);
        drawSinks(ts);
        drawPieces(ts);
        drawGlides(ts);
        drawRemoteSettles(ts);
        drawRemoteDrags(ts);
        drawDropAnim(ts);
        drawDragPiece(ts);
      });
      drawVignette();
      drawSeatBar();
      drawNotation();
      drawUndoPill();
      drawControls();
      drawPromoPicker();
      drawBanner(ts);
      if (isHost() && ts - lastHeartbeatAt > SNAPSHOT_HEARTBEAT_MS) {
        lastHeartbeatAt = ts;
        host.broadcastState(makeSnapshot());
      }
      scheduleNextFrame(ts);
    }

    return {
      start() {
        resize();
        notationCollapsed = W > 0 && W < 640;
        if (initialState) applySnapshot(initialState);
        else if (isHost()) resetHostState();
        window.addEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.addEventListener("pointerdown", onPointerDown);
          canvas.addEventListener("pointermove", onPointerMove);
          canvas.addEventListener("pointerup", onPointerUp);
          canvas.addEventListener("pointercancel", onPointerUp);
          canvas.addEventListener("lostpointercapture", onLostPointerCapture);
          canvas.addEventListener("wheel", onWheel, { passive: false });
        } else {
          canvas.addEventListener("touchstart", onPointerDown, { passive: false });
          window.addEventListener("touchmove", onPointerMove, { passive: false });
          window.addEventListener("touchend", onPointerUp);
          window.addEventListener("touchcancel", onPointerUp);
          canvas.addEventListener("mousedown", onPointerDown);
          window.addEventListener("mousemove", onPointerMove);
          window.addEventListener("mouseup", onPointerUp);
          canvas.addEventListener("wheel", onWheel, { passive: false });
        }
        window.addEventListener("keydown", onKeyDown);
        document.addEventListener("visibilitychange", onVisibilityChange);
        startLoop();
      },
      destroy() {
        stopLoop();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("resize", resize);
        if (window.PointerEvent) {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerUp);
          canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
          canvas.removeEventListener("wheel", onWheel);
        } else {
          canvas.removeEventListener("touchstart", onPointerDown);
          window.removeEventListener("touchmove", onPointerMove);
          window.removeEventListener("touchend", onPointerUp);
          window.removeEventListener("touchcancel", onPointerUp);
          canvas.removeEventListener("mousedown", onPointerDown);
          window.removeEventListener("mousemove", onPointerMove);
          window.removeEventListener("mouseup", onPointerUp);
          canvas.removeEventListener("wheel", onWheel);
        }
        window.removeEventListener("keydown", onKeyDown);
      },
      onPeerInput(id, input) { handleAction(id, input); },
      onPeerEvent(id, event) { handlePeerEvent(id, event); },
      onState(snapshot) { applySnapshot(snapshot); },
      getSnapshot() { return makeSnapshot(); },
      onPlayerList() {
        if (!isHost()) return;
        const ids = new Set((host.getPlayers?.() || []).map((p) => p.id));
        const s = seats();
        let changed = false;
        for (const seat of ["white", "black"]) {
          if (s[seat] && !ids.has(s[seat])) {
            state.message = `${playerName(s[seat])}'s ${seat} seat opens up.`;
            s[seat] = null;
            changed = true;
          }
        }
        if (state.undoReq && !ids.has(state.undoReq.by)) {
          state.undoReq = null;
          changed = true;
        }
        for (const id of [...remoteDrags.keys()]) if (!ids.has(id)) remoteDrags.delete(id);
        if (changed) state.rev = (state.rev || 0) + 1;
        host.broadcastState(makeSnapshot());
      },
      restart() { if (isHost()) resetHostState(); },
    };
  }

  window.BP2PGames = window.BP2PGames || {};
  window.SimpleChessGame = {
    id: GAME_ID,
    name: "SimpleChess",
    emoji: "♞",
    musicTracks: [],
    create,
  };
  window.BP2PGames[GAME_ID] = window.SimpleChessGame;
})();
