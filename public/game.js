(() => {
  'use strict';

  const { createEngine } = window.TypingEngine;
  const WORDS = window.WORDS;
  const DURATION = 60;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (n) => Number(n).toLocaleString('ja-JP');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------- 保存 ------------------------- */
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('kiwami:' + k);
        return v === null ? d : JSON.parse(v);
      } catch (_) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('kiwami:' + k, JSON.stringify(v)); } catch (_) { /* 保存できなくても遊べる */ }
    },
  };

  const LANGS = [['jp', '日本語'], ['en', 'English'], ['mix', 'ミックス']];
  const LEVELS = [
    [1, '梅', 'かんたん', '短い言葉。まずはここから'],
    [2, '竹', 'ふつう', 'ふつうの長さの言葉'],
    [3, '松', 'むずかしい', '長い言葉・ことわざ・英文'],
  ];
  const langName = (v) => (LANGS.find((l) => l[0] === v) || LANGS[0])[1];
  const levelInfo = (v) => LEVELS.find((l) => Number(l[0]) === Number(v)) || LEVELS[0];
  const courseLabel = (c) => {
    const [lang, lv] = c.split('-');
    const li = levelInfo(lv);
    return `${langName(lang)}　${li[1]}（${li[2]}）`;
  };

  const prefs = {
    sound: store.get('sound', true),
    theme: store.get('theme', 'dark'),
    size: store.get('size', 'normal'),
    lang: store.get('lang', 'jp'),
    level: store.get('level', 1),
    name: store.get('name', ''),
  };
  if (!LANGS.some((l) => l[0] === prefs.lang)) prefs.lang = 'jp';
  if (!LEVELS.some((l) => Number(l[0]) === Number(prefs.level))) prefs.level = 1;
  prefs.level = Number(prefs.level);
  const pbs = store.get('pb', {});

  /* ------------------------- 音 ------------------------- */
  let actx = null;
  function audio() {
    if (!prefs.sound) return null;
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur = 0.06, type = 'sine', vol = 0.05, delay = 0) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    key: () => tone(1046, 0.04, 'sine', 0.03),
    word: () => { tone(784, 0.09, 'sine', 0.06); tone(1175, 0.16, 'sine', 0.06, 0.07); },
    miss: () => tone(150, 0.14, 'triangle', 0.08),
    tick: () => tone(660, 0.08, 'sine', 0.06),
    go: () => tone(990, 0.25, 'sine', 0.08),
    end: () => { tone(392, 0.5, 'sine', 0.07); tone(587, 0.7, 'sine', 0.06, 0.12); },
  };

  /* ------------------------- 設定ボタン ------------------------- */
  const btnSound = $('#btnSound');
  const btnSize = $('#btnSize');
  const btnTheme = $('#btnTheme');
  function applyPrefs() {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.dataset.size = prefs.size;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.content = prefs.theme === 'light' ? '#F1EFF5' : '#15121C';
    btnSound.textContent = `サウンド：${prefs.sound ? 'オン' : 'オフ'}`;
    btnSize.textContent = `文字：${prefs.size === 'large' ? '大' : '標準'}`;
    btnTheme.textContent = `画面：${prefs.theme === 'light' ? 'ライト' : 'ダーク'}`;
  }
  btnSound.addEventListener('click', () => { prefs.sound = !prefs.sound; store.set('sound', prefs.sound); applyPrefs(); if (prefs.sound) sfx.word(); });
  btnSize.addEventListener('click', () => { prefs.size = prefs.size === 'large' ? 'normal' : 'large'; store.set('size', prefs.size); applyPrefs(); });
  btnTheme.addEventListener('click', () => { prefs.theme = prefs.theme === 'light' ? 'dark' : 'light'; store.set('theme', prefs.theme); applyPrefs(); });

  /* ------------------------- 画面切り替え ------------------------- */
  const screens = {
    menu: $('#screen-menu'),
    play: $('#screen-play'),
    result: $('#screen-result'),
    ranking: $('#screen-ranking'),
  };
  function show(name) {
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
    window.scrollTo(0, 0);
    const h = screens[name].querySelector('[data-focus]');
    if (h) h.focus({ preventScroll: true });
  }

  /* ------------------------- ゲーム状態 ------------------------- */
  const G = {
    state: 'menu', // menu | countdown | play | finishing | result | ranking
    course: '',
    startAt: 0,
    score: 0, combo: 0, maxCombo: 0, keys: 0, miss: 0, words: 0,
    queue: [], cur: null, engine: null,
    raf: 0, timers: [], lastSec: -1,
    result: null, submitted: false, submitting: false,
    rankFrom: 'menu',
  };

  const el = {
    wordMain: $('#wordMain'), wordKana: $('#wordKana'), guide: $('#guide'),
    missMsg: $('#missMsg'), stage: $('#stage'), count: $('#count'),
    timeText: $('#timeText'), timerFill: $('#timerFill'), timer: $('#timer'), timerRow: $('#timerRow'),
    scoreText: $('#scoreText'), comboText: $('#comboText'), multText: $('#multText'), accText: $('#accText'),
    imeWarn: $('#imeWarn'),
  };

  /* ------------------------- コース選択 ------------------------- */
  function segHTML(name, items, value) {
    return items
      .map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"${String(v) === String(value) ? ' checked' : ''}><span>${l}</span></label>`)
      .join('');
  }

  function renderMenu() {
    $('#langSeg').innerHTML = segHTML('lang', LANGS, prefs.lang);
    $('#levelSeg').innerHTML = LEVELS
      .map(([v, k, n, d]) =>
        `<label><input type="radio" name="level" value="${v}"${v === prefs.level ? ' checked' : ''}>` +
        `<span class="card"><b class="k">${k}</b><span class="n">${n}</span><span class="d">${d}</span><span class="pb" data-lv="${v}"></span></span></label>`)
      .join('');
    updatePB();
  }
  function updatePB() {
    $$('#levelSeg .pb').forEach((p) => {
      const b = pbs[`${prefs.lang}-${p.dataset.lv}`];
      p.textContent = b ? `自己ベスト ${fmt(b)}` : '自己ベスト まだなし';
    });
  }
  $('#menuForm').addEventListener('change', (e) => {
    if (e.target.name === 'lang') { prefs.lang = e.target.value; store.set('lang', prefs.lang); }
    if (e.target.name === 'level') { prefs.level = Number(e.target.value); store.set('level', prefs.level); }
    updatePB();
  });
  $('#menuForm').addEventListener('submit', (e) => { e.preventDefault(); startGame(); });
  $('#btnRanking').addEventListener('click', () => openRanking('menu', prefs.lang, prefs.level));

  /* ------------------------- お題 ------------------------- */
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function makeBag(lang, level) {
    const jp = WORDS.jp[level].map(([w, k]) => ({ type: 'jp', w, k }));
    const en = WORDS.en[level].map((w) => ({ type: 'en', w }));
    const pool = lang === 'jp' ? jp : lang === 'en' ? en : jp.concat(en);
    return shuffle(pool.slice());
  }
  function pickWord() {
    if (!G.queue.length) {
      const [lang, lv] = G.course.split('-');
      G.queue = makeBag(lang, Number(lv));
      const last = G.cur;
      if (last && G.queue.length > 1 && G.queue[G.queue.length - 1].w === last.w) {
        G.queue.unshift(G.queue.pop());
      }
    }
    return G.queue.pop();
  }

  /* ------------------------- ゲーム開始 ------------------------- */
  function startGame() {
    if (G.state !== 'menu' && G.state !== 'result') return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    audio(); // ブラウザの音声制限を解除
    G.course = `${prefs.lang}-${prefs.level}`;
    Object.assign(G, { score: 0, combo: 0, maxCombo: 0, keys: 0, miss: 0, words: 0, queue: [], cur: null, engine: null, lastSec: -1, result: null, submitted: false, submitting: false, highlightId: null });
    $('#playCourse').textContent = courseLabel(G.course);
    el.wordMain.textContent = '';
    el.wordKana.replaceChildren();
    el.guide.replaceChildren();
    el.missMsg.textContent = '';
    el.imeWarn.hidden = true;
    updateStats();
    setTimer(DURATION);
    show('play');
    G.state = 'countdown';
    runCountdown();
  }

  function clearTimers() {
    G.timers.forEach(clearTimeout);
    G.timers = [];
    cancelAnimationFrame(G.raf);
  }

  function runCountdown() {
    const seq = ['3', '2', '1', 'スタート'];
    el.count.hidden = false;
    seq.forEach((t, i) => {
      G.timers.push(setTimeout(() => {
        el.count.textContent = t;
        el.count.classList.remove('pulse');
        void el.count.offsetWidth;
        el.count.classList.add('pulse');
        i < 3 ? sfx.tick() : sfx.go();
      }, i * 800));
    });
    G.timers.push(setTimeout(beginPlay, 3 * 800 + 500));
  }

  function beginPlay() {
    el.count.hidden = true;
    G.state = 'play';
    G.startAt = performance.now();
    nextWord();
    loop();
  }

  function quitToMenu() {
    clearTimers();
    G.state = 'menu';
    el.count.hidden = true;
    show('menu');
  }
  $('#btnQuit').addEventListener('click', quitToMenu);

  /* ------------------------- 描画 ------------------------- */
  function mult() { return 1 + Math.min(10, Math.floor(G.combo / 15)) / 10; }
  function updateStats() {
    el.scoreText.textContent = fmt(G.score);
    el.comboText.textContent = G.combo;
    el.multText.textContent = `×${mult().toFixed(1)}`;
    const tot = G.keys + G.miss;
    el.accText.textContent = tot ? `${Math.round((G.keys / tot) * 100)}%` : '100%';
  }
  function setTimer(left) {
    const sec = Math.ceil(left);
    if (sec !== G.lastSec) {
      G.lastSec = sec;
      el.timeText.textContent = sec;
      const low = left <= 10;
      el.timer.classList.toggle('low', low);
      el.timerRow.classList.toggle('low', low);
    }
    el.timerFill.style.transform = `scaleX(${Math.max(0, left / DURATION)})`;
  }

  function nextWord() {
    G.cur = pickWord();
    G.engine = createEngine(G.cur);
    el.wordMain.textContent = G.cur.w;
    renderProgress();
  }
  function renderProgress() {
    const v = G.engine.view();
    if (G.cur.type === 'jp') {
      el.wordKana.hidden = false;
      el.wordKana.replaceChildren(...v.kana.map((t, i) => {
        const s = document.createElement('span');
        s.textContent = t;
        if (i < v.ti) s.className = 'done';
        return s;
      }));
    } else {
      el.wordKana.hidden = true;
      el.wordKana.replaceChildren();
    }
    const mk = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const parts = [];
    if (v.done) parts.push(mk('d', v.done));
    if (v.rest) {
      parts.push(mk('n', v.rest[0]));
      if (v.rest.length > 1) parts.push(mk('r', v.rest.slice(1)));
    }
    el.guide.replaceChildren(...parts);
  }

  let missTimer = 0;
  function flashMiss() {
    el.missMsg.textContent = '× ミス';
    el.stage.classList.remove('is-miss');
    el.stage.classList.add('is-miss');
    clearTimeout(missTimer);
    missTimer = setTimeout(() => {
      el.stage.classList.remove('is-miss');
      el.missMsg.textContent = '';
    }, 280);
  }
  function flashClear() {
    el.stage.classList.remove('cleared');
    void el.stage.offsetWidth;
    el.stage.classList.add('cleared');
  }

  /* ------------------------- 入力 ------------------------- */
  function handleChar(ch) {
    const r = G.engine.press(ch);
    if (r === 'miss') {
      G.miss++;
      G.combo = 0;
      G.score = Math.max(0, G.score - 20);
      sfx.miss();
      flashMiss();
    } else {
      G.keys++;
      G.combo++;
      G.maxCombo = Math.max(G.maxCombo, G.combo);
      G.score += Math.round(10 * mult());
      if (r === 'done') {
        const len = G.engine.view().done.length;
        G.words++;
        G.score += 30 + 5 * len;
        sfx.word();
        flashClear();
        nextWord();
      } else {
        sfx.key();
        renderProgress();
      }
    }
    updateStats();
  }

  document.addEventListener('keydown', (e) => {
    if ((G.state === 'countdown' || G.state === 'play') && e.key === 'Escape') {
      quitToMenu();
      return;
    }
    if (G.state === 'menu' && e.key === 'Enter' && !e.target.closest('button, a, input[type="text"]')) {
      e.preventDefault();
      startGame();
      return;
    }
    if (G.state !== 'play') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.key === 'Process' || e.keyCode === 229) {
      el.imeWarn.hidden = false;
      return;
    }
    if (e.key.length !== 1) return;
    e.preventDefault();
    if (!el.imeWarn.hidden) el.imeWarn.hidden = true;
    handleChar(e.key);
  });
  document.addEventListener('keyup', (e) => {
    if (G.state === 'play' && e.key === ' ') e.preventDefault();
  });

  /* ------------------------- ゲームループ ------------------------- */
  function loop() {
    const left = Math.max(0, DURATION - (performance.now() - G.startAt) / 1000);
    setTimer(left);
    if (left <= 0) { finish(); return; }
    G.raf = requestAnimationFrame(loop);
  }

  const TITLES = [
    [0, '見習い'], [120, '一人前'], [200, '職人'], [280, '達人'], [360, '名人'], [460, '伝説'],
  ];
  function titleFor(kpm) {
    let t = TITLES[0][1];
    for (const [min, name] of TITLES) if (kpm >= min) t = name;
    return t;
  }

  function finish() {
    clearTimers();
    G.state = 'finishing';
    sfx.end();
    el.missMsg.textContent = '';
    const tot = G.keys + G.miss;
    const kpm = Math.round((G.keys * 60) / DURATION);
    const acc = tot ? G.keys / tot : 0;
    G.result = { course: G.course, score: G.score, keys: G.keys, miss: G.miss, kpm, acc, words: G.words, maxCombo: G.maxCombo, title: titleFor(kpm) };

    // 終了の余韻(打ち続けていても誤操作にならないよう少し待つ)
    el.guide.replaceChildren();
    el.wordKana.replaceChildren();
    el.wordMain.textContent = '終了！';
    G.timers.push(setTimeout(showResult, 1100));
  }

  function showResult() {
    const r = G.result;
    G.state = 'result';
    $('#resultCourse').textContent = courseLabel(r.course);
    $('#rScore').textContent = fmt(r.score);
    $('#rKpm').textContent = fmt(r.kpm);
    $('#rAcc').textContent = `${(r.acc * 100).toFixed(1)}%`;
    $('#rWords').textContent = fmt(r.words);
    $('#rMiss').textContent = fmt(r.miss);
    $('#rCombo').textContent = fmt(r.maxCombo);
    $('#rTitle').textContent = r.title;
    $('#rSeal').textContent = r.title.slice(0, 1);

    const old = pbs[r.course] || 0;
    if (r.score > old) {
      pbs[r.course] = r.score;
      store.set('pb', pbs);
      $('#rBest').textContent = old ? '自己ベスト更新！' : '初めての記録です！';
    } else {
      $('#rBest').textContent = `自己ベスト ${fmt(old)}`;
    }

    const form = $('#submitForm');
    form.hidden = r.score <= 0;
    $('#nameInput').value = prefs.name || '';
    $('#nameInput').disabled = false;
    $('#btnSubmit').disabled = false;
    setSubmitMsg('');

    show('result');
    loadRanking($('#resultRanking'), r.course, { limit: 10 });
    updatePB();
  }

  $('#btnAgain').addEventListener('click', startGame);
  $('#btnToMenu').addEventListener('click', () => { G.state = 'menu'; show('menu'); });
  $('#btnToRanking').addEventListener('click', () => {
    const [lang, lv] = G.result ? G.result.course.split('-') : [prefs.lang, prefs.level];
    openRanking('result', lang, Number(lv), G.highlightId);
  });

  /* ------------------------- 通信・ランキング ------------------------- */
  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(path, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || String(res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(to);
    }
  }

  function buildTable(entries, course, hid) {
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'まだ記録がありません。最初の1位をめざそう！';
      return p;
    }
    const wrap = document.createElement('div');
    wrap.className = 'scroll';
    const t = document.createElement('table');
    t.className = 'rank-table';
    const cap = document.createElement('caption');
    cap.textContent = `${courseLabel(course)} のランキング`;
    t.appendChild(cap);
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['順位', 'なまえ', 'スコア', '打鍵/分', '正確率'].forEach((h) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    entries.forEach((e) => {
      const tr = document.createElement('tr');
      const cells = [`${e.rank}位`, e.name, fmt(e.score), fmt(e.kpm), `${e.accuracy.toFixed(1)}%`];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (i === 1 && hid != null && e.id === hid) {
          const b = document.createElement('span');
          b.className = 'me-badge';
          b.textContent = 'あなた';
          td.appendChild(b);
        }
        tr.appendChild(td);
      });
      if (hid != null && e.id === hid) tr.className = 'me';
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  async function loadRanking(box, course, { limit = 20, highlightId = null } = {}) {
    const seq = (box._seq = (box._seq || 0) + 1);
    box.setAttribute('aria-busy', 'true');
    box.textContent = '読み込み中…（しばらく待つことがあります）';
    try {
      const data = await api(`/api/ranking?course=${encodeURIComponent(course)}&limit=${limit}`, { cache: 'no-store' });
      if (seq !== box._seq) return;
      box.replaceChildren(buildTable(data.entries, course, highlightId));
    } catch (_) {
      if (seq !== box._seq) return;
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = 'ランキングを読み込めませんでした。';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'もう一度読み込む';
      b.addEventListener('click', () => loadRanking(box, course, { limit, highlightId }));
      box.replaceChildren(p, b);
    } finally {
      if (seq === box._seq) box.setAttribute('aria-busy', 'false');
    }
  }

  /* --- ランキング画面 --- */
  const rk = { lang: 'jp', level: 1 };
  function renderRankingTabs() {
    $('#rkLang').innerHTML = segHTML('rkLang', LANGS, rk.lang);
    $('#rkLevel').innerHTML = segHTML('rkLevel', LEVELS.map(([v, k, n]) => [v, `${k} ${n}`]), rk.level);
  }
  function refreshRankingList(hid) {
    loadRanking($('#rankBox'), `${rk.lang}-${rk.level}`, { limit: 20, highlightId: hid ?? null });
  }
  function openRanking(from, lang, level, hid) {
    G.rankFrom = from;
    rk.lang = lang;
    rk.level = Number(level);
    G.state = 'ranking';
    renderRankingTabs();
    show('ranking');
    refreshRankingList(hid);
  }
  $('#rkLang').addEventListener('change', (e) => { rk.lang = e.target.value; refreshRankingList(); });
  $('#rkLevel').addEventListener('change', (e) => { rk.level = Number(e.target.value); refreshRankingList(); });
  $('#btnRkBack').addEventListener('click', () => {
    if (G.rankFrom === 'result' && G.result) { G.state = 'result'; show('result'); } else { G.state = 'menu'; show('menu'); }
  });

  /* --- 登録 --- */
  function setSubmitMsg(text, isErr) {
    const m = $('#submitMsg');
    m.textContent = text;
    m.classList.toggle('err', !!isErr);
  }
  $('#submitForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (G.submitted || G.submitting || !G.result) return;
    const name = $('#nameInput').value.trim();
    if (!name) { setSubmitMsg('なまえを入力してください。', true); $('#nameInput').focus(); return; }
    G.submitting = true;
    $('#btnSubmit').disabled = true;
    setSubmitMsg('送信中…');
    const r = G.result;
    try {
      const data = await api('/api/ranking', {
        method: 'POST',
        body: JSON.stringify({ course: r.course, name, score: r.score, keys: r.keys, miss: r.miss }),
      });
      prefs.name = name;
      store.set('name', name);
      G.submitted = true;
      G.highlightId = data.id;
      $('#nameInput').disabled = true;
      setSubmitMsg(`${data.rank}位に登録しました！`);
      loadRanking($('#resultRanking'), r.course, { limit: 10, highlightId: data.id });
    } catch (err) {
      $('#btnSubmit').disabled = false;
      setSubmitMsg(
        err.status === 429
          ? '短い時間にたくさん登録されました。少し待ってからもう一度お試しください。'
          : '登録できませんでした。通信を確認して、もう一度お試しください。',
        true
      );
    } finally {
      G.submitting = false;
    }
  });

  /* ------------------------- 起動(ロード画面) ------------------------- */
  (async function boot() {
    applyPrefs();
    renderMenu();

    const loader = $('#screen-loading');
    const app = $('#app');
    const fill = $('#loadFill');
    const text = $('#loadText');
    app.inert = true;

    const t0 = performance.now();
    const MIN = 1100;
    let fontsDone = false;
    const fontLoads = document.fonts && document.fonts.load
      ? Promise.all([
          document.fonts.load('800 1em "Shippori Mincho B1"'),
          document.fonts.load('700 1em "BIZ UDPGothic"'),
        ]).catch(() => {})
      : Promise.resolve();
    Promise.race([fontLoads, sleep(3000)]).then(() => { fontsDone = true; });

    await new Promise((resolve) => {
      (function step() {
        let p = Math.min(1, (performance.now() - t0) / MIN);
        if (!fontsDone) p = Math.min(p, 0.9);
        fill.style.transform = `scaleX(${p})`;
        text.textContent = `じゅんび中… ${Math.round(p * 100)}%`;
        if (p >= 1) resolve(); else requestAnimationFrame(step);
      })();
    });

    app.inert = false;
    loader.classList.add('out');
    setTimeout(() => loader.remove(), 700);
  })();
})();
