/**
 * Hostile ZIP fixture builders. Byte-exact central-directory construction:
 * these fixtures must exercise the validator's own parsing, not a library's.
 */

const u16le = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32le = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export type FixtureEntry = {
  name: string;
  body?: Uint8Array;
  /** Literal bytes in the central directory (for lying about sizes). */
  declaredCompressed?: number;
  declaredExpanded?: number;
  method?: number;
  flags?: number;
  /** Extra field appended after the name in the central directory. */
  extra?: Uint8Array;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ?? 0 ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Build a ZIP archive from `entries`. Names are written raw (no UTF-8 flag
 * unless asked) so traversal and encoding attacks are constructible.
 */
export function buildZip(entries: readonly FixtureEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const body = entry.body ?? new Uint8Array(0);
    // Stored by default: the validator reads the central directory and never
    // decompresses, so a real deflate stream would add a dependency and buy
    // no coverage. Bomb cases forge the declared sizes instead, which is what
    // the ceiling actually defends against.
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const payload = body;
    const name = utf8(entry.name);
    const extra = entry.extra ?? new Uint8Array(0);

    const declaredCompressed = entry.declaredCompressed ?? payload.length;
    const declaredExpanded = entry.declaredExpanded ?? body.length;

    locals.push(
      concat([
        u32le(0x04034b50),
        u16le(20), // version needed
        u16le(flags),
        u16le(method),
        u16le(0),
        u16le(0),
        u32le(crc32(body)),
        u32le(declaredCompressed),
        u32le(declaredExpanded),
        u16le(name.length),
        u16le(extra.length),
        name,
        extra,
        payload,
      ]),
    );

    centrals.push(
      concat([
        u32le(0x02014b50),
        u16le(20), // version made by
        u16le(20), // version needed
        u16le(flags),
        u16le(method),
        u16le(0),
        u16le(0),
        u32le(crc32(body)),
        u32le(declaredCompressed),
        u32le(declaredExpanded),
        u16le(name.length),
        u16le(extra.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        name,
        extra,
      ]),
    );

    offset += 30 + name.length + extra.length + payload.length;
  }

  const central = concat(centrals);
  const eocd = concat([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(central.length),
    u32le(offset),
    u16le(0),
  ]);

  return concat([...locals, central, eocd]);
}

/** Small, valid container + OPF so validation tests exercise happy paths too. */
export const CONTAINER_XML =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

export const OPF_XML =
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
  "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>Hostile Book</dc:title><dc:language>en</dc:language></metadata>" +
  '<manifest><item id="nav" href="nav.xhtml" properties="nav"/><item id="c1" href="ch1.xhtml"/>' +
  '<item id="c2" href="ch2.xhtml"/></manifest>' +
  '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>';
