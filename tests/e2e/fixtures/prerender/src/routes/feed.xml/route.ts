export const prerender = true;

export const GET = () =>
  new Response("<feed></feed>", { headers: { "content-type": "application/xml" } });
