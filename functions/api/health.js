
export function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "VidPik",
      message: "API فعال است"
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}
