const test = require("node:test");
const assert = require("node:assert/strict");
const qr = require("../../src/warehouse/qr");

const replaceAt = (text, index, char) => text.slice(0, index) + char + text.slice(index + 1);

test("generated codes are 13 base32 characters with a valid check character", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = qr.generateCode();
    assert.equal(code.length, qr.CODE_LENGTH);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/);
    assert.ok(qr.hasValidCheckCharacter(code), code);
    seen.add(code);
  }
  assert.equal(seen.size, 500);
});

test("generation is deterministic for given random bytes", () => {
  const code = qr.generateCode(() => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 31]));
  assert.equal(code.slice(0, 12), "0123456789AZ");
  assert.ok(qr.hasValidCheckCharacter(code));
});

test("check character detects every single-character error", () => {
  const code = qr.generateCode();
  for (let i = 0; i < code.length; i++) {
    for (const char of qr.ALPHABET) {
      if (char === code[i]) continue;
      assert.ok(!qr.hasValidCheckCharacter(replaceAt(code, i, char)), `${i}:${char}`);
    }
  }
});

test("check character detects adjacent transpositions (except 0<->Z, a known Luhn mod N blind spot)", () => {
  const body = "0123456789AB";
  const valid = body + qr.checkCharacter(body);
  for (let i = 0; i < valid.length - 1; i++) {
    if (valid[i] === valid[i + 1]) continue;
    const swapped = valid.slice(0, i) + valid[i + 1] + valid[i] + valid.slice(i + 2);
    assert.ok(!qr.hasValidCheckCharacter(swapped), `swap at ${i}`);
  }
  const blind = "Z0" + "1234567890";
  const blindValid = blind + qr.checkCharacter(blind);
  assert.ok(qr.hasValidCheckCharacter("0Z" + blindValid.slice(2)));
});

test("scanned payloads and typed codes resolve to the same code", () => {
  const code = qr.generateCode();
  const payload = qr.buildPayload(code);
  assert.equal(payload, `PTWH:1:${code}`);
  assert.deepEqual(qr.parseQrInput(payload), { ok: true, code });
  assert.deepEqual(qr.parseQrInput(`  ${payload}\n`), { ok: true, code });
  assert.deepEqual(qr.parseQrInput(code.toLowerCase()), { ok: true, code });
  assert.deepEqual(qr.parseQrInput(qr.formatCode(code)), { ok: true, code });
});

test("typed I/L/O are read as 1/1/0", () => {
  const body = "1100ABCDEFGH";
  const code = body + qr.checkCharacter(body);
  assert.deepEqual(qr.parseQrInput(`IL0O${code.slice(4)}`), { ok: true, code });
});

test("invalid input is rejected with a reason", () => {
  const code = qr.generateCode();
  const wrongCheck = replaceAt(code, 12, code[12] === "0" ? "1" : "0");
  assert.equal(qr.parseQrInput("").reason, "empty");
  assert.equal(qr.parseQrInput(undefined).reason, "empty");
  assert.equal(qr.parseQrInput("https://example.com/x").reason, "format");
  assert.equal(qr.parseQrInput(`PTWH:2:${code}`).reason, "format");
  assert.equal(qr.parseQrInput(code.slice(0, 12)).reason, "format");
  assert.equal(qr.parseQrInput(`${code}0`).reason, "format");
  assert.equal(qr.parseQrInput(replaceAt(code, 3, "U")).reason, "format");
  assert.equal(qr.parseQrInput(wrongCheck).reason, "checksum");
});

test("payload uses only QR alphanumeric-mode characters", () => {
  assert.match(qr.buildPayload(qr.generateCode()), /^[0-9A-Z $%*+\-./:]+$/);
});
