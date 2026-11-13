/**
 * THE TATIANA EDIT — OUTREACH BUDDY (Google Apps Script)
 * Notion = CRM, Gmail = verzending. Geen AI-sessie nodig.
 *
 * VEILIGHEIDSREGELS (hard ingebouwd):
 *  - DRY_RUN staat standaard AAN: er wordt niets verzonden en niets in Notion gewijzigd.
 *  - Eerste pitch vertrekt alleen als: Status = Concept klaar / Klaar voor verzending,
 *    "Automatisch verzenden goedgekeurd" = aan, "Verzending toegestaan" = aan,
 *    Verzendwijze = Automatisch, Niet meer contacteren = uit, geldig e-mailadres,
 *    onderwerp + eerste bericht ingevuld, Mailthread en Eerste verzending leeg.
 *  - Vóór elke verzending: rij vergrendelen in Notion + Gmail doorzoeken op eerdere mail
 *    naar dat adres of domein. Gevonden = NIET verzenden.
 *  - Na verzending: meteen terugschrijven (3 pogingen); lukt dat niet, dan onthoudt het script
 *    dit duurzaam en probeert het de volgende run opnieuw. Rij blijft vergrendeld.
 *  - Onbekende fout = rij blijft vergrendeld met FOUT-melding en komt in je dagrapport.
 *  - Follow-ups: max 2, pas 4 kalenderdagen na de ECHTE Gmail-verzenddatum, alleen in
 *    de bestaande thread, nooit bij antwoord, afwijzing, bounce of "Niet meer contacteren".
 */

// ====== INSTELLINGEN ======
var CFG = {
  DRY_RUN: true,                 // zet op false pas na de dry-run-controle
  DATA_SOURCE_ID: '32a5fb7f-bced-4e2c-b926-7f1ec94afd17',
  NOTION_VERSION: '2025-09-03',
  SENDER_NAME: 'Tatiana | The Tatiana Edit',
  REPORT_TO: Session.getActiveUser().getEmail(),
  DAILY_CAP_FIRST: 50,           // nieuwe pitches per werkdag
  BATCH_SIZE: 8,                 // per run (houdt de run onder de 6 minuten)
  PAUSE_MS: 25000,               // pauze tussen mails
  FOLLOWUP_DAYS: 4,
  MAX_FOLLOWUPS: 2,
  WINDOW_START: 9, WINDOW_END: 17, // Brussels-uren
  TZ: 'Europe/Brussels',
  RUN_BUDGET_MS: 4.5 * 60 * 1000
};

// ====== TRIGGERS ======
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runQueue').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(17).inTimezone(CFG.TZ).create();
}

// ====== HOOFDRUN ======
function runQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { log_('Vorige run draait nog, overslaan.'); return; }
  try {
    if (!inWindow_()) { return; }
    var t0 = Date.now();
    flushPendingWritebacks_();
    processBounces_();
    processFollowups_(t0);
    processFirstPitches_(t0);
  } catch (e) {
    alert_('Onverwachte fout in runQueue: ' + e);
  } finally {
    lock.releaseLock();
  }
}

function inWindow_() {
  var now = new Date();
  var day = Number(Utilities.formatDate(now, CFG.TZ, 'u')); // 1=ma ... 7=zo
  var hr = Number(Utilities.formatDate(now, CFG.TZ, 'H'));
  return day <= 5 && hr >= CFG.WINDOW_START && hr < CFG.WINDOW_END;
}

// ====== EERSTE PITCHES ======
function processFirstPitches_(t0) {
  var sentToday = getCounter_('first');
  var room = CFG.DAILY_CAP_FIRST - sentToday;
  if (room <= 0) { return; }
  var filter = { and: [
    { or: [ sel_('Status', 'Concept klaar'), sel_('Status', 'Klaar voor verzending') ] },
    chk_('Automatisch verzenden goedgekeurd', true),
    chk_('Verzending toegestaan', true),
    chk_('Niet meer contacteren', false),
    sel_('Verzendwijze', 'Automatisch'),
    sel_('Kanaal', 'E-mail'),
    { property: 'Mailthread', url: { is_empty: true } },
    { property: 'Eerste verzending', date: { is_empty: true } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'VERGRENDELD' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'FOUT' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'GEBLOKKEERD' } }
  ]};
  var rows = queryAll_(filter, Math.min(room, CFG.BATCH_SIZE));
  rows.forEach(function (page) {
    if (Date.now() - t0 > CFG.RUN_BUDGET_MS) { return; }
    sendFirst_(page);
  });
}

function sendFirst_(page) {
  var id = page.id;
  var brand = txt_(page, 'Merk');
  var to = (page.properties['E-mail'].email || '').trim();
  var subject = txt_(page, 'Onderwerp');
  var body = txt_(page, 'Eerste bericht');

  var problem = validate_(page, to, subject, body);
  if (problem) { block_(id, brand, problem); return; }

  // 1. Duplicaatcontrole in Gmail (adres + domein)
  var domain = to.split('@')[1];
  var prior = GmailApp.search('in:sent (to:' + to + ' OR to:@' + domain + ')', 0, 1);
  if (prior.length) {
    block_(id, brand, 'Gmail toont al eerder contact met ' + to + ' of @' + domain + ' (thread ' + prior[0].getId() + '). Handmatig controleren.');
    return;
  }

  if (CFG.DRY_RUN) {
    log_('[DRY RUN] zou verzenden: ' + brand + ' -> ' + to + ' | ' + subject);
    return;
  }

  // 2. Vergrendelen vóór verzending
  var runId = Utilities.getUuid().slice(0, 8);
  if (!updatePage_(id, { 'Verzendcontrole': rt_('VERGRENDELD ' + runId + ' ' + iso_(new Date())) })) {
    log_('Kon ' + brand + ' niet vergrendelen, NIET verzonden.');
    return;
  }

  // 3. Verzenden
  var msg;
  try {
    msg = GmailApp.createDraft(to, subject, body, { name: CFG.SENDER_NAME }).send();
  } catch (e) {
    updatePage_(id, { 'Verzendcontrole': rt_('FOUT bij verzenden ' + iso_(new Date()) + ': ' + String(e).slice(0, 300) + ' — controleer Gmail vóór je dit wist.') });
    alert_('Verzendfout bij ' + brand + ': ' + e);
    return;
  }
  var thread = msg.getThread();
  var sentAt = msg.getDate();
  var props = {
    'Status': { select: { name: 'Verzonden' } },
    'Eerste verzending': { date: { start: iso_(sentAt) } },
    'Laatste contact': { date: { start: iso_(sentAt) } },
    'Mailthread': { url: 'https://mail.google.com/mail/u/0/#all/' + thread.getId() },
    'Aantal follow-ups': { number: 0 },
    'Follow-upstatus': { select: { name: 'Wacht op antwoord' } },
    'Volgende actie': { date: { start: addDays_(sentAt, CFG.FOLLOWUP_DAYS) } },
    'Verzendcontrole': rt_('VERZONDEN — Gmail thread ' + thread.getId() + '; Gmail-tijd ' + iso_(sentAt) + '. Verzonden is geen bewijs van aflevering of lezen.')
  };
  bumpCounter_('first');
  if (!updateWithRetry_(id, props)) { queueWriteback_(id, props); }
  Utilities.sleep(CFG.PAUSE_MS);
}

function validate_(page, to, subject, body) {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return 'Ongeldig of leeg e-mailadres';
  if (/^(no-?reply|noreply|donotreply)@/i.test(to)) return 'No-reply adres';
  if (!subject || subject.length < 5) return 'Onderwerp ontbreekt';
  if (!body || body.length < 200) return 'Bericht ontbreekt of te kort';
  if (body.length > 2500) return 'Bericht te lang voor een eerste pitch';
  if (!txt_(page, 'Land of markt')) return 'Land of markt ontbreekt (taal te bevestigen)';
  var taal = page.properties['Taal'] && page.properties['Taal'].select ? page.properties['Taal'].select.name : '';
  if (!taal || taal === 'Taal te bevestigen') return 'Taal te bevestigen (veld Taal leeg)';
  if (/\[[^\]]*\]|\{\{|TODO|XXX/.test(body + subject)) return 'Placeholder in tekst';
  return null;
}

function block_(id, brand, reason) {
  log_('GEBLOKKEERD ' + brand + ': ' + reason);
  if (CFG.DRY_RUN) return;
  updatePage_(id, { 'Verzendcontrole': rt_('GEBLOKKEERD ' + iso_(new Date()) + ': ' + reason) });
}

// ====== FOLLOW-UPS ======
function processFollowups_(t0) {
  var today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var filter = { and: [
    { or: [ sel_('Status', 'Verzonden'), sel_('Status', 'Follow-up 1 verzonden') ] },
    sel_('Follow-upstatus', 'Wacht op antwoord'),
    sel_('Verzendwijze', 'Automatisch'),
    chk_('Niet meer contacteren', false),
    { property: 'Mailthread', url: { is_not_empty: true } },
    { property: 'Volgende actie', date: { on_or_before: today } },
    { property: 'Aantal follow-ups', number: { less_than: CFG.MAX_FOLLOWUPS } }
  ]};
  queryAll_(filter, CFG.BATCH_SIZE).forEach(function (page) {
    if (Date.now() - t0 > CFG.RUN_BUDGET_MS) { return; }
    sendFollowup_(page);
  });
}

function sendFollowup_(page) {
  var id = page.id, brand = txt_(page, 'Merk');
  var n = page.properties['Aantal follow-ups'].number || 0;
  var text = txt_(page, n === 0 ? 'Follow-up 1' : 'Follow-up 2');
  var m = (page.properties['Mailthread'].url || '').match(/([0-9a-f]{12,})$/i);
  if (!m || !text) { log_('Follow-up overgeslagen ' + brand + ': thread of tekst ontbreekt'); return; }
  var thread = GmailApp.getThreadById(m[1]);
  if (!thread) { block_(id, brand, 'Gmail-thread niet gevonden'); return; }

  var me = Session.getActiveUser().getEmail().toLowerCase();
  var msgs = thread.getMessages();
  var lastMine = null;
  for (var i = 0; i < msgs.length; i++) {
    var from = msgs[i].getFrom().toLowerCase();
    if (from.indexOf(me) === -1) {
      // antwoord (of bounce) van iemand anders: stoppen
      var bounce = /mailer-daemon|postmaster/.test(from);
      if (!CFG.DRY_RUN) {
        updatePage_(id, {
          'Follow-upstatus': { select: { name: 'Gestopt' } },
          'Status': bounce ? { select: { name: 'Verzonden' } } : { select: { name: 'Reactie ontvangen' } },
          'Reactiecategorie': bounce ? { select: { name: 'Afleverprobleem' } } : undefined,
          'Laatste reactie': rt_(iso_(msgs[i].getDate()) + ' — ' + msgs[i].getFrom().slice(0, 80)),
          'Volgende stap': rt_('Antwoord lezen en zelf opvolgen')
        });
      }
      log_('Follow-up gestopt (antwoord/bounce) ' + brand);
      return;
    } else { lastMine = msgs[i]; }
  }
  if (!lastMine) { return; }
  var days = (Date.now() - lastMine.getDate().getTime()) / 86400000;
  if (days < CFG.FOLLOWUP_DAYS) { return; } // echte verzenddatum, niet de geplande

  if (CFG.DRY_RUN) { log_('[DRY RUN] zou follow-up ' + (n + 1) + ' sturen: ' + brand); return; }

  var runId = Utilities.getUuid().slice(0, 8);
  if (!updatePage_(id, { 'Verzendcontrole': rt_('VERGRENDELD FU' + (n + 1) + ' ' + runId + ' ' + iso_(new Date())) })) { return; }
  try {
    thread.reply(text, { name: CFG.SENDER_NAME });
  } catch (e) {
    updatePage_(id, { 'Verzendcontrole': rt_('FOUT follow-up ' + (n + 1) + ': ' + String(e).slice(0, 300)) });
    alert_('Follow-upfout bij ' + brand + ': ' + e);
    return;
  }
  var now = new Date();
  var done = n + 1;
  var props = {
    'Aantal follow-ups': { number: done },
    'Status': { select: { name: done === 1 ? 'Follow-up 1 verzonden' : 'Follow-up 2 verzonden' } },
    'Laatste contact': { date: { start: iso_(now) } },
    'Follow-upstatus': { select: { name: done >= CFG.MAX_FOLLOWUPS ? 'Gestopt' : 'Wacht op antwoord' } },
    'Volgende actie': done >= CFG.MAX_FOLLOWUPS ? { date: null } : { date: { start: addDays_(now, CFG.FOLLOWUP_DAYS) } },
    'Verzendcontrole': rt_('FOLLOW-UP ' + done + ' VERZONDEN ' + iso_(now) + ' in thread ' + m[1])
  };
  bumpCounter_('followup');
  if (!updateWithRetry_(id, props)) { queueWriteback_(id, props); }
  Utilities.sleep(CFG.PAUSE_MS);
}

// ====== BOUNCES ======
function processBounces_() {
  var threads = GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:3d', 0, 20);
  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      var body = msg.getPlainBody() || '';
      var found = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      found.forEach(function (addr) {
        if (addr.toLowerCase() === Session.getActiveUser().getEmail().toLowerCase() || /mailer-daemon|postmaster/i.test(addr)) return;
        var rows = queryAll_({ and: [
          { property: 'E-mail', email: { equals: addr } },
          { property: 'Reactiecategorie', select: { is_empty: true } }
        ]}, 1);
        if (rows.length && !CFG.DRY_RUN) {
          updatePage_(rows[0].id, {
            'Reactiecategorie': { select: { name: 'Afleverprobleem' } },
            'Follow-upstatus': { select: { name: 'Gestopt' } },
            'Volgende stap': rt_('Adres geeft bounce — nieuwe contactroute zoeken')
          });
        }
        if (rows.length) log_('Bounce verwerkt: ' + addr);
      });
    });
  });
}

// ====== DAGRAPPORT ======
function dailyReport() {
  var statuses = ['Te onderzoeken', 'Concept klaar', 'Klaar voor verzending', 'Verzonden', 'Follow-up 1 verzonden', 'Follow-up 2 verzonden', 'Reactie ontvangen', 'In gesprek', 'Deal', 'Afgesloten'];
  var lines = ['Outreach Buddy — dagrapport ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy'), CFG.DRY_RUN ? '(DRY RUN: er is niets verzonden)' : ''];
  statuses.forEach(function (s) {
    var n = queryAll_(sel_('Status', s), 500).length;
    lines.push(s + ': ' + n);
  });
  lines.push('');
  lines.push('Vandaag verzonden door het script — eerste pitches: ' + getCounter_('first') + ', follow-ups: ' + getCounter_('followup'));
  var errs = queryAll_({ or: [
    { property: 'Verzendcontrole', rich_text: { contains: 'FOUT' } },
    { property: 'Verzendcontrole', rich_text: { contains: 'VERGRENDELD' } },
    { property: 'Verzendcontrole', rich_text: { contains: 'GEBLOKKEERD' } }
  ]}, 100);
  lines.push('Aandacht nodig (fout/vergrendeld/geblokkeerd): ' + errs.length);
  errs.slice(0, 25).forEach(function (p) { lines.push(' - ' + txt_(p, 'Merk') + ': ' + txt_(p, 'Verzendcontrole').slice(0, 140)); });
  GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy dagrapport', lines.join('\n'));
}

function alert_(msg) {
  log_('ALERT ' + msg);
  try { GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy — aandacht nodig', msg); } catch (e) {}
}

// ====== NOTION ======
function nfetch_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  for (var attempt = 0; attempt < 4; attempt++) {
    var res = UrlFetchApp.fetch('https://api.notion.com' + path, {
      method: method, muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': CFG.NOTION_VERSION },
      payload: payload ? JSON.stringify(payload) : undefined
    });
    var code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (attempt + 1)); continue; }
    throw new Error('Notion ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  throw new Error('Notion bleef falen na 4 pogingen');
}

function queryAll_(filter, limit) {
  var out = [], cursor;
  do {
    var body = { filter: filter, page_size: Math.min(100, limit - out.length) };
    if (cursor) body.start_cursor = cursor;
    var r = nfetch_('post', '/v1/data_sources/' + CFG.DATA_SOURCE_ID + '/query', body);
    out = out.concat(r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

function updatePage_(id, props) {
  try {
    var clean = {};
    Object.keys(props).forEach(function (k) { if (props[k] !== undefined) clean[k] = props[k]; });
    nfetch_('patch', '/v1/pages/' + id, { properties: clean });
    return true;
  } catch (e) { log_('Update mislukt ' + id + ': ' + e); return false; }
}

function updateWithRetry_(id, props) {
  for (var i = 0; i < 3; i++) { if (updatePage_(id, props)) return true; Utilities.sleep(2000 * (i + 1)); }
  return false;
}

// Terugschrijf-wachtrij: verzonden maar Notion-update mislukt
function queueWriteback_(id, props) {
  var sp = PropertiesService.getScriptProperties();
  var q = JSON.parse(sp.getProperty('PENDING') || '{}');
  q[id] = props;
  sp.setProperty('PENDING', JSON.stringify(q));
  alert_('Verzonden maar Notion-update mislukt voor pagina ' + id + '. Script probeert opnieuw.');
}
function flushPendingWritebacks_() {
  var sp = PropertiesService.getScriptProperties();
  var q = JSON.parse(sp.getProperty('PENDING') || '{}');
  Object.keys(q).forEach(function (id) { if (updatePage_(id, q[id])) delete q[id]; });
  sp.setProperty('PENDING', JSON.stringify(q));
}

// ====== HULPFUNCTIES ======
function sel_(p, v) { return { property: p, select: { equals: v } }; }
function chk_(p, v) { return { property: p, checkbox: { equals: v } }; }
function rt_(s) { return { rich_text: [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] }; }
function txt_(page, name) {
  var p = page.properties[name];
  if (!p) return '';
  var arr = p.title || p.rich_text || [];
  return arr.map(function (x) { return x.plain_text; }).join('').trim();
}
function iso_(d) { return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); }
function addDays_(d, n) { return Utilities.formatDate(new Date(d.getTime() + n * 86400000), CFG.TZ, 'yyyy-MM-dd'); }
function log_(s) { console.log(s); }
function dayKey_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd'); }
function getCounter_(k) { return Number(PropertiesService.getScriptProperties().getProperty(k + '_' + dayKey_()) || 0); }
function bumpCounter_(k) { PropertiesService.getScriptProperties().setProperty(k + '_' + dayKey_(), String(getCounter_(k) + 1)); }

// ====== HANDIGE TESTFUNCTIES ======
function testNotionConnection() {
  var r = queryAll_(sel_('Status', 'Verzonden'), 3);
  console.log('Notion OK, voorbeeldrijen: ' + r.map(function (p) { return txt_(p, 'Merk'); }).join(', '));
}
