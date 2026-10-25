// ==UserScript==
// @name         YouTube Rec Cleaner
// @namespace    https://github.com/Common-Fool/Youtube-Rec-Cleaner
// @version      2.0.4
// @description  Cleans up YouTube recommendations: hides Mixes/Radio and adds one-click native feedback buttons ("Not interested" and "Don't recommend channel") to the home feed and Shorts. Every action goes through YouTube's own menu.
// @author       Common-Fool
// @homepageURL  https://github.com/Common-Fool/Youtube-Rec-Cleaner
// @supportURL   https://github.com/Common-Fool/Youtube-Rec-Cleaner/issues
// @updateURL    https://raw.githubusercontent.com/Common-Fool/Youtube-Rec-Cleaner/main/youtube-rec-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/Common-Fool/Youtube-Rec-Cleaner/main/youtube-rec-cleaner.user.js
// @match        https://www.youtube.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '2.0.4';

    /* ──────────────────────────── SETTINGS ──────────────────────────── */
    /*
       The script auto-updates, so edits made directly in this block are lost on update.
       Put your own settings into youtube.com's localStorage (F12 console on a YouTube page):

           localStorage['ytrc:cfg'] = JSON.stringify({ shorts: { autoNext: false } })

       The given keys are merged over the defaults below. Reset: localStorage.removeItem('ytrc:cfg')
    */
    const DEFAULTS = {
        mixes: {
            enabled: true,
            // Where to hide them
            where: {
                feed: true,        // home and subscriptions (ytd-rich-item-renderer tiles)
                search: true,      // search results
                sidebar: true,     // related videos on the watch page
                legacy: true,      // legacy standalone mix elements (ytd-radio-renderer etc.)
            },
            // Also match by the "Mix" badge text (localized).
            // Off by default: the CSS markers are more precise and language-independent.
            alsoMatchBadgeText: false,
        },

        feed: {
            notInterested: true,       // X button on the thumbnail
            channel: true,             // X button next to the channel name
            // true: home page (/) only; false: everywhere lockup cards appear
            onlyHomePage: true,
            // Channel X placement: 'row' next to the channel name, 'menu' left of the ⋮ button (always visible)
            channelBtnPlace: 'row',
            // Channel X always visible (false) or only while hovering the card (true)
            channelBtnOnlyOnHover: false,
        },

        shorts: {
            notInterested: true,       // "Not interested" button below the arrows
            channel: true,             // "Don't recommend channel" button below the arrows
            // Scroll to the next Short IF YouTube didn't do it itself
            autoNext: true,
            autoNextWait: 1200,
        },

        tooltipDelay: 350,
        tips: {
            notInterested: 'Not interested',
            notRecommend: "Don't recommend channel",
        },

        // true: verbose console log. Errors are always logged regardless of this flag.
        debug: false,
    };

    function deepMerge(base, over) {
        if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
        const out = { ...base };
        for (const k of Object.keys(over)) {
            const b = base[k], o = over[k];
            out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, o) : o;
        }
        return out;
    }

    const CFG = (() => {
        try { return deepMerge(DEFAULTS, JSON.parse(localStorage.getItem('ytrc:cfg') || 'null')); }
        catch (e) { console.error('[ytrc] invalid localStorage ytrc:cfg, using defaults', e); return DEFAULTS; }
    })();

    const log = (...a) => CFG.debug && console.log('[ytrc]', ...a);
    const err = (...a) => console.error('[ytrc]', ...a);
    // timing log for Shorts actions: ms since the button was clicked
    let t0 = 0;
    const tlog = (...a) => log(`+${Math.round(performance.now() - t0)}ms`, ...a);

    /** Isolation: one failing block must not take down the others */
    function safe(name, fn) {
        try { return fn(); } catch (e) { err('error in', name, e); return null; }
    }

    const supportsHas = (() => {
        try { return CSS.supports('selector(:has(*))'); } catch (e) { return false; }
    })();

    /* ══════════════════════════ MIXES ══════════════════════════════════ */
    /*
       1) The lockup host has a class like content-id-RD… — that is the mix playlist id.
          It must be paired with ytLockupViewModelCollectionStack…, otherwise a regular
          video whose 11-char id happens to start with RD would match too.
       2) The link contains start_radio=1 — that marks cards that start a mix/radio.
          Queue items inside an already playing mix don't have it,
          so a mix you opened yourself is left alone.
    */
    const MIX_HOST = '[class*="ytLockupViewModelCollectionStack"][class*="content-id-RD"]';
    const MIX_LINK = 'a[href*="start_radio=1"]';

    function mixRules() {
        const w = CFG.mixes.where, r = [];
        if (w.feed) r.push(
            `ytd-rich-item-renderer:has(${MIX_HOST})`,
            `ytd-rich-item-renderer:has(${MIX_LINK})`,
            `ytd-rich-grid-media:has(${MIX_LINK})`,
        );
        if (w.search) r.push(
            `ytd-video-renderer:has(${MIX_LINK})`,
            `ytd-item-section-renderer > #contents > yt-lockup-view-model:has(${MIX_HOST})`,
        );
        if (w.sidebar) r.push(
            `yt-lockup-view-model:has(${MIX_HOST})`,
            `ytd-compact-video-renderer:has(${MIX_LINK})`,
        );
        if (w.legacy) r.push(
            'ytd-radio-renderer',
            'ytd-compact-radio-renderer',
            `ytd-compact-playlist-renderer:has(${MIX_LINK})`,
        );
        return r;
    }

    function injectMixCSS() {
        if (!CFG.mixes.enabled || !supportsHas || document.getElementById('ytrc-mixes')) return;
        const rules = mixRules();
        if (!rules.length) return;
        const st = document.createElement('style');
        st.id = 'ytrc-mixes';
        st.textContent = rules.join(',\n') + ' { display: none !important; }';
        (document.head || document.documentElement).appendChild(st);
        log('mixes: CSS applied,', rules.length, 'rules');
    }

    const mixJsNeeded = () => CFG.mixes.enabled && (!supportsHas || CFG.mixes.alsoMatchBadgeText);

    /* Fallback: browser without :has(), or badge-text matching enabled */
    function hideMixesJs() {
        let n = 0;
        const hide = (el) => {
            if (!el || el.dataset.ytrcMix) return;
            el.dataset.ytrcMix = '1';
            el.style.setProperty('display', 'none', 'important');
            n++;
        };
        const container = (el) =>
            el.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model');

        if (!supportsHas) {
            document.querySelectorAll(MIX_HOST).forEach((el) => hide(container(el)));
            document.querySelectorAll(MIX_LINK).forEach((el) => hide(container(el)));
            if (CFG.mixes.where.legacy) {
                document.querySelectorAll('ytd-radio-renderer, ytd-compact-radio-renderer').forEach(hide);
            }
        }
        if (CFG.mixes.alsoMatchBadgeText) {
            const re = /^(мікс|микс|mix)$/i; // localized badge text
            document.querySelectorAll('.ytBadgeShapeText').forEach((b) => {
                if (re.test((b.textContent || '').trim())) hide(container(b));
            });
        }
        if (n) log('mixes: hidden via JS:', n);
    }

    /* ═════════════════════════ FEEDBACK BUTTONS ════════════════════════ */

    // YouTube menu item icons, for language-independent item lookup
    const ICON = {
        NOT_INTERESTED: 'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z',
        REMOVE: 'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 110 18.001A9 9 0 0112 3Zm4 8H8a1 1 0 000 2h8a1 1 0 000-2Z',
    };

    const X_PATH = 'M6.4 4.99 4.99 6.4 10.59 12l-5.6 5.6 1.41 1.41L12 13.41l5.6 5.6 1.41-1.41-5.6-5.6 5.6-5.6-1.41-1.41-5.6 5.6-5.6-5.6Z';
    // ⊘ for "Not interested" in Shorts, so it isn't confused with the channel X
    const BAN_PATH = ICON.NOT_INTERESTED;

    // Menu item labels as YouTube renders them (English, Ukrainian, Russian UI).
    // These match YouTube's own text, so they must stay in those languages.
    const RE_NOT_INTERESTED = /не\s*ці?к[аи]в|не\s*интерес|not\s*interested/i;
    const RE_NOT_RECOMMEND = /не\s*рекоменд|do\s*n[o']?t\s*recommend|don't\s*recommend/i;

    const MATCH = {
        notInterested: { text: RE_NOT_INTERESTED, notText: RE_NOT_RECOMMEND, icons: [ICON.NOT_INTERESTED] },
        notRecommend: { text: RE_NOT_RECOMMEND, notText: RE_NOT_INTERESTED, icons: [ICON.REMOVE] },
    };

    /* ───────────────────────────── UTILITIES ─────────────────────────── */

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeout = 2500, step = 40) {
        const deadline = Date.now() + timeout;
        for (;;) {
            let v = null;
            try { v = fn(); } catch (e) { v = null; }
            if (v) return v;
            if (Date.now() > deadline) return null;
            await sleep(step);
        }
    }

    const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    function killEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    /* ───────────────────────────── STYLES ────────────────────────────── */
    /* All layout tweaks to YouTube's markup are done via CSS rather than writing to its nodes:
       inline styles and data attributes on view-model elements trigger re-renders. */

    function buildCSS() {
        return `
html.ytrc-busy ytd-popup-container tp-yt-iron-dropdown,
html.ytrc-busy tp-yt-iron-dropdown.ytd-popup-container,
html.ytrc-busy ytd-popup-container yt-sheet-view-model,
html.ytrc-busy ytd-shorts .ytp-popup {
    opacity: 0 !important;
    pointer-events: none !important;
}

.ytrc-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
    flex: 0 0 auto;
    align-self: center;
    margin-left: 6px;
    padding: 2px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--yt-spec-text-secondary, #aaa);
    opacity: .7;
    cursor: pointer;
    line-height: 0;
    transition: opacity .1s, background-color .1s, color .1s;
}
.ytrc-x svg { width: 15px; height: 15px; display: block; fill: currentColor; }
.ytrc-x:hover { opacity: 1; color: var(--yt-spec-text-primary, #f1f1f1); background: rgba(128,128,128,.18); }
.ytrc-x:active { background: rgba(128,128,128,.3); }
${CFG.feed.channelBtnOnlyOnHover ? `
.ytrc-x { opacity: 0; pointer-events: none; }
yt-lockup-view-model:hover .ytrc-x { opacity: .7; pointer-events: auto; }
` : ''}

${supportsHas ? `
/* YouTube's metadata row is a -webkit-box with line-clamp: a foreign element
   wraps onto the hidden second line. Unclamp ONLY the row that holds our X. */
.ytContentMetadataViewModelMetadataRow:has(> .ytrc-x) {
    display: flex !important;
    align-items: center !important;
    overflow: visible !important;
    -webkit-line-clamp: unset !important;
}
.ytContentMetadataViewModelMetadataRow:has(> .ytrc-x) > .ytAttributedStringHost {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
` : ''}

.ytrc-overlay-wrap, .ytrc-shorts-wrap { cursor: pointer; }

.ytrc-tip {
    position: fixed;
    z-index: 2147483647;
    max-width: 260px;
    padding: 5px 8px;
    border-radius: 4px;
    background: var(--yt-spec-static-overlay-background-heavy, rgba(0,0,0,.85));
    color: #fff;
    font: 400 12px/1.35 "Roboto", "Arial", sans-serif;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity .08s linear;
}
.ytrc-tip[data-show="1"] { opacity: 1; }
`;
    }

    function injectCSS() {
        if (document.getElementById('ytrc-style')) return;
        const st = document.createElement('style');
        st.id = 'ytrc-style';
        st.textContent = buildCSS();
        (document.head || document.documentElement).appendChild(st);
    }

    /* ──────────────────────────── TOOLTIP ────────────────────────────── */

    let tipEl = null;
    let tipTimer = null;

    function tipShow(anchor, text, place) {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => {
            try {
                if (!tipEl) {
                    tipEl = document.createElement('div');
                    tipEl.className = 'ytrc-tip';
                    document.body.appendChild(tipEl);
                }
                tipEl.textContent = text;
                tipEl.dataset.show = '1';
                const r = anchor.getBoundingClientRect();
                const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
                let x, y;
                if (place === 'left') {
                    x = r.left - tw - 8;
                    y = r.top + (r.height - th) / 2;
                } else {
                    y = r.bottom + 6;
                    x = r.right - tw;
                }
                tipEl.style.left = Math.max(6, Math.min(x, innerWidth - tw - 6)) + 'px';
                tipEl.style.top = Math.max(6, Math.min(y, innerHeight - th - 6)) + 'px';
            } catch (e) { err('tooltip', e); }
        }, CFG.tooltipDelay);
    }

    function tipHide() {
        clearTimeout(tipTimer);
        if (tipEl) tipEl.dataset.show = '0';
    }

    function bindTip(el, text, place) {
        el.addEventListener('mouseenter', () => tipShow(el, text, place));
        el.addEventListener('mouseleave', tipHide);
        el.addEventListener('click', tipHide);
    }

    /* ─────────────────── DRIVING YOUTUBE'S NATIVE MENU ──────────────── */
    /*
       Menus come in several kinds: the classic tp-yt-iron-dropdown (feed),
       yt-sheet-view-model (newer view-model menus) and the player popup .ytp-popup
       (the new ⋮ in Shorts, alongside Subtitles, Playback speed, etc.).
    */
    const POPUP_SEL = 'tp-yt-iron-dropdown, yt-sheet-view-model, .ytp-popup, [role="menu"]';
    const ITEM_SEL = [
        'yt-list-item-view-model',
        'ytd-menu-service-item-renderer',
        'ytd-menu-navigation-item-renderer',
        'tp-yt-paper-item',
        '.ytp-menuitem',
        '[role="menuitem"]',
    ].join(', ');

    function openPopups() {
        return [...document.querySelectorAll(POPUP_SEL)]
            .filter((d) => d.getAttribute('aria-hidden') !== 'true' && isVisible(d));
    }

    function closePopup(d) {
        try {
            if (d && typeof d.close === 'function') { d.close(); return; }
            if (d && d.matches('tp-yt-iron-dropdown')) { d.setAttribute('aria-hidden', 'true'); return; }
            // player popups and view-model menus close on Escape
            const ev = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
            (d || document).dispatchEvent(new KeyboardEvent('keydown', ev));
            (d || document).dispatchEvent(new KeyboardEvent('keyup', ev));
        } catch (e) { /* noop */ }
    }

    const closeAllPopups = () => openPopups().forEach(closePopup);

    function menuItems(root) {
        return [...root.querySelectorAll(ITEM_SEL)]
            .filter((it) => !it.hasAttribute('hidden') && !it.closest('[hidden]'));
    }

    function iconOf(item) {
        const p = item.querySelector('svg path');
        return p ? (p.getAttribute('d') || '').trim() : '';
    }

    function findItem(matcher) {
        for (const d of openPopups()) {
            const items = menuItems(d);
            if (!items.length) continue;
            for (const it of items) {
                const t = norm(it);
                if (!t) continue;
                if (matcher.notText && matcher.notText.test(t)) continue;
                if (matcher.text.test(t)) return it;
            }
            for (const it of items) {
                const t = norm(it);
                if (matcher.notText && t && matcher.notText.test(t)) continue;
                if (matcher.icons.includes(iconOf(it))) return it;
            }
        }
        return null;
    }

    function clickItem(item) {
        const self = item.matches('.ytp-menuitem, [role="menuitem"]');
        const target = self ? item
            : item.querySelector('[role="menuitem"], button, a, .ytListItemViewModelTextWrapper') || item;
        target.click();
    }

    let busy = false;

    /**
     * Opens ⋮ and clicks the wanted item. triggers is one button or a list of candidates:
     * if the first candidate's menu lacks the item, the next one is tried.
     * Returns the trigger that worked, or null.
     */
    async function runNativeAction(triggers, matcher) {
        const list = (Array.isArray(triggers) ? triggers : [triggers]).filter(Boolean);
        if (!list.length) { log('no ⋮ button for this action'); return null; }
        if (busy) return null;
        busy = true;
        const html = document.documentElement;
        html.classList.add('ytrc-busy');
        const safety = setTimeout(() => html.classList.remove('ytrc-busy'), 8000);

        try {
            for (const trigger of list) {
                closeAllPopups();
                await sleep(0);
                tlog('click ⋮', trigger.getAttribute('aria-label'), trigger);
                trigger.click();

                // no early give-up: YouTube may add feedback items to an already open menu later
                const item = await waitFor(() => findItem(matcher), 2500, 40);
                if (!item) { tlog('item not found in this menu, next ⋮', openPopups()); continue; }

                const pop = item.closest(POPUP_SEL);
                tlog('item found:', norm(item), item);
                clickItem(item);

                await sleep(150);
                if (pop && pop.getAttribute('aria-hidden') !== 'true' && isVisible(pop)) closePopup(pop);
                return trigger;
            }
            log('item not found in any candidate menu', list);
            closeAllPopups();
            return null;
        } catch (e) {
            err('runNativeAction', e);
            return null;
        } finally {
            clearTimeout(safety);
            setTimeout(() => { html.classList.remove('ytrc-busy'); busy = false; }, 200);
        }
    }

    /* ───────────────────────── BUILDING BUTTONS ──────────────────────── */

    /**
     * Icon inside a cloned YouTube button.
     * First swap d on the already rendered <svg>; if there is no svg yet
     * (in Shorts the arrows are stamped before their icons), build the markup ourselves.
     */
    function setIcon(btn, d, px = 24) {
        const path = btn.querySelector('svg path');
        if (path && path.ownerSVGElement) {
            const svg = path.ownerSVGElement;
            svg.setAttribute('viewBox', '0 0 24 24');
            [...svg.querySelectorAll('path')].forEach((p, i) => (i ? p.remove() : p.setAttribute('d', d)));
            return;
        }
        const slot = btn.querySelector('.ytSpecButtonShapeNextIcon');
        if (!slot) { log('no icon slot', btn); return; }
        slot.textContent = '';

        const wrap = document.createElement('span');
        wrap.className = 'ytIconWrapperHost';
        wrap.style.width = px + 'px';
        wrap.style.height = px + 'px';

        const shape = document.createElement('span');
        shape.className = 'yt-icon-shape ytSpecIconShapeHost';

        const inner = document.createElement('div');
        inner.style.cssText = 'width:100%;height:100%;display:block;fill:currentcolor;';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('style', 'pointer-events:none;display:inherit;width:100%;height:100%');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);

        inner.appendChild(svg);
        shape.appendChild(inner);
        wrap.appendChild(shape);
        slot.appendChild(wrap);
    }

    function cloneYtButton(sample, label, d = X_PATH) {
        const btn = sample.cloneNode(true);
        btn.querySelectorAll('yt-touch-feedback-shape, yt-light-shape, tp-yt-paper-tooltip').forEach((n) => n.remove());
        btn.removeAttribute('aria-pressed');
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('disabled');
        btn.removeAttribute('title');
        btn.setAttribute('aria-label', label);
        setIcon(btn, d);
        return btn;
    }

    function makeFlatX(label) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ytrc-x';
        btn.setAttribute('aria-label', label);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', X_PATH);
        svg.appendChild(p);
        btn.appendChild(svg);
        return btn;
    }

    /* ───────────────────────── FEED BUTTONS ──────────────────────────── */

    const feedEnabled = () => !CFG.feed.onlyHomePage || location.pathname === '/';

    function lockupMenuTrigger(lockup) {
        if (!lockup) return null;
        return lockup.querySelector('.ytLockupMetadataViewModelMenuButton button')
            || lockup.querySelector('ytd-menu-renderer #button');
    }

    function injectOverlayButtons() {
        let n = 0;
        for (const cont of document.querySelectorAll('yt-thumbnail-hover-overlay-toggle-actions-view-model')) {
            if (cont.querySelector('.ytrc-overlay-wrap')) continue;
            const lockup = cont.closest('yt-lockup-view-model');
            if (!lockup || !lockupMenuTrigger(lockup)) continue;
            const sample = cont.querySelector('button-view-model button, button');
            if (!sample) continue;

            const wrap = document.createElement('div');
            wrap.className = 'ytThumbnailHoverOverlayToggleActionsViewModelButton ytrc-overlay-wrap';
            const btn = cloneYtButton(sample, CFG.tips.notInterested);
            wrap.appendChild(btn);

            // the button sits inside <a href="/watch?v=…">, so suppress navigation to the video
            ['pointerdown', 'mousedown', 'mouseup', 'auxclick', 'touchstart'].forEach((ev) =>
                wrap.addEventListener(ev, killEvent, true));
            wrap.addEventListener('click', async (e) => {
                killEvent(e);
                const lk = wrap.closest('yt-lockup-view-model');
                await runNativeAction(lockupMenuTrigger(lk), MATCH.notInterested);
            }, true);

            bindTip(btn, CFG.tips.notInterested, 'bottom-right');
            cont.appendChild(wrap);
            n++;
        }
        if (n) log('thumbnail X buttons added:', n);
    }

    function channelBtnAnchor(meta) {
        if (CFG.feed.channelBtnPlace !== 'menu') {
            const link = meta.querySelector('a[href^="/@"], a[href*="/channel/"], a[href*="/c/"]');
            const row = link && link.closest('.ytContentMetadataViewModelMetadataRow');
            if (row) return { parent: row, mode: 'append' };
            const first = meta.querySelector('.ytContentMetadataViewModelMetadataRow');
            if (first) return { parent: first, mode: 'append' };
        }
        const menuBox = meta.querySelector('.ytLockupMetadataViewModelMenuButton');
        return menuBox ? { parent: menuBox, mode: 'prepend' } : null;
    }

    function injectChannelButtons() {
        let n = 0, skipped = 0;
        for (const meta of document.querySelectorAll('yt-lockup-metadata-view-model')) {
            if (meta.querySelector('.ytrc-x')) continue;
            const lockup = meta.closest('yt-lockup-view-model') || meta;
            if (!lockupMenuTrigger(lockup)) { skipped++; continue; }

            const anchor = channelBtnAnchor(meta);
            if (!anchor) { skipped++; continue; }

            const btn = makeFlatX(CFG.tips.notRecommend);
            ['pointerdown', 'mousedown', 'auxclick'].forEach((ev) => btn.addEventListener(ev, killEvent, true));
            btn.addEventListener('click', async (e) => {
                killEvent(e);
                await runNativeAction(lockupMenuTrigger(btn.closest('yt-lockup-view-model')), MATCH.notRecommend);
            }, true);
            bindTip(btn, CFG.tips.notRecommend, 'bottom-right');

            if (anchor.mode === 'prepend') anchor.parent.prepend(btn);
            else anchor.parent.appendChild(btn);
            n++;
        }
        if (n || skipped) log('channel X buttons added:', n, '| cards skipped:', skipped);
    }

    /* ─────────────────────────── SHORTS ─────────────────────────────── */

    const REEL_SEL = 'ytd-reel-video-renderer, .reel-video-in-sequence-new, .reel-video-in-sequence';

    function activeReel() {
        const reels = [...document.querySelectorAll(`ytd-shorts :is(${REEL_SEL})`)];
        const act = reels.find((r) => r.hasAttribute('is-active'));
        if (act) return act;
        const mid = innerHeight / 2;
        const best = reels
            .map((r) => { const b = r.getBoundingClientRect(); return { r, b, d: Math.abs(b.top + b.height / 2 - mid) }; })
            .filter((x) => x.b.height > 0)
            .sort((a, b) => a.d - b.d)[0];
        return best ? best.r : null;
    }

    // aria-label of the ⋮ button in different UI languages
    const RE_MORE_LABEL = /^(more( actions| options)?|action menu|інші дії|додаткові дії|більше( дій| параметрів)?|ще|другие действия|дополнительные действия|ещё|еще|больше( действий)?|меню|menu)$/i;

    const TRIGGER_SEL = [
        'ytd-shorts-player-controls #menu-button ytd-menu-renderer yt-button-shape#button-shape button',
        'ytd-shorts-player-controls #menu-button ytd-menu-renderer yt-icon-button#button > button',
        '#menu-button ytd-menu-renderer yt-button-shape button',
        '#menu-button yt-button-shape button',
        '#menu-button button',
        'ytd-menu-renderer yt-button-shape#button-shape button',
        'ytd-menu-renderer yt-icon-button#button > button',
    ];

    const rectsOverlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    /**
     * ⋮ candidates for the active Short, most likely first.
     * YouTube keeps moving this menu (it used to be in the right-hand action column,
     * now it is also in the player's top bar), so several lookup strategies are used.
     */
    function shortsMenuTriggers() {
        const shorts = document.querySelector('ytd-shorts');
        if (!shorts) return [];
        const reel = activeReel();
        const reelRect = reel && reel.getBoundingClientRect();

        // an element belongs to the active Short if it is inside it
        // or (for overlays rendered outside the reel) visually overlaps it
        const inActive = (el) => {
            if (!reel) return true;
            if (reel.contains(el)) return true;
            const other = el.closest(REEL_SEL);
            if (other && other !== reel) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && rectsOverlap(r, reelRect);
        };
        // the player's own controls (share, cards, playlist…) are never the feedback menu,
        // and clicking them can leave the player stuck
        const ok = (b) => b && !b.matches('.ytp-button, [class*="ytp-"]') && !b.closest('.html5-video-player')
            && !b.closest('.ytrc-shorts-wrap, .navigation-container, #navigation-button-up, #navigation-button-down');

        const all = [];
        const push = (b) => { if (ok(b) && !all.includes(b)) all.push(b); };
        for (const sel of TRIGGER_SEL) shorts.querySelectorAll(sel).forEach(push);
        shorts.querySelectorAll('button[aria-label], [role="button"][aria-label]').forEach((b) => {
            if (RE_MORE_LABEL.test((b.getAttribute('aria-label') || '').trim())) push(b);
        });

        // visible ones first, but keep hidden ones: the ⋮ may only show on hover
        let out = all.filter(inActive);
        out = out.filter(isVisible).concat(out.filter((b) => !isVisible(b)));

        // active Short not recognised: take the visible ⋮ nearest to the screen centre
        if (!out.length) {
            const cx = innerWidth / 2, cy = innerHeight / 2;
            const dist = (b) => { const r = b.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); };
            out = all.filter(isVisible).sort((a, b) => dist(a) - dist(b));
        }
        return out.slice(0, 3);
    }

    /* Remembered per action between page loads:
       trigger — which ⋮ worked last time, so it is tried first;
       advances — whether YouTube scrolls to the next Short by itself after this action.
       Without the latter every action would wait autoNextWait before scrolling. */
    const STATE_KEY = 'ytrc:state';
    const STATE_TTL = 24 * 3600 * 1000; // re-check YouTube's behaviour once a day

    function loadState() {
        try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    function saveState(kind, patch) {
        try {
            const st = loadState();
            st[kind] = { ...st[kind], ...patch };
            localStorage.setItem(STATE_KEY, JSON.stringify(st));
        } catch (e) { /* noop */ }
    }

    // DOM path alone is ambiguous (several ⋮ can share it), so add its index among namesakes
    function triggerKey(btn, all) {
        const d = describe(btn);
        return d + '|' + all.filter((b) => describe(b) === d).indexOf(btn);
    }

    async function shortsAction(kind, matcher) {
        if (busy) return;
        t0 = performance.now();
        const before = location.pathname;
        const known = loadState()[kind] || {};

        const found = shortsMenuTriggers();
        const triggers = found.slice();
        const pref = found.findIndex((b) => triggerKey(b, found) === known.trigger);
        if (pref > 0) triggers.unshift(...triggers.splice(pref, 1));
        log('shorts: ⋮ candidates', triggers);

        const used = await runNativeAction(triggers, matcher);
        if (!used) { err('shorts: action failed. Run __ytrc.diag() in the console for details'); return; }
        saveState(kind, { trigger: triggerKey(used, found) });
        if (!CFG.shorts.autoNext) return;

        const next = () => {
            const btn = document.querySelector('ytd-shorts #navigation-button-down button');
            if (btn) btn.click();
        };
        const fresh = known.checkedAt && Date.now() - known.checkedAt < STATE_TTL;
        if (fresh && known.advances === false) {
            // YouTube doesn't scroll after this action: do it right away
            await sleep(150);
            tlog('scrolling (learned: YouTube does not)');
            if (location.pathname === before) next();
            return;
        }
        // YouTube often moves to the next Short by itself; otherwise we'd skip two
        const moved = await waitFor(() => location.pathname !== before, CFG.shorts.autoNextWait, 60);
        saveState(kind, { advances: !!moved, checkedAt: Date.now() });
        if (moved) { tlog('YouTube scrolled to the next Short itself'); return; }
        tlog('YouTube did not scroll, scrolling');
        next();
    }

    function makeShortsButton(sample, kind, tip, icon, matcher) {
        const wrap = document.createElement('div');
        wrap.className = 'navigation-button style-scope ytd-shorts ytrc-shorts-wrap';
        wrap.dataset.ytrc = kind;
        const btn = cloneYtButton(sample, tip, icon);
        btn.addEventListener('click', (e) => { killEvent(e); shortsAction(kind, matcher); }, true);
        bindTip(btn, tip, 'left');
        wrap.appendChild(btn);
        return wrap;
    }

    function injectShortsButtons() {
        const nav = document.querySelector('ytd-shorts .navigation-container');
        if (!nav) return;
        const down = nav.querySelector('#navigation-button-down');
        const sample = down && down.querySelector('button');
        if (!down || !sample) return;

        // order below the down arrow: "Not interested", then "Don't recommend channel"
        let after = down;
        const place = (kind, enabled, tip, icon, matcher) => {
            if (!enabled) return;
            let w = nav.querySelector(`.ytrc-shorts-wrap[data-ytrc="${kind}"]`);
            if (!w) {
                w = makeShortsButton(sample, kind, tip, icon, matcher);
                after.insertAdjacentElement('afterend', w);
                log('shorts: button added -', kind);
            }
            after = w;
        };
        place('not-interested', CFG.shorts.notInterested, CFG.tips.notInterested, BAN_PATH, MATCH.notInterested);
        place('channel', CFG.shorts.channel, CFG.tips.notRecommend, X_PATH, MATCH.notRecommend);
    }

    /* ─────────────────────────── DIAGNOSTICS ───────────────────────── */
    /* In the YouTube console: __ytrc.diag() shows what the script sees in Shorts;
       __ytrc.diag(true) also opens the found ⋮ buttons and lists their menu items. */

    const describe = (el) => {
        if (!el) return null;
        const parts = [];
        for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) {
            let s = e.tagName.toLowerCase();
            if (e.id) s += '#' + e.id;
            if (typeof e.className === 'string' && e.className.trim()) s += '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.');
            parts.push(s);
        }
        return parts.join(' < ');
    };

    async function diag(openMenus = false) {
        const reel = activeReel();
        const triggers = shortsMenuTriggers();
        const report = {
            version: VERSION,
            url: location.href,
            activeReel: describe(reel),
            navContainer: !!document.querySelector('ytd-shorts .navigation-container'),
            triggers: triggers.map((b) => ({ label: b.getAttribute('aria-label'), visible: isVisible(b), path: describe(b) })),
            menus: [],
        };
        if (openMenus) {
            for (const t of triggers.slice(0, 4)) {
                closeAllPopups();
                await sleep(50);
                t.click();
                await sleep(700);
                report.menus.push({
                    trigger: t.getAttribute('aria-label'),
                    popups: openPopups().map((p) => ({ path: describe(p), items: menuItems(p).map(norm).filter(Boolean) })),
                });
            }
            closeAllPopups();
        }
        console.log('[ytrc] diag', report);
        console.log(JSON.stringify(report, null, 2));
        return report;
    }

    /* ──────────────────────────── SCHEDULER ─────────────────────────── */

    let scheduled = false;
    let injecting = false;

    function scan() {
        scheduled = false;
        injecting = true;
        try {
            if (mixJsNeeded()) safe('hideMixesJs', hideMixesJs);
            if (feedEnabled()) {
                if (CFG.feed.notInterested) safe('injectOverlayButtons', injectOverlayButtons);
                if (CFG.feed.channel) safe('injectChannelButtons', injectChannelButtons);
            }
            if ((CFG.shorts.notInterested || CFG.shorts.channel) && location.pathname.startsWith('/shorts')) {
                safe('injectShortsButtons', injectShortsButtons);
            }
        } finally {
            // our own insertions must not immediately trigger another scan
            setTimeout(() => { injecting = false; }, 0);
        }
    }

    function schedule(delay = 120) {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => safe('scan', scan), delay);
    }

    function start() {
        safe('injectMixCSS', injectMixCSS);
        safe('injectCSS', injectCSS);
        schedule(0);

        const root = document.querySelector('ytd-app') || document.body || document.documentElement;
        new MutationObserver(() => { if (!injecting) schedule(); }).observe(root, { childList: true, subtree: true });

        // card hover: YouTube creates the thumbnail overlay lazily, so catch up with it
        document.addEventListener('mouseover', (e) => {
            const t = e.target;
            if (t && t.closest && t.closest('yt-lockup-view-model')) schedule(30);
        }, true);

        ['yt-navigate-finish', 'yt-page-data-updated'].forEach((ev) =>
            window.addEventListener(ev, () => schedule(150), true));
        addEventListener('scroll', () => schedule(300), { passive: true });
        setInterval(() => schedule(0), 2000);

        window.__ytrc = { version: VERSION, cfg: CFG, diag };
        log('started, version', VERSION);
    }

    safe('injectMixCSS', injectMixCSS); // hide mixes as early as possible so they never flash
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => safe('start', start), { once: true });
    else safe('start', start);
})();
