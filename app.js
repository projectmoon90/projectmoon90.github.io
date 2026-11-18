/* =========================================================
   탐나는 아이템 모음zip
   - 상품은 products.json, 브랜드/문구는 site.json 만 고치면 됩니다.
   - 번호 검색: "01", "1", "#01", "1번" → 해당 번호 상품만 표시
   - 공유 링크: 사이트주소/#01 또는 #p-01 → 그 상품만 보이게
   ========================================================= */

(() => {
  'use strict';

  const DATA_URL = './products.json';
  const SITE_URL = './site.json';

  // GA4 속성 '문구공 허브'의 데이터 스트림 '문구공 허브 웹' (gtag 스크립트는 index.html head에 있음)
  // 유입 출처를 담아 두는 키 (?src=yt 로 들어오면 'yt')
  const SRC_KEY = 'mgTrafficSrc';
  const SRC_DEFAULT = 'direct';

  const FALLBACK_SITE = {
    brand: { emoji: '🧺', title: '꿀템 모음집', tagline: '영상에서 본 상품, 번호로 1초 만에 찾기' },
    searchHint: '번호나 상품명으로 검색 (예: 01, 장난감)',
    disclosure: '이 페이지의 링크는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
    channels: [],
    footerNote: ''
  };

  const state = {
    site: FALLBACK_SITE,
    categories: [],
    products: [],
    category: 'all',
    query: '',
    ready: false,
    src: SRC_DEFAULT
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    brandEmoji: $('brandEmoji'),
    brandTitle: $('brandTitle'),
    brandTagline: $('brandTagline'),
    disclosureTop: $('disclosureTopText'),
    disclosureBottom: $('disclosureBottom'),
    footerNote: $('footerNote'),
    footerChannels: $('channelLinks'),
    footerBrand: $('footerBrand'),
    year: $('year'),
    searchForm: $('searchForm'),
    searchInput: $('searchInput'),
    clearBtn: $('clearBtn'),
    tabs: $('tabs'),
    grid: $('grid'),
    resultLine: $('resultLine'),
    empty: $('empty'),
    resetBtn: $('resetBtn'),
    error: $('error'),
    toast: $('toast')
  };

  /* ---------------- 유틸 ---------------- */

  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** "01", "1", "#1", "1번", " 01 " → 1 / 그 외 → null */
  function numberQuery(raw) {
    const compact = String(raw || '').replace(/\s+/g, '');
    const m = compact.match(/^[#＃]?0*(\d{1,3})(?:번|번째)?$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const productNo = (p) => parseInt(p.no, 10) || 0;
  const padNo = (v) => String(v).padStart(2, '0');

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-on'), 2600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 아래 폴백 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function loadJSON(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json();
  }

  /* ---------------- 유입 출처(src) · subId · GA4 ---------------- */

  /** 영문 소문자·숫자·하이픈만 남깁니다. "YT" → "yt", "youtube " → "youtube" */
  function sanitizeSrc(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '');
  }

  function readStoredSrc() {
    try {
      return sessionStorage.getItem(SRC_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  function storeSrc(value) {
    try {
      sessionStorage.setItem(SRC_KEY, value);
    } catch (_) { /* 시크릿 모드 등 저장이 막혀도 동작에는 지장 없음 */ }
  }

  /** 주소의 ?src= 값을 우선 쓰고, 없으면 이번 세션에 기억해 둔 값, 그것도 없으면 direct */
  function resolveTrafficSrc() {
    let param = null;
    try {
      param = new URLSearchParams(window.location.search).get('src');
    } catch (_) { /* 구형 브라우저 */ }

    if (param != null) {
      const clean = sanitizeSrc(param);
      if (clean) {
        storeSrc(clean);
        return clean;
      }
    }

    const saved = readStoredSrc();
    if (saved) return saved;

    storeSrc(SRC_DEFAULT);
    return SRC_DEFAULT;
  }

  /** 쿠팡 링크에 붙일 값: {src}-{상품번호} 예) yt-01 */
  function subIdFor(p) {
    return state.src + '-' + p.no;
  }

  /**
   * 상품 링크에 subId를 자동으로 붙입니다.
   * 이미 ?가 있어도 &subId= 로 이어지고, 같은 subId가 있으면 중복으로 붙지 않습니다.
   * products.json에 새 상품을 추가하면 그대로 적용됩니다.
   */
  function withSubId(url, subId) {
    if (!url) return url;
    try {
      const u = new URL(url, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      u.searchParams.set('subId', subId);
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function gaEvent(name, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    } catch (_) { /* GA 스크립트가 차단돼도 사이트 동작은 유지 */ }
  }

  function trackVisit() {
    try {
      if (typeof window.gtag === 'function') {
        // 이후 모든 이벤트에 유입 출처가 함께 실리도록 설정
        window.gtag('set', { traffic_src: state.src });
      }
    } catch (_) { /* noop */ }

    gaEvent('hub_visit', {
      traffic_src: state.src,
      page_path: window.location.pathname,
      landing_query: window.location.search
    });
  }

  function trackProductClick(p, href) {
    const subId = subIdFor(p);
    const cat = categoryOf(p.category);
    const item = {
      item_id: p.no,
      item_name: p.name,
      item_category: cat ? cat.label : '',
      item_list_id: 'hub',
      item_list_name: '문구공 허브'
    };

    gaEvent('coupang_click', {
      item_id: p.no,
      item_name: p.name,
      item_category: cat ? cat.label : '',
      traffic_src: state.src,
      sub_id: subId,
      link_url: href
    });

    // GA4 기본 전자상거래 이벤트 이름으로도 함께 기록
    gaEvent('select_item', {
      item_list_id: 'hub',
      item_list_name: '문구공 허브',
      traffic_src: state.src,
      items: [item]
    });
  }

  /* ---------------- 렌더링 ---------------- */

  function applySite(site) {
    const s = Object.assign({}, FALLBACK_SITE, site || {});
    const brand = Object.assign({}, FALLBACK_SITE.brand, s.brand || {});
    state.site = s;

    el.brandEmoji.textContent = brand.emoji || '🧺';
    el.brandTitle.textContent = brand.title || FALLBACK_SITE.brand.title;
    el.brandTagline.textContent = brand.tagline || '';
    el.brandTagline.hidden = !brand.tagline;

    if (s.disclosure) {
      el.disclosureTop.textContent = s.disclosure;
      el.disclosureBottom.textContent = s.disclosure;
    }
    el.footerNote.textContent = s.footerNote || '';
    el.footerNote.hidden = !s.footerNote;
    el.footerBrand.textContent = brand.title || '';
    el.year.textContent = String(new Date().getFullYear());

    if (s.searchHint) el.searchInput.placeholder = s.searchHint;

    document.title = brand.title ? `${brand.title}` : '꿀템 모음집';
    const desc = document.querySelector('meta[name="description"]');
    if (desc && brand.tagline) desc.setAttribute('content', brand.tagline);

    const channels = (Array.isArray(s.channels) ? s.channels : []).filter(
      (c) => c && c.label && c.url && c.url !== '#'
    );
    el.footerChannels.innerHTML = '';
    if (channels.length) {
      channels.forEach((c) => {
        const a = make('a', null, c.label);
        a.href = c.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        el.footerChannels.appendChild(a);
      });
      el.footerChannels.hidden = false;
    } else {
      el.footerChannels.hidden = true;
    }
  }

  function applyData(data) {
    const rawCats = Array.isArray(data.categories) ? data.categories : [];
    const rawProducts = Array.isArray(data.products) ? data.products : [];

    const cats = rawCats
      .filter((c) => c && c.id)
      .map((c) => ({
        id: String(c.id),
        label: c.label || String(c.id),
        emoji: c.emoji || '',
        theme: c.theme || 'default'
      }));

    const products = rawProducts
      .filter((p) => p && p.name && !p.hidden)
      .map((p, i) => ({
        no: p.no != null && p.no !== '' ? padNo(p.no) : padNo(i + 1),
        category: String(p.category || ''),
        name: String(p.name),
        pitch: p.pitch ? String(p.pitch) : '',
        price: p.price ? String(p.price) : '',
        tags: Array.isArray(p.tags) ? p.tags.filter(Boolean).map(String) : [],
        emoji: p.emoji ? String(p.emoji) : '',
        image: p.image ? String(p.image) : '',
        url: p.url == null ? '' : String(p.url).trim()
      }))
      .sort((a, b) => productNo(a) - productNo(b));

    // 카테고리 정의에 없는 상품도 탭에서 사라지지 않도록 보정
    products.forEach((p) => {
      if (p.category && !cats.some((c) => c.id === p.category)) {
        cats.push({ id: p.category, label: p.category, emoji: '', theme: 'default' });
      }
      if (!p.category) p.category = cats[0] ? cats[0].id : '';
    });

    state.categories = cats;
    state.products = products;
    state.ready = true;
  }

  function renderTabs() {
    el.tabs.innerHTML = '';
    // 상품이 하나도 없는 카테고리는 탭에 띄우지 않음 (정의는 products.json에 남겨두면 상품이 생길 때 자동으로 나타남)
    const used = new Set(state.products.map((p) => p.category));
    const visible = state.categories.filter((c) => used.has(c.id));
    if (state.category !== 'all' && !visible.some((c) => c.id === state.category)) {
      state.category = 'all';
    }
    const items = [{ id: 'all', label: '전체', emoji: '' }].concat(visible);
    items.forEach((c) => {
      const btn = make('button', 'tab', c.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.dataset.category = c.id;
      btn.setAttribute('aria-selected', String(state.category === c.id));
      el.tabs.appendChild(btn);
    });
  }

  function syncTabs() {
    el.tabs.querySelectorAll('.tab').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.category === state.category));
    });
  }

  function categoryOf(id) {
    return state.categories.find((c) => c.id === id) || null;
  }

  function buildCard(p) {
    const cat = categoryOf(p.category);

    const card = make('article', 'card');
    card.id = 'p-' + p.no;
    card.dataset.no = p.no;

    // 썸네일
    const thumb = make('div', 'thumb thumb--' + (cat && cat.theme ? cat.theme : 'default'));
    const fallbackEmoji = p.emoji || (cat && cat.emoji) || '🛍️';

    if (p.image) {
      const img = make('img', 'thumb__img');
      img.src = p.image;
      img.alt = p.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        img.remove();
        thumb.prepend(make('span', 'thumb__emoji', fallbackEmoji));
      });
      thumb.appendChild(img);
    } else {
      const emoji = make('span', 'thumb__emoji', fallbackEmoji);
      emoji.setAttribute('aria-hidden', 'true');
      thumb.appendChild(emoji);
    }

    const badge = make('span', 'badge', '#' + p.no);
    badge.setAttribute('aria-label', p.no + '번 상품');
    thumb.appendChild(badge);
    card.appendChild(thumb);

    // 본문
    const body = make('div', 'card__body');

    const top = make('div', 'card__top');
    top.appendChild(make('span', 'cat', cat ? cat.label : '추천'));
    const copyBtn = make('button', 'copy');
    copyBtn.type = 'button';
    copyBtn.dataset.copy = p.no;
    copyBtn.setAttribute('aria-label', p.no + '번 상품 링크 복사');
    copyBtn.title = '이 상품 링크 복사';
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path d="M10.5 13.5a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1L11.8 7" ' +
      'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
      '<path d="M13.5 10.5a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3" ' +
      'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
    top.appendChild(copyBtn);
    body.appendChild(top);

    body.appendChild(make('h3', 'card__name', p.name));

    if (p.pitch) body.appendChild(make('p', 'card__pitch', p.pitch));

    const meta = make('div', 'card__meta');
    if (p.price) meta.appendChild(make('span', 'price', p.price));
    p.tags.forEach((t) => meta.appendChild(make('span', 'tag', t)));
    if (meta.childNodes.length) body.appendChild(meta);

    // CTA (쿠팡 링크에는 유입 출처 기반 subId가 자동으로 붙습니다)
    const isDemo = !p.url || p.url === '#' || p.url.startsWith('#');
    const cta = make('a', 'cta');
    const buyHref = isDemo ? '#' : withSubId(p.url, subIdFor(p));
    cta.href = buyHref;
    cta.innerHTML =
      '<span>쿠팡에서 보기</span>' +
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';

    if (isDemo) {
      cta.dataset.demo = '1';
      cta.setAttribute('aria-label', p.name + ' — 데모 링크');
      cta.addEventListener('click', (e) => {
        e.preventDefault();
        toast('데모 링크예요. products.json의 url에 쿠팡 파트너스 링크를 넣으면 바로 연결돼요.');
      });
    } else {
      cta.target = '_blank';
      cta.rel = 'nofollow sponsored noopener noreferrer';
      cta.setAttribute('aria-label', p.name + ' — 쿠팡에서 보기 (새 창)');
      cta.addEventListener('click', () => {
        // 세션 중 출처가 바뀌었거나 누락됐을 때를 대비해 직전에 한 번 더 맞춥니다.
        const href = withSubId(p.url, subIdFor(p));
        cta.href = href;
        trackProductClick(p, href);
      });
    }

    body.appendChild(cta);
    card.appendChild(body);
    return card;
  }

  function currentList() {
    const q = norm(state.query);
    const num = numberQuery(q);
    let list = state.products.slice();

    if (num === null && state.category !== 'all') {
      list = list.filter((p) => p.category === state.category);
    }
    if (num !== null) {
      list = list.filter((p) => productNo(p) === num);
    } else if (q) {
      const terms = q.split(' ').filter(Boolean);
      list = list.filter((p) => {
        const cat = categoryOf(p.category);
        const hay = norm(
          [p.name, p.pitch, p.price, p.tags.join(' '), cat ? cat.label : '', '#' + p.no, p.no].join(' ')
        );
        return terms.every((t) => hay.includes(t));
      });
    }
    return list;
  }

  function describe(count) {
    const q = norm(state.query);
    const num = numberQuery(q);

    if (num !== null) {
      return count
        ? `<b>#${padNo(num)}</b> 상품을 찾았어요`
        : `<b>#${padNo(num)}</b> 상품이 아직 없어요`;
    }
    if (q) {
      return count ? `‘${state.query.trim()}’ 검색 결과 <b>${count}</b>개` : `‘${state.query.trim()}’ 검색 결과가 없어요`;
    }
    if (state.category === 'all') return `전체 <b>${count}</b>개 상품`;
    const cat = categoryOf(state.category);
    return `${cat ? cat.label : ''} <b>${count}</b>개 상품`;
  }

  function render() {
    const list = currentList();

    el.grid.innerHTML = '';
    list.forEach((p) => el.grid.appendChild(buildCard(p)));

    el.resultLine.innerHTML = describe(list.length);
    el.empty.hidden = list.length !== 0 || !state.ready;
    syncTabs();
    el.clearBtn.hidden = !state.query;
  }

  function renderSkeletons() {
    el.grid.innerHTML = '';
    for (let i = 0; i < 3; i += 1) {
      const s = make('div', 'skeleton');
      s.setAttribute('aria-hidden', 'true');
      el.grid.appendChild(s);
    }
    el.resultLine.textContent = '';
  }

  /* ---------------- 동작 ---------------- */

  function setQuery(value, opts) {
    const options = opts || {};
    state.query = value;

    const num = numberQuery(value);
    if (num !== null && state.category !== 'all') {
      state.category = 'all'; // 번호로 찾을 때는 카테고리에 가두지 않음
    }

    render();

    if (options.focusResult) {
      const first = el.grid.querySelector('.card');
      if (first && list0Count() === 1) {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        first.classList.add('is-flash');
        setTimeout(() => first.classList.remove('is-flash'), 1600);
        el.searchInput.blur();
      }
    }
  }

  function list0Count() {
    return el.grid.querySelectorAll('.card').length;
  }

  function focusProduct(no) {
    const card = document.getElementById('p-' + padNo(no));
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 1700);
  }

  function deepLinkQuery() {
    const params = new URLSearchParams(window.location.search);
    const fromParam = params.get('no') || params.get('q');
    if (fromParam) return fromParam;

    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (!hash) return '';
    return hash.replace(/^p-/, '');
  }

  function bind() {
    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      state.category = btn.dataset.category;
      render();
    });

    el.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      setQuery(el.searchInput.value, { focusResult: true });
    });

    el.searchInput.addEventListener('input', () => {
      setQuery(el.searchInput.value);
    });

    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setQuery(el.searchInput.value, { focusResult: true });
      }
      if (e.key === 'Escape') {
        el.searchInput.value = '';
        setQuery('');
      }
    });

    el.clearBtn.addEventListener('click', () => {
      el.searchInput.value = '';
      setQuery('');
      el.searchInput.focus();
    });

    el.resetBtn.addEventListener('click', () => {
      el.searchInput.value = '';
      state.category = 'all';
      setQuery('');
    });

    // 주소 끝에 #p-03 / #03 을 붙여 들어와도 그 상품만 보이게
    window.addEventListener('hashchange', () => {
      const deep = deepLinkQuery();
      if (!deep) return;
      el.searchInput.value = deep;
      setQuery(deep);
      const num = numberQuery(deep);
      if (num !== null) focusProduct(num);
    });

    el.grid.addEventListener('click', async (e) => {      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      const no = btn.dataset.copy;
      // 복사하는 링크에도 지금 유입 출처를 담아 두어, 그 링크로 들어온 사람도 같은 출처로 집계되게 합니다.
      let link = window.location.href.split('#')[0];
      try {
        const u = new URL(link);
        u.searchParams.delete('no');
        u.searchParams.delete('q');
        if (state.src && state.src !== SRC_DEFAULT) u.searchParams.set('src', state.src);
        else u.searchParams.delete('src');
        link = u.toString();
      } catch (_) { /* 주소 해석 실패 시 원본 주소 사용 */ }
      link += '#p-' + no;
      const ok = await copyText(link);
      toast(ok ? `#${no} 링크를 복사했어요. 영상 설명란에 붙여 넣으세요.` : `복사에 실패했어요: ${link}`);
    });
  }

  async function init() {
    state.src = resolveTrafficSrc();
    bind();
    renderSkeletons();

    const sitePromise = loadJSON(SITE_URL).catch(() => FALLBACK_SITE);
    const dataPromise = loadJSON(DATA_URL);

    applySite(await sitePromise);
    trackVisit();

    try {
      const data = await dataPromise;
      applyData(data);
    } catch (err) {
      el.grid.innerHTML = '';
      el.error.hidden = false;
      el.resultLine.textContent = '';
      return;
    }

    renderTabs();
    render();

    const deep = deepLinkQuery();
    if (deep) {
      el.searchInput.value = deep;
      setQuery(deep);
      const num = numberQuery(deep);
      if (num !== null) focusProduct(num);
      // 주소창은 깔끔하게 유지
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search.replace(/[?&]no=[^&]*/, ''));
      }
    }
  }

  init();
})();
