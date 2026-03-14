require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'static')));

// ─── DB Init ─────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS utenti (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      nome          TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS turni (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES utenti(id),
      data                DATE NOT NULL,
      turno               TEXT,
      ora_inizio          TEXT,
      ora_fine            TEXT,
      ore_diurne          REAL DEFAULT 0,
      ore_notturne        REAL DEFAULT 0,
      strao_diurno        REAL DEFAULT 0,
      strao_notturno      REAL DEFAULT 0,
      strao_fest_diurno   REAL DEFAULT 0,
      strao_fest_notturno REAL DEFAULT 0,
      reperibilita        TEXT,
      note                TEXT,
      UNIQUE(user_id, data)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS impostazioni (
      user_id INTEGER NOT NULL REFERENCES utenti(id),
      chiave  TEXT NOT NULL,
      valore  TEXT,
      PRIMARY KEY (user_id, chiave)
    )
  `);
  console.log('✅ DB pronto');
}

// ─── Config turni ─────────────────────────────────────────────────────────────
const TURNO_ORARI = {
  M:  [7*60,  15*60],
  M1: [8*60,  16*60],
  M2: [9*60,  17*60],
  M3: [11*60, 19*60],
  P:  [15*60, 23*60],
  N:  [23*60, 7*60],
};

const TURNI_CONFIG = {
  M:   { lavorativo: true,  label: 'Mattino 7-15',     colore: '#3B82F6' },
  M1:  { lavorativo: true,  label: 'Mattino 1 8-16',   colore: '#2563EB' },
  M2:  { lavorativo: true,  label: 'Mattino 2 9-17',   colore: '#1D4ED8' },
  M3:  { lavorativo: true,  label: 'Mattino 3 11-19',  colore: '#1E40AF' },
  P:   { lavorativo: true,  label: 'Pomeriggio 15-23', colore: '#F59E0B' },
  N:   { lavorativo: true,  label: 'Notte 23-7',       colore: '#6366F1' },
  RC:  { lavorativo: false, label: 'Riposo Comp.',     colore: '#10B981' },
  R:   { lavorativo: false, label: 'Riposo Dom.',      colore: '#EF4444' },
  ROT: { lavorativo: false, label: 'Rid. Orario',      colore: '#8B5CF6' },
  RF:  { lavorativo: false, label: 'Riposo Festivo',   colore: '#EC4899' },
  MAL: { lavorativo: false, label: 'Malattia',         colore: '#F97316' },
  F:   { lavorativo: false, label: 'Ferie',            colore: '#14B8A6' },
  'F-P': { lavorativo: false, label: 'Ferie su P',     colore: '#84CC16' },
  'F-N': { lavorativo: false, label: 'Ferie su N',     colore: '#06B6D4' },
};

const FESTIVITA = new Set([
  '2025-01-01','2025-01-06','2025-04-20','2025-04-21','2025-04-25',
  '2025-05-01','2025-06-02','2025-08-15','2025-11-01','2025-12-07',
  '2025-12-08','2025-12-25','2025-12-26',
  '2026-01-01','2026-01-06','2026-04-05','2026-04-06','2026-04-25',
  '2026-05-01','2026-06-02','2026-08-15','2026-11-01','2026-12-07',
  '2026-12-08','2026-12-25','2026-12-26',
  '2027-01-01','2027-01-06','2027-03-28','2027-03-29','2027-04-25',
  '2027-05-01','2027-06-02','2027-08-15','2027-11-01','2027-12-07',
  '2027-12-08','2027-12-25','2027-12-26',
]);

const IMPOSTAZIONI_DEFAULTS = {
  retribuzione_totale:     2573.39,
  tariffa_nott_50:         7.53974,
  tariffa_dom:             8.39811,
  tariffa_nott_ord:        5.27782,
  tariffa_strao_fer_d:     22.61922,
  tariffa_strao_fer_n:     24.12716,
  tariffa_strao_fest_d:    24.12716,
  tariffa_strao_fest_n:    24.36517,
  tariffa_rep_feriale:     15.26,
  tariffa_rep_semifestiva: 32.99,
  tariffa_rep_festiva:     53.13,
  indennita_turno:         279.66,
  trattenuta_sindacato:    18.86,
  trattenuta_regionale:    50.00,
  trattenuta_pegaso:       33.90,
  aliquota_inps:           9.19,
  detrazioni_annue:        1955.00,
};

// ─── Calcolo ore ──────────────────────────────────────────────────────────────
function splitDiurnoNotturno(start, end) {
  if (end <= start) end += 1440;
  const notturni = [[0,360],[1200,1440],[1440,1800]];
  let nott = 0;
  for (const [ns,ne] of notturni) {
    const s = Math.max(start,ns), e = Math.min(end,ne);
    if (e > s) nott += e - s;
  }
  const tot = end - start;
  return [Math.round((tot-nott)/60*100)/100, Math.round(nott/60*100)/100];
}

function toMin(s) {
  if (!s) return null;
  const [h,m] = s.split(':').map(Number);
  return h*60 + m;
}

function calcolaOre(turno, oraInizio, oraFine) {
  const r = { ore_diurne:0, ore_notturne:0, strao_diurno:0, strao_notturno:0, strao_fest_diurno:0, strao_fest_notturno:0 };
  const effIni = toMin(oraInizio), effFin = toMin(oraFine);
  const std = TURNO_ORARI[turno];

  if (turno === 'R') {
    if (effIni !== null && effFin !== null) {
      const [d,n] = splitDiurnoNotturno(effIni, effFin);
      r.strao_fest_diurno = d; r.strao_fest_notturno = n;
    }
    return r;
  }
  if (turno === 'RC') {
    if (effIni !== null && effFin !== null) {
      const [d,n] = splitDiurnoNotturno(effIni, effFin);
      r.strao_diurno = d; r.strao_notturno = n;
    }
    return r;
  }
  if (!std) {
    if (effIni !== null && effFin !== null) {
      const [d,n] = splitDiurnoNotturno(effIni, effFin);
      r.strao_diurno = d; r.strao_notturno = n;
    }
    return r;
  }

  const [stdIni, stdFin] = std;
  if (effIni === null && effFin === null) {
    const [d,n] = splitDiurnoNotturno(stdIni, stdFin);
    r.ore_diurne = d; r.ore_notturne = n;
    return r;
  }

  const ini = effIni ?? stdIni, fin = effFin ?? stdFin;
  const stdFinN = stdFin > stdIni ? stdFin : stdFin + 1440;
  const finN    = fin   > ini    ? fin   : fin + 1440;

  const ordIni = Math.max(ini, stdIni), ordFin = Math.min(finN, stdFinN);
  if (ordFin > ordIni) { const [d,n]=splitDiurnoNotturno(ordIni,ordFin); r.ore_diurne+=d; r.ore_notturne+=n; }
  if (ini < stdIni)    { const [d,n]=splitDiurnoNotturno(ini,stdIni);    r.strao_diurno+=d; r.strao_notturno+=n; }
  if (finN > stdFinN)  { const [d,n]=splitDiurnoNotturno(stdFinN,finN);  r.strao_diurno+=d; r.strao_notturno+=n; }
  return r;
}

function calcolaTipoReperibilita(turno, dataStr) {
  if (turno === 'RC') return 'semifestiva';
  if (turno === 'R' || FESTIVITA.has(dataStr)) return 'festiva';
  if (TURNI_CONFIG[turno]?.lavorativo) return 'feriale';
  return '';
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non autorizzato' });
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

async function getUserSettings(userId) {
  const rows = await pool.query('SELECT chiave, valore FROM impostazioni WHERE user_id=$1', [userId]);
  const cfg = { ...IMPOSTAZIONI_DEFAULTS };
  for (const r of rows.rows) cfg[r.chiave] = parseFloat(r.valore);
  return cfg;
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password, nome } = req.body;
  if (!username || username.length < 3) return res.status(400).json({ detail: 'Username troppo corto (min 3 caratteri)' });
  if (!password || password.length < 6) return res.status(400).json({ detail: 'Password troppo corta (min 6 caratteri)' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO utenti (username, nome, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [username.toLowerCase().trim(), nome || username, hash]
    );
    const token = jwt.sign({ id: result.rows[0].id, username }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ access_token: token, username });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ detail: 'Username già esistente' });
    res.status(500).json({ detail: 'Errore server' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM utenti WHERE username=$1', [username?.toLowerCase().trim()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ detail: 'Credenziali non corrette' });
  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
  res.json({ access_token: token, username: user.username, nome: user.nome });
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));

// ─── API routes ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const out = {};
  for (const [k,v] of Object.entries(TURNI_CONFIG)) {
    const orari = TURNO_ORARI[k];
    out[k] = { ...v, std_ini: orari?.[0] ?? null, std_fin: orari?.[1] ?? null };
  }
  res.json(out);
});

app.get('/api/festivita', (req, res) => res.json([...FESTIVITA]));

app.get('/api/turni/:anno/:mese', authMiddleware, async (req, res) => {
  const { anno, mese } = req.params;
  const rows = await pool.query(
    `SELECT * FROM turni WHERE user_id=$1 AND to_char(data,'YYYY-MM')=$2`,
    [req.user.id, `${anno}-${mese.padStart(2,'0')}`]
  );
  const result = {};
  for (const r of rows.rows) result[r.data.toISOString().slice(0,10)] = r;
  res.json(result);
});

app.post('/api/turni/:data', authMiddleware, async (req, res) => {
  const { data } = req.params;
  const { turno, ora_inizio, ora_fine, reperibilita, note } = req.body;
  const ore = calcolaOre(turno || '', ora_inizio, ora_fine);
  const tipoRep = reperibilita ? calcolaTipoReperibilita(turno || '', data) : '';
  await pool.query(`
    INSERT INTO turni (user_id,data,turno,ora_inizio,ora_fine,
      ore_diurne,ore_notturne,strao_diurno,strao_notturno,
      strao_fest_diurno,strao_fest_notturno,reperibilita,note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (user_id,data) DO UPDATE SET
      turno=EXCLUDED.turno, ora_inizio=EXCLUDED.ora_inizio, ora_fine=EXCLUDED.ora_fine,
      ore_diurne=EXCLUDED.ore_diurne, ore_notturne=EXCLUDED.ore_notturne,
      strao_diurno=EXCLUDED.strao_diurno, strao_notturno=EXCLUDED.strao_notturno,
      strao_fest_diurno=EXCLUDED.strao_fest_diurno, strao_fest_notturno=EXCLUDED.strao_fest_notturno,
      reperibilita=EXCLUDED.reperibilita, note=EXCLUDED.note
  `, [req.user.id, data, turno, ora_inizio, ora_fine,
      ore.ore_diurne, ore.ore_notturne, ore.strao_diurno, ore.strao_notturno,
      ore.strao_fest_diurno, ore.strao_fest_notturno, tipoRep || null, note]);
  res.json({ ok: true, ...ore, tipo_reperibilita: tipoRep });
});

app.delete('/api/turni/:data', authMiddleware, async (req, res) => {
  await pool.query('DELETE FROM turni WHERE user_id=$1 AND data=$2', [req.user.id, req.params.data]);
  res.json({ ok: true });
});

app.get('/api/riepilogo/:anno', authMiddleware, async (req, res) => {
  const rows = await pool.query(
    `SELECT * FROM turni WHERE user_id=$1 AND EXTRACT(YEAR FROM data)=$2`,
    [req.user.id, req.params.anno]
  );
  const mesi = {};
  for (let m=1; m<=12; m++) mesi[m] = {
    ore_diurne:0, ore_notturne:0, strao_diurno:0, strao_notturno:0,
    strao_fest_diurno:0, strao_fest_notturno:0,
    reperibilita_feriale:0, reperibilita_semifestiva:0, reperibilita_festiva:0,
    mal:0, ferie:0, rc:0, r:0, rot:0, rf:0,
  };
  for (const r of rows.rows) {
    const m = new Date(r.data).getMonth() + 1;
    const t = r.turno || '';
    for (const c of ['ore_diurne','ore_notturne','strao_diurno','strao_notturno','strao_fest_diurno','strao_fest_notturno'])
      mesi[m][c] += r[c] || 0;
    if (t==='MAL') mesi[m].mal++;
    if (['F','F-P','F-N'].includes(t)) mesi[m].ferie++;
    if (t==='RC') mesi[m].rc++;
    if (t==='R')  mesi[m].r++;
    if (t==='ROT') mesi[m].rot++;
    if (t==='RF')  mesi[m].rf++;
    if (r.reperibilita==='feriale')       mesi[m].reperibilita_feriale++;
    else if (r.reperibilita==='semifestiva') mesi[m].reperibilita_semifestiva++;
    else if (r.reperibilita==='festiva')     mesi[m].reperibilita_festiva++;
  }
  res.json(mesi);
});

app.get('/api/impostazioni', authMiddleware, async (req, res) => {
  res.json(await getUserSettings(req.user.id));
});

app.post('/api/impostazioni', authMiddleware, async (req, res) => {
  const { valori } = req.body;
  for (const [k,v] of Object.entries(valori)) {
    await pool.query(
      'INSERT INTO impostazioni (user_id,chiave,valore) VALUES ($1,$2,$3) ON CONFLICT (user_id,chiave) DO UPDATE SET valore=$3',
      [req.user.id, k, String(v)]
    );
  }
  res.json({ ok: true });
});

app.get('/api/bustapaga/:anno/:mese', authMiddleware, async (req, res) => {
  const anno = parseInt(req.params.anno), mese = parseInt(req.params.mese);
  const mesePrec = mese > 1 ? mese - 1 : 12;
  const annoPrec = mese > 1 ? anno : anno - 1;

  const rows = await pool.query(
    `SELECT * FROM turni WHERE user_id=$1 AND to_char(data,'YYYY-MM')=$2`,
    [req.user.id, `${annoPrec}-${String(mesePrec).padStart(2,'0')}`]
  );
  const cfg = await getUserSettings(req.user.id);

  const tot = { ore_diurne:0, ore_notturne:0, strao_diurno:0, strao_notturno:0,
                strao_fest_diurno:0, strao_fest_notturno:0,
                rep_feriale:0, rep_semifestiva:0, rep_festiva:0, domeniche:0, giorni_lavoro:0 };

  for (const r of rows.rows) {
    const t = r.turno || '';
    if (TURNI_CONFIG[t]?.lavorativo) {
      tot.giorni_lavoro++;
      if (new Date(r.data).getDay() === 0) tot.domeniche++;
    }
    for (const c of ['ore_diurne','ore_notturne','strao_diurno','strao_notturno','strao_fest_diurno','strao_fest_notturno'])
      tot[c] += r[c] || 0;
    if (r.reperibilita==='feriale')       tot.rep_feriale++;
    else if (r.reperibilita==='semifestiva') tot.rep_semifestiva++;
    else if (r.reperibilita==='festiva')     tot.rep_festiva++;
  }

  const mesiIt = ['','Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
  const refPrec = `${mesiIt[mesePrec]}/${String(annoPrec).slice(-2)}`;
  const refCorr = `${mesiIt[mese]}/${String(anno).slice(-2)}`;

  const vociComp = [
    { voce:'Retribuzione totale mensile',   ref:refCorr, qty:null,                        tariffa:null,                         importo:cfg.retribuzione_totale },
    { voce:'Indennità turno X',             ref:refCorr, qty:null,                        tariffa:null,                         importo:cfg.indennita_turno },
    { voce:'Ore notturne in turno 50%',     ref:refPrec, qty:tot.ore_notturne,            tariffa:cfg.tariffa_nott_50,          importo:+(tot.ore_notturne       *cfg.tariffa_nott_50).toFixed(2) },
    { voce:'Indennità lavoro domenicale',   ref:refPrec, qty:tot.domeniche*8,             tariffa:cfg.tariffa_dom,              importo:+(tot.domeniche*8        *cfg.tariffa_dom).toFixed(2) },
    { voce:'Lavoro ordinario notte',        ref:refPrec, qty:tot.ore_notturne,            tariffa:cfg.tariffa_nott_ord,         importo:+(tot.ore_notturne       *cfg.tariffa_nott_ord).toFixed(2) },
    { voce:'Str. Feriale Diurno 150%',      ref:refPrec, qty:tot.strao_diurno,            tariffa:cfg.tariffa_strao_fer_d,      importo:+(tot.strao_diurno       *cfg.tariffa_strao_fer_d).toFixed(2) },
    { voce:'Str. Feriale Notturno 160%',    ref:refPrec, qty:tot.strao_notturno,          tariffa:cfg.tariffa_strao_fer_n,      importo:+(tot.strao_notturno     *cfg.tariffa_strao_fer_n).toFixed(2) },
    { voce:'Str. Festivo Diurno 160%',      ref:refPrec, qty:tot.strao_fest_diurno,       tariffa:cfg.tariffa_strao_fest_d,     importo:+(tot.strao_fest_diurno  *cfg.tariffa_strao_fest_d).toFixed(2) },
    { voce:'Str. Festivo Notturno 175%',    ref:refPrec, qty:tot.strao_fest_notturno,     tariffa:cfg.tariffa_strao_fest_n,     importo:+(tot.strao_fest_notturno*cfg.tariffa_strao_fest_n).toFixed(2) },
    { voce:'Ind. Reperibilità Feriale',     ref:refPrec, qty:tot.rep_feriale,             tariffa:cfg.tariffa_rep_feriale,      importo:+(tot.rep_feriale        *cfg.tariffa_rep_feriale).toFixed(2) },
    { voce:'Ind. Reperibilità Semifestiva', ref:refPrec, qty:tot.rep_semifestiva,         tariffa:cfg.tariffa_rep_semifestiva,  importo:+(tot.rep_semifestiva    *cfg.tariffa_rep_semifestiva).toFixed(2) },
    { voce:'Ind. Reperibilità Festiva',     ref:refPrec, qty:tot.rep_festiva,             tariffa:cfg.tariffa_rep_festiva,      importo:+(tot.rep_festiva        *cfg.tariffa_rep_festiva).toFixed(2) },
  ];

  const totComp = +vociComp.reduce((s,v) => s+v.importo, 0).toFixed(2);
  const inps    = +(totComp * cfg.aliquota_inps / 100).toFixed(2);
  const imponibileAnnuo = +((totComp - inps) * 12).toFixed(2);

  function irpefAnnua(r) {
    if (r<=0) return 0;
    let imp=0, res=r;
    for (const [soglia,aliq] of [[28000,.23],[22000,.35],[Infinity,.43]]) {
      const p=Math.min(res,soglia); imp+=p*aliq; res-=p; if(res<=0) break;
    }
    return +imp.toFixed(2);
  }
  const irpefLorda = irpefAnnua(imponibileAnnuo);
  const detr = cfg.detrazioni_annue;
  let detrazione = 0;
  if      (imponibileAnnuo <= 15000) detrazione = Math.max(detr, 690);
  else if (imponibileAnnuo <= 28000) detrazione = +(detr*(28000-imponibileAnnuo)/13000).toFixed(2);
  else if (imponibileAnnuo <= 50000) detrazione = +(658*(50000-imponibileAnnuo)/22000).toFixed(2);
  const irpefNetta   = +Math.max(0, irpefLorda-detrazione).toFixed(2);
  const irpefMensile = +(irpefNetta/12).toFixed(2);

  const vociTrat = [
    { voce:`Contributi INPS (${cfg.aliquota_inps}%)`, importo:inps,          calcolato:true },
    { voce:'IRPEF stimata mensile (2024)',             importo:irpefMensile,  calcolato:true },
    { voce:'Trattenuta sindacato (CISL)',              importo:cfg.trattenuta_sindacato },
    { voce:'Add. regionale trattenuta',               importo:cfg.trattenuta_regionale },
    { voce:'Contr. Prev. Compl. (Pegaso)',             importo:cfg.trattenuta_pegaso },
  ];
  const totTrat = +vociTrat.reduce((s,v) => s+v.importo, 0).toFixed(2);

  res.json({
    anno, mese, mese_prec:mesePrec, anno_prec:annoPrec,
    ore_totali:tot, voci_competenze:vociComp, voci_trattenute:vociTrat,
    tot_competenze:totComp, tot_trattenute:totTrat, netto:+(totComp-totTrat).toFixed(2),
    dettaglio_fiscale:{ imponibile_annuo_stimato:imponibileAnnuo, irpef_lorda_annua:irpefLorda,
                        detrazione_applicata:detrazione, irpef_netta_annua:irpefNetta,
                        inps_mensile:inps, irpef_mensile:irpefMensile },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server avviato su http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌ Errore connessione DB:', err.message);
  console.error('→ Verifica che DATABASE_URL nel file .env sia corretto');
  console.error('→ Verifica che la porta 15256 non sia bloccata dalla rete aziendale');
  process.exit(1);
});
