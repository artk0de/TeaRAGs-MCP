/**
 * Runtime config — set once at startup, read many times.
 * Avoids passing debug flag through every function signature.
 */
let _debug = false;

export function setDebug(value: boolean): void {
  _debug = value;
}

export function isDebug(): boolean {
  return _debug;
}
