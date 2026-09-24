/** Best-effort human message from anything a query/mutation can throw. */
export function errorMessage(error: unknown): string | null {
  if (!error) return null
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return null
}
