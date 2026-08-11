const AUTH_REALM = 'ThermalEye browser'
const AUTH_PROBE_PATH = '/__pvstudio_auth'
const PROTECTED_SHELL_PATH = '/pvstudio-shell.html'

export interface AuthEnvironment {
  ASSETS: Pick<Fetcher, 'fetch'>
  PVSTUDIO_AUTH_VERIFICATION_URL?: string
}

function challengeResponse(): Response {
  return new Response('Authorization required', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=UTF-8',
      'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
    },
  })
}

function configurationErrorResponse(): Response {
  return new Response('Authentication is not configured', {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=UTF-8',
    },
  })
}

function verificationUrl(value: string | undefined): URL | null {
  if (value === undefined) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export async function handleRequest(request: Request, env: AuthEnvironment): Promise<Response> {
  const authUrl = verificationUrl(env.PVSTUDIO_AUTH_VERIFICATION_URL)
  if (authUrl === null) {
    return configurationErrorResponse()
  }

  const authorization = request.headers.get('Authorization')
  if (authorization === null || !authorization.startsWith('Basic ')) {
    return challengeResponse()
  }

  let verificationResponse: Response
  try {
    verificationResponse = await fetch(authUrl, {
      method: 'HEAD',
      headers: { Authorization: authorization },
      redirect: 'manual',
    })
  } catch {
    return configurationErrorResponse()
  }

  if (verificationResponse.status === 401 || verificationResponse.status === 403) {
    return challengeResponse()
  }
  if (!verificationResponse.ok) return configurationErrorResponse()

  const url = new URL(request.url)
  if (url.pathname === AUTH_PROBE_PATH) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  }
  if (url.pathname === '/') {
    url.pathname = PROTECTED_SHELL_PATH
    return env.ASSETS.fetch(new Request(url, request))
  }

  return env.ASSETS.fetch(request)
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env)
  },
} satisfies ExportedHandler<AuthEnvironment>
