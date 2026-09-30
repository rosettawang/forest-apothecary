// Stands in for @netlify/blobs on Cloudflare (see "alias" in wrangler.jsonc).
// Covers only what chat.js and get-logs.js use: setJSON, list and get as JSON.
import { env } from 'cloudflare:workers';

export function getStore(name) {
  const prefix = `${name}:`;
  return {
    setJSON: (key, value) => env.QUERIES.put(prefix + key, JSON.stringify(value)),

    get: (key, opts) => env.QUERIES.get(prefix + key, opts && opts.type === 'json' ? 'json' : 'text'),

    async list() {
      const blobs = [];
      let cursor;
      do {
        const page = await env.QUERIES.list({ prefix, cursor });
        page.keys.forEach(k => blobs.push({ key: k.name.slice(prefix.length) }));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return { blobs };
    }
  };
}
