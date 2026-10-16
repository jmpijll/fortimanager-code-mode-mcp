/**
 * Compatibility shim for quickjs-emscripten 0.32.0.
 *
 * Freeing an async runtime runs the GC finalizers of functions created with
 * `newFunction()` / `newAsyncifiedFunction()` (the HostRef rework in 0.32).
 * Those finalizers look the runtime up in the module's callback map, so the
 * callbacks must still be registered while `QTS_FreeRuntime` runs. 0.32.0's
 * asyncify module deletes them first, which makes every disposal throw
 * `QuickJSRuntime(rt = …) not found when trying to free HostRef(id = …)`.
 *
 * Upstream fixed the ordering in justjake/quickjs-emscripten#256, which is not
 * part of a release yet. This shim applies the same ordering to the runtime's
 * disposer; drop it once a release contains that fix.
 *
 * https://github.com/justjake/quickjs-emscripten/pull/256
 */

import type { QuickJSRuntime } from 'quickjs-emscripten';

/** The parts of a runtime the upstream disposer touches, none of them public API. */
interface RuntimeInternals {
  rt?: { disposer?: (rtPtr: number) => void };
  ffi?: { QTS_FreeRuntime?: (rtPtr: number) => void };
  callbacks?: { deleteRuntime?: (rtPtr: number) => void };
}

/**
 * Ensure `runtime` frees its WASM runtime before deregistering its callbacks.
 * No-op on other versions, where these internals are missing or already fixed.
 */
export function restoreRuntimeDisposalOrder(runtime: QuickJSRuntime): void {
  const { rt, ffi, callbacks } = runtime as unknown as RuntimeInternals;
  if (!rt || !ffi?.QTS_FreeRuntime || !callbacks?.deleteRuntime) {
    return;
  }

  const freeRuntime = ffi.QTS_FreeRuntime.bind(ffi);
  const deleteRuntime = callbacks.deleteRuntime.bind(callbacks);
  rt.disposer = (rtPtr: number): void => {
    freeRuntime(rtPtr);
    deleteRuntime(rtPtr);
  };
}
