/* Landing page script, shared by the FastFix and Blindless sites — no dependencies. */
(() => {
  'use strict';

  const root = document.documentElement;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const EASE = 'cubic-bezier(0.28, 0.11, 0.32, 1)';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => !reduceMotion.matches;

  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const smooth = (t) => t * t * (3 - 2 * t);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Per-site settings live in the page (#site-config), so both sites share this file.
  const CONFIG = (() => {
    try { return JSON.parse(document.getElementById('site-config').textContent); } catch { return {}; }
  })();
  const BRAND = CONFIG.brand || 'FastFix';
  const KEY_BASE = CONFIG.key || 'fastfix';
  // Sign-ups can go straight to a hosted table from any static host: "store" in
  // #site-config names a Supabase table the public may only insert into (its
  // row-level security allows insert and never read). Only a publishable key is
  // accepted here, never a secret one.
  const STORE = (() => {
    const s = CONFIG.store;
    if (!s || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(s.url) || !/^sb_publishable_[\w-]+$/.test(s.key)) return null;
    return { url: s.url, key: s.key, table: /^[a-z_]+$/.test(s.table || '') ? s.table : 'waitlist_signups' };
  })();
  // The GitHub Pages staging copy is static: there is no /api/waitlist behind
  // it, so unless the page names a store the forms send nothing and say so.
  // Set only by sites/build-pages.mjs.
  const STATIC_PREVIEW = CONFIG.preview === 'static' && !STORE;

  // E.164 from what people type. A leading "+" (or "00") wins over the picker.
  function toE164(raw, cc = '1') {
    let text = String(raw ?? '').trim();
    if (text.startsWith('00')) text = `+${text.slice(2)}`;
    if (/[^\d\s()+.-]/.test(text)) return { error: 'chars' };
    let digits = text.replace(/\D/g, '');
    if (!digits) return { error: 'empty' };
    if (!text.startsWith('+')) {
      if (cc === '1' && digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
      else if (cc !== '1') digits = digits.replace(/^0+/, '');
      digits = cc + digits;
    }
    if (digits.length < 10) return { error: 'short' };
    if (digits.length > 15) return { error: 'long' };
    if (digits[0] === '1' && !/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { error: 'area' };
    return { e164: `+${digits}` };
  }
  const PHONE_ERRORS = {
    empty: 'Add your number.',
    short: 'That number looks short. Include the area code.',
    long: 'That number looks too long.',
    area: 'Check the area code.',
    chars: 'Use digits only.',
  };
  const prettyPhone = (e164) => {
    if (e164.startsWith('+1') && e164.length === 12) return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
    // Elsewhere: the country code, then the rest in readable groups.
    const cc = ['52', '57', '34', '44'].find((code) => e164.startsWith(`+${code}`));
    if (!cc) return e164;
    const rest = e164.slice(cc.length + 1);
    return `+${cc} ${rest.replace(/(\d{3,4})(?=(\d{3,4})+$)/g, '$1 ').trim()}`;
  };

  function icon(id) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  // One rAF-throttled scroll/resize loop shared by every scroll-linked piece.
  const frames = new Set();
  let queued = false;
  const flush = () => {
    queued = false;
    frames.forEach((fn) => fn());
  };
  const requestFrame = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(flush);
  };
  window.addEventListener('scroll', requestFrame, { passive: true });

  const resizers = new Set();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizers.forEach((fn) => fn());
      requestFrame();
    }, 80);
  });

  // Browser storage can be missing or throw (private mode, blocked site data).
  const store = {
    get(area, key) {
      try { return JSON.parse(window[area].getItem(key)); } catch { return null; }
    },
    set(area, key, value) {
      try { window[area].setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
    },
  };

  // Where signups go. On the real site: the /api/waitlist function. When the
  // page runs as a claude.ai staging preview (window.claude exists), the
  // preview's own database: one private document per viewer, readable only
  // by the owner.
  const previewStore = window.claude?.use
    ? Promise.all([window.claude.use('db'), window.claude.use('user')])
      .then(async ([db, user]) => {
        const id = db && user ? await user.id() : null;
        return id ? { db, id } : null;
      })
      .catch(() => null)
    : null;

  // One row per sign-up. The honeypot answers like a success so a bot moves on.
  async function saveToStore({ company_website: trap, phone, channel, source, prize = null, code = null }) {
    if (trap) return {};
    const res = await fetch(`${STORE.url}/rest/v1/${STORE.table}`, {
      method: 'POST',
      headers: { apikey: STORE.key, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ site: KEY_BASE, phone, channel, source, prize, code, page: window.location.pathname.slice(0, 200) }),
    });
    if (!res.ok) throw new Error(`store ${res.status}`);
    return {};
  }

  async function postSignup(payload) {
    if (STATIC_PREVIEW) return { preview: true };
    if (previewStore) {
      const preview = await previewStore;
      if (!preview) throw new Error('preview store unavailable');
      const { company_website: trap, ...entry } = payload;
      if (trap) return {};
      // One document per viewer, one field per form, so a waitlist signup
      // and a Play to Win claim from the same person both survive.
      const ref = preview.db.doc(`signups/${preview.id}`);
      const at = new Date().toISOString();
      const fields = { [entry.source]: { ...entry, at }, phone: entry.phone, channel: entry.channel, updated: at };
      const snap = await ref.get();
      await (snap.exists ? ref.update(fields) : ref.set(fields));
      return {};
    }
    if (STORE) return saveToStore(payload);
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`waitlist ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // One chosen app for the page: the sign-up forms announce it, the demo phone follows.
  const channelBus = new EventTarget();

  root.classList.add('js');
  // Per-site styling hook (e.g. Blindless' everyday chat wallpaper), also when the page is embedded.
  root.dataset.site = KEY_BASE;
  if (motion() && 'IntersectionObserver' in window) root.classList.add('js-motion');

  /* ---------- Page chrome ---------- */

  $$('[data-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });

  const nav = $('.nav');
  if (nav) {
    const darks = $$('.day, .bd-dark');
    const dockBar = $('[data-dock]');
    const syncNav = () => {
      nav.classList.toggle('is-stuck', window.scrollY > 8);
      if (!darks.length) return;
      // Dark while any dark band is under the bar (the dark bar is solid, so it never shows two tones).
      const boxes = darks.map((el) => el.getBoundingClientRect());
      nav.classList.toggle('is-dark', boxes.some((box) => box.top < nav.offsetHeight && box.bottom > 0));
      // The phone dock follows the bands the same way.
      if (dockBar) {
        const mid = window.innerHeight - parseFloat(getComputedStyle(dockBar).bottom) - dockBar.offsetHeight / 2;
        dockBar.classList.toggle('is-dark', boxes.some((box) => box.top <= mid && box.bottom >= mid));
      }
    };
    frames.add(syncNav);
    syncNav();
  }

  /* ---------- Reveals ---------- */

  const reveals = $$('[data-reveal]');
  const revealHooks = [];
  reveals.forEach((node) => {
    const siblings = Array.from(node.parentElement.children).filter((child) => child.hasAttribute('data-reveal'));
    node.style.setProperty('--i', String(siblings.indexOf(node)));
  });
  if (root.classList.contains('js-motion')) {
    const io = new IntersectionObserver((entries) => {
      // Stagger by arrival: only items that come into view together take turns,
      // so a row reached later doesn't wait behind tiles already on screen.
      const batch = new Map();
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const parent = entry.target.parentElement;
        const turn = batch.get(parent) || 0;
        batch.set(parent, turn + 1);
        entry.target.style.setProperty('--i', String(turn));
        entry.target.classList.add('is-in');
        revealHooks.forEach((hook) => hook(entry.target));
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    reveals.forEach((node) => io.observe(node));
  }

  /* ---------- Story: pinned, scroll-driven chat ---------- */

  const story = $('[data-story]');
  if (story) {
    const stage = $('.story__stage', story);
    const device = $('[data-device]', story);
    const phone = $('[data-phone]', story);
    const thread = $('[data-thread]', story);
    const list = $('[data-thread-list]', story);
    const steps = $$('.step', story);
    // Stacked story: phones, portrait tablets and anything too short to pin; landscape tablets go side by side.
    const compact = window.matchMedia('(max-width: 1023px) and (orientation: portrait), (max-width: 639px), (max-width: 1023px) and (max-height: 500px)');
    const PHONE_W = 360;
    const PHONE_H = 740;
    const MIN_PH = 500;
    const MIN_SCALE = 0.9;

    // Each step owns a slice of the scroll (data-range on the step); messages key off it.
    const RANGES = steps.every((step) => step.dataset.range)
      ? steps.map((step) => step.dataset.range.split(',').map(Number))
      : [[0, 0.22], [0.22, 0.46], [0.46, 0.68], [0.68, 1]];
    const CHANNEL = {
      WhatsApp: { sub: 'online', input: '' },
      SMS: { sub: 'Text Message', input: 'Text Message' },
      Telegram: { sub: 'bot', input: 'Message' },
    };

    const timed = $$('[data-at]', story).map((node) => ({
      node,
      at: Number(node.dataset.at),
      until: node.dataset.until ? Number(node.dataset.until) : null,
      out: node.classList.contains('msg--out'),
      on: node.classList.contains('is-shown'),
      past: false,
      read: false,
    }));
    const typing = $$('[data-from]', story).map((node) => ({ node, from: Number(node.dataset.from), to: Number(node.dataset.to), on: false }));
    const presses = $$('[data-press]', story).map((node) => ({ node, at: Number(node.dataset.press), on: false }));
    const items = Array.from(list.children);

    // The phone rises from just under the hero's sign-up form.
    const heroEnd = $('.hero__note') || $('.hero [data-join]');
    const stepList = $('.steps', story);
    const statusTime = $('[data-status-time]', story);
    const subLabel = $('[data-channel-label]', story);
    let shift = 0;
    let lift = 0;
    let lastP = -1;
    let lastOpened = null;
    let lastOffset = -1;
    let dateTimer = 0;

    // Fit the phone to the frame, note how far it sits from the page centre,
    // and how far it must rise to sit just under the hero on arrival.
    const measure = () => {
      // Tablets in portrait have room to spare; the wide layout keeps 1:1 for the documents.
      const room = stage.clientHeight;
      let ph = PHONE_H;
      // Tall portrait screens in the side-by-side layout (a 12.9" iPad) have room for a bigger phone.
      const tallWide = !compact.matches && !device.querySelector('.docs') && window.innerHeight > window.innerWidth;
      let scale = Math.min(compact.matches ? 1.15 : (tallWide ? 1.2 : 1), room / ph, stage.clientWidth / PHONE_W);
      // Short screens: a readable chat beats a whole phone, so the mock gets
      // shorter (the thread shows fewer earlier bubbles) instead of smaller.
      if (scale < MIN_SCALE) {
        const target = Math.min(MIN_SCALE, stage.clientWidth / PHONE_W);
        ph = Math.max(MIN_PH, Math.min(PHONE_H, Math.round(room / target)));
        scale = Math.min(target, room / ph);
      }
      story.style.setProperty('--ph', `${ph}px`);
      story.style.setProperty('--phone-scale', scale.toFixed(4));
      story.style.setProperty('--slack', `${Math.max(0, (room - ph * scale) / 2).toFixed(1)}px`);
      const box = stage.getBoundingClientRect();
      const centre = box.left + device.offsetLeft + device.offsetWidth / 2;
      shift = compact.matches ? 0 : window.innerWidth / 2 - centre;
      const top = story.getBoundingClientRect().top + window.scrollY + stage.offsetTop + device.offsetTop + (ph * (1 - scale)) / 2;
      // Layout box, not the transform: the form may still be mid-entrance.
      const floor = heroEnd
        ? heroEnd.getBoundingClientRect().bottom + window.scrollY - (new DOMMatrixReadOnly(getComputedStyle(heroEnd).transform).m42 || 0) + (compact.matches ? 36 : 56)
        : top;
      lift = Math.max(0, top - floor);
    };

    // Keep the newest bubble resting on the composer, like a real chat.
    const align = () => {
      let bottom = 0;
      items.forEach((node) => {
        if (node.classList.contains('typing')) {
          if (!node.classList.contains('is-on')) return;
          const bubble = node.firstElementChild;
          bottom = Math.max(bottom, node.offsetTop + bubble.offsetTop + bubble.offsetHeight);
        } else if (!node.classList.contains('msg') || node.classList.contains('is-shown')) {
          bottom = Math.max(bottom, node.offsetTop + node.offsetHeight);
        }
      });
      const offset = Math.max(0, bottom + 14 - thread.clientHeight);
      list.style.setProperty('--y', `${-offset}px`);
      // Like WhatsApp and Telegram, the date floats while the thread moves and fades once it rests.
      if (offset !== lastOffset) {
        lastOffset = offset;
        phone.classList.toggle('is-scrolled', offset > 0);
        phone.classList.remove('is-still');
        window.clearTimeout(dateTimer);
        dateTimer = window.setTimeout(() => phone.classList.add('is-still'), motion() ? 1200 : 0);
      }
    };

    const update = () => {
      const vh = window.innerHeight;
      const box = story.getBoundingClientRect();
      const p = clamp(-box.top / Math.max(1, box.height - vh), 0, 1);

      // As the section arrives, the phone slides from centre to its column.
      const enter = clamp((vh - box.top) / vh, 0, 1);
      const e = motion() ? smooth(clamp((enter - 0.45) / 0.5, 0, 1)) : 1;
      story.style.setProperty('--e', e.toFixed(4));
      device.style.setProperty('--dx', `${(shift * (1 - e)).toFixed(1)}px`);
      // The lift is shared, so on phones the captions ride above the rising phone.
      story.style.setProperty('--dy', `${(-lift * (1 - e)).toFixed(1)}px`);
      // Stacked layout: the captions show once they clear the sign-up form above.
      let head = e;
      if (compact.matches && heroEnd) {
        const formBottom = heroEnd.getBoundingClientRect().bottom;
        head = formBottom < 0 ? 1 : clamp((stepList.getBoundingClientRect().top - formBottom - 16) / 24, 0, 1);
      }
      story.style.setProperty('--head', head.toFixed(4));

      // The first text sends as the phone starts to rise, so the hero never ends on half a bubble.
      const opened = p > 0 || e > 0.25;
      if (p === lastP && opened === lastOpened) return;
      lastP = p;
      lastOpened = opened;

      let active = RANGES.findIndex(([, end]) => p < end);
      if (active === -1) active = RANGES.length - 1;
      steps.forEach((step, i) => {
        const [start, end] = RANGES[i];
        step.style.setProperty('--fill', clamp((p - start) / (end - start), 0, 1).toFixed(4));
        step.classList.toggle('is-active', i === active);
        if (i === active) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      });

      let moved = false;
      timed.forEach((item) => {
        const on = item.at === 0 ? opened : p >= item.at;
        if (on !== item.on) {
          item.on = on;
          item.node.classList.toggle('is-shown', on);
          moved = true;
        }
        if (item.until != null && (p >= item.until) !== item.past) {
          item.past = !item.past;
          item.node.classList.toggle('is-past', item.past);
        }
        if (item.out && (p >= item.at + 0.02) !== item.read) {
          item.read = !item.read;
          item.node.classList.toggle('is-read', item.read);
        }
      });
      typing.forEach((item) => {
        const on = p >= item.from && p < item.to;
        if (on === item.on) return;
        item.on = on;
        item.node.classList.toggle('is-on', on);
        moved = true;
      });
      presses.forEach((item) => {
        const on = p >= item.at;
        if (on === item.on) return;
        item.on = on;
        item.node.classList.toggle('is-pressed', on);
      });
      if (moved) {
        align();
        syncChrome();
      }
    };

    // WhatsApp and Telegram say "typing…" in the header; the status bar shows
    // the time of the newest message.
    function syncChrome() {
      const busy = typing.some((item) => item.on);
      const name = phone.dataset.channel;
      const typingNow = busy && (name === 'WhatsApp' || name === 'Telegram');
      subLabel.textContent = typingNow ? 'typing…' : CHANNEL[name].sub;
      subLabel.classList.toggle('is-typing', typingNow);
      // iOS Messages marks only your latest text "Delivered".
      const outs = timed.filter((item) => item.on && item.out);
      const lastOut = outs[outs.length - 1];
      timed.forEach((item) => { if (item.out) item.node.classList.toggle('is-last-out', item === lastOut); });
      const last = timed.filter((item) => item.on && item.node.classList.contains('msg')).pop();
      const stamp = last && $('.msg__meta', last.node)?.firstChild?.textContent.trim();
      if (stamp && statusTime.textContent !== stamp) statusTime.textContent = stamp;
    }

    frames.add(update);
    resizers.add(() => { measure(); lastP = -1; align(); });
    measure();
    update();
    align();
    document.fonts?.ready.then(() => { measure(); align(); requestFrame(); });
    // The room can change without a window resize (a font arriving, captions re-wrapping): refit then.
    if ('ResizeObserver' in window) {
      let lastRoom = -1;
      new ResizeObserver(() => {
        if (stage.clientHeight === lastRoom) return;
        lastRoom = stage.clientHeight;
        measure();
        lastP = -1;
        align();
        requestFrame();
      }).observe(stage);
    }

    // Channel switcher: same assistant, dressed as each app.
    const seg = $('.seg', story);
    const radios = $$('button[data-channel]', seg);
    seg.style.setProperty('--seg-n', String(radios.length));
    const inputLabel = $('[data-channel-input]', story);
    let switchTimer = 0;

    const dress = (name) => {
      phone.dataset.channel = name;
      inputLabel.textContent = CHANNEL[name].input;
      syncChrome();
      align();
    };

    const selectChannel = (button, focus) => {
      const index = radios.indexOf(button);
      radios.forEach((radio, i) => {
        radio.setAttribute('aria-checked', String(i === index));
        radio.tabIndex = i === index ? 0 : -1;
      });
      seg.style.setProperty('--seg-i', String(index));
      if (focus) button.focus();
      const name = button.dataset.channel;
      if (phone.dataset.channel === name) return;
      window.clearTimeout(switchTimer);
      if (!motion()) { dress(name); return; }
      phone.classList.add('is-switching');
      switchTimer = window.setTimeout(() => {
        dress(name);
        window.requestAnimationFrame(() => phone.classList.remove('is-switching'));
      }, 190);
    };

    radios.forEach((radio, index) => {
      radio.tabIndex = index === 0 ? 0 : -1;
      radio.addEventListener('click', () => { selectChannel(radio); setChannel(radio.dataset.channel.toLowerCase()); });
      radio.addEventListener('keydown', (event) => {
        const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!dir) return;
        event.preventDefault();
        const next = radios[(index + dir + radios.length) % radios.length];
        selectChannel(next, true);
        setChannel(next.dataset.channel.toLowerCase());
      });
    });
    dress(phone.dataset.channel);
    // The app picked in a sign-up form dresses the demo phone too.
    channelBus.addEventListener('pick', (event) => {
      const button = radios.find((radio) => radio.dataset.channel.toLowerCase() === event.detail);
      if (button && button.getAttribute('aria-checked') !== 'true') selectChannel(button);
    });
  }

  /* ---------- Hand it off: finished documents you can open ---------- */

  const jobs = $('[data-jobs]');
  if (jobs) {
    // Payroll: the owner's yes (or not yet) plays out in the chat. Nothing is paid.
    $$('.job--pay', jobs).forEach((tile) => {
      const ask = $('[data-ask]', tile);
      const answer = (kind) => {
        if (ask.classList.contains('is-answered')) return;
        const hadFocus = ask.contains(document.activeElement);
        ask.classList.add('is-answered');
        $$('.wask__act', ask).forEach((button) => button.setAttribute('aria-disabled', 'true'));
        // The buttons step aside for the reply; focus stays on the document.
        if (hadFocus) $('.wask__file', ask)?.focus({ preventScroll: true });
        $(`[data-reply="${kind}"]`, tile).hidden = false;
        window.setTimeout(() => {
          const done = $(`[data-done="${kind}"]`, tile);
          done.hidden = false;
          done.setAttribute('role', 'status');
          // The document says what happened too, in the tile and in the viewer.
          const stamp = $('.pg__stamp--wait', tile);
          if (stamp) {
            stamp.textContent = kind === 'yes' ? 'Approved by you' : 'On hold';
            stamp.classList.toggle('pg__stamp--wait', kind !== 'yes');
          }
          const pay = $('.pg__pay', tile);
          if (pay && kind === 'yes') {
            if (pay.closest('.pg--vendor')) {
              pay.closest('.pg').classList.add('is-paid');
              pay.className = 'pg__stamp';
              pay.textContent = 'Paid';
              const due = $('.pg__due span', tile);
              if (due) due.textContent = 'Amount paid';
            } else pay.remove();
          }
        }, motion() ? 900 : 0);
      };
      $('[data-approve]', tile)?.addEventListener('click', () => answer('yes'));
      $('[data-hold]', tile)?.addEventListener('click', () => answer('hold'));
    });

    // Phones: a job index over the swipeable rail.
    const index = $('[data-jobs-index]');
    const rail = window.matchMedia('(max-width: 767px)');
    if (index && 'IntersectionObserver' in window) {
      const links = $$('a', index);
      const mark = (id) => links.forEach((link) => link.setAttribute('aria-current', String(link.hash === `#${id}`)));
      const seen = new IntersectionObserver((entries) => {
        if (!rail.matches) return;
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          // The chip follows the tile the rail has snapped to; a neighbour can pass 60%.
          if (entry.intersectionRatio >= 0.95) mark(entry.target.id);
          // A tile swiped into view plays its chat in place, with no vertical rise. While the
          // rail is off screen the page's own reveal plays it, once it scrolls in.
          const box = jobs.getBoundingClientRect();
          const onScreen = box.top < window.innerHeight * 0.85 && box.bottom > window.innerHeight * 0.15;
          if (onScreen && root.classList.contains('js-motion') && !entry.target.classList.contains('is-in')) {
            entry.target.style.setProperty('--i', '0');
            entry.target.classList.add('is-in');
            revealHooks.forEach((hook) => hook(entry.target));
          }
        });
      }, { root: jobs, threshold: [0.6, 0.95] });
      $$('.job', jobs).forEach((job) => seen.observe(job));
      links.forEach((link) => link.addEventListener('click', (event) => {
        const job = $(link.hash);
        if (!job || !rail.matches) return;
        event.preventDefault();
        // The rail moves; the page follows only if the tile's chat would end below the screen.
        const pad = parseFloat(getComputedStyle(jobs).scrollPaddingInlineStart) || 0;
        jobs.scrollTo({ left: job.offsetLeft - jobs.offsetLeft - pad, behavior: motion() ? 'smooth' : 'auto' });
        const over = job.getBoundingClientRect().bottom + 12 - window.innerHeight;
        if (over > 0) window.scrollBy({ top: over, behavior: motion() ? 'smooth' : 'auto' });
        mark(job.id);
      }));
    }
    // Once a tile has played its entrance, hover responds without the stagger.
    revealHooks.push((node) => {
      if (node.classList.contains('job')) window.setTimeout(() => node.classList.add('is-settled'), 2400);
    });
  }

  /* ---------- Document viewer (WhatsApp style) ---------- */

  const dv = $('[data-dv]');
  const DOCS = CONFIG.docs || {};
  const ORDER = (CONFIG.order || Object.keys(DOCS)).filter((key) => DOCS[key]);
  if (dv && ORDER.length) {
    const pagesBox = $('[data-dv-pages]', dv);
    const scroller = $('[data-dv-scroll]', dv);
    let current = null;
    let opener = null;
    let pushed = false;
    let closing = false;
    let fadeOut = null;
    let thumbEl = null;
    let returnY = 0;
    const announce = $('[data-dv-live]', dv);

    // Keyframes that carry a page between its chat thumbnail and the viewer.
    const zoomFrames = (thumb, pageEl) => {
      const a = thumb.getBoundingClientRect();
      const b = pageEl.getBoundingClientRect();
      const s = a.width / b.width;
      const clip = Math.max(0, b.height - a.height / s);
      return [
        { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})`, clipPath: `inset(0 0 ${clip}px 0 round ${6 / s}px)`, transformOrigin: '0 0' },
        { transform: 'none', clipPath: 'inset(0 0 0 0 round 2px)', transformOrigin: '0 0' },
      ];
    };

    const build = (key) => {
      const frag = document.createDocumentFragment();
      const first = $(`[data-paper="${key}"]`);
      if (first) frag.append(first.cloneNode(true));
      const extra = $(`template[data-pages="${key}"]`);
      if (extra) frag.append(extra.content.cloneNode(true));
      return frag;
    };

    const fill = (key, page = 0, dir = 0) => {
      current = key;
      const doc = DOCS[key];
      const i = ORDER.indexOf(key);
      const name = doc.names?.[page] || doc.name;
      $('[data-dv-name]', dv).textContent = name;
      if (announce) announce.textContent = `${name}, ${i + 1} of ${ORDER.length}`;
      $('[data-dv-sub]', dv).textContent = window.innerWidth < 640 ? doc.sub : `${BRAND} · ${doc.sub}`;
      $('[data-dv-cap]', dv).textContent = doc.cap;
      $('[data-dv-count]', dv).textContent = `${i + 1} of ${ORDER.length}`;
      $('[data-dv-prev]', dv).setAttribute('aria-label', `Previous: ${DOCS[ORDER[(i + ORDER.length - 1) % ORDER.length]].name}`);
      $('[data-dv-next]', dv).setAttribute('aria-label', `Next: ${DOCS[ORDER[(i + 1) % ORDER.length]].name}`);
      pagesBox.replaceChildren(build(key));
      scroller.scrollTop = 0;
      if (dir && motion()) {
        pagesBox.style.setProperty('--dx', `${dir * 32}px`);
        pagesBox.classList.remove('is-swap');
        void pagesBox.offsetWidth;
        pagesBox.classList.add('is-swap');
      }
    };

    const openDoc = (key, page, from) => {
      if (!DOCS[key]) return;
      opener = from;
      // Drop the last close's fade, or the next file opens invisible.
      fadeOut?.cancel();
      fadeOut = null;
      pagesBox.getAnimations().forEach((animation) => animation.cancel());
      fill(key, page);
      returnY = window.scrollY;
      try { window.history.scrollRestoration = 'manual'; } catch { /* older browsers */ }
      dv.showModal();
      // Multi-file docs open at the file that was tapped (layout exists only once shown).
      const target = page ? pagesBox.children[page] : null;
      if (target) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20;
      document.body.classList.add('has-modal');
      window.requestAnimationFrame(() => dv.classList.add('is-open'));
      scroller.focus({ preventScroll: true });
      try { window.history.pushState({ dv: true }, ''); pushed = true; } catch { pushed = false; }
      // The page zooms out of its bubble.
      const bubble = from?.closest('.tb');
      const thumb = bubble && $$('.wdoc__page, .wlink__img, .wimg__pic', bubble).find((node) => node.getBoundingClientRect().width > 0);
      const pageEl = pagesBox.firstElementChild;
      thumbEl = null;
      if (motion() && thumb && pageEl && !page) {
        thumbEl = thumb;
        const frames = zoomFrames(thumb, pageEl);
        // One copy on screen: the bubble's page travels, the original waits.
        thumb.style.visibility = 'hidden';
        pageEl.animate(frames, { duration: 460, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }).finished
          .then(() => { if (!closing && thumbEl === thumb) thumb.style.visibility = ''; }, () => {});
      } else if (motion()) {
        pagesBox.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE_OUT });
      }
    };

    const finish = () => {
      closing = false;
      if (dv.open) dv.close();
      fadeOut?.cancel();
      fadeOut = null;
      if (thumbEl) thumbEl.style.visibility = '';
      thumbEl = null;
      window.scrollTo({ top: returnY, behavior: 'instant' });
      try { window.history.scrollRestoration = 'auto'; } catch { /* older browsers */ }
      document.body.classList.remove('has-modal');
      dv.classList.remove('is-open');
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    const closeDoc = (fromHistory = false) => {
      if (!dv.open || closing) return;
      closing = true;
      if (pushed && !fromHistory) window.history.back();
      pushed = false;
      dv.classList.remove('is-open');
      const pageEl = pagesBox.firstElementChild;
      const onScreen = (node) => { const r = node?.getBoundingClientRect(); return r && r.width && r.bottom > 0 && r.top < window.innerHeight; };
      if (motion() && thumbEl && pageEl && scroller.scrollTop < 40 && onScreen(thumbEl)) {
        // Back into the bubble it came from, the way it opened.
        thumbEl.style.visibility = 'hidden';
        fadeOut = pageEl.animate(zoomFrames(thumbEl, pageEl).reverse(), { duration: 380, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' });
        fadeOut.finished.then(finish, () => {});
      } else if (motion()) {
        fadeOut = pagesBox.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
        fadeOut.finished.then(finish, () => {});
      } else finish();
    };

    const step = (dir) => {
      const i = ORDER.indexOf(current);
      fill(ORDER[(i + dir + ORDER.length) % ORDER.length], 0, dir);
    };

    $$('[data-doc]').forEach((button) => button.addEventListener('click', () => openDoc(button.dataset.doc, Number(button.dataset.page || 0), button)));
    $('[data-dv-close]', dv).addEventListener('click', () => closeDoc());
    $('[data-dv-prev]', dv).addEventListener('click', () => step(-1));
    $('[data-dv-next]', dv).addEventListener('click', () => step(1));
    $('[data-dv-cta]', dv)?.addEventListener('click', (event) => {
      event.preventDefault();
      closeDoc();
      window.setTimeout(() => goToSignup(), motion() ? 260 : 0);
    });
    dv.addEventListener('cancel', (event) => { event.preventDefault(); closeDoc(); });
    dv.addEventListener('close', () => { document.body.classList.remove('has-modal'); dv.classList.remove('is-open'); });
    dv.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    });
    // Phones: the back button closes the viewer, as in WhatsApp.
    window.addEventListener('popstate', () => { if (dv.open && !closing) { pushed = false; closeDoc(true); } });
    // A set of files: the title names the one in view.
    const dvName = $('[data-dv-name]', dv);
    scroller.addEventListener('scroll', () => {
      const doc = DOCS[current];
      if (!doc?.names) return;
      const mark = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let page = 0;
      Array.from(pagesBox.children).forEach((node, i) => { if (node.getBoundingClientRect().top <= mark) page = i; });
      const name = doc.names[page] || doc.name;
      if (dvName.textContent !== name) dvName.textContent = name;
    }, { passive: true });
    // Swipe between files.
    let sx = NaN;
    let sy = 0;
    scroller.addEventListener('pointerdown', (event) => { sx = event.clientX; sy = event.clientY; });
    scroller.addEventListener('pointercancel', () => { sx = NaN; });
    scroller.addEventListener('pointerup', (event) => {
      if (Number.isNaN(sx)) return;
      const dx = event.clientX - sx;
      sx = NaN;
      const dy = event.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
    // A click on the dark area (not a page, not a control) closes.
    dv.addEventListener('click', (event) => {
      if (event.target === scroller || event.target === dv || event.target.classList.contains('dv__stage')) closeDoc();
    });
  }

  /* ---------- Agents: one ask fans out to one agent per app ---------- */

  $$('[data-agents]').forEach((fig) => {
    const scene = $('.ag__scene', fig);
    const svg = $('.ag__wires', fig);
    const ask = $('[data-ag-ask]', fig);
    const hub = $('[data-ag-hub]', fig);
    const agents = $$('[data-agent]', fig);
    if (!scene || !svg || !hub || !agents.length) return;
    const wire = (cls) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('pathLength', '1');
      path.setAttribute('class', cls);
      svg.append(path);
      return path;
    };
    const askWire = ask ? wire('ag__wire') : null;
    const wires = agents.map(() => wire('ag__wire'));
    const flows = agents.map(() => wire('ag__flow'));

    // Layout boxes relative to the scene, ignoring the transforms the animation adds.
    const place = (el) => {
      let x = 0;
      let y = 0;
      for (let node = el; node && node !== scene; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };
    // Side by side, wires leave the hub's right edge; stacked (phones), its bottom.
    const draw = () => {
      svg.setAttribute('viewBox', `0 0 ${scene.offsetWidth} ${scene.offsetHeight}`);
      const down = getComputedStyle(scene).getPropertyValue('--ag-flow').trim() === 'down';
      const hb = place(hub);
      const hx = hb.x + hb.w / 2;
      const hy = hb.y + hb.h / 2;
      agents.forEach((agent, i) => {
        const a = place(agent);
        const ay = a.y + a.h / 2;
        let d;
        if (down) {
          const sy = hb.y + hb.h;
          d = `M${hx} ${sy} C${hx} ${ay} ${hx} ${ay} ${a.x} ${ay}`;
        } else {
          const sx = hb.x + hb.w;
          const mid = (sx + a.x) / 2;
          d = `M${sx} ${hy} C${mid} ${hy} ${mid} ${ay} ${a.x} ${ay}`;
        }
        wires[i].setAttribute('d', d);
        flows[i].setAttribute('d', d);
        // Each agent is born on the hub.
        agent.style.setProperty('--fx', `${hx - (a.x + a.w / 2)}px`);
        agent.style.setProperty('--fy', `${hy - ay}px`);
      });
      if (askWire) {
        const q = place(ask);
        if (down) {
          const sx = q.x + Math.min(24, q.w / 2);
          const sy = q.y + q.h;
          askWire.setAttribute('d', `M${sx} ${sy} C${sx} ${hb.y} ${hx} ${sy} ${hx} ${hb.y}`);
        } else {
          const sx = q.x + q.w;
          const qy = q.y + q.h / 2;
          const mid = (sx + hb.x) / 2;
          askWire.setAttribute('d', `M${sx} ${qy} C${mid} ${qy} ${mid} ${hy} ${hb.x} ${hy}`);
        }
      }
    };
    draw();
    if ('ResizeObserver' in window) new ResizeObserver(draw).observe(scene);
    document.fonts?.ready.then(draw);
    // Without motion the finished picture stays: every agent done, every wire drawn.
    if (!motion() || !('IntersectionObserver' in window)) return;

    const ON = [1900, 2150, 2400, 2650, 2900];
    const DONE = [3500, 4300, 4900, 5600, 6300];
    let timers = [];
    const later = (ms, fn) => timers.push(window.setTimeout(fn, ms));
    const reset = () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
      fig.classList.add('is-snap');
      fig.classList.remove('is-asked', 'is-heard', 'is-fanned', 'is-done');
      [askWire, ...agents, ...wires, ...flows].forEach((el) => el?.classList.remove('is-on', 'is-done'));
      void fig.offsetWidth;
      fig.classList.remove('is-snap');
    };
    const run = () => {
      reset();
      // After a loop the empty scene fades back in before the next ask.
      fig.classList.remove('is-fading');
      later(350, () => fig.classList.add('is-asked'));
      later(1150, () => { fig.classList.add('is-heard'); askWire?.classList.add('is-on'); });
      later(1650, () => fig.classList.add('is-fanned'));
      agents.forEach((agent, i) => {
        const on = ON[i] ?? ON[0] + i * 250;
        const done = DONE[i] ?? on + 1600;
        agent.style.setProperty('--work', `${done - on}ms`);
        later(on, () => { agent.classList.add('is-on'); wires[i].classList.add('is-on'); flows[i].classList.add('is-on'); });
        later(done, () => { agent.classList.add('is-done'); wires[i].classList.add('is-done'); flows[i].classList.remove('is-on'); });
      });
      later(7000, () => fig.classList.add('is-done'));
      later(11000, () => fig.classList.add('is-fading'));
      later(11600, run);
    };
    fig.classList.add('is-armed');
    reset();
    let playing = false;
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !playing) { playing = true; run(); }
      else if (!entry.isIntersecting && playing) { playing = false; reset(); }
    }, { threshold: 0.35 }).observe(fig);
  });

  /* ---------- Loops that run only while on screen ---------- */

  const liveBoxes = $$('[data-live]');
  if (liveBoxes.length && 'IntersectionObserver' in window) {
    const liveWatch = new IntersectionObserver((entries) => entries.forEach((entry) => entry.target.classList.toggle('is-live', entry.isIntersecting)));
    liveBoxes.forEach((box) => liveWatch.observe(box));
  }

  /* ---------- One workday ---------- */

  const feed = $('[data-feed]');
  if (feed) {
    const rows = $$('.t-row', feed);
    const countNode = $('.day__count [data-count]');
    const nowNode = $('.day__now[data-now]');
    const pill = $('[data-now-pill]', feed);
    const ask = rows.find((row) => row.classList.contains('t-row--ask'));
    let current = -1;
    let approveTimer = 0;
    let pressTimer = 0;
    const roll = (node, text) => {
      if (!node || node.textContent === text) return;
      node.textContent = text;
      if (!motion()) return;
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: EASE });
    };
    frames.add(() => {
      const line = window.innerHeight * 0.62;
      const box = feed.getBoundingClientRect();
      if (box.bottom < -200 || box.top > window.innerHeight + 200) return;
      feed.style.setProperty('--tl', clamp((line - box.top) / box.height, 0, 1).toFixed(4));
      let index = 0;
      rows.forEach((row, i) => {
        const trigger = row.classList.contains('t-row--end') ? window.innerHeight * 0.88 : line;
        const on = i === 0 || row.getBoundingClientRect().top + 10 < trigger;
        row.classList.toggle('is-on', on);
        if (on) index = i;
      });
      const show = (row) => {
        // The waiting row only counts once the owner's yes has landed.
        const approved = ask && ask.classList.contains('is-approved') && rows.indexOf(row) >= rows.indexOf(ask);
        const done = Number(row.dataset.done) + (approved ? 1 : 0);
        roll(countNode, String(done));
        if (nowNode) nowNode.textContent = row.dataset.now;
        if (pill) pill.textContent = `${row.dataset.now} · ${done} done`;
      };
      if (index !== current) {
        current = index;
        show(rows[index]);
      }
      // The order waits, the yes is tapped, then it lands.
      if (ask) {
        const on = ask.classList.contains('is-on');
        if (on && !ask.classList.contains('is-approved') && !approveTimer) {
          const wait = motion() ? 2600 : 0;
          pressTimer = window.setTimeout(() => ask.classList.add('is-approving'), Math.max(0, wait - 600));
          approveTimer = window.setTimeout(() => {
            ask.classList.add('is-approved');
            approveTimer = 0;
            if (current >= rows.indexOf(ask)) show(rows[current]);
          }, wait);
        }
        if (!on) {
          window.clearTimeout(approveTimer);
          window.clearTimeout(pressTimer);
          approveTimer = 0;
          ask.classList.remove('is-approved', 'is-approving');
        }
      }
    });
  }

  /* ---------- FAQ: animated open and close ---------- */

  $$('.faq details').forEach((details) => {
    const summary = $('summary', details);
    const body = $('.faq__a', details);
    let anim = null;
    summary.addEventListener('click', (event) => {
      if (!motion() || !body.animate) return;
      event.preventDefault();
      const from = details.open ? body.getBoundingClientRect().height : 0;
      const fromOpacity = details.open ? Number(getComputedStyle(body).opacity) : 0;
      anim?.cancel();
      if (details.open && !details.classList.contains('is-closing')) {
        details.classList.add('is-closing');
        anim = body.animate(
          [{ height: `${from}px`, opacity: fromOpacity }, { height: '0px', opacity: 0 }],
          { duration: 420, easing: EASE },
        );
        anim.onfinish = () => {
          details.open = false;
          details.classList.remove('is-closing');
          anim = null;
        };
      } else {
        details.classList.remove('is-closing');
        details.open = true;
        anim = body.animate(
          [{ height: `${from}px`, opacity: fromOpacity }, { height: `${body.scrollHeight}px`, opacity: 1 }],
          { duration: 520, easing: EASE_OUT },
        );
        anim.onfinish = () => { anim = null; };
      }
    });
  });

  /* ---------- Early access: phone number + the app to reach you on ---------- */

  // Consent wording; a page's site-config can override any line.
  const HINTS = {
    whatsapp: `By tapping Get early access, you agree to early-access messages from ${BRAND} on WhatsApp. Reply STOP to opt out.`,
    sms: `By tapping Get early access, you agree to early-access texts from ${BRAND}. Msg\u00a0frequency\u00a0varies. Msg & data rates may apply. Reply HELP for help, STOP\u00a0to\u00a0opt\u00a0out.`,
    telegram: `At launch, find ${BRAND} in Telegram and tap Start.`,
    ...CONFIG.hints,
  };
  const REACH_TEXT = {
    whatsapp: 'We’ll WhatsApp {n} when your spot opens.',
    sms: 'We’ll text {n} when your spot opens.',
    telegram: `We saved {n}. At launch, find ${BRAND} in Telegram and tap Start.`,
    ...CONFIG.reach,
  };
  const REACH = Object.fromEntries(Object.entries(REACH_TEXT).map(([key, text]) => [key, (n) => text.replace('{n}', n)]));
  const joinForms = $$('[data-join]');

  function checkPhone(form, msg) {
    const input = form.elements.phone;
    const result = toE164(input.value, form.elements.cc?.value || '1');
    if (result.e164) {
      input.removeAttribute('aria-invalid');
      return result.e164;
    }
    input.setAttribute('aria-invalid', 'true');
    msg.className = 'join__msg is-error';
    msg.textContent = PHONE_ERRORS[result.error];
    input.focus();
    return null;
  }

  // Country picker: the chip shows the code; a typed "+" number wins over it.
  $$('.join__cc select').forEach((select) => {
    const label = $('[data-cc-label]', select.parentElement);
    select.addEventListener('change', () => { label.textContent = `+${select.value}`; });
  });

  // Pretty-print a US/Canada number once the visitor leaves the field.
  $$('input[name="phone"]').forEach((input) => {
    // A fix clears the error as soon as the visitor types.
    input.addEventListener('input', () => {
      if (!input.hasAttribute('aria-invalid')) return;
      input.removeAttribute('aria-invalid');
      const msg = $('.join__msg', input.form);
      if (msg?.classList.contains('is-error')) { msg.className = 'join__msg'; msg.textContent = ''; }
    });
    input.addEventListener('blur', () => {
      const form = input.form;
      const cc = form.elements.cc?.value || '1';
      if (cc !== '1' || input.value.trim().startsWith('+')) return;
      const { e164 } = toE164(input.value, cc);
      if (e164) input.value = `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
    });
  });

  // The chosen app follows the visitor between forms.
  const setChannel = (value) => {
    if (!HINTS[value]) return;
    channelBus.dispatchEvent(new CustomEvent('pick', { detail: value }));
    joinForms.forEach((form) => {
      const radio = $(`input[name="channel"][value="${value}"]`, form);
      if (radio && !radio.checked) radio.checked = true;
      const hint = $('[data-hint]', form);
      if (hint) hint.textContent = HINTS[value];
      const field = form.elements.phone;
      if (field && CONFIG.placeholders?.[value]) field.placeholder = CONFIG.placeholders[value];
    });
    store.set('localStorage', `${KEY_BASE}.channel`, value);
  };
  const savedChannel = store.get('localStorage', `${KEY_BASE}.channel`);
  if (savedChannel) setChannel(savedChannel);

  joinForms.forEach((form) => {
    const msg = $('.join__msg', form);
    const button = $('button[type="submit"]', form);
    $$('input[name="channel"]', form).forEach((radio) => radio.addEventListener('change', () => setChannel(radio.value)));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = checkPhone(form, msg);
      if (!phone) return;
      const channel = form.elements.channel.value || 'whatsapp';
      button.setAttribute('aria-busy', 'true');
      try {
        const result = await postSignup({ phone, channel, source: form.dataset.source, company_website: form.elements.company_website.value });
        form.style.minHeight = `${form.offsetHeight}px`;
        form.classList.add('is-done');
        msg.className = 'join__msg is-ok';
        const done = el('div', 'join__done');
        const redo = el('button', 'join__redo', 'Wrong number? Change it');
        redo.type = 'button';
        redo.addEventListener('click', () => {
          form.classList.remove('is-done');
          form.style.minHeight = '';
          msg.className = 'join__msg';
          msg.textContent = '';
          form.elements.phone.focus();
        });
        if (result?.preview) done.append(el('b', null, 'This is a preview.'), el('span', null, 'Your number wasn’t saved.'));
        else done.append(el('b', null, 'You’re on the list.'), el('span', null, REACH[channel](prettyPhone(phone))));
        msg.replaceChildren(icon('i-check'), done, redo);
        // The button that had focus is gone; the confirmation takes it.
        msg.tabIndex = -1;
        msg.focus({ preventScroll: true });
      } catch {
        msg.className = 'join__msg is-error';
        msg.textContent = 'Couldn’t save that. Try again.';
      } finally {
        button.removeAttribute('aria-busy');
      }
    });
  });

  // Scroll to the final form and put the cursor in it.
  function goToSignup() {
    // The hero form is on screen: use it rather than scrolling to the footer.
    const heroPhone = $('#hero-phone');
    const r = heroPhone?.getBoundingClientRect();
    if (r && r.top > 0 && r.bottom < window.innerHeight && !heroPhone.form.classList.contains('is-done')) {
      heroPhone.focus();
      return;
    }
    const target = $('#join');
    if (!target) return;
    target.scrollIntoView({ behavior: motion() ? 'smooth' : 'auto', block: 'center' });
    window.setTimeout(() => $('#join input[name="phone"]')?.focus({ preventScroll: true }), motion() ? 700 : 0);
  }
  $$('a[href="#join"]:not([data-dv-cta])').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    goToSignup();
  }));

  /* ---------- Phones: a dock keeps the call to action in reach ---------- */

  const dock = $('[data-dock]');
  if (dock && 'IntersectionObserver' in window) {
    const small = window.matchMedia('(max-width: 639px)');
    const inView = new Set();
    const closeForm = $('#join [data-join]');
    let hinted = !$('.dock__game', dock) || !!store.get('sessionStorage', `${KEY_BASE}.ptw.nudged`);
    const sync = () => {
      const typing = document.activeElement?.matches?.('input, select, textarea');
      const on = small.matches && inView.size === 0 && window.scrollY > 320
        && !document.body.classList.contains('has-modal') && !typing;
      dock.classList.toggle('is-on', on);
      root.classList.toggle('has-dock', on);
      root.classList.toggle('at-join', small.matches && joinForms.some((form) => inView.has(form)));
      // The bar's button steps aside only while the form's own box is fully on screen below the bar.
      const box = closeForm && ($('.join__box', closeForm) || closeForm);
      const rect = box?.getBoundingClientRect();
      root.classList.toggle('at-close', !small.matches && !!rect && rect.top >= (nav?.offsetHeight || 64) && rect.bottom <= window.innerHeight);
      if (on && !hinted) {
        hinted = true;
        store.set('sessionStorage', `${KEY_BASE}.ptw.nudged`, true);
        dock.classList.add('is-hinting');
        window.setTimeout(() => dock.classList.remove('is-hinting'), 3200);
      }
    };
    new IntersectionObserver((entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? inView.add(entry.target) : inView.delete(entry.target)));
      sync();
    }).observe($('.hero') || $('[data-top]') || document.body);
    const watcher = new IntersectionObserver((entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? inView.add(entry.target) : inView.delete(entry.target)));
      sync();
    });
    const formWatcher = new IntersectionObserver((entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? inView.add(entry.target) : inView.delete(entry.target)));
      sync();
    });
    joinForms.forEach((form) => formWatcher.observe(form));
    // Keep clear of the story's channel switch while the story is pinned.
    const storyEl = $('[data-story]');
    if (storyEl) watcher.observe(storyEl);
    // ...and of the tiles' rail, whose answers sit at the bottom of each tile.
    const railEl = $('[data-jobs]');
    if (railEl) watcher.observe(railEl);
    frames.add(sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', () => window.setTimeout(sync, 50));
  }

  /* ---------- Play to win ---------- */

  const dialog = $('[data-ptw]');
  const tab = $('[data-ptw-tab]');
  if (!dialog) return;

  // The side tab slides in once the visitor has seen the product.
  if (tab) {
    const slim = window.matchMedia('(max-width: 1439px)');
    // Tablets and small laptops: the story's step bar hangs in the margin where
    // the tab sits, so it tucks away while the story passes. At the close the page
    // already offers the game under its form, so the tab steps aside there too.
    const hang = window.matchMedia('(min-width: 1024px) and (max-width: 1339px), (min-width: 640px) and (max-width: 1023px) and (orientation: landscape) and (min-height: 501px)');
    const crowd = new Set();
    let atClose = false;
    const tuck = () => tab.classList.toggle('is-tucked', atClose || (hang.matches && crowd.size > 0));
    const tuckWatch = new IntersectionObserver((entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? crowd.add(entry.target) : crowd.delete(entry.target)));
      tuck();
    }, { rootMargin: '-55% 0px -5% 0px' });
    $$('[data-story]').forEach((el) => tuckWatch.observe(el));
    hang.addEventListener('change', tuck);
    const closing = $('.final');
    if (closing) new IntersectionObserver(([entry]) => { atClose = entry.isIntersecting; tuck(); }, { threshold: 0.3 }).observe(closing);
    if (!store.get('sessionStorage', `${KEY_BASE}.ptw.hidden`)) {
      let shown = false;
      const show = () => {
        if (shown) return;
        shown = true;
        frames.delete(watch);
        tab.classList.remove('is-hidden');
        // Let the tab finish sliding in before looking for room.
        window.setTimeout(armNudge, 800);
      };
      const watch = () => { if (window.scrollY > 240) show(); };
      frames.add(watch);
      window.setTimeout(show, 2500);
    }
    // On narrower screens the tab is a slim strip, so say what it is once:
    // past the demo, while the page is still, over empty space. It leaves
    // when text is about to reach it or when scrolling resumes.
    const nudgeEl = $('.ptw-tab__nudge', tab);
    const jobs = $('#jobs');
    const BUSY = 'h1, h2, h3, p, li, .tile, .t-row, .day__clock, .access, .faq__list, .join, .device, .seg, .chip, .apps, .teaser, .btn';
    let lastScroll = 0;
    window.addEventListener('scroll', () => { lastScroll = window.performance.now(); }, { passive: true });
    // A 3x3 grid of probes over the pill, padded for breathing room.
    const clearUnder = (pad) => {
      const box = nudgeEl.getBoundingClientRect();
      if (!box.width) return false;
      const xs = [box.left - pad + 2, (box.left + box.right) / 2, box.right + pad - 2];
      const ys = [box.top - pad + 2, (box.top + box.bottom) / 2, box.bottom + pad - 2];
      return xs.every((x) => ys.every((y) => document.elementsFromPoint(x, y)
        .every((node) => tab.contains(node) || !node.closest(BUSY))));
    };
    let nudge = nudgeEl && document.elementsFromPoint && !store.get('sessionStorage', `${KEY_BASE}.ptw.nudged`) ? 'waiting' : 'done';
    const IDLE = 1200; // a real reading pause, not a hesitation mid-scroll
    let tries = 0;
    let clearSince = 0;
    let shownAt = 0;
    let nudgeTimer = 0;
    const endNudge = () => {
      nudge = 'done';
      tab.classList.remove('is-nudging');
      window.clearInterval(nudgeTimer);
      frames.delete(checkNudge);
    };
    function checkNudge() {
      if (nudge === 'done' || nudge === 'waiting') return;
      if (!slim.matches || tab.classList.contains('is-hidden') || tab.classList.contains('is-away') || tab.classList.contains('is-tucked')) return;
      const now = window.performance.now();
      if (nudge === 'armed') {
        const pastDemo = !jobs || jobs.getBoundingClientRect().top < window.innerHeight;
        if (!pastDemo || now - lastScroll < IDLE || !clearUnder(24)) { clearSince = 0; return; }
        clearSince = clearSince || now;
        if (now - clearSince < 250) return;
        nudge = 'showing';
        shownAt = now;
        tries += 1;
        tab.classList.add('is-nudging');
      } else {
        const age = now - shownAt;
        const scrolling = now - lastScroll < 60;
        if (!clearUnder(8) || age > 3200 || (scrolling && age > 1000)) {
          // Cut short before it could be read: allow one more try.
          if (age < 700 && tries < 2) {
            tab.classList.remove('is-nudging');
            nudge = 'armed';
            clearSince = 0;
            return;
          }
          store.set('sessionStorage', `${KEY_BASE}.ptw.nudged`, true);
          endNudge();
        }
      }
    }
    const armNudge = () => {
      if (nudge !== 'waiting') return;
      nudge = 'armed';
      frames.add(checkNudge);
      nudgeTimer = window.setInterval(checkNudge, 200);
    };
    $('[data-ptw-hide]', tab)?.addEventListener('click', () => {
      tab.classList.add('is-hidden');
      store.set('sessionStorage', `${KEY_BASE}.ptw.hidden`, true);
    });
    $('.ptw-tab__nudge', tab)?.addEventListener('click', () => open());
  }

  const PRIZES = Array.isArray(CONFIG.prizes) ? CONFIG.prizes : [];
  const byId = Object.fromEntries(PRIZES.map((prize) => [prize.id, prize]));
  const KEY = `${KEY_BASE}.ptw`;

  const deck = $('[data-deck]', dialog);
  const burstHost = $('[data-burst]', dialog);
  const title = $('[data-ptw-title]', dialog);
  const desc = $('[data-ptw-desc]', dialog);
  // Per-site wording comes from the markup: the intro line and what a card is called.
  const introDesc = desc.textContent;
  const cardNoun = dialog.dataset.cardNoun || 'sealed card';
  const live = $('[data-ptw-live]', dialog);
  const doneStep = $('[data-step="done"]', dialog);
  const claimForm = $('[data-claim]', dialog);
  const claimLabel = $('[data-claim-label]', claimForm);
  const claimInput = claimForm.elements.phone;
  // The claim follows the app picked in a sign-up form (WhatsApp unless one was chosen).
  const claimFine = $('.ptw__fine', dialog);
  const fineText = claimFine ? claimFine.textContent : '';
  const claimChannel = () => {
    const picked = store.get('localStorage', `${KEY_BASE}.channel`);
    return CONFIG.placeholders?.[picked] ? picked : 'whatsapp';
  };
  const CLAIM_REACH = {
    whatsapp: (last4) => `We’ll WhatsApp you at •••${last4} to set it up.`,
    sms: (last4) => `We’ll text you at •••${last4} to set it up.`,
    telegram: () => `At launch, find ${BRAND} in Telegram and tap Start to set it up.`,
  };
  const dressClaim = () => {
    const channel = claimChannel();
    if (CONFIG.placeholders?.[channel]) claimInput.placeholder = CONFIG.placeholders[channel];
    if (claimFine) {
      claimFine.textContent = channel === 'sms'
        ? fineText.replace(/Reply STOP\s+anytime\./, 'Msg & data rates may apply. Reply HELP for help, STOP to opt out.')
        : fineText;
    }
  };
  const claimCc = claimForm.elements.cc;
  const claimMsg = $('.join__msg', claimForm);
  const claimButton = $('button[type="submit"]', claimForm);
  const codeOut = $('[data-code]', dialog);
  const copyButton = $('[data-copy]', dialog);

  let state = store.get('localStorage', KEY) || {};
  let lastFocus = null;
  let order = [];
  let cards = [];

  const shuffle = (items) => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const makeCode = (prize) => {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = new Uint32Array(4);
    window.crypto.getRandomValues(bytes);
    return `${CONFIG.code || 'FF'}-${prize.code}-${Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('')}`;
  };

  const tag = (number) => {
    const row = el('span', 'card__tag');
    row.append(el('span', null, CONFIG.cardTag || 'Work order'), el('span', null, `#${number}`));
    return row;
  };

  // Cards lean toward the pointer, with a soft glare that follows it.
  const tilt = (card, holder) => {
    card.addEventListener('pointermove', (event) => {
      if (card.disabled || event.pointerType !== 'mouse' || !motion()) return;
      const box = holder.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      card.classList.add('is-tilting');
      card.style.setProperty('--ry', `${(x * 16).toFixed(2)}deg`);
      card.style.setProperty('--rx', `${(-y * 12).toFixed(2)}deg`);
      card.style.setProperty('--gx', `${((x + 0.5) * 100).toFixed(1)}%`);
      card.style.setProperty('--gy', `${((y + 0.5) * 100).toFixed(1)}%`);
    });
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-tilting');
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  };

  const buildCard = (prize, index) => {
    const item = el('li');
    const card = el('button', 'card');
    card.type = 'button';
    card.setAttribute('aria-label', `Open ${cardNoun} ${index + 1} of 3`);
    const number = String(417 + index).padStart(4, '0');

    const inner = el('span', 'card__inner');

    const back = el('span', 'card__back');
    const seal = el('span', 'card__seal');
    const sealText = el('span');
    const mark = document.createElementNS(SVG_NS, 'svg');
    mark.setAttribute('aria-hidden', 'true');
    mark.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-logo');
    mark.append(use);
    sealText.append(mark, 'Sealed');
    seal.append(sealText);
    back.append(tag(number), seal, el('span', 'card__hint', 'Tap to open'));

    const face = el('span', 'card__face');
    face.append(tag(number), el('span', 'card__title', prize.title), el('span', 'card__cmd', prize.cmd), el('span', 'card__won', 'Yours'));

    inner.append(back, face);
    card.append(inner);
    card.addEventListener('click', () => pick(index));
    tilt(card, item);
    item.append(card);
    return item;
  };

  const confetti = (card) => {
    if (!motion() || !burstHost.animate) return;
    const host = burstHost.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const x = box.left + box.width / 2 - host.left;
    const y = box.top - host.top + 8;
    const COLORS = ['#f54e00', '#26251e', '#34785c', '#cdcdc9', '#4ade80'];
    for (let i = 0; i < 56; i += 1) {
      const bit = el('i');
      bit.style.left = `${x}px`;
      bit.style.top = `${y}px`;
      bit.style.background = COLORS[i % COLORS.length];
      burstHost.append(bit);
      // A fan out of the card's top edge, behind the cards.
      const angle = ((-160 + (i / 55) * 140 + (Math.random() - 0.5) * 10) * Math.PI) / 180;
      const reach = 160 + Math.random() * 160;
      const dx = Math.cos(angle) * reach;
      const dy = Math.sin(angle) * reach * 0.8 - 20;
      const spin = (Math.random() - 0.5) * 900;
      bit.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.4) rotate(0deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) rotate(${(spin * 0.7).toFixed(0)}deg)`, opacity: 1, offset: 0.62 },
          { transform: `translate(calc(-50% + ${(dx * 1.12).toFixed(1)}px), calc(-50% + ${(dy + 90).toFixed(1)}px)) rotate(${spin.toFixed(0)}deg)`, opacity: 0 },
        ],
        { duration: 1200 + Math.random() * 500, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
      ).onfinish = () => bit.remove();
    }
  };

  const lockClaim = (locked) => {
    claimForm.classList.toggle('is-locked', locked);
    claimInput.disabled = locked;
    if (claimCc) claimCc.disabled = locked;
    claimButton.disabled = locked;
  };

  const setStep = (step) => {
    const prize = byId[state.prize];
    if (step === 'pick') {
      title.textContent = 'Pick a card.';
      desc.textContent = introDesc;
      claimLabel.textContent = 'Then add your number';
      dressClaim();
      lockClaim(true);
    } else if (step === 'claim') {
      title.textContent = 'You won.';
      desc.textContent = prize.line;
      claimLabel.textContent = 'Now add your number';
      dressClaim();
      lockClaim(false);
    } else {
      title.textContent = 'It’s yours.';
      const reach = CLAIM_REACH[state.channel] || CLAIM_REACH.whatsapp;
      desc.textContent = state.last4
        ? `${reach(state.last4)} Keep\u00a0this\u00a0code\u00a0handy.`
        : 'We’ll message you to set it up. Keep\u00a0this\u00a0code\u00a0handy.';
      if (STATIC_PREVIEW) desc.textContent = 'This is a preview. Your number wasn’t saved.';
      codeOut.textContent = state.code;
    }
    claimForm.hidden = step === 'done';
    doneStep.hidden = step !== 'done';
  };

  const revealAll = (mineIndex) => {
    cards.forEach((card, i) => {
      card.disabled = true;
      card.classList.remove('is-tilting');
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.classList.add('is-flipped', i === mineIndex ? 'is-mine' : 'is-other');
      card.setAttribute('aria-label', `${order[i].title}${i === mineIndex ? ', your prize' : ''}`);
    });
    deck.classList.add('is-picked');
  };

  const render = () => {
    const known = Array.isArray(state.order) && state.order.length === PRIZES.length && state.order.every((id) => byId[id]);
    order = known ? state.order.map((id) => byId[id]) : shuffle(PRIZES);
    deck.classList.remove('is-picked', 'is-static');
    deck.replaceChildren(...order.map(buildCard));
    cards = $$('.card', deck);
    claimMsg.textContent = '';

    if (state.prize && byId[state.prize]) {
      // Returning visitor: show what they already picked, no replays.
      deck.classList.add('is-static');
      revealAll(order.findIndex((prize) => prize.id === state.prize));
      setStep(state.claimed ? 'done' : 'claim');
    } else {
      state = {};
      setStep('pick');
    }
  };

  function pick(index) {
    if (state.prize) return;
    const prize = order[index];
    state = { prize: prize.id, order: order.map((p) => p.id) };
    store.set('localStorage', KEY, state);

    const quick = !motion();
    deck.classList.add('is-picked');
    cards.forEach((card) => { card.disabled = true; });
    cards[index].classList.remove('is-tilting');
    cards[index].style.setProperty('--rx', '0deg');
    cards[index].style.setProperty('--ry', '0deg');
    cards[index].classList.add('is-flipped', 'is-mine');
    live.textContent = `You won ${prize.won}.`;

    window.setTimeout(() => {
      confetti(cards[index]);
      // The headline turns with the card, not after it.
      title.textContent = 'You won.';
      desc.textContent = prize.line;
      claimLabel.textContent = 'Now add your number';
    }, quick ? 0 : 520);
    window.setTimeout(() => revealAll(index), quick ? 0 : 900);
    window.setTimeout(() => {
      setStep('claim');
      claimInput.focus({ preventScroll: true });
      if (!quick) claimForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, quick ? 0 : 1300);
  }

  claimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.prize) return;
    const phone = checkPhone(claimForm, claimMsg);
    if (!phone) return;
    const prize = byId[state.prize];
    const code = state.code || makeCode(prize);
    claimButton.setAttribute('aria-busy', 'true');
    try {
      const channel = claimChannel();
      const result = await postSignup({ phone, channel, source: 'play-to-win', prize: prize.id, code, company_website: claimForm.elements.company_website.value });
      // Keep only the last four digits on this device, never the number.
      state = { ...state, last4: phone.slice(-4), channel, code, claimed: true };
      // A preview claim isn't kept, so the game can be played again.
      if (!result?.preview) store.set('localStorage', KEY, state);
      claimMsg.textContent = '';
      setStep('done');
      live.textContent = result?.preview ? `This is a preview. Nothing was saved. Your code is ${code}.` : `Saved. Your claim code is ${code}.`;
      copyButton.focus();
    } catch {
      claimMsg.className = 'join__msg is-error';
      claimMsg.textContent = 'Couldn’t save that. Try again.';
    } finally {
      claimButton.removeAttribute('aria-busy');
    }
  });

  copyButton.addEventListener('click', async () => {
    const label = $('span', copyButton);
    try {
      await navigator.clipboard.writeText(codeOut.textContent);
      label.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(codeOut);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      label.textContent = 'Selected';
    }
    window.setTimeout(() => { label.textContent = 'Copy'; }, 1800);
  });

  function open() {
    if (dialog.open) return;
    lastFocus = document.activeElement;
    render();
    dialog.showModal();
    document.body.classList.add('has-modal');
    tab?.classList.add('is-away');
    window.requestAnimationFrame(() => dialog.classList.add('is-open'));
    const firstCard = cards.find((card) => !card.disabled);
    (firstCard || (state.claimed ? copyButton : claimInput)).focus({ preventScroll: true });
  }

  function close() {
    if (!dialog.open) return;
    dialog.classList.remove('is-open');
    dialog.classList.add('is-closing');
    window.setTimeout(() => {
      dialog.classList.remove('is-closing');
      dialog.close();
      document.body.classList.remove('has-modal');
      tab?.classList.remove('is-away');
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }, motion() ? 260 : 0);
  }

  $$('[data-open-game]').forEach((button) => button.addEventListener('click', open));
  $$('[data-ptw-close]', dialog).forEach((button) => button.addEventListener('click', close));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  // A click that lands on the dialog element itself is a click outside the panel.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
})();
