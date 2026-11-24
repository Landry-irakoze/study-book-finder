'use strict';

require('dotenv').config();

const express = require('express');
const os = require('os');
const path = require('path');


const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
const SERVER_ID = process.env.SERVER_ID || os.hostname();

const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';
const PAGE_SIZE = 12;
const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 60;
const ORDERS = new Set(['relevance', 'newest']);
const FILTERS = new Set(['', 'ebooks', 'free-ebooks', 'paid-ebooks', 'full', 'partial']);
const LANG_PATTERN = /^[a-z]{2}$/;

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


function optionalString(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === 'string' ? value : null;
}

function parseQuery(query) {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q.length < 2) return { error: 'Enter at least 2 characters to search.' };
  if (q.length > 100) return { error: 'Search text is too long (100 characters max).' };

  const lang = optionalString(query.lang, '');
  const filter = optionalString(query.filter, '');
  const order = optionalString(query.order, 'relevance');
  const startRaw = optionalString(query.startIndex, '0');

  if (lang === null || (lang !== '' && !LANG_PATTERN.test(lang))) {
    return { error: 'Unsupported language option.' };
  }
  if (filter === null || !FILTERS.has(filter)) return { error: 'Unsupported availability filter.' };
  if (order === null || !ORDERS.has(order)) return { error: 'Unsupported sort order.' };
  if (startRaw === null || !/^\d{1,3}$/.test(startRaw)) return { error: 'Invalid page position.' };

  return { params: { q, lang, filter, order, startIndex: Number(startRaw) } };
}

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value); 
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function toHttps(url) {
  if (typeof url !== 'string') return '';
  const secure = url.replace(/^http:\/\//i, 'https://');
  return secure.startsWith('https://') ? secure : '';
}

function normalize(item) {
  const v = item.volumeInfo || {};
  const images = v.imageLinks || {};
  const sale = item.saleInfo || {};
  return {
    id: String(item.id || ''),
    title: v.title || 'Untitled',
    authors: Array.isArray(v.authors) ? v.authors : [],
    publisher: v.publisher || '',
    year: parseInt(String(v.publishedDate || '').slice(0, 4), 10) || null,
    description: v.description ? String(v.description).replace(/<[^>]*>/g, '').slice(0, 300) : '',
    pages: v.pageCount || null,
    rating: typeof v.averageRating === 'number' ? v.averageRating : null,
    ratingsCount: v.ratingsCount || 0,
    language: v.language || '',
    thumbnail: toHttps(images.thumbnail || images.smallThumbnail),
    infoLink: toHttps(v.infoLink),
    freeEbook: sale.saleability === 'FREE',
  };
}

async function fetchBooks({ q, lang, filter, order, startIndex }) {
  const url = new URL(GOOGLE_BOOKS_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('orderBy', order);
  url.searchParams.set('startIndex', String(startIndex));
  url.searchParams.set('maxResults', String(PAGE_SIZE));
  url.searchParams.set('printType', 'books');
  if (lang) url.searchParams.set('langRestrict', lang);
  if (filter) url.searchParams.set('filter', filter);
  if (API_KEY) url.searchParams.set('key', API_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new UpstreamError(504, 'Google Books took too long to respond. Try again in a moment.');
      }
      throw new UpstreamError(502, 'Could not reach Google Books. Try again in a moment.');
    }

    if (res.status === 429) {
      throw new UpstreamError(429, 'Search limit reached for now. Wait a minute and try again.');
    }
    if (res.status === 403) {
      throw new UpstreamError(502, 'Google Books refused the request. The API key may be invalid or out of quota.');
    }
    if (!res.ok) {
      throw new UpstreamError(502, `Google Books returned an error (${res.status}). Try again shortly.`);
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError(502, 'Google Books sent an unreadable response.');
    }

    const items = Array.isArray(body.items) ? body.items.map(normalize) : [];
    return { total: Number(body.totalItems) || 0, startIndex, pageSize: PAGE_SIZE, items };
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');

app.use((req, res, next) => {
  res.set({
    'X-Served-By': SERVER_ID,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://books.google.com https://*.googleusercontent.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
});

const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.reset < now) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  let entry = hits.get(req.ip);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + RATE_WINDOW_MS };
    hits.set(req.ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_MAX_REQUESTS) {
    res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: SERVER_ID });
});

app.get('/api/books', async (req, res) => {
  const parsed = parseQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const key = JSON.stringify(parsed.params);
  const cached = cacheGet(key);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    const data = await fetchBooks(parsed.params);
    cacheSet(key, data);
    res.set('X-Cache', 'MISS');
    return res.json(data);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`Study Book Finder (${SERVER_ID}) listening on http://${HOST}:${PORT}`);
  if (!API_KEY) console.warn('Warning: GOOGLE_BOOKS_API_KEY is not set. Using the low anonymous quota.');
});
