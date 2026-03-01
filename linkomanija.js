/**
 * LinkoManija.net plugin for LAMPA v3.4
 */
(function () {
    'use strict';

    var BASE = 'https://www.linkomanija.net';
    // Cloudflare Worker URL — замени на свой после деплоя
    var PROXY = 'https://winter-snowflake-c96f.artiomdesolei.workers.dev';

    var CATS = [
        { id: 53, name: 'Filmai LT' },
        { id: 61, name: 'Filmai LT HD' },
        { id: 28, name: 'Serialai LT' },
        { id: 62, name: 'Serialai LT HD' },
        { id: 26, name: 'DVD LT' }
    ];

    /* --- STORAGE --- */
    function sget(key, def) {
        return Lampa.Storage.get('lm_' + key, def !== undefined ? def : '');
    }
    function sset(key, val) {
        Lampa.Storage.set('lm_' + key, val);
    }

    /* --- NETWORK (via Cloudflare Worker proxy) --- */
    function proxyUrl(url) {
        var path = url.replace(BASE, '');
        if (path && path[0] !== '/') path = '/' + path;
        if (!path) path = '/';
        return PROXY + path;
    }

    function request(url, body, ok, fail) {
        var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        var cookies = sget('cookies');
        if (cookies) headers['X-Cookie'] = cookies;

        $.ajax({
            url: proxyUrl(url),
            type: body ? 'POST' : 'GET',
            data: body || undefined,
            headers: headers,
            dataType: 'text',
            success: function (data, status, xhr) {
                // Save any new session cookies returned by Worker
                var newCookies = xhr.getResponseHeader('X-Set-Cookies');
                if (newCookies) {
                    var existing = sget('cookies');
                    // Merge: new cookies override old ones with same name
                    var merged = mergeCookies(existing, newCookies);
                    sset('cookies', merged);
                }
                ok(data);
            },
            error: function (xhr, status) {
                fail(status + (xhr.status ? '/' + xhr.status : ''));
            }
        });
    }

    function mergeCookies(existing, fresh) {
        var map = {};
        (existing || '').split(';').forEach(function (p) {
            var kv = p.trim(); if (kv) { var eq = kv.indexOf('='); if (eq > 0) map[kv.slice(0, eq)] = kv; }
        });
        (fresh || '').split(';').forEach(function (p) {
            var kv = p.trim(); if (kv) { var eq = kv.indexOf('='); if (eq > 0) map[kv.slice(0, eq)] = kv; }
        });
        return Object.values(map).join('; ');
    }

    /* --- AUTH --- */
    function isLogged() { return sget('logged') === 'yes'; }

    function doLogin(ok, fail) {
        var user = sget('user');
        var pass = sget('pass');
        if (!user || !pass) { fail('no_creds'); return; }

        // Step 1: GET login page (gets session cookie via Worker)
        request(BASE + '/login.php', false, function () {
            // Step 2: POST credentials
            var body = 'username=' + encodeURIComponent(user) +
                       '&password=' + encodeURIComponent(pass) + '&returnto=';
            request(BASE + '/takelogin.php', body, function (html) {
                // Check for logout link = we are logged in
                // Check absence of login form = we are logged in
                var loggedIn = typeof html === 'string' && (
                    html.indexOf('atsijungti') !== -1 ||
                    html.indexOf('logout') !== -1 ||
                    html.indexOf('takelogin') === -1
                );
                if (loggedIn) {
                    sset('logged', 'yes'); ok();
                } else {
                    sset('logged', 'no'); fail('bad_creds');
                }
            }, function (err) { fail('post:' + err); });
        }, function (err) { fail('get:' + err); });
    }

    function ensureAuth(then) {
        if (isLogged()) { then(); return; }
        var user = sget('user'), pass = sget('pass');
        if (!user || !pass) {
            showLoginDialog(then);
            return;
        }
        doLogin(then, function (err) {
            Lampa.Noty.show('LinkoManija: prisijungimo klaida (' + err + ')');
        });
    }

    /* --- PARSERS --- */
    function parseDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function parseBrowse(html) {
        var doc = parseDoc(html), seen = {}, out = [];
        doc.querySelectorAll('a[href*="details?"]').forEach(function (a) {
            var href = a.getAttribute('href') || '';
            if (href && href[0] !== '/') href = '/' + href;
            var m = href.match(/details\?(\d+)\./);
            if (!m) return;
            var id = parseInt(m[1]);
            if (seen[id]) return;
            seen[id] = true;
            var title = (a.textContent || '').trim();
            if (!title) return;
            var seeds = 0, leeches = 0, size = '', date = '';
            var row = a.closest ? a.closest('tr') : null;
            if (row) {
                row.querySelectorAll('td').forEach(function (td) {
                    var t = (td.textContent || '').trim();
                    var cl = (td.className || '') + (td.getAttribute('style') || '');
                    if (/^\d+$/.test(t)) {
                        var n = parseInt(t);
                        if (/green/i.test(cl)) seeds = n;
                        else if (/red/i.test(cl)) leeches = n;
                    }
                    if (/\d[\d.]*\s*(GB|MB|TB)/i.test(t)) size = t;
                    var dm = t.match(/^(\d{4}-\d{2}-\d{2})/);
                    if (dm) date = dm[1];
                });
            }
            out.push({ id: id, href: href, title: title, seeds: seeds, leeches: leeches, size: size, date: date });
        });
        return out;
    }

    function parseTotalPages(html) {
        var max = 1, re = /[?&]page=(\d+)/g, m;
        while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1]) + 1);
        return max;
    }

    function parseDetail(html, id) {
        var doc = parseDoc(html), r = { id: id };
        var h1 = doc.querySelector('h1');
        if (h1) r.title = h1.textContent.trim();
        var dlEl = doc.querySelector('a[href*="download.php?id=' + id + '"]');
        if (dlEl) {
            r.dl = dlEl.getAttribute('href') || '';
            if (r.dl && !/^https?:/.test(r.dl)) r.dl = BASE + r.dl;
        }
        var descr = doc.querySelector('.descr_text') || doc.querySelector('td.descr_text');
        if (descr) {
            var img = descr.querySelector('img');
            if (img) {
                var src = img.getAttribute('src') || '';
                r.poster = /^https?:/.test(src) ? src : BASE + '/' + src.replace(/^\.\//, '');
            }
            var fnt = descr.querySelector('font[size="4"] b');
            if (fnt) r.lt_title = fnt.textContent.trim();
            var inner = descr.innerHTML || '';
            var m1 = inner.match(/Premjera[^:]*:.*?(\d{4})/);      if (m1) r.year      = m1[1];
            var m2 = inner.match(/Žanras[^:]*:<\/b>([^<]+)/);       if (m2) r.genre     = m2[1].trim();
            var m3 = inner.match(/(\d+\.?\d*)\/10/);                 if (m3) r.imdb      = parseFloat(m3[1]);
            var m4 = inner.match(/Originalus pavadinimas[^:]*:<\/b>([^<]+)/); if (m4) r.orig = m4[1].trim();
            var m5 = inner.match(/Režisierius[^:]*:<\/b>([^<]+)/);   if (m5) r.director  = m5[1].trim();
            var m6 = inner.match(/Aktoriai[^:]*:<\/b>([^<]+)/);      if (m6) r.cast      = m6[1].trim();
            // Description — multiple strategies
            var m7 = inner.match(/si[uū]žetas[^:]*:<\/b>\s*<br[^>]*>([\s\S]*?)(?:<br\s*[/]?>\s*<br|<iframe|<\/td|<\/div)/i)
                   || inner.match(/si[uū]žetas[^:]*:\s*<\/b>([\s\S]*?)(?:<b>|<iframe|<\/td|<\/div)/i)
                   || inner.match(/si[uū]žetas[^:]*:([^<]{60,})/i);
            if (m7) {
                r.description = m7[1].replace(/<[^>]+>/g, '').trim().slice(0, 700);
            }
            // Fallback: find longest text chunk in descr, skipping known metadata lines
            if (!r.description || r.description.length < 40) {
                var metaRe = /^(Premjera|Žanras|Kalbos|Kokybė|Formatas|Trukmė|Šalis|Studija|IMDB|Režisierius|Aktoriai|Dydis|Seed|Leech|Originalus|Siužetas)/i;
                var chunks = (descr.textContent || '').split(/\n|\r|\t/)
                    .map(function (l) { return l.trim(); })
                    .filter(function (l) { return l.length > 60 && !metaRe.test(l); });
                if (chunks.length) r.description = chunks.join(' ').slice(0, 700);
            }
            // YouTube trailer — find iframe with youtube embed
            var ytm = inner.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
            if (!ytm) ytm = inner.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (!ytm) ytm = inner.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
            if (ytm) r.youtube = ytm[1];
        }
        var body = doc.body ? doc.body.innerHTML : '';
        var ms = body.match(/(\d+)\s*seed[^,]*,?\s*(\d+)\s*leech/i) ||
                 body.match(/<b>(\d+)<\/b>\s*seed.*?<b>(\d+)<\/b>\s*leech/i);
        if (ms) { r.seeds = parseInt(ms[1]); r.leeches = parseInt(ms[2]); }
        var mz = body.match(/Dydis[^:]*:[^<]*?(\d[\d.]*\s*(?:GB|MB|TB))/i);
        if (mz) r.size = mz[1].trim();
        // Comments — try multiple TBdev selector patterns
        r.comments = [];
        var commentSels = [
            '#reply_area td:nth-child(2)', '#replies td:nth-child(2)',
            'table[id*="repl"] td:nth-child(2)', 'table[id*="comment"] td:nth-child(2)',
            '.reply_text', '.comment_text', '.comment_body', '.msg_text',
            'td[class*="reply"]', 'td[class*="comment"]',
            '#comment_list .text', '.comments .body'
        ].join(', ');
        var seen = {};
        doc.querySelectorAll(commentSels).forEach(function (el) {
            var t = el.textContent.trim();
            if (t.length > 10 && t.length < 1000 && !seen[t]) { seen[t] = true; r.comments.push(t); }
        });
        return r;
    }

    /* --- DETAIL MODAL --- */
    function showDetail(item) {
        var wrap = $('<div style="padding:20px"><p style="color:#aaa">Kraunama…</p></div>');
        Lampa.Modal.open({ title: item.title, html: wrap, onBack: function () { Lampa.Modal.close(); } });
        ensureAuth(function () {
            var detailUrl = item.href
                ? (/^https?:/.test(item.href) ? item.href : BASE + item.href)
                : (BASE + '/details?id=' + item.id);
            request(detailUrl, false, function (html) {
                renderDetail(wrap, parseDetail(html, item.id), item);
            }, function () {
                wrap.html('<p style="color:#f55">Klaida / Ошибка загрузки</p>');
            });
        });
    }

    function renderDetail(wrap, d, item) {
        wrap.empty();
        if (d.poster) {
            var imgEl = $('<img style="float:left;max-width:150px;margin:0 16px 10px 0;border-radius:4px">');
            imgEl.attr('src', d.poster).on('error', function () { imgEl.remove(); });
            wrap.append(imgEl);
        }
        wrap.append($('<h2 style="margin:0 0 10px"></h2>').text(d.lt_title || d.title || item.title));
        function row(lbl, val) {
            if (!val) return;
            var el = $('<p style="margin:3px 0;font-size:14px"></p>');
            el.html('<b>' + lbl + ':</b> ').append(document.createTextNode(val));
            wrap.append(el);
        }
        if (d.orig && d.orig !== d.title) row('Originalus', d.orig);
        row('Metai', d.year);
        row('Žanras', d.genre);
        if (d.imdb) row('IMDB', d.imdb + '/10');
        row('Dydis', (d.size || '') + (d.seeds ? '  🌱 ' + d.seeds : ''));
        row('Režisierius', d.director);
        row('Aktoriai', d.cast);
        if (d.description) {
            wrap.append($('<p style="margin:10px 0 14px;font-size:13px;color:#ccc;clear:both;line-height:1.5"></p>').text(d.description));
        }
        var btnRow = $('<div style="clear:both;display:flex;flex-wrap:wrap;gap:8px;margin-top:14px"></div>');
        var watchBtn = $('<div class="full-start__button selector" style="padding:10px 20px">▶ Žiūrėti / Смотреть</div>');
        watchBtn.on('hover:enter', function () {
            if (!d.dl) { Lampa.Noty.show('LinkoManija: nerasta nuoroda'); return; }
            Lampa.Modal.close();
            startTorrent(d, item);
        });
        btnRow.append(watchBtn);
        if (d.youtube) {
            var trailerBtn = $('<div class="full-start__button selector" style="padding:10px 20px">🎬 Treileras</div>');
            trailerBtn.on('hover:enter', function () {
                try { Lampa.Youtube.trailer({ url: 'https://www.youtube.com/watch?v=' + d.youtube }); }
                catch(e) {
                    try { Lampa.Player.play({ url: 'https://www.youtube.com/watch?v=' + d.youtube, title: d.lt_title || 'Treileras' }); }
                    catch(e2) { Lampa.Noty.show('YouTube: youtu.be/' + d.youtube); }
                }
            });
            btnRow.append(trailerBtn);
        }
        wrap.append(btnRow);
        if (d.comments && d.comments.length) {
            wrap.append($('<p style="margin:16px 0 6px;font-size:12px;color:#666;font-weight:600">Komentarai (' + d.comments.length + ')</p>'));
            d.comments.slice(0, 10).forEach(function (c) {
                wrap.append($('<p style="margin:4px 0;font-size:12px;color:#999;border-left:2px solid #333;padding-left:8px"></p>').text(c));
            });
        }
        Lampa.Controller.add('modal', {
            toggle: function () { Lampa.Controller.collectionSet(wrap); Lampa.Controller.collectionFocus(watchBtn, wrap); },
            back: function () { Lampa.Modal.close(); }
        });
        Lampa.Controller.toggle('modal');
    }

    /* --- TORRSERVE --- */
    function startTorrent(d, item) {
        var title = d.lt_title || d.title || item.title;
        var poster = d.poster || '';
        // Route download through proxy with session cookies so TorrServe can fetch the .torrent file
        var dlUrl = proxyUrl(d.dl);
        var cookies = sget('cookies');
        if (cookies) dlUrl += (dlUrl.indexOf('?') >= 0 ? '&' : '?') + '_ck=' + encodeURIComponent(cookies);
        if (Lampa.Torrent && Lampa.Torrent.start) {
            Lampa.Torrent.start({ title: title, Link: dlUrl, poster: poster },
                { id: d.id, title: title, original_title: d.orig || title,
                  release_date: d.year ? d.year + '-01-01' : '', img: poster, poster_path: poster });
        } else {
            Lampa.Noty.show('TorrServe: ' + dlUrl);
        }
    }

    /* --- CARD (list item: poster left, info right) --- */
    function buildCard(item) {
        var card = $([
            '<div class="selector" style="display:flex;align-items:flex-start;',
            'padding:8px 12px;border-bottom:1px solid #222;min-height:90px">',
            '<div style="width:60px;height:85px;flex-shrink:0;border-radius:4px;',
            'overflow:hidden;background:#1a1a2e;position:relative;margin-right:12px">',
            '<img class="lm_pimg" style="width:100%;height:100%;object-fit:cover;',
            'object-position:center top;display:none" />',
            '<div class="lm_ctxt" style="position:absolute;inset:0;display:flex;',
            'align-items:center;justify-content:center;padding:2px;',
            'color:#555;font-size:9px;text-align:center;line-height:1.2"></div>',
            '</div>',
            '<div style="flex:1;overflow:hidden;padding-top:2px">',
            '<div class="lm_title" style="font-size:13px;font-weight:600;',
            'color:#fff;line-height:1.3;margin-bottom:5px"></div>',
            '<div class="lm_meta" style="font-size:11px;color:#888"></div>',
            '</div></div>'
        ].join(''));
        card.find('.lm_title').text(item.title);
        card.find('.lm_ctxt').text('IMG');
        var meta = [];
        if (item.size)   meta.push(item.size);
        if (item.seeds)  meta.push('🌱' + item.seeds);
        if (item.date)   meta.push(item.date);
        card.find('.lm_meta').text(meta.join('  ·  '));
        card.on('hover:enter', function () { showDetail(item); });
        return card;
    }

    /* --- POSTER LOADER --- */
    function loadPosters(items, cardEls) {
        items.forEach(function (item, idx) {
            var card = cardEls[idx];
            var detailUrl = item.href
                ? (/^https?:/.test(item.href) ? item.href : BASE + item.href)
                : (BASE + '/details?id=' + item.id);
            request(detailUrl, false, function (html) {
                var d = parseDetail(html, item.id);
                if (d.poster && card && card.length) {
                    card.find('.lm_pimg').attr('src', d.poster).show();
                    card.find('.lm_ctxt').hide();
                }
            }, function () {});
        });
    }

    /* --- FULL PAGE HOOK (кнопка LinkoManija на странице фильма в LAMPA каталоге) --- */
    function cleanTitleForSearch(title) {
        return title
            .replace(/\(\d{4}\)/g, '')
            .replace(/[^\w\s\u00C0-\u024F\u0400-\u04FF-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function hookFullPage() {
        try {
            Lampa.Listener.follow('full', function (e) {
                if (e.type !== 'complite') return;
                try {
                    var comp = e.component;
                    var movie = (e.data && e.data.movie) ? e.data.movie : (e.data || {});
                    var title = movie.original_title || movie.title || '';
                    if (!title) return;

                    setTimeout(function () {
                        if (!comp || !comp.render) return;
                        var fullEl = comp.render();
                        if (!fullEl || !fullEl.length) return;
                        if (fullEl.find('.lm_full_btn').length) return; // already added

                        var lmBtn = $('<div class="full-start__button selector lm_full_btn" style="margin-top:4px">🇱🇹 LinkoManija</div>');
                        lmBtn.on('hover:enter click', function () {
                            var q = cleanTitleForSearch(title);
                            Lampa.Activity.push({ url: '', title: 'LM: ' + q, component: 'lm_browse', query: q, page: 1 });
                        });

                        // Ищем ряд кнопок — несколько вариантов классов в разных версиях LAMPA
                        var btnArea = fullEl.find('.full-start__buttons').first();
                        if (!btnArea.length) btnArea = fullEl.find('.full-start__rate').first();
                        if (!btnArea.length) btnArea = fullEl.find('.full-start__icons').first();
                        if (!btnArea.length) btnArea = fullEl.find('[class*="full-start__b"]').first();
                        if (btnArea.length) {
                            btnArea.append(lmBtn);
                        }
                    }, 300);
                } catch (ex) {}
            });
        } catch (e) {}
    }

    /* --- BROWSE COMPONENT --- */
    function BrowseComponent(object) {
        var catId = object.cat_id, query = object.query;
        var page = object.page || 1, pages = 1, busy = false;

        var scroll  = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        scroll.minus(); // tell LAMPA scroll its height = full activity height
        var info    = $('<div style="padding:8px 12px;color:#888;font-size:13px"></div>');
        var prevBtn = $('<div class="full-start__button selector" style="padding:8px 20px;margin:6px">‹ Ankst.</div>');
        var nextBtn = $('<div class="full-start__button selector" style="padding:8px 20px;margin:6px">Kitas ›</div>');
        var pgInfo  = $('<span style="color:#aaa;font-size:13px;margin:0 12px"></span>');
        var pager   = $('<div style="display:flex;align-items:center;padding:10px 16px 20px"></div>').append(prevBtn).append(pgInfo).append(nextBtn);

        prevBtn.on('hover:enter', function () { if (page > 1) { page--; reload(); } });
        nextBtn.on('hover:enter', function () { if (page < pages) { page++; reload(); } });

        function updatePager() {
            pgInfo.text('Puslapis ' + page + ' / ' + pages);
            prevBtn.css('opacity', page > 1 ? 1 : 0.3);
            nextBtn.css('opacity', page < pages ? 1 : 0.3);
        }

        function setCtrl() {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                },
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        }

        function reload() {
            if (busy) return;
            busy = true;
            scroll.clear();
            scroll.append(info);
            info.text('Kraunama…');
            var url = query
                ? BASE + '/browse.php?search=' + encodeURIComponent(query) + '&page=' + (page - 1)
                : BASE + '/browse.php?cat=' + catId + '&page=' + (page - 1) + '&sort=added&d=DESC';
            ensureAuth(function () {
                request(url, false, function (html) {
                    busy = false;
                    var list = parseBrowse(html);
                    pages = parseTotalPages(html);
                    if (list.length >= 15 && pages <= page) pages = page + 1;
                    if (!list.length) { info.text('Nėra rezultatų'); updatePager(); scroll.append(pager); setCtrl(); return; }
                    info.text(list.length + ' torrentų');
                    var cardEls = [];
                    list.forEach(function (item) { var c = buildCard(item); scroll.append(c); cardEls.push(c); });
                    scroll.append(pager);
                    updatePager(); setCtrl();
                    loadPosters(list, cardEls);
                }, function () {
                    busy = false;
                    info.text('Klaida / Ошибка');
                    Lampa.Noty.show('LinkoManija: tinklo klaida');
                });
            });
        }

        return {
            create:  function () { reload(); },
            render:  function () { return scroll.render(); },
            start:   function () { setCtrl(); },
            pause:   function () {},
            stop:    function () {},
            destroy: function () { if (scroll.destroy) scroll.destroy(); }
        };
    }

    /* --- LOGIN DIALOG --- */
    function showLoginDialog(onSuccess) {
        var html = $([
            '<div style="padding:20px;min-width:260px">',
            '<p style="margin:0 0 6px;color:#aaa;font-size:13px">Логин (linkomanija.net)</p>',
            '<input id="lm_inp_user" type="text" autocomplete="off"',
            ' style="width:100%;padding:10px;margin-bottom:14px;background:#222;border:1px solid #444;',
            'color:#fff;border-radius:4px;font-size:16px;box-sizing:border-box">',
            '<p style="margin:0 0 6px;color:#aaa;font-size:13px">Пароль</p>',
            '<input id="lm_inp_pass" type="password" autocomplete="off"',
            ' style="width:100%;padding:10px;margin-bottom:18px;background:#222;border:1px solid #444;',
            'color:#fff;border-radius:4px;font-size:16px;box-sizing:border-box">',
            '<div class="full-start__button selector" id="lm_login_ok"',
            ' style="display:inline-block;padding:10px 24px">Войти / Prisijungti</div>',
            '</div>'
        ].join(''));

        html.find('#lm_inp_user').val(sget('user'));
        html.find('#lm_inp_pass').val(sget('pass'));

        html.find('#lm_login_ok').on('hover:enter click', function () {
            var u = html.find('#lm_inp_user').val().trim();
            var p = html.find('#lm_inp_pass').val();
            if (!u || !p) { Lampa.Noty.show('LinkoManija: įveskite duomenis'); return; }
            sset('user', u);
            sset('pass', p);
            sset('logged', 'no');
            Lampa.Modal.close();
            doLogin(
                function () {
                    Lampa.Noty.show('LinkoManija: ✓ Prisijungta!');
                    if (onSuccess) onSuccess();
                },
                function (e) { Lampa.Noty.show('LinkoManija: klaida — ' + e); }
            );
        });

        Lampa.Modal.open({
            title: 'LinkoManija – Prisijungimas',
            html: html,
            onBack: function () { Lampa.Modal.close(); }
        });
        setTimeout(function () { html.find('#lm_inp_user').focus(); }, 300);
    }

    /* --- SETTINGS --- */
    function addSettings() {
        try {
            Lampa.SettingsApi.addComponent({
                component: 'linkomanija', name: 'LinkoManija',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>'
            });
            Lampa.SettingsApi.addParam({
                component: 'linkomanija',
                param: { name: 'lm_login_btn', type: 'button', default: false },
                field: { name: 'Войти / Prisijungti', description: 'Ввести логин и пароль' },
                onChange: function () { showLoginDialog(); }
            });
            Lampa.SettingsApi.addParam({
                component: 'linkomanija',
                param: { name: 'lm_out_btn', type: 'button', default: false },
                field: { name: 'Выйти / Atsijungti', description: 'Сбросить сессию' },
                onChange: function () { sset('logged', 'no'); Lampa.Noty.show('LinkoManija: sesija išvalyta'); }
            });
        } catch(e) {}
    }

    /* --- MENU --- */
    function onMenuClick() {
        var items = CATS.map(function (c) { return { title: c.name, cat_id: c.id }; });
        items.push({ title: '🔍 Paieška / Поиск', search: true });
        items.push({ title: '⚙ Prisijungti / Войти', login: true });
        if (isLogged()) items.push({ title: '⚙ Atsijungti / Выйти', logout: true });
        Lampa.Select.show({
            title: 'LinkoManija', items: items,
            onSelect: function (sel) {
                Lampa.Menu.close();
                if (sel.login) {
                    showLoginDialog();
                } else if (sel.logout) {
                    sset('logged', 'no');
                    Lampa.Noty.show('LinkoManija: sesija išvalyta');
                } else if (sel.search) {
                    var sinp = $('<input type="text" placeholder="Filmo pavadinimas…" style="width:100%;padding:12px;font-size:18px;background:transparent;border:0;border-bottom:2px solid #fff;color:#fff;outline:none;box-sizing:border-box;margin-bottom:16px">');
                    var sbtn = $('<div class="full-start__button selector" style="display:inline-block;padding:10px 24px">🔍 Ieškoti</div>');
                    var swrap = $('<div style="padding:20px"></div>').append(sinp).append(sbtn);
                    function doSearch() {
                        var q = sinp.val().trim();
                        if (!q) return;
                        Lampa.Modal.close();
                        Lampa.Activity.push({ url: '', title: 'LM: ' + q, component: 'lm_browse', query: q, page: 1 });
                    }
                    sinp.on('keydown', function (e) { if (e.keyCode === 13) doSearch(); });
                    sbtn.on('hover:enter click', doSearch);
                    Lampa.Modal.open({
                        title: 'LinkoManija – Paieška', html: swrap,
                        onBack: function () { Lampa.Modal.close(); }
                    });
                    setTimeout(function () { sinp.focus(); }, 200);
                } else {
                    Lampa.Activity.push({ url: '', title: 'LinkoManija – ' + sel.title, component: 'lm_browse', cat_id: sel.cat_id, page: 1 });
                }
            },
            onBack: function () { Lampa.Controller.toggle('menu'); }
        });
    }

    function addMenu() {
        // Use DOM presence as single source of truth — no flag that can lie
        if ($('#lm_menu_btn').length) return;

        var target = $('.menu .menu__list').eq(0);
        if (!target.length) target = $('.menu__list').eq(0);
        if (!target.length) return; // menu DOM not ready yet

        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" fill="currentColor"><text y="48" font-size="46" font-weight="bold" font-family="Arial,sans-serif">LM</text></svg>';
        var btn = $('<li class="menu__item selector" id="lm_menu_btn"><div class="menu__ico"></div><div class="menu__text">LinkoManija 3.4</div></li>');
        btn.find('.menu__ico').html(svg);
        btn.on('hover:enter click', onMenuClick);
        target.append(btn);
    }

    /* --- INIT --- */
    function init() {
        console.log('LinkoManija', 'init v3.4');

        try { Lampa.Manifest.plugins = { type: 'other', version: '1.9', name: 'LinkoManija', description: 'linkomanija.net' }; } catch(e) {}
        try { Lampa.Component.add('lm_browse', function (obj) { return BrowseComponent(obj); }); } catch(e) {}
        hookFullPage();


        try {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'start' || e.type === 'ready') addMenu();
            });
        } catch(e) {}

        try {
            Lampa.Listener.follow('menu', function (e) {
                if (e.type === 'start' || e.type === 'end' || e.type === 'open') addMenu();
            });
        } catch(e) {}

        // Timed retries — covers cases where events already fired before plugin loaded
        [500, 1000, 2000, 4000, 8000].forEach(function (ms) {
            setTimeout(addMenu, ms);
        });
    }

    if (!window.lm_plugin_loaded) { window.lm_plugin_loaded = true; init(); }

})();
