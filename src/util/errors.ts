// The text of anything thrown. No imports (shared by every module, tested standalone).

/** The message of anything thrown (Errors, HerdrErrors, plain objects with a message, strings). */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
