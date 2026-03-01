/**
 * LinkoManija CORS Worker for Cloudflare Workers
 */

const TARGET = 'https://www.linkomanija.net';

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Cookie',
        'Access-Control-Expose-Headers': 'X-Set-Cookies',
    };
}

function extractCookie(setCookieHeader) {
    if (!setCookieHeader) return '';
    return setCookieHeader.split(';')[0].trim();
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'lt,en;q=0.8',
        'Referer': TARGET + '/',
    };

    const xCookie = request.headers.get('X-Cookie');
    if (xCookie) baseHeaders['Cookie'] = xCookie;

    // Allow cookie via _ck query param (for TorrServe direct downloads)
    const ckParam = url.searchParams.get('_ck');
    if (ckParam) {
        baseHeaders['Cookie'] = decodeURIComponent(ckParam);
        url.searchParams.delete('_ck');
    }

    // Build targetUrl AFTER removing _ck so it doesn't get forwarded to the origin
    const targetUrl = TARGET + url.pathname + url.search;

    try {
        if (request.method === 'POST') {
            // Step 1: POST without following redirect so we can capture cookies
            const postHeaders = Object.assign({}, baseHeaders, {
                'Content-Type': 'application/x-www-form-urlencoded',
            });
            const body = await request.text();
            const postResp = await fetch(targetUrl, {
                method: 'POST',
                headers: postHeaders,
                body: body,
                redirect: 'manual',
            });

            // Collect new cookies from POST response
            const newCookie = extractCookie(postResp.headers.get('set-cookie'));
            const allCookies = [xCookie, newCookie].filter(Boolean).join('; ');

            // Step 2: Follow redirect manually with all cookies
            if (postResp.status >= 300 && postResp.status < 400) {
                var location = postResp.headers.get('location') || '/';
                if (!location.startsWith('http')) location = TARGET + location;

                const getHeaders = Object.assign({}, baseHeaders);
                if (allCookies) getHeaders['Cookie'] = allCookies;

                const getResp = await fetch(location, {
                    method: 'GET',
                    headers: getHeaders,
                    redirect: 'follow',
                });
                const text = await getResp.text();

                // Also collect any further cookies
                const moreCookies = extractCookie(getResp.headers.get('set-cookie'));
                const finalCookies = [allCookies, moreCookies].filter(Boolean).join('; ');

                var h = corsHeaders();
                h['Content-Type'] = 'text/html; charset=utf-8';
                if (finalCookies) h['X-Set-Cookies'] = finalCookies;
                return new Response(text, { status: 200, headers: h });
            }

            // POST returned non-redirect (login failed)
            const text = await postResp.text();
            var h = corsHeaders();
            h['Content-Type'] = 'text/html; charset=utf-8';
            return new Response(text, { status: 200, headers: h });

        } else {
            // GET request
            const getResp = await fetch(targetUrl, {
                method: 'GET',
                headers: baseHeaders,
                redirect: 'follow',
            });

            const contentType = getResp.headers.get('content-type') || 'text/html';
            const newCookie = extractCookie(getResp.headers.get('set-cookie'));
            var h = corsHeaders();
            if (newCookie) h['X-Set-Cookies'] = newCookie;

            if (contentType.includes('text/html') || contentType.includes('text/plain')) {
                // HTML pages — read as text
                const text = await getResp.text();
                h['Content-Type'] = 'text/html; charset=utf-8';
                return new Response(text, { status: 200, headers: h });
            } else {
                // Binary file (e.g. .torrent) — stream through as-is
                h['Content-Type'] = contentType;
                return new Response(getResp.body, { status: getResp.status, headers: h });
            }
        }

    } catch (e) {
        return new Response('proxy error: ' + e.message, {
            status: 502, headers: corsHeaders()
        });
    }
}
