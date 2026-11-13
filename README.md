# Outreach Buddy

Google Apps Script (`outreach-buddy/Code.js`) dat UGC-pitches en follow-ups via Gmail verstuurt, op basis van de Notion-database **Tatiana's Outreach Buddy** (data source `32a5fb7f-bced-4e2c-b926-7f1ec94afd17`).

## Hoe het werkt

**Triggers:** `runQueue` draait elke 10 minuten en `dailyReport` elke dag om 17u. Je installeert ze met `installTriggers`. Let op: die functie verwijdert eerst alle bestaande triggers.

**Verzendvenster:** maandag tot en met vrijdag van 9 tot 17u, tijdzone Europe/Brussels. Buiten dat venster doet `runQueue` niets.

**Volgorde per run:** eerst mislukte Notion-terugschrijvingen opnieuw proberen, dan bounces verwerken, dan follow-ups, dan eerste pitches.

### Eerste pitch vertrekt als
- Status is `Concept klaar` of `Klaar voor verzending`
- de vinkjes **Automatisch verzenden goedgekeurd** en **Verzending toegestaan** staan allebei aan (met `SIMPLE_APPROVAL: true` is alleen het eerste nodig)
- Verzendwijze is `Automatisch` en Kanaal is `E-mail`
- **Niet meer contacteren** staat uit
- Mailthread en Eerste verzending zijn leeg
- Verzendcontrole bevat geen VERGRENDELD, FOUT, GEBLOKKEERD of BEZIG
- de validatie slaagt:
  - het e-mailadres is geldig, geen no-reply en niet je eigen adres
  - er is een onderwerp
  - de tekst telt tussen 200 en 2500 tekens
  - Land of markt is ingevuld
  - Taal is ingevuld en staat niet op "te bevestigen"
  - er staan geen placeholders in de tekst
- Gmail (Verzonden) toont geen eerder contact met dat adres of domein. Bij gratis maildomeinen zoals gmail.com of telenet.be wordt alleen op het exacte adres gecontroleerd.

### Beveiligingen
- **Lock:** er kan nooit meer dan één run tegelijk draaien.
- **Vergrendelen:** de rij krijgt in Notion eerst `VERGRENDELD` voordat de mail vertrekt.
- **Na verzending:** de rij gaat naar Status `Verzonden` en Mailthread, Eerste verzending, Laatste contact, Follow-upstatus (`Wacht op antwoord`), Volgende actie (+4 dagen) en Verzendcontrole worden ingevuld.
- **Mislukte Notion-update na verzending:** de update komt in een wachtrij (`PENDING`) en de rij blijft vergrendeld. Opnieuw verzenden gebeurt dus nooit.
- **Daglimiet:** maximaal 50 eerste pitches per dag, 8 per run, 25 seconden tussen mails en een runbudget van 4,5 minuten (de limiet van Apps Script is 6 minuten).
- **Gmail-quotum:** onder de 10 resterende mails stopt het verzenden.
- **Meldingen:** dezelfde melding komt maximaal één keer per uur.
- **Dry-run:** met `DRY_RUN: true` wordt er niets verzonden en niets in Notion gewijzigd.

### Follow-ups
- Maximaal 2 (`MAX_FOLLOWUPS`), telkens 4 kalenderdagen (`FOLLOWUP_DAYS`) na de echte Gmail-verzenddatum.
- Alleen als:
  - Status `Verzonden` of `Follow-up 1 verzonden` is
  - Follow-upstatus `Wacht op antwoord` is
  - Verzendwijze `Automatisch` is
  - Reactiecategorie leeg is
  - Niet meer contacteren uit staat
  - Volgende actie vandaag of eerder valt
- De tekst komt uit het veld Follow-up 1 of Follow-up 2. Is dat leeg, dan wordt de follow-up overgeslagen.
- Antwoordt iemand in de thread, dan stopt de reeks en gaat de Status naar `Reactie ontvangen`. Bij een bounce wordt Reactiecategorie `Afleverprobleem`.
- De follow-up gaat via de Gmail API als antwoord in dezelfde thread, expliciet naar de oorspronkelijke ontvanger. Die ontvanger moet overeenkomen met het e-mailadres in Notion.

### Bounce-detectie
Het script bekijkt mails van mailer-daemon of postmaster van de laatste 3 dagen. Komt het adres in een bounce overeen met een rij, dan wordt Reactiecategorie `Afleverprobleem` en Follow-upstatus `Gestopt`.

### Dagrapport (17u)
Het rapport bevat, in deze volgorde:
1. Interessante reacties bovenaan (Geïnteresseerd, Meer informatie gevraagd, Offerte gevraagd)
2. Wat er vandaag verzonden is en het resterende Gmail-quotum
3. Aangevinkte rijen die nog wachten, met de reden waarom
4. Probleemrijen
5. Een overzicht per status

## Testen
Voer `healthCheck` uit in de editor. Die functie verstuurt nooit iets naar merken en wijzigt niets in Notion. Ze controleert:
- de instellingen
- de Notion-token en alle velden
- de triggers
- het quotum
- de Gmail API
- een dry-run van de eerste pitches en de follow-ups

Het resultaat krijg je per mail.

## Werken met clasp
```
cd outreach-buddy
clasp pull   # code uit Google ophalen
clasp push   # code naar Google sturen
```
Geheimen zoals `NOTION_TOKEN` staan alleen in Script Properties en nooit in deze repo.
