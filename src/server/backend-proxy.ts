import "@/server/env";

const BACKEND_URL = (process.env.BACKEND_PROXY_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

export function backendUrl(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BACKEND_URL}${normalized}`;
}

export async function proxyToBackend(request: Request, path: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${backendUrl(path)}${incoming.search}`;
  const headers = new Headers();

  const auth = request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);

  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  const upstream = await fetch(target, init);
  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
