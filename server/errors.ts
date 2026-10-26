export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

export function cleanMessage(value: string, secrets: string[] = [], limit = 800): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/(bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(0, limit);
}
