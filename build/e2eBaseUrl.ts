export function normaliseE2eBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.search !== '' || url.hash !== '') {
    throw new Error('PVSTUDIO_BASE_URL must not contain a query string or fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}
