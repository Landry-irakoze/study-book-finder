(() => {
  'use strict';

  const PAGE_SIZE = 12;
  const STORE_KEY = 'studyBookFinder.readingList';
  const SUGGESTIONS = ['Database systems', 'Data structures', 'Network security', 'Entrepreneurship', 'Learning theory'];

  const $ = (selector) => document.querySelector(selector);
  const form = $('#search-form');
  const qInput = $('#q');
  const langSelect = $('#lang');
  const filterSelect = $('#filter');
  const sortSelect = $('#sort');
  const narrowRow = $('#narrow-row');
  const narrowInput = $('#narrow');
  const summary = $('#summary');
  const statusBox = $('#status');
  const resultsList = $('#results');
  const pager = $('#pager');
  const prevBtn = $('#prev');
  const nextBtn = $('#next');
  const pageLabel = $('#page-label');
  const shelf = $('#shelf');
  const shelfToggle = $('#shelf-toggle');
  const shelfClose = $('#shelf-close');
  const shelfCount = $('#shelf-count');
  const shelfItems = $('#shelf-items');
  const shelfEmpty = $('#shelf-empty');

  const state = { query: null, order: 'relevance', startIndex: 0, total: 0, items: [], busy: false };
  let readingList = loadList();

  
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child !== null && child !== undefined) {
        node.append(child.nodeType ? child : document.createTextNode(String(child)));
      }
    }
    return node;
  }

  
  function loadList() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((b) => b && typeof b.id === 'string' && typeof b.title === 'string')
        .map((b) => ({
          id: b.id,
          title: b.title,
          authors: Array.isArray(b.authors) ? b.authors.filter((a) => typeof a === 'string') : [],
          infoLink: typeof b.infoLink === 'string' && b.infoLink.startsWith('https://') ? b.infoLink : '',
        }));
    } catch {
      return [];
    }
  }

  function saveList() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readingList));
    } catch {
      
    }
  }

  const isSaved = (id) => readingList.some((b) => b.id === id);

  function toggleSaved(book) {
    if (isSaved(book.id)) {
      readingList = readingList.filter((b) => b.id !== book.id);
    } else {
      readingList.push({ id: book.id, title: book.title, authors: book.authors, infoLink: book.infoLink });
    }
    saveList();
    renderShelf();
    renderResults();
  }

  function renderShelf() {
    shelfCount.textContent = String(readingList.length);
    shelfEmpty.hidden = readingList.length > 0;
    shelfItems.replaceChildren(
      ...readingList.map((b) =>
        el(
          'li',
          {},
          el('strong', {}, b.title),
          b.authors.length ? el('span', { class: 'muted' }, b.authors.join(', ')) : null,
          b.infoLink
            ? el('a', { href: b.infoLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Google Books')
            : null,
          el(
            'button',
            {
              type: 'button',
              class: 'link-btn',
              'aria-label': `Remove ${b.title} from reading list`,
              onclick: () => {
                readingList = readingList.filter((x) => x.id !== b.id);
                saveList();
                renderShelf();
                renderResults();
              },
            },
            'Remove'
          )
        )
      )
    );
  }

  function setShelfOpen(open) {
    shelf.hidden = !open;
    shelfToggle.setAttribute('aria-expanded', String(open));
    if (open) shelfClose.focus();
    else shelfToggle.focus();
  }


  function showStatus(message, { error = false, retry = null, suggestions = false } = {}) {
    statusBox.className = error ? 'status is-error' : 'status';
    const parts = [el('p', {}, message)];
    if (retry) parts.push(el('button', { type: 'button', class: 'btn btn-ghost', onclick: retry }, 'Try again'));
    if (suggestions) {
      parts.push(
        el(
          'div',
          { class: 'chips' },
          ...SUGGESTIONS.map((topic) =>
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                onclick: () => {
                  qInput.value = topic;
                  search(0);
                },
              },
              topic
            )
          )
        )
      );
    }
    statusBox.replaceChildren(...parts);
  }

  function clearStatus() {
    statusBox.className = 'status';
    statusBox.replaceChildren();
  }

  
  function visibleItems() {
    const needle = narrowInput.value.trim().toLowerCase();
    let list = state.items.filter(
      (b) => !needle || `${b.title} ${b.authors.join(' ')}`.toLowerCase().includes(needle)
    );
    if (sortSelect.value === 'rating') {
      list = [...list].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.ratingsCount - a.ratingsCount);
    } else if (sortSelect.value === 'title') {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }

  function bookCard(book) {
    const saved = isSaved(book.id);
    const cover = book.thumbnail
      ? el('img', {
          class: 'cover',
          src: book.thumbnail,
          alt: `Cover of ${book.title}`,
          loading: 'lazy',
          width: '96',
          height: '144',
        })
      : el('div', { class: 'cover cover-empty', 'aria-hidden': 'true' }, book.title.charAt(0).toUpperCase());

    const meta = el(
      'ul',
      { class: 'meta' },
      el('li', {}, book.rating !== null ? `Rated ${book.rating} (${book.ratingsCount})` : 'No ratings yet'),
      book.year ? el('li', {}, `Published ${book.year}`) : null,
      book.pages ? el('li', {}, `${book.pages} pages`) : null,
      book.language ? el('li', {}, book.language.toUpperCase()) : null,
      book.freeEbook ? el('li', {}, el('span', { class: 'badge' }, 'Free e-book')) : null
    );

    return el(
      'li',
      { class: 'book' },
      cover,
      el(
        'div',
        {},
        el('h3', {}, book.title),
        el('p', { class: 'authors' }, book.authors.length ? book.authors.join(', ') : 'Author not listed'),
        meta,
        book.description ? el('p', { class: 'blurb' }, book.description) : null,
        el(
          'div',
          { class: 'actions' },
          el(
            'button',
            {
              type: 'button',
              class: saved ? 'btn btn-ghost' : 'btn btn-primary',
              'aria-pressed': String(saved),
              onclick: () => toggleSaved(book),
            },
            saved ? 'Saved' : 'Save to list'
          ),
          book.infoLink
            ? el('a', { href: book.infoLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open on Google Books')
            : null
        )
      )
    );
  }

  function renderResults() {
    const list = visibleItems();
    resultsList.replaceChildren(...list.map(bookCard));

    const page = Math.floor(state.startIndex / PAGE_SIZE) + 1;
    summary.textContent = state.items.length
      ? `Showing ${list.length} of ${state.items.length} books on this page`
      : '';
    pageLabel.textContent = `Page ${page}`;
    prevBtn.disabled = state.busy || state.startIndex === 0;
    nextBtn.disabled = state.busy || state.items.length < PAGE_SIZE;

    const hasResults = state.items.length > 0;
    narrowRow.hidden = !hasResults;
    pager.hidden = !hasResults && state.startIndex === 0;

    if (hasResults && list.length === 0) {
      showStatus('No books on this page match your narrowing text. Clear it to see all results.');
    } else if (hasResults && statusBox.textContent) {
      clearStatus();
    }
  }

  
  async function search(startIndex = 0) {
    const q = qInput.value.trim();
    if (q.length < 2) {
      showStatus('Enter at least 2 characters to search.', { error: true });
      qInput.focus();
      return;
    }

    const order = sortSelect.value === 'newest' ? 'newest' : 'relevance';
    state.query = { q, lang: langSelect.value, filter: filterSelect.value };
    state.order = order;
    state.startIndex = startIndex;
    state.busy = true;
    narrowInput.value = '';
    showStatus('Searching Google Books...');
    resultsList.replaceChildren();
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    const params = new URLSearchParams({ q, order, startIndex: String(startIndex) });
    if (state.query.lang) params.set('lang', state.query.lang);
    if (state.query.filter) params.set('filter', state.query.filter);

    try {
      const res = await fetch(`/api/books?${params}`);
      let body = null;
      try {
        body = await res.json();
      } catch {
      
      }
      if (!res.ok) {
        throw new Error((body && body.error) || `The server returned an error (${res.status}).`);
      }
      if (!body || !Array.isArray(body.items)) {
        throw new Error('The server sent an unexpected response.');
      }

      state.items = body.items;
      state.total = body.total;
      state.busy = false;

      if (body.items.length === 0) {
        renderResults();
        pager.hidden = startIndex === 0;
        showStatus(
          startIndex === 0
            ? `No books found for "${q}". Try a broader topic, remove a filter, or pick a suggestion.`
            : 'No more results for this search.',
          { suggestions: startIndex === 0 }
        );
        return;
      }

      clearStatus();
      renderResults();
      document.querySelector('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      state.busy = false;
      state.items = [];
      renderResults();
      const offline = err instanceof TypeError;
      showStatus(
        offline ? 'Cannot reach the server. Check your connection and try again.' : err.message,
        { error: true, retry: () => search(startIndex) }
      );
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    search(0);
  });

  sortSelect.addEventListener('change', () => {
    const wantsNewest = sortSelect.value === 'newest';
    const serverOrder = wantsNewest ? 'newest' : 'relevance';
    const serverSideChange = (sortSelect.value === 'relevance' || wantsNewest) && serverOrder !== state.order;
    if (state.query && serverSideChange) search(0);
    else renderResults();
  });

  narrowInput.addEventListener('input', renderResults);
  prevBtn.addEventListener('click', () => search(Math.max(0, state.startIndex - PAGE_SIZE)));
  nextBtn.addEventListener('click', () => search(state.startIndex + PAGE_SIZE));
  shelfToggle.addEventListener('click', () => setShelfOpen(shelf.hidden));
  shelfClose.addEventListener('click', () => setShelfOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !shelf.hidden) setShelfOpen(false);
  });

  async function showServerId() {
    try {
      const res = await fetch('/api/health');
      const id = res.headers.get('X-Served-By');
      if (id) $('#served-by').textContent = `Served by ${id}`;
    } catch {
      
    }
  }

  renderShelf();
  showStatus('Search for a course topic, or start with one of these:', { suggestions: true });
  showServerId();
})();
