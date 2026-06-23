const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // Simple secret check — set LOGS_SECRET env var in Netlify
  const secret = process.env.LOGS_SECRET;
  if (secret && event.queryStringParameters?.secret !== secret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const store = getStore('queries');
    const { blobs } = await store.list();
    const entries = await Promise.all(
      blobs.map(async (b) => {
        const data = await store.get(b.key, { type: 'json' });
        return data;
      })
    );
    // Sort by timestamp ascending
    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entries, null, 2)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
