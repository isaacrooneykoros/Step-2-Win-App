/**
 * Android hardware back: a LIFO stack of handlers that get first refusal before navigation.
 * Open sheets / overlays register while visible; the top-most one consumes the press
 * (returns true). App.tsx's NativeBackButtonGuard falls back to history navigation.
 */
type BackHandler = () => boolean;

const stack: BackHandler[] = [];

export function pushBackHandler(handler: BackHandler): () => void {
  stack.push(handler);
  return () => {
    const index = stack.lastIndexOf(handler);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Runs handlers from the top; true if one consumed the press. */
export function runBackHandlers(): boolean {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]()) return true;
  }
  return false;
}
