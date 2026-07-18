const ASYNCIFY_OBJECTS = new Set([
  'litertlm_wasm_asyncify_internal.wasm',
  'litertlm_wasm_compat_asyncify_internal.wasm',
]);

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const filename = String(context.params.filename ?? '');
  if (!ASYNCIFY_OBJECTS.has(filename)) return new Response('Not found', { status: 404 });

  const cache = caches.default;
  if (method === 'GET') {
    const cached = await cache.match(context.request);
    if (cached) return cached;
  }

  const object = method === 'HEAD'
    ? await context.env.RP_ENGINE_ASSETS.head(filename)
    : await context.env.RP_ENGINE_ASSETS.get(filename);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': String(object.size),
    'Content-Type': 'application/wasm',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
  });
  const response = new Response(method === 'HEAD' ? null : object.body, { headers });
  if (method === 'GET') context.waitUntil(cache.put(context.request, response.clone()));
  return response;
}
