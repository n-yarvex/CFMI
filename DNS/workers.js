let DoH = "cloudflare-dns.com";
const jsonDoH = `https://${DoH}/resolve`;
const dnsDoH = `https://${DoH}/dns-query`;
let dohPath = 'dns-query';
export default {
  async fetch(request, env) {
    if (env.DOH) {
      DoH = env.DOH;
      const match = DoH.match(/:\/\/([^\/]+)/);
      if (match) DoH = match[1];
    }
    dohPath = env.PATH || env.TOKEN || dohPath;
    if (dohPath.includes("/")) dohPath = dohPath.split("/")[1];
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    if (path === `/${dohPath}`) {
      return await DOHRequest(request);
    }
    return new Response('Not Found', { status: 404 });
  }
}
async function DOHRequest(request) {
  const { method, headers, body } = request;
  const UA = headers.get('User-Agent') || 'DoH Client';
  const url = new URL(request.url);
  const { searchParams } = url;
  try {
    if (method === 'GET' && !url.search) {
      return new Response('Bad Request', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    let response;
    if (method === 'GET' && searchParams.has('name')) {
      const searchQuery = searchParams.has('type') ? url.search : url.search + '&type=A';
      response = await fetch(dnsDoH + searchQuery, {
        headers: {
          'Accept': 'application/dns-json',
          'User-Agent': UA
        }
      });
      if (!response.ok) response = await fetch(jsonDoH + searchQuery, {
        headers: {
          'Accept': 'application/dns-json',
          'User-Agent': UA
        }
      });
    } else if (method === 'GET') {
      response = await fetch(dnsDoH + url.search, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': UA
        }
      });
    } else if (method === 'POST') {
      response = await fetch(dnsDoH, {
        method: 'POST',
        headers: {
          'Accept': 'application/dns-message',
          'Content-Type': 'application/dns-message',
          'User-Agent': UA
        },
        body: body
      });
    } else {
      return new Response('Unsupported request format', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DoH error (${response.status}): ${errorText.substring(0, 200)}`);
    }
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    if (method === 'GET' && searchParams.has('name')) {
      responseHeaders.set('Content-Type', 'application/json');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    console.error("DoH error:", error);
    return new Response(JSON.stringify({
      error: `DoH error: ${error.message}`,
      stack: error.stack
    }, null, 4), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
        }
