import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, type AuthEnvironment } from './index'

function authorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}

describe('hosting worker authentication', () => {
  const fetchAsset = vi.fn<(request: Request) => Promise<Response>>()
  fetchAsset.mockResolvedValue(new Response('PV Studio'))
  const verifyCredential = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
  let env: AuthEnvironment

  beforeEach(() => {
    env = {
      ASSETS: { fetch: fetchAsset },
      PVSTUDIO_AUTH_VERIFICATION_URL: 'https://thermaleye.app/',
    }
    vi.stubGlobal('fetch', verifyCredential)
  })

  it('uses the same browser challenge details as ThermalEye', async () => {
    const response = await handleRequest(new Request('https://pvstudio.thermaleye.app/'), env)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="ThermalEye browser"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed credentials', 'Basic not-base64!'],
  ])('rejects %s when ThermalEye rejects it', async (_description, header) => {
    verifyCredential.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const request = new Request('https://pvstudio.thermaleye.app/', {
      headers: { Authorization: header },
    })

    const response = await handleRequest(request, env)

    expect(response.status).toBe(401)
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('serves static assets after valid credentials are supplied', async () => {
    const request = new Request('https://pvstudio.thermaleye.app/', {
      headers: { Authorization: authorization('thermaleye', 'shared password') },
    })

    const response = await handleRequest(request, env)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('PV Studio')
    expect(verifyCredential).toHaveBeenCalledWith(new URL('https://thermaleye.app/'), {
      method: 'HEAD',
      headers: { Authorization: authorization('thermaleye', 'shared password') },
      redirect: 'manual',
    })
    const assetRequest = fetchAsset.mock.calls[0]?.[0]
    expect(assetRequest).toBeInstanceOf(Request)
    expect((assetRequest as Request).url).toBe('https://pvstudio.thermaleye.app/pvstudio-shell.html')
  })

  it('confirms authentication without serving an asset for the client-side probe', async () => {
    const request = new Request('https://pvstudio.thermaleye.app/__pvstudio_auth', {
      headers: { Authorization: authorization('thermaleye', 'shared password') },
    })

    const response = await handleRequest(request, env)

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('fails closed when the verification URL is absent or unsafe', async () => {
    env.PVSTUDIO_AUTH_VERIFICATION_URL = 'http://thermaleye.app/'

    const response = await handleRequest(new Request('https://pvstudio.thermaleye.app/'), env)

    expect(response.status).toBe(503)
    expect(fetchAsset).not.toHaveBeenCalled()
  })

  it('fails closed when ThermalEye cannot verify credentials', async () => {
    verifyCredential.mockRejectedValueOnce(new Error('network unavailable'))
    const request = new Request('https://pvstudio.thermaleye.app/', {
      headers: { Authorization: authorization('thermaleye', 'shared password') },
    })

    const response = await handleRequest(request, env)

    expect(response.status).toBe(503)
    expect(fetchAsset).not.toHaveBeenCalled()
  })
})
