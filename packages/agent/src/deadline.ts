export async function withinDeadline<T>(deadline: number, run: () => Promise<T>, fallback: T): Promise<T> {
  if (deadline === Infinity) return run();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>(resolve => { timer = setTimeout(resolve, remaining, fallback); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
