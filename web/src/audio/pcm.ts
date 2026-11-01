/**
 * Splits streamed PCM16 bytes into whole samples. A chunk can end in the middle
 * of a sample; that odd byte is carried into the next chunk. Without the carry,
 * every later sample is read one byte off and the speech turns to static.
 */
export function alignPcm(bytes: Uint8Array, carry: Uint8Array | null): { samples: Int16Array; carry: Uint8Array | null } {
  let joined = bytes;
  if (carry && carry.length) {
    joined = new Uint8Array(carry.length + bytes.length);
    joined.set(carry, 0);
    joined.set(bytes, carry.length);
  }
  const whole = joined.length - (joined.length % 2);
  // A fresh copy, so the samples start at a 2-byte boundary whatever the input offset was.
  const samples = new Int16Array(joined.slice(0, whole).buffer);
  const rest = joined.length > whole ? joined.slice(whole) : null;
  return { samples, carry: rest };
}
