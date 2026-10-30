export function loadNodeModule<T>(id: string): T | null {
  const req =
    typeof module !== 'undefined' && typeof module.require === 'function'
      ? module.require
      : undefined;
  if (!req) {
    if (
      typeof process !== 'undefined' &&
      typeof process.getBuiltinModule === 'function'
    ) {
      return (process.getBuiltinModule(id) as T | undefined) ?? null;
    }
    return null;
  }
  const nodeId = id.startsWith('node:') ? id : `node:${id}`;
  try {
    return req(nodeId) as T;
  } catch {
    try {
      return req(id) as T;
    } catch {
      return null;
    }
  }
}

export function loadNodeModuleOrThrow<T>(id: string, errorMessage: string): T {
  const mod = loadNodeModule<T>(id);
  if (mod) {
    return mod;
  }
  throw new Error(errorMessage);
}
