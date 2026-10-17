// QR identifiers for batches (identification, not AI).
//
// A QR code encodes only an opaque payload, e.g. "PTWH:1:7K3M9Q2XWD4RB":
//   PTWH  PharmaTwin warehouse
//   1     payload version
//   code  12 random Crockford base32 characters + 1 Luhn mod 32 check character
// The batch is looked up from the code, so printed labels never go stale.
// The check character catches typos when a code is typed in by hand.
// Payload characters are all in the QR alphanumeric set, giving small codes.

const crypto = require("node:crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const BASE = ALPHABET.length;
const BODY_LENGTH = 12; // 60 random bits
const CODE_LENGTH = BODY_LENGTH + 1;
const PAYLOAD_PREFIX = "PTWH:1:";

// Luhn mod N: one weighted pass from the right.
function luhnSum(chars, startFactor) {
  let factor = startFactor;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    let addend = factor * ALPHABET.indexOf(chars[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / BASE) + (addend % BASE);
    sum += addend;
  }
  return sum;
}

function checkCharacter(body) {
  return ALPHABET[(BASE - (luhnSum(body, 2) % BASE)) % BASE];
}

function hasValidCheckCharacter(code) {
  return luhnSum(code, 1) % BASE === 0;
}

// 256 is a multiple of 32, so masking each byte keeps characters uniform.
function generateCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(BODY_LENGTH);
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[bytes[i] & (BASE - 1)];
  return body + checkCharacter(body);
}

function buildPayload(code) {
  return PAYLOAD_PREFIX + code;
}

// Typed codes: ignore case, spaces and hyphens; read I/L as 1 and O as 0.
function normalizeCode(text) {
  return text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

// Accepts a scanned payload or a typed code.
// Returns { ok: true, code } or { ok: false, reason, message }.
function parseQrInput(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { ok: false, reason: "empty", message: "Scan or enter a QR code" };

  let raw = text;
  if (/^PTWH:/i.test(text)) {
    if (!text.toUpperCase().startsWith(PAYLOAD_PREFIX)) {
      return { ok: false, reason: "format", message: "Unsupported PharmaTwin QR version" };
    }
    raw = text.slice(PAYLOAD_PREFIX.length);
  } else if (text.includes(":") || text.includes("/")) {
    return { ok: false, reason: "format", message: "This is not a PharmaTwin warehouse QR code" };
  }

  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH || [...code].some((char) => !ALPHABET.includes(char))) {
    return { ok: false, reason: "format", message: `A QR code has ${CODE_LENGTH} letters and digits` };
  }
  if (!hasValidCheckCharacter(code)) {
    return { ok: false, reason: "checksum", message: "QR code is not valid (check character mismatch); re-scan or re-type it" };
  }
  return { ok: true, code };
}

// "7K3M9Q2XWD4RB" -> "7K3M-9Q2X-WD4RB" for labels and manual entry.
function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  PAYLOAD_PREFIX,
  checkCharacter,
  hasValidCheckCharacter,
  generateCode,
  buildPayload,
  normalizeCode,
  parseQrInput,
  formatCode,
};
