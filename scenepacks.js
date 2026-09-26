const ALL_PACKS = [
  { name: 'Lettuce', ratio: '1:1', links: [
    'https://mega.nz/file/H5Y1FI6A#tks4QryDboIzbzxmXiuERYwbVUCz-EvK3Ko5wM2zN24',
  ]},
  { name: 'Ashswagg', ratio: '1:1', links: [
    'https://mega.nz/file/3pAzSQhD#ZSe_eCdKtIOxVj3vIMDjTcao1IOEZIrMEPRTsZuxUEk',
  ]},
  { name: 'Boosfer', ratio: '16:9 / 1:1', links: [
    'https://mega.nz/file/DkZnAJjA#HD5V2wobsJMWxq0os-ag26nJwyyv5n0vbXLeaF_F2ls',
    'https://mega.nz/file/mlIH0RQL#F9IVQPE3VPKM5xv-0R92jP4a2M2d7xFIzXgYmoqEv0E',
  ]},
  { name: 'Eggchan', ratio: '1:1', links: [
    'https://mega.nz/file/axAzwRQT#X91RLnIs21QVpOGP4VQtCBNIOL1_c_gppfMWMplxIv4',
  ]},
  { name: 'Clownpierce', ratio: '16:9 / 1:1', links: [
    'https://mega.nz/file/ntAmhDza#9hufYAazzlrEtwmrWimvA3ympHwqGMIls2sXW7j5V-w',
    'https://mega.nz/file/vgZQ3YjT#qD_O9q-wEfUXU0flNGNfOzwGLDkX0KFtTkJkX54L020',
  ]},
  { name: 'Jaden', ratio: '16:9 / 1:1', links: [
    'https://mega.nz/file/fwRy1BRD#L38nceFaJsK4xTcGG9WA7gItcO-64ZS65i91tn7qUSg',
    'https://mega.nz/file/6pxElQqK#6o6GgqkUZbec3mOKGPTEKhoCGjo90ki7bJwN1nwcHDU',
  ]},
  { name: 'Unstable SMP Scenery', ratio: '16:9', links: [
    'https://mega.nz/file/msoB0DBK#6KkXlTdo50iy6siCAHcugOPAwlZoUJumYvD83v2MV5Q',
  ]},
  { name: 'Theo', ratio: '1:1', links: [
    'https://mega.nz/file/z1YlUBQb#Tq7ZSyZl3PhRXWaxjYBLjYuXtXEEYIbKuFx6c3zG_Dg',
  ]},
  { name: 'Swight', ratio: '16:9 / 1:1', links: [
    'https://mega.nz/file/jlIFXCTL#DBSr-MwcRFcUXsoYEfarKjYrmxbQ5YcC4nj-DqHn0r0',
    'https://mega.nz/file/2pwFQDgS#auzJO5SB6mfoewD7A9Swfc_aIj8CIZ4djoKUMVUTKHg',
  ]},
  { name: 'Parrot', ratio: '1:1', links: [
    'https://mega.nz/file/n05SVCwK#1f80SlVWBJcuZY7UZAUjYq3JDLUFyvgu4bzjNJWOt9A',
  ]},
  { name: 'Wifies', ratio: '1:1', links: [
    'https://mega.nz/file/G8JGCbSI#ssT9PEwk80Z33nNRj1q6iaVMqVC4i6Pk2iNC7ddp9rs',
  ]},
  { name: 'Minute', ratio: '1:1', links: [
    'https://mega.nz/file/PoIBRAiY#oKlsNIY_D7Rsv4CeHqZwBZTBrez7gdb-rDVZLE-s3Hk',
  ]},
  { name: 'ItzRealMe', ratio: '1:1', links: [
    'https://mega.nz/file/ekQ1UB7a#vdIS9k9RNeFUO5X2bviSYyi2eG_WCVcbZ5NGuZSuIbM',
  ]},
  { name: 'Zam', ratio: '16:9 / 1:1', links: [
    'https://mega.nz/file/b0g3wIgQ#subZkdS0Drzl10gTYkM1WvaCHnTTogtxcehQ34rtwVw',
    'https://mega.nz/file/vxgjzYQS#-QYozs7aGSAuV2pj2pCQwvrJ5vnG6Pc8sTkDbk6Cfn4',
  ]},
  { name: 'Flamefrags', ratio: '1:1 (Alternate Version)', links: [
    'https://mega.nz/file/31QCmDxI#BMdEWDxQiIeduGDWFrOUssyWrHtGRmPIQdASHUZkdJk',
  ]},
  { name: 'Spoke', ratio: '1:1 (Alternate Version)', links: [
    'https://mega.nz/file/WgQxkZ5Y#6oBf_K6kZ6zAd3d3xqnUTUtROgWdi7plAcNamN3_6Hw',
  ]},
  { name: 'Wemmbu', ratio: '1:1 / 16:9 (Alternate Versions)', links: [
    'https://mega.nz/file/mhoS1KpY#R2Ou7IV4rErr9Kualu4TL_MOE03W74yxk_Ta8ydhiDA',
    'https://mega.nz/file/y0BFTJQR#_A5MZ697B6hVo3lW-MKIHEyLceASD_DvHlmi7QKMhIM',
  ]},
];

const STOPWORDS = new Set([
  'scenepack', 'scenery', 'pack', 'packs', 'link', 'links', 'download',
  'do', 'ka', 'de', 'dedo', 'me', 'mein', 'ko', 'hai', 'please', 'plz',
]);

function normalize(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(str) {
  const words = String(str).toLowerCase().match(/[a-z0-9:]+/g) || [];
  return words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function searchPacks(query) {
  const raw = String(query || '').trim();
  const q = normalize(raw);

  if (!q || ['list', 'help', 'sab', 'sare', 'saare'].includes(q)) {
    return { type: 'list', packs: ALL_PACKS };
  }

  let exact = ALL_PACKS.find((p) => normalize(p.name) === q || (normalize(p.name) + normalize(p.ratio)) === q);
  if (exact) return { type: 'one', packs: [exact] };

  if (q.length >= 3) {
    const partial = ALL_PACKS.filter((p) => {
      const n = normalize(p.name);
      return n.includes(q) || q.includes(n);
    });
    if (partial.length === 1) return { type: 'one', packs: partial };
    if (partial.length > 1) return { type: 'many', packs: partial };
  }

  const queryTokens = tokens(raw);
  if (queryTokens.length) {
    const byWord = ALL_PACKS.filter((p) => {
      const nameWords = p.name.toLowerCase().split(/\s+/);
      return queryTokens.some((t) =>
        nameWords.some((w) => w === t || w.startsWith(t) || t.startsWith(w))
      );
    });
    if (byWord.length === 1) return { type: 'one', packs: byWord };
    if (byWord.length > 1) return { type: 'many', packs: byWord };
  }

  return { type: 'none', packs: [], wordCount: raw.split(/\s+/).length };
}

module.exports = { ALL_PACKS, searchPacks, normalize };
