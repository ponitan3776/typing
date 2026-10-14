/* 入力判定エンジン: ローマ字の複数表記(si/shi, tu/tsu, nn/n など)に対応 */
(function (root) {
  'use strict';

  const SINGLE = {};
  (
    'あ:a い:i う:u え:e お:o か:ka き:ki く:ku け:ke こ:ko ' +
    'さ:sa し:shi,si,ci す:su せ:se そ:so た:ta ち:chi,ti つ:tsu,tu て:te と:to ' +
    'な:na に:ni ぬ:nu ね:ne の:no は:ha ひ:hi ふ:fu,hu へ:he ほ:ho ' +
    'ま:ma み:mi む:mu め:me も:mo や:ya ゆ:yu よ:yo ら:ra り:ri る:ru れ:re ろ:ro ' +
    'わ:wa を:wo が:ga ぎ:gi ぐ:gu げ:ge ご:go ざ:za じ:ji,zi ず:zu ぜ:ze ぞ:zo ' +
    'だ:da ぢ:di づ:du で:de ど:do ば:ba び:bi ぶ:bu べ:be ぼ:bo ぱ:pa ぴ:pi ぷ:pu ぺ:pe ぽ:po ' +
    'ぁ:la,xa ぃ:li,xi ぅ:lu,xu ぇ:le,xe ぉ:lo,xo ゃ:lya,xya ゅ:lyu,xyu ょ:lyo,xyo ー:-'
  )
    .split(' ')
    .forEach((p) => {
      const i = p.indexOf(':');
      SINGLE[p.slice(0, i)] = p.slice(i + 1).split(',');
    });

  const DI = {
    き: ['ky'], ぎ: ['gy'], し: ['sh', 'sy'], じ: ['j', 'zy', 'jy'], ち: ['ch', 'ty', 'cy'],
    ぢ: ['dy'], に: ['ny'], ひ: ['hy'], み: ['my'], り: ['ry'], び: ['by'], ぴ: ['py'],
  };
  const SMALLY = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
  const EXT = {
    ふぁ: ['fa'], ふぃ: ['fi'], ふぇ: ['fe'], ふぉ: ['fo'],
    てぃ: ['thi'], でぃ: ['dhi'], しぇ: ['she'], じぇ: ['je'], ちぇ: ['che'],
  };

  const uniq = (a) => Array.from(new Set(a));

  function buildTokens(kana) {
    const chars = Array.from(kana);
    const raw = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const n = chars[i + 1];
      if (c === 'っ') { raw.push({ kana: c, type: 'sokuon' }); continue; }
      if (c === 'ん') { raw.push({ kana: c, type: 'n' }); continue; }
      if (n && EXT[c + n]) { raw.push({ kana: c + n, opts: EXT[c + n].slice() }); i++; continue; }
      if (n && SMALLY[n] && DI[c]) {
        raw.push({ kana: c + n, opts: DI[c].map((p) => p + SMALLY[n]) });
        i++;
        continue;
      }
      if (SINGLE[c]) raw.push({ kana: c, opts: SINGLE[c].slice() });
    }

    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      const nx = raw[i + 1];

      if (t.type === 'sokuon') {
        if (nx && nx.opts) {
          const opts = [];
          nx.opts.forEach((o) => {
            if (!/[aiueon\-lx]/.test(o[0])) opts.push(o[0] + o);
            if (o.startsWith('ch')) opts.push('t' + o);
          });
          ['ltu', 'xtu'].forEach((p) => nx.opts.forEach((o) => opts.push(p + o)));
          out.push({ kana: t.kana + nx.kana, opts: uniq(opts) });
          i++;
        } else {
          out.push({ kana: t.kana, opts: ['ltu', 'xtu'] });
        }
        continue;
      }

      if (t.type === 'n') {
        let opts;
        if (!nx || nx.type === 'n') opts = ['nn', 'xn'];
        else if (nx.type === 'sokuon') opts = ['n', 'nn', 'xn'];
        else {
          const heads = nx.opts.map((o) => o[0]);
          opts = heads.some((h) => 'aiueoyn'.includes(h)) ? ['nn', 'xn'] : ['n', 'nn', 'xn'];
        }
        out.push({ kana: t.kana, opts });
        continue;
      }

      out.push({ kana: t.kana, opts: t.opts });
    }
    return out;
  }

  function tryToken(tok, cur, ch) {
    const s = cur + ch;
    if (!tok.opts.some((o) => o.startsWith(s))) return null;
    const exact = tok.opts.includes(s);
    const longer = tok.opts.some((o) => o.length > s.length && o.startsWith(s));
    return { s, complete: exact && !longer };
  }

  function createJP(kana) {
    const tokens = buildTokens(kana);
    if (!tokens.length) throw new Error('empty kana: ' + kana);
    let ti = 0;
    let typed = '';
    const chosen = [];

    function press(ch) {
      if (ti >= tokens.length) return 'done';
      const r = tryToken(tokens[ti], typed, ch);
      if (r) {
        typed = r.s;
        if (r.complete) {
          chosen[ti] = typed; ti++; typed = '';
          if (ti >= tokens.length) return 'done';
        }
        return 'ok';
      }
      // 「n」だけで確定できる「ん」の次の文字を打ったとき
      if (typed && tokens[ti].opts.includes(typed) && ti + 1 < tokens.length) {
        const r2 = tryToken(tokens[ti + 1], '', ch);
        if (r2) {
          chosen[ti] = typed; ti++;
          typed = r2.s;
          if (r2.complete) {
            chosen[ti] = typed; ti++; typed = '';
            if (ti >= tokens.length) return 'done';
          }
          return 'ok';
        }
      }
      return 'miss';
    }

    function view() {
      const done = chosen.slice(0, ti).join('') + typed;
      let rest = '';
      if (ti < tokens.length) {
        const t = tokens[ti];
        const cand = t.opts.find((o) => o.startsWith(typed)) || t.opts[0];
        rest = cand.slice(typed.length);
        for (let i = ti + 1; i < tokens.length; i++) rest += tokens[i].opts[0];
      }
      return { done, rest, kana: tokens.map((t) => t.kana), ti };
    }

    return { press, view };
  }

  function createEN(text) {
    const chars = Array.from(text);
    let i = 0;
    function press(ch) {
      if (i >= chars.length) return 'done';
      if (ch.toLowerCase() === chars[i].toLowerCase()) {
        i++;
        return i >= chars.length ? 'done' : 'ok';
      }
      return 'miss';
    }
    function view() {
      return { done: chars.slice(0, i).join(''), rest: chars.slice(i).join(''), kana: null, ti: 0 };
    }
    return { press, view };
  }

  function createEngine(word) {
    return word.type === 'jp' ? createJP(word.k) : createEN(word.w);
  }

  const api = { createEngine, createJP, createEN, buildTokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TypingEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
