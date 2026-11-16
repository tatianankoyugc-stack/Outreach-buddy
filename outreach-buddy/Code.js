/**
 * THE TATIANA EDIT — OUTREACH BUDDY (Google Apps Script)
 * Notion = CRM, Gmail = verzending. Geen AI-sessie nodig.
 *
 * VEILIGHEIDSREGELS (hard ingebouwd):
 *  - DRY_RUN staat standaard AAN: er wordt niets verzonden en niets in Notion gewijzigd.
 *  - Eerste pitch vertrekt alleen als: Status = Concept klaar / Klaar voor verzending,
 *    "Automatisch verzenden goedgekeurd" = aan, "Verzending toegestaan" = aan,
 *    Verzendwijze = Automatisch, Kanaal = E-mail, Niet meer contacteren = uit, geldig
 *    e-mailadres, onderwerp + eerste bericht ingevuld, Mailthread en Eerste verzending leeg.
 *  - Vóór elke verzending: Gmail doorzoeken op eerdere mail naar dat adres of domein
 *    (gratis maildomeinen zoals gmail.com alleen op exact adres). Gevonden = NIET verzenden.
 *    Daarna rij vergrendelen in Notion, pas dan verzenden.
 *  - Na verzending: meteen terugschrijven (3 pogingen); lukt dat niet, dan onthoudt het script
 *    dit duurzaam en probeert het de volgende run opnieuw. Rij blijft vergrendeld.
 *  - Onbekende fout = rij blijft vergrendeld met FOUT-melding en komt in je dagrapport.
 *  - Follow-ups: max 2, pas 4 kalenderdagen na de ECHTE Gmail-verzenddatum, alleen in
 *    de bestaande thread en alleen naar de oorspronkelijke ontvanger, nooit bij antwoord,
 *    afwijzing, bounce of "Niet meer contacteren".
 *  - Gmail-quotum wordt vóór elke mail gecontroleerd.
 */

// ====== INSTELLINGEN ======
var CFG = {
  DRY_RUN: false,                // zet op false pas na de dry-run-controle
  DATA_SOURCE_ID: '32a5fb7f-bced-4e2c-b926-7f1ec94afd17',
  NOTION_VERSION: '2025-09-03',
  SENDER_NAME: 'Tatiana | The Tatiana Edit',
  REPORT_TO: 'tatianankoyugc@gmail.com',
  DAILY_CAP_FIRST: 50,           // nieuwe pitches per werkdag (harde bovengrens)
  BATCH_SIZE: 8,                 // per run (houdt de run onder de 6 minuten)
  PAUSE_MS: 25000,               // pauze tussen mails
  FOLLOWUP_DAYS: 4,
  MAX_FOLLOWUPS: 2,
  WINDOW_START: 9, WINDOW_END: 17, // Brussels-uren, ma-vr
  TZ: 'Europe/Brussels',
  RUN_BUDGET_MS: 4.5 * 60 * 1000,
  MIN_MAIL_QUOTA: 10,            // stop met verzenden als er minder mails over zijn vandaag
  // Eenvoudige werkwijze: alleen "Automatisch verzenden goedgekeurd" is dan nodig.
  // Staat UIT tot Tatiana akkoord geeft.
  SIMPLE_APPROVAL: true          // aan sinds 14/11 op vraag van Tatiana
};

var FREE_MAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.be', 'hotmail.nl',
  'outlook.com', 'outlook.be', 'live.com', 'live.be', 'live.nl', 'yahoo.com', 'icloud.com', 'me.com',
  'telenet.be', 'skynet.be', 'proximus.be', 'ziggo.nl', 'kpnmail.nl', 'msn.com'];

var INTERESTING_REPLIES = ['Geïnteresseerd', 'Meer informatie gevraagd', 'Offerte gevraagd'];

var FORCE_DRY_ = false; // wordt door de testfuncties op true gezet
var LOG_BUF_ = [];
function isDry_() { return CFG.DRY_RUN || FORCE_DRY_; }

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
    try { runMigrations_(); } catch (e) { alert_("Opruimactie mislukt (verzenden gaat gewoon door): " + e); }
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

function mailQuotaOk_() {
  var left = MailApp.getRemainingDailyQuota();
  if (left < CFG.MIN_MAIL_QUOTA) {
    alert_('Gmail-quotum bijna op (' + left + ' over vandaag). Verzenden gepauzeerd tot morgen.');
    return false;
  }
  return true;
}

// ====== EENMALIGE OPRUIMACTIES ======
// Draait één keer (onthouden in Script Properties), ook buiten het verzendvenster. Verstuurt niets.
function runMigrations_() {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('MIG_BEZIG_20261114')) return;
  var rows = queryAll_({ property: 'Verzendcontrole', rich_text: { starts_with: 'BEZIG' } }, 100);
  var done = [], skipped = [];
  rows.forEach(function (p) {
    var rt = (p.properties['Verzendcontrole'].rich_text || []);
    var full = rt.map(function (x) { return x.plain_text; }).join('');
    if (full.indexOf('BEVESTIGD') === -1 || !rt.length || rt.some(function (x) { return x.type !== 'text'; })) { skipped.push(txt_(p, 'Merk')); return; }
    // Alleen het eerste stukje aanpassen; de rest van het bewijs blijft exact staan.
    var parts = rt.map(function (x) { return { type: 'text', text: { content: x.text.content, link: x.text.link }, annotations: x.annotations }; });
    parts[0].text.content = parts[0].text.content.replace(/^BEZIG\s*[—-]\s*/, '');
    if (updatePage_(p.id, { 'Verzendcontrole': { rich_text: parts } })) done.push(txt_(p, 'Merk')); else skipped.push(txt_(p, 'Merk'));
  });
  sp.setProperty('MIG_BEZIG_20261114', iso_(new Date())); // max 1x, nooit herhalen
  GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy — opruiming BEZIG',
    '"BEZIG" weggehaald bij ' + done.length + ' verstuurde merken (bewijs behouden):\n - ' + done.join('\n - ') +
    (skipped.length ? '\n\nNiet aangepast (geen BEVESTIGD-bewijs of fout; niets gewijzigd):\n - ' + skipped.join('\n - ') : ''));
}

// ====== EERSTE PITCHES ======
function firstPitchFilter_() {
  var f = [
    { or: [ sel_('Status', 'Concept klaar'), sel_('Status', 'Klaar voor verzending') ] },
    chk_('Automatisch verzenden goedgekeurd', true),
    chk_('Niet meer contacteren', false),
    // Het vinkje is de beslissing; alleen "Niet benaderen" en "Instagram DM" houden tegen.
    { property: 'Verzendwijze', select: { does_not_equal: 'Niet benaderen' } },
    { property: 'Kanaal', select: { does_not_equal: 'Instagram DM' } },
    { property: 'Mailthread', url: { is_empty: true } },
    { property: 'Eerste verzending', date: { is_empty: true } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'VERGRENDELD' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'FOUT' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'GEBLOKKEERD' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'BEZIG' } }
  ];
  if (!CFG.SIMPLE_APPROVAL) f.push(chk_('Verzending toegestaan', true));
  return { and: f };
}

function processFirstPitches_(t0) {
  var sentToday = getCounter_('first');
  var room = CFG.DAILY_CAP_FIRST - sentToday;
  if (room <= 0) { log_('Daglimiet eerste pitches bereikt (' + sentToday + ').'); return; }
  var rows = queryAll_(firstPitchFilter_(), Math.min(room, CFG.BATCH_SIZE));
  log_('Eerste pitches in de wachtrij deze run: ' + rows.length);
  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - t0 > CFG.RUN_BUDGET_MS) { log_('Runbudget op, rest volgende run.'); return; }
    if (!isDry_() && !mailQuotaOk_()) return;
    sendFirst_(rows[i]);
  }
}

function priorContact_(to) {
  var domain = to.split('@')[1].toLowerCase();
  var q = FREE_MAIL_DOMAINS.indexOf(domain) >= 0
    ? 'in:sent to:' + to
    : 'in:sent (to:' + to + ' OR to:@' + domain + ')';
  var prior = GmailApp.search(q, 0, 1);
  return prior.length ? { domain: domain, thread: prior[0].getId() } : null;
}

function sendFirst_(page) {
  var id = page.id;
  var brand = txt_(page, 'Merk');
  var to = ((page.properties['E-mail'] && page.properties['E-mail'].email) || '').trim();
  var subject = txt_(page, 'Onderwerp');
  var body = txt_(page, 'Eerste bericht');

  var problem = validate_(page, to, subject, body);
  if (problem) { block_(id, brand, problem); return; }

  // 1. Duplicaatcontrole in Gmail (adres + domein)
  var prior = priorContact_(to);
  if (prior) {
    block_(id, brand, 'Gmail toont al eerder contact met ' + to + ' of @' + prior.domain + ' (thread ' + prior.thread + '). Handmatig controleren.');
    return;
  }

  if (isDry_()) {
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
  bumpCounter_('first');
  var thread = msg.getThread();
  var sentAt = msg.getDate();
  var props = {
    'Status': { select: { name: 'Verzonden' } },
    'Kanaal': { select: { name: 'E-mail' } },
    'Verzendwijze': { select: { name: 'Automatisch' } },
    'Taal': { select: { name: selName_(page, 'Taal') || detectLang_(subject + '\n' + body) } },
    'Eerste verzending': { date: { start: iso_(sentAt) } },
    'Laatste contact': { date: { start: iso_(sentAt) } },
    'Mailthread': { url: 'https://mail.google.com/mail/u/0/#all/' + thread.getId() },
    'Aantal follow-ups': { number: 0 },
    'Follow-upstatus': { select: { name: 'Wacht op antwoord' } },
    'Volgende actie': { date: { start: addDays_(sentAt, CFG.FOLLOWUP_DAYS) } },
    'Verzendcontrole': rt_('VERZONDEN — Gmail thread ' + thread.getId() + '; Gmail-tijd ' + iso_(sentAt) + '. Verzonden is geen bewijs van aflevering of lezen.')
  };
  if (!updateWithRetry_(id, props)) { queueWriteback_(id, props); }
  log_('VERZONDEN ' + brand + ' -> ' + to + ' (thread ' + thread.getId() + ')');
  Utilities.sleep(CFG.PAUSE_MS);
}

function validate_(page, to, subject, body) {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return 'Ongeldig of leeg e-mailadres';
  if (/^(no-?reply|noreply|donotreply)@/i.test(to)) return 'No-reply adres';
  if (to.toLowerCase() === CFG.REPORT_TO.toLowerCase()) return 'Ontvanger is je eigen adres';
  if (!subject || subject.length < 5) return 'Onderwerp ontbreekt';
  if (!body || body.length < 200) return 'Bericht ontbreekt of te kort';
  if (body.length > 2500) return 'Bericht te lang voor een eerste pitch';
  if (!txt_(page, 'Land of markt')) return 'Land of markt ontbreekt (taal te bevestigen)';
  var taal = selName_(page, 'Taal');
  if (taal === 'Taal te bevestigen') return 'Taal te bevestigen';
  if (!taal && !detectLang_(subject + '\n' + body)) return 'Taal van de pitch niet herkend; vul het veld Taal in';
  if (/\[[^\]]*\]|\{\{|TODO|XXX/.test(body + subject)) return 'Placeholder in tekst';
  return null;
}

function block_(id, brand, reason) {
  log_('GEBLOKKEERD ' + brand + ': ' + reason);
  if (isDry_()) return;
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
    { property: 'Reactiecategorie', select: { is_empty: true } },
    { property: 'Mailthread', url: { is_not_empty: true } },
    { property: 'Volgende actie', date: { on_or_before: today } },
    { or: [
      { property: 'Aantal follow-ups', number: { less_than: CFG.MAX_FOLLOWUPS } },
      { property: 'Aantal follow-ups', number: { is_empty: true } }
    ] },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'VERGRENDELD' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'GEBLOKKEERD' } },
    { property: 'Verzendcontrole', rich_text: { does_not_contain: 'BEZIG' } }
  ]};
  var rows = queryAll_(filter, CFG.BATCH_SIZE);
  log_('Follow-ups die vandaag aan de beurt zijn (deze run): ' + rows.length);
  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - t0 > CFG.RUN_BUDGET_MS) { return; }
    if (!isDry_() && !mailQuotaOk_()) return;
    sendFollowup_(rows[i]);
  }
}

function threadIdFromUrl_(url) {
  var m = String(url || '').match(/([0-9a-f]{12,})\s*$/i);
  return m ? m[1] : null;
}

function sendFollowup_(page) {
  var id = page.id, brand = txt_(page, 'Merk');
  var n = (page.properties['Aantal follow-ups'] && page.properties['Aantal follow-ups'].number) || 0;
  var text = txt_(page, n === 0 ? 'Follow-up 1' : 'Follow-up 2');
  var threadId = threadIdFromUrl_(page.properties['Mailthread'].url);
  if (!threadId || !text) { log_('Follow-up overgeslagen ' + brand + ': thread of tekst ontbreekt'); return; }
  var thread = null;
  try { thread = GmailApp.getThreadById(threadId); } catch (e) {}
  if (!thread) { // oudere rijen bewaren soms een bericht-ID in plaats van een thread-ID
    try { var mm = GmailApp.getMessageById(threadId); if (mm) thread = mm.getThread(); } catch (e) {}
  }
  if (!thread) { block_(id, brand, 'Gmail-thread niet gevonden'); return; }
  threadId = thread.getId();

  var me = CFG.REPORT_TO.toLowerCase();
  var msgs = thread.getMessages();
  var lastMine = null;
  for (var i = 0; i < msgs.length; i++) {
    var from = msgs[i].getFrom().toLowerCase();
    if (from.indexOf(me) === -1) {
      // antwoord (of bounce) van iemand anders: stoppen
      var bounce = /mailer-daemon|postmaster/.test(from);
      if (!isDry_()) {
        updatePage_(id, {
          'Follow-upstatus': { select: { name: 'Gestopt' } },
          'Status': bounce ? { select: { name: 'Verzonden' } } : { select: { name: 'Reactie ontvangen' } },
          'Reactiecategorie': bounce ? { select: { name: 'Afleverprobleem' } } : undefined,
          'Laatste reactie': rt_(iso_(msgs[i].getDate()) + ' — ' + msgs[i].getFrom().slice(0, 80)),
          'Volgende stap': rt_(bounce ? 'Adres geeft bounce — nieuwe contactroute zoeken' : 'Antwoord lezen en zelf opvolgen')
        });
      }
      log_('Follow-up gestopt (' + (bounce ? 'bounce' : 'antwoord') + ') ' + brand);
      return;
    } else { lastMine = msgs[i]; }
  }
  if (!lastMine) { return; }
  var days = (Date.now() - lastMine.getDate().getTime()) / 86400000;
  if (days < CFG.FOLLOWUP_DAYS) { return; } // echte verzenddatum, niet de geplande

  // Ontvanger = de oorspronkelijke ontvanger van de eerste mail, en die moet overeenkomen met Notion.
  var to = msgs[0].getTo();
  var notionTo = ((page.properties['E-mail'] && page.properties['E-mail'].email) || '').trim().toLowerCase();
  if (!to || to.toLowerCase().indexOf(me) >= 0 || (notionTo && to.toLowerCase().indexOf(notionTo) === -1)) {
    block_(id, brand, 'Follow-up niet verstuurd: ontvanger in Gmail-thread (' + to + ') komt niet overeen met E-mail in Notion. Handmatig controleren.');
    return;
  }

  if (isDry_()) { log_('[DRY RUN] zou follow-up ' + (n + 1) + ' sturen: ' + brand + ' -> ' + to); return; }

  var runId = Utilities.getUuid().slice(0, 8);
  if (!updatePage_(id, { 'Verzendcontrole': rt_('VERGRENDELD FU' + (n + 1) + ' ' + runId + ' ' + iso_(new Date())) })) { return; }
  try {
    replyInThread_(threadId, msgs[0], lastMine, to, text);
  } catch (e) {
    updatePage_(id, { 'Verzendcontrole': rt_('FOUT follow-up ' + (n + 1) + ' ' + iso_(new Date()) + ': ' + String(e).slice(0, 300) + ' — controleer Gmail vóór je dit wist.') });
    alert_('Follow-upfout bij ' + brand + ': ' + e);
    return;
  }
  bumpCounter_('followup');
  var now = new Date();
  var done = n + 1;
  var props = {
    'Aantal follow-ups': { number: done },
    'Status': { select: { name: done === 1 ? 'Follow-up 1 verzonden' : 'Follow-up 2 verzonden' } },
    'Laatste contact': { date: { start: iso_(now) } },
    'Follow-upstatus': { select: { name: done >= CFG.MAX_FOLLOWUPS ? 'Gestopt' : 'Wacht op antwoord' } },
    'Volgende actie': done >= CFG.MAX_FOLLOWUPS ? { date: null } : { date: { start: addDays_(now, CFG.FOLLOWUP_DAYS) } },
    'Verzendcontrole': rt_('FOLLOW-UP ' + done + ' VERZONDEN ' + iso_(now) + ' in thread ' + threadId)
  };
  if (!updateWithRetry_(id, props)) { queueWriteback_(id, props); }
  log_('FOLLOW-UP ' + done + ' VERZONDEN ' + brand + ' -> ' + to);
  Utilities.sleep(CFG.PAUSE_MS);
}

/**
 * Antwoord in de bestaande thread, expliciet naar de oorspronkelijke ontvanger.
 * (GmailThread.reply() stuurt bij een thread waarvan jij de laatste afzender bent
 *  het antwoord naar jezelf. Daarom via de Gmail API met In-Reply-To/References.)
 */
function replyInThread_(threadId, firstMsg, lastMine, to, text) {
  var subj = firstMsg.getSubject();
  if (!/^re:/i.test(subj)) subj = 'Re: ' + subj;
  var msgId = lastMine.getHeader('Message-ID');
  if (!msgId) throw new Error('Message-ID van vorige mail ontbreekt');
  var refs = lastMine.getHeader('References');
  refs = (refs ? refs + ' ' : '') + msgId;
  var lines = [
    'From: ' + encodeWord_(CFG.SENDER_NAME) + ' <' + CFG.REPORT_TO + '>',
    'To: ' + to,
    'Subject: ' + encodeWord_(subj),
    'In-Reply-To: ' + msgId,
    'References: ' + refs,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Utilities.base64Encode(text, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n')
  ];
  var raw = Utilities.base64EncodeWebSafe(lines.join('\r\n'));
  return Gmail.Users.Messages.send({ raw: raw, threadId: threadId }, 'me');
}
function encodeWord_(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
}

// ====== BOUNCES ======
function processBounces_() {
  var cache = CacheService.getScriptCache();
  var me = CFG.REPORT_TO.toLowerCase();
  var threads = GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:3d', 0, 20);
  threads.forEach(function (th) {
    th.getMessages().forEach(function (msg) {
      var key = 'bounce_' + msg.getId();
      if (cache.get(key)) return; // al verwerkt
      var body = msg.getPlainBody() || '';
      var found = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      var seen = {};
      found.forEach(function (addr) {
        addr = addr.toLowerCase();
        if (seen[addr] || addr === me || /mailer-daemon|postmaster/i.test(addr)) return;
        seen[addr] = true;
        var rows = queryAll_({ and: [
          { property: 'E-mail', email: { equals: addr } },
          { property: 'Reactiecategorie', select: { is_empty: true } }
        ]}, 1);
        if (rows.length && !isDry_()) {
          updatePage_(rows[0].id, {
            'Reactiecategorie': { select: { name: 'Afleverprobleem' } },
            'Follow-upstatus': { select: { name: 'Gestopt' } },
            'Volgende stap': rt_('Adres geeft bounce — nieuwe contactroute zoeken')
          });
        }
        if (rows.length) log_('Bounce verwerkt: ' + addr);
      });
      if (!isDry_()) cache.put(key, '1', 21600);
    });
  });
}

// ====== DAGRAPPORT ======
function dailyReport() {
  var lines = ['Outreach Buddy — dagrapport ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy')];
  if (isDry_()) lines.push('(DRY RUN: er is niets verzonden)');

  // 1. Interessante reacties bovenaan
  var hot = queryAll_({ and: [
    { or: INTERESTING_REPLIES.map(function (r) { return sel_('Reactiecategorie', r); }) },
    { property: 'Status', select: { does_not_equal: 'Afgesloten' } },
    { property: 'Status', select: { does_not_equal: 'Deal' } }
  ]}, 50);
  lines.push('');
  lines.push('>>> ZELF OPPAKKEN (interessante reacties): ' + hot.length);
  hot.forEach(function (p) { lines.push(' - ' + txt_(p, 'Merk') + ' — ' + selName_(p, 'Reactiecategorie') + ' — ' + (p.url || '')); });

  // 2. Vandaag verzonden
  lines.push('');
  lines.push('Vandaag verzonden door het script — eerste pitches: ' + getCounter_('first') + ', follow-ups: ' + getCounter_('followup'));
  lines.push('Gmail-quotum nog over vandaag: ' + MailApp.getRemainingDailyQuota());

  // 3. Aangevinkt maar (nog) niet verstuurd, met reden
  var approved = queryAll_({ and: [
    { or: [ sel_('Status', 'Concept klaar'), sel_('Status', 'Klaar voor verzending') ] },
    chk_('Automatisch verzenden goedgekeurd', true)
  ]}, 100);
  if (approved.length) {
    lines.push('');
    lines.push('Aangevinkt, wacht op verzending: ' + approved.length);
    approved.slice(0, 25).forEach(function (p) { lines.push(' - ' + txt_(p, 'Merk') + ': ' + (whyNotSent_(p) || 'klaar, gaat mee in de volgende run binnen het venster')); });
  }

  // 4. Aandacht nodig: alleen rijen waarvan Verzendcontrole met een probleemwoord begint
  var errs = queryAll_({ or: ['FOUT', 'VERGRENDELD', 'GEBLOKKEERD', 'BEZIG', 'BEZORGFOUT'].map(function (w) {
    return { property: 'Verzendcontrole', rich_text: { starts_with: w } };
  }) }, 100);
  lines.push('');
  lines.push('Aandacht nodig (fout/vergrendeld/geblokkeerd): ' + errs.length);
  errs.slice(0, 25).forEach(function (p) { lines.push(' - ' + txt_(p, 'Merk') + ': ' + txt_(p, 'Verzendcontrole').slice(0, 140)); });

  // 5. Statusoverzicht
  lines.push('');
  ['Te onderzoeken', 'Concept klaar', 'Klaar voor verzending', 'Verzonden', 'Follow-up 1 verzonden', 'Follow-up 2 verzonden', 'Reactie ontvangen', 'In gesprek', 'Deal', 'Afgesloten'].forEach(function (s) {
    lines.push(s + ': ' + queryAll_(sel_('Status', s), 1000).length);
  });
  GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy dagrapport', lines.join('\n'));
}

// Leesbare reden waarom een aangevinkte rij niet vertrekt (geen wijzigingen).
function whyNotSent_(p) {
  if (!CFG.SIMPLE_APPROVAL && !chkVal_(p, 'Verzending toegestaan')) return 'vinkje "Verzending toegestaan" staat uit';
  if (chkVal_(p, 'Niet meer contacteren')) return '"Niet meer contacteren" staat aan';
  if (selName_(p, 'Verzendwijze') === 'Niet benaderen') return 'Verzendwijze is "Niet benaderen"';
  if (selName_(p, 'Kanaal') === 'Instagram DM') return 'Kanaal is Instagram DM (handmatig sturen)';
  var vc = txt_(p, 'Verzendcontrole');
  if (/VERGRENDELD|FOUT|GEBLOKKEERD|BEZIG/i.test(vc)) return 'Verzendcontrole: ' + vc.slice(0, 80);
  if (p.properties['Mailthread'] && p.properties['Mailthread'].url) return 'Mailthread is al ingevuld';
  var to = ((p.properties['E-mail'] && p.properties['E-mail'].email) || '').trim();
  return validate_(p, to, txt_(p, 'Onderwerp'), txt_(p, 'Eerste bericht'));
}

function alert_(msg) {
  log_('ALERT ' + msg);
  try {
    var cache = CacheService.getScriptCache();
    var key = 'alert_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(msg).slice(0, 200)));
    if (cache.get(key)) return; // dezelfde melding max 1x per uur
    cache.put(key, '1', 3600);
    GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy — aandacht nodig', msg);
  } catch (e) {}
}

// ====== NOTION ======
function nfetch_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN ontbreekt in Script Properties');
  for (var attempt = 0; attempt < 5; attempt++) {
    var res = UrlFetchApp.fetch('https://api.notion.com' + path, {
      method: method, muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': CFG.NOTION_VERSION },
      payload: payload ? JSON.stringify(payload) : undefined
    });
    var code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 || code >= 500) {
      var ra = Number((res.getHeaders() || {})['Retry-After'] || 0);
      Utilities.sleep(ra ? Math.min(ra, 30) * 1000 : 1500 * (attempt + 1));
      continue;
    }
    throw new Error('Notion ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  throw new Error('Notion bleef falen na 5 pogingen');
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
  var ids = Object.keys(q);
  if (!ids.length) return;
  ids.forEach(function (id) { if (updatePage_(id, q[id])) delete q[id]; });
  sp.setProperty('PENDING', JSON.stringify(q));
}

// ====== HULPFUNCTIES ======
// Herkent de taal van de pitch zelf. Geeft 'Nederlands', 'Frans', 'Engels' of '' (twijfel).
function detectLang_(text) {
  var t = ' ' + String(text || '').toLowerCase().replace(/[^a-zàâçéèêëîïôûùüÿœ']+/g, ' ') + ' ';
  var words = {
    Nederlands: ['de', 'het', 'een', 'jullie', 'ik', 'en', 'van', 'voor', 'mijn', 'groetjes', 'dag', 'dat', 'zou', 'met', 'niet'],
    Frans: ['le', 'la', 'les', 'vous', 'je', 'et', 'une', 'des', 'pour', 'votre', 'bonjour', 'avec', 'est', 'mon', 'pas'],
    Engels: ['the', 'and', 'you', 'your', 'i', 'with', 'for', 'my', 'hi', 'would', 'this', 'that', 'is', 'of', 'to']
  };
  var score = {};
  Object.keys(words).forEach(function (l) {
    score[l] = words[l].reduce(function (n, w) { return n + (t.split(' ' + w + ' ').length - 1); }, 0);
  });
  var ranked = Object.keys(score).sort(function (a, b) { return score[b] - score[a]; });
  var best = score[ranked[0]], second = score[ranked[1]];
  return (best >= 8 && best >= 2 * second) ? ranked[0] : '';
}

function sel_(p, v) { return { property: p, select: { equals: v } }; }
function chk_(p, v) { return { property: p, checkbox: { equals: v } }; }
function rt_(s) { return { rich_text: [{ type: 'text', text: { content: String(s).slice(0, 1900) } }] }; }
function txt_(page, name) {
  var p = page.properties[name];
  if (!p) return '';
  var arr = p.title || p.rich_text || [];
  return arr.map(function (x) { return x.plain_text; }).join('').trim();
}
function selName_(page, name) {
  var p = page.properties[name];
  return p && p.select ? p.select.name : '';
}
function chkVal_(page, name) { var p = page.properties[name]; return !!(p && p.checkbox); }
function iso_(d) { return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); }
function addDays_(d, n) { return Utilities.formatDate(new Date(d.getTime() + n * 86400000), CFG.TZ, 'yyyy-MM-dd'); }
function log_(s) { console.log(s); LOG_BUF_.push(s); }
function dayKey_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd'); }
function getCounter_(k) { return Number(PropertiesService.getScriptProperties().getProperty(k + '_' + dayKey_()) || 0); }
function bumpCounter_(k) { PropertiesService.getScriptProperties().setProperty(k + '_' + dayKey_(), String(getCounter_(k) + 1)); }

// ====== TESTFUNCTIES (versturen NOOIT iets naar merken) ======
function testNotionConnection() {
  var r = queryAll_(sel_('Status', 'Verzonden'), 3);
  console.log('Notion OK, voorbeeldrijen: ' + r.map(function (p) { return txt_(p, 'Merk'); }).join(', '));
}

/**
 * Eén klik = volledige controle. Verstuurt NIETS naar merken en wijzigt niets in Notion,
 * ook niet als DRY_RUN op false staat. Mailt het resultaat naar REPORT_TO.
 */
function healthCheck() {
  FORCE_DRY_ = true;
  LOG_BUF_ = [];
  var out = ['Outreach Buddy — healthcheck ' + Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm') + ' (Brussel)'];
  function step(name, fn) {
    try { var r = fn(); out.push('OK   ' + name + (r ? ': ' + r : '')); }
    catch (e) { out.push('FOUT ' + name + ': ' + e); }
  }
  step('Instellingen', function () {
    return 'DRY_RUN=' + CFG.DRY_RUN + ', SIMPLE_APPROVAL=' + CFG.SIMPLE_APPROVAL + ', tijdzone script=' + Session.getScriptTimeZone() +
      ', venster ' + CFG.WINDOW_START + '-' + CFG.WINDOW_END + 'u ma-vr (nu ' + (inWindow_() ? 'BINNEN' : 'BUITEN') + ' venster), daglimiet ' + CFG.DAILY_CAP_FIRST;
  });
  step('Account', function () { return 'script draait als ' + Session.getEffectiveUser().getEmail() + ', rapport naar ' + CFG.REPORT_TO + ', afzendernaam "' + CFG.SENDER_NAME + '"'; });
  step('Notion-token', function () { if (!PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN')) throw new Error('ontbreekt'); return 'aanwezig (waarde niet getoond)'; });
  step('Notion-database + velden', function () {
    var ds = nfetch_('get', '/v1/data_sources/' + CFG.DATA_SOURCE_ID);
    var need = ['Merk', 'Status', 'E-mail', 'Onderwerp', 'Eerste bericht', 'Follow-up 1', 'Follow-up 2', 'Kanaal', 'Verzendwijze',
      'Automatisch verzenden goedgekeurd', 'Verzending toegestaan', 'Niet meer contacteren', 'Verzendcontrole', 'Mailthread',
      'Eerste verzending', 'Laatste contact', 'Volgende actie', 'Aantal follow-ups', 'Follow-upstatus', 'Reactiecategorie',
      'Laatste reactie', 'Volgende stap', 'Land of markt', 'Taal'];
    var missing = need.filter(function (k) { return !ds.properties[k]; });
    if (missing.length) throw new Error('ontbrekende velden: ' + missing.join(', '));
    return 'versie ' + CFG.NOTION_VERSION + ', alle ' + need.length + ' velden gevonden';
  });
  step('Triggers', function () {
    var t = ScriptApp.getProjectTriggers().map(function (x) { return x.getHandlerFunction() + ' (' + x.getEventType() + ')'; });
    var ok = t.join(' ').indexOf('runQueue') >= 0 && t.join(' ').indexOf('dailyReport') >= 0;
    return (t.length ? t.join(', ') : 'GEEN') + (ok ? '' : '  <-- runQueue en/of dailyReport ontbreekt: voer installTriggers uit');
  });
  step('Gmail-quotum', function () { return MailApp.getRemainingDailyQuota() + ' mails over vandaag'; });
  step('Gmail API (follow-ups)', function () { Gmail.Users.getProfile('me'); return 'bereikbaar'; });
  step('Wachtende terugschrijvingen', function () { return Object.keys(JSON.parse(PropertiesService.getScriptProperties().getProperty('PENDING') || '{}')).length + ''; });
  step('Dry-run eerste pitches', function () { processFirstPitches_(Date.now()); return ''; });
  step('Dry-run follow-ups', function () { processFollowups_(Date.now()); return ''; });
  out.push('');
  out.push('--- Logboek ---');
  out = out.concat(LOG_BUF_);
  FORCE_DRY_ = false;
  var text = out.join('\n');
  console.log(text);
  GmailApp.sendEmail(CFG.REPORT_TO, 'Outreach Buddy healthcheck', text);
}
