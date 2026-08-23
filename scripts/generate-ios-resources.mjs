import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'src', 'i18n.tsx');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(
  sourcePath,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const objects = new Map();
const directKeys = new Map();

// Copy that exists only in the native shell still belongs in the generated
// catalog. Keeping it here means the checked-in resource remains reproducible
// from the web catalog instead of becoming a second hand-maintained file.
const nativeMessages = {
  en: {
    'native.account': 'Account',
    'native.apnsTokenError': 'Apple did not return a notification token. Try again on a signed development build.',
    'native.auth.cancelled': 'Sign-in was cancelled.',
    'native.auth.invalidResponse': 'The authentication service returned an invalid response.',
    'native.auth.missingSession': 'The sign-in code did not create a session.',
    'native.auth.notConfigured': 'Authentication is not configured.',
    'native.auth.requestFailed': 'Sign-in failed ({{status}}).',
    'native.auth.saveSession': 'The secure session could not be saved.',
    'native.auth.secureRequest': 'A secure sign-in request could not be created.',
    'native.configurationHelp': 'Add your public Supabase URL and publishable key to Configuration/Local.xcconfig.',
    'native.deliveries': 'Deliveries',
    'native.deliveryProgress': 'Delivery progress',
    'native.done': 'Done',
    'native.error.authenticationExpired': 'Your sign-in expired. Please sign in again.',
    'native.error.duplicateTracking': 'This tracking number is already in your delivery box.',
    'native.error.invalidResponse': 'The delivery service returned an invalid response.',
    'native.error.labelTooLong': 'Parcel names can be at most 80 characters.',
    'native.error.refreshFailed': 'Tracking refresh failed. Try again.',
    'native.error.refreshTimeout': 'The tracking refresh is taking longer than expected.',
    'native.error.serviceFailed': 'Delivery service failed ({{status}}).',
    'native.errorTitle': 'Something went wrong',
    'native.latest': 'Latest',
    'native.notificationsDenied': 'Notifications were not allowed.',
    'native.openSettings': 'Open iPhone Settings',
    'native.parcelMissing': 'This parcel is no longer in your delivery box.',
    'native.resetDemo': 'Reset demo data',
    'onboarding.notifications.connectionError': 'Notifications are allowed, but this development build could not finish connecting to Apple Push Notifications. You can retry from Notification Settings later.',
    'onboarding.notifications.continue': 'Continue to my parcels',
    'onboarding.notifications.enable': 'Enable notifications',
    'onboarding.notifications.enabledSubtitle': 'This iPhone is ready to receive the delivery updates you chose.',
    'onboarding.notifications.enabledTitle': 'Parcel alerts are ready',
    'onboarding.notifications.enabling': 'Enabling alerts…',
    'onboarding.notifications.eyebrow': 'One last choice',
    'onboarding.notifications.feature.delivery': 'Know when a parcel is out for delivery',
    'onboarding.notifications.feature.issues': 'Catch customs holds and missed attempts',
    'onboarding.notifications.feature.pickup': 'Get reminded when pickup is ready',
    'onboarding.notifications.fineTune': 'You stay in control. Fine-tune updates and quiet hours anytime in Notification Settings.',
    'onboarding.notifications.notNow': 'Not now',
    'onboarding.notifications.subtitle': 'Timely alerts help when a delivery needs you. We’ll only ask iOS for permission after you choose Enable.',
    'onboarding.notifications.title': 'Let important deliveries find you',
    'welcome.back': 'Back',
    'welcome.demo': 'Try the demo',
    'welcome.demoDescription': 'Demo parcels stay on this iPhone and do not require an account.',
    'welcome.feature.alerts': 'Get timely alerts for important delivery updates',
    'welcome.feature.private': 'Keep tracking numbers and history private to your account',
    'welcome.feature.track': 'Follow every parcel from announcement to arrival',
    'welcome.signIn': 'Sign in to my delivery box',
    'welcome.signInInstead': 'Sign in instead',
    'welcome.subtitle': 'Follow every delivery across the web and this iPhone.',
    'welcome.title': 'All your parcels in one place',
  },
  de: {
    'native.account': 'Konto',
    'native.apnsTokenError': 'Apple hat kein Benachrichtigungstoken zurückgegeben. Versuche es erneut mit einem signierten Entwicklungs-Build.',
    'native.auth.cancelled': 'Die Anmeldung wurde abgebrochen.',
    'native.auth.invalidResponse': 'Der Anmeldedienst hat eine ungültige Antwort zurückgegeben.',
    'native.auth.missingSession': 'Der Anmeldecode hat keine Sitzung erstellt.',
    'native.auth.notConfigured': 'Die Anmeldung ist nicht konfiguriert.',
    'native.auth.requestFailed': 'Anmeldung fehlgeschlagen ({{status}}).',
    'native.auth.saveSession': 'Die sichere Sitzung konnte nicht gespeichert werden.',
    'native.auth.secureRequest': 'Die sichere Anmeldeanfrage konnte nicht erstellt werden.',
    'native.configurationHelp': 'Füge deine öffentliche Supabase-URL und den Publishable Key zu Configuration/Local.xcconfig hinzu.',
    'native.deliveries': 'Sendungen',
    'native.deliveryProgress': 'Zustellfortschritt',
    'native.done': 'Fertig',
    'native.error.authenticationExpired': 'Deine Anmeldung ist abgelaufen. Bitte melde dich erneut an.',
    'native.error.duplicateTracking': 'Diese Sendungsnummer befindet sich bereits in deiner Paketbox.',
    'native.error.invalidResponse': 'Der Lieferdienst hat eine ungültige Antwort zurückgegeben.',
    'native.error.labelTooLong': 'Paketnamen dürfen höchstens 80 Zeichen lang sein.',
    'native.error.refreshFailed': 'Die Sendungsverfolgung konnte nicht aktualisiert werden. Versuche es erneut.',
    'native.error.refreshTimeout': 'Die Aktualisierung der Sendungsverfolgung dauert länger als erwartet.',
    'native.error.serviceFailed': 'Der Lieferdienst ist fehlgeschlagen ({{status}}).',
    'native.errorTitle': 'Etwas ist schiefgelaufen',
    'native.latest': 'Neueste',
    'native.notificationsDenied': 'Benachrichtigungen wurden nicht erlaubt.',
    'native.openSettings': 'iPhone-Einstellungen öffnen',
    'native.parcelMissing': 'Dieses Paket befindet sich nicht mehr in deiner Paketübersicht.',
    'native.resetDemo': 'Demodaten zurücksetzen',
    'onboarding.notifications.connectionError': 'Benachrichtigungen sind erlaubt, aber dieser Entwicklungs-Build konnte die Verbindung zu Apple Push Notifications nicht abschließen. Du kannst es später in den Benachrichtigungseinstellungen erneut versuchen.',
    'onboarding.notifications.continue': 'Weiter zu meinen Paketen',
    'onboarding.notifications.enable': 'Benachrichtigungen aktivieren',
    'onboarding.notifications.enabledSubtitle': 'Dieses iPhone ist bereit, deine ausgewählten Sendungsupdates zu empfangen.',
    'onboarding.notifications.enabledTitle': 'Paketmeldungen sind bereit',
    'onboarding.notifications.enabling': 'Meldungen werden aktiviert…',
    'onboarding.notifications.eyebrow': 'Eine letzte Wahl',
    'onboarding.notifications.feature.delivery': 'Erfahre, wenn ein Paket in Zustellung ist',
    'onboarding.notifications.feature.issues': 'Verpasse Zollstopps und Zustellversuche nicht',
    'onboarding.notifications.feature.pickup': 'Erhalte eine Erinnerung, wenn die Abholung bereit ist',
    'onboarding.notifications.fineTune': 'Du behältst die Kontrolle. Updates und Ruhezeiten kannst du jederzeit in den Benachrichtigungseinstellungen anpassen.',
    'onboarding.notifications.notNow': 'Nicht jetzt',
    'onboarding.notifications.subtitle': 'Rechtzeitige Meldungen helfen, wenn eine Lieferung dich braucht. iOS fragt erst nach deiner Zustimmung, wenn du Aktivieren wählst.',
    'onboarding.notifications.title': 'Wichtige Lieferungen finden dich',
    'welcome.back': 'Zurück',
    'welcome.demo': 'Demo ausprobieren',
    'welcome.demoDescription': 'Demopakete bleiben auf diesem iPhone und benötigen kein Konto.',
    'welcome.feature.alerts': 'Erhalte rechtzeitig Meldungen zu wichtigen Lieferupdates',
    'welcome.feature.private': 'Sendungsnummern und Verlauf bleiben in deinem Konto privat',
    'welcome.feature.track': 'Verfolge jedes Paket von der Ankündigung bis zur Ankunft',
    'welcome.signIn': 'Bei meiner Paketbox anmelden',
    'welcome.signInInstead': 'Stattdessen anmelden',
    'welcome.subtitle': 'Verfolge jede Lieferung im Web und auf diesem iPhone.',
    'welcome.title': 'Alle deine Pakete an einem Ort',
  },
  fr: {
    'native.account': 'Compte',
    'native.apnsTokenError': 'Apple n’a pas renvoyé de jeton de notification. Réessayez avec une version de développement signée.',
    'native.auth.cancelled': 'La connexion a été annulée.',
    'native.auth.invalidResponse': 'Le service d’authentification a renvoyé une réponse non valide.',
    'native.auth.missingSession': 'Le code de connexion n’a pas créé de session.',
    'native.auth.notConfigured': 'L’authentification n’est pas configurée.',
    'native.auth.requestFailed': 'Échec de la connexion ({{status}}).',
    'native.auth.saveSession': 'La session sécurisée n’a pas pu être enregistrée.',
    'native.auth.secureRequest': 'La demande de connexion sécurisée n’a pas pu être créée.',
    'native.configurationHelp': 'Ajoutez votre URL Supabase publique et votre clé publiable à Configuration/Local.xcconfig.',
    'native.deliveries': 'Livraisons',
    'native.deliveryProgress': 'Progression de la livraison',
    'native.done': 'Terminé',
    'native.error.authenticationExpired': 'Votre connexion a expiré. Veuillez vous reconnecter.',
    'native.error.duplicateTracking': 'Ce numéro de suivi se trouve déjà dans votre boîte de livraison.',
    'native.error.invalidResponse': 'Le service de livraison a renvoyé une réponse non valide.',
    'native.error.labelTooLong': 'Le nom d’un colis ne peut pas dépasser 80 caractères.',
    'native.error.refreshFailed': 'L’actualisation du suivi a échoué. Réessayez.',
    'native.error.refreshTimeout': 'L’actualisation du suivi prend plus de temps que prévu.',
    'native.error.serviceFailed': 'Échec du service de livraison ({{status}}).',
    'native.errorTitle': 'Un problème est survenu',
    'native.latest': 'Dernier',
    'native.notificationsDenied': 'Les notifications n’ont pas été autorisées.',
    'native.openSettings': 'Ouvrir les réglages iPhone',
    'native.parcelMissing': 'Ce colis ne se trouve plus dans votre liste de livraisons.',
    'native.resetDemo': 'Réinitialiser les données de démo',
    'onboarding.notifications.connectionError': 'Les notifications sont autorisées, mais cette version de développement n’a pas pu terminer la connexion aux notifications push Apple. Vous pourrez réessayer plus tard dans les réglages des notifications.',
    'onboarding.notifications.continue': 'Voir mes colis',
    'onboarding.notifications.enable': 'Activer les notifications',
    'onboarding.notifications.enabledSubtitle': 'Cet iPhone est prêt à recevoir les mises à jour de livraison que vous avez choisies.',
    'onboarding.notifications.enabledTitle': 'Les alertes colis sont prêtes',
    'onboarding.notifications.enabling': 'Activation des alertes…',
    'onboarding.notifications.eyebrow': 'Un dernier choix',
    'onboarding.notifications.feature.delivery': 'Savoir quand un colis est en livraison',
    'onboarding.notifications.feature.issues': 'Repérer un blocage en douane ou une tentative manquée',
    'onboarding.notifications.feature.pickup': 'Être prévenu quand un retrait est prêt',
    'onboarding.notifications.fineTune': 'Vous gardez le contrôle. Ajustez les alertes et les heures silencieuses à tout moment dans les réglages des notifications.',
    'onboarding.notifications.notNow': 'Pas maintenant',
    'onboarding.notifications.subtitle': 'Les alertes utiles vous préviennent lorsqu’une livraison a besoin de vous. iOS ne demandera votre autorisation qu’après avoir choisi Activer.',
    'onboarding.notifications.title': 'Laissez les livraisons importantes vous trouver',
    'welcome.back': 'Retour',
    'welcome.demo': 'Essayer la démo',
    'welcome.demoDescription': 'Les colis de démonstration restent sur cet iPhone et ne nécessitent aucun compte.',
    'welcome.feature.alerts': 'Recevez à temps les alertes de livraison importantes',
    'welcome.feature.private': 'Gardez vos numéros de suivi et votre historique privés',
    'welcome.feature.track': 'Suivez chaque colis de son annonce à son arrivée',
    'welcome.signIn': 'Ouvrir ma boîte de livraison',
    'welcome.signInInstead': 'Se connecter à la place',
    'welcome.subtitle': 'Suivez chaque livraison sur le web et sur cet iPhone.',
    'welcome.title': 'Tous vos colis au même endroit',
  },
  it: {
    'native.account': 'Account',
    'native.apnsTokenError': 'Apple non ha restituito un token di notifica. Riprova con una build di sviluppo firmata.',
    'native.auth.cancelled': 'L’accesso è stato annullato.',
    'native.auth.invalidResponse': 'Il servizio di autenticazione ha restituito una risposta non valida.',
    'native.auth.missingSession': 'Il codice di accesso non ha creato una sessione.',
    'native.auth.notConfigured': 'L’autenticazione non è configurata.',
    'native.auth.requestFailed': 'Accesso non riuscito ({{status}}).',
    'native.auth.saveSession': 'Non è stato possibile salvare la sessione sicura.',
    'native.auth.secureRequest': 'Non è stato possibile creare una richiesta di accesso sicura.',
    'native.configurationHelp': 'Aggiungi l’URL Supabase pubblico e la chiave pubblicabile a Configuration/Local.xcconfig.',
    'native.deliveries': 'Consegne',
    'native.deliveryProgress': 'Avanzamento della consegna',
    'native.done': 'Fine',
    'native.error.authenticationExpired': 'La sessione è scaduta. Accedi di nuovo.',
    'native.error.duplicateTracking': 'Questo numero di tracciamento è già presente nella tua casella consegne.',
    'native.error.invalidResponse': 'Il servizio di consegna ha restituito una risposta non valida.',
    'native.error.labelTooLong': 'I nomi dei pacchi possono contenere al massimo 80 caratteri.',
    'native.error.refreshFailed': 'Aggiornamento del tracciamento non riuscito. Riprova.',
    'native.error.refreshTimeout': 'L’aggiornamento del tracciamento richiede più tempo del previsto.',
    'native.error.serviceFailed': 'Servizio di consegna non riuscito ({{status}}).',
    'native.errorTitle': 'Qualcosa è andato storto',
    'native.latest': 'Più recente',
    'native.notificationsDenied': 'Le notifiche non sono state autorizzate.',
    'native.openSettings': 'Apri le impostazioni iPhone',
    'native.parcelMissing': 'Questo pacco non è più presente nell’elenco delle consegne.',
    'native.resetDemo': 'Reimposta i dati demo',
    'onboarding.notifications.connectionError': 'Le notifiche sono consentite, ma questa build di sviluppo non ha completato la connessione alle notifiche push di Apple. Puoi riprovare più tardi dalle impostazioni delle notifiche.',
    'onboarding.notifications.continue': 'Vai ai miei pacchi',
    'onboarding.notifications.enable': 'Attiva le notifiche',
    'onboarding.notifications.enabledSubtitle': 'Questo iPhone è pronto a ricevere gli aggiornamenti di consegna che hai scelto.',
    'onboarding.notifications.enabledTitle': 'Gli avvisi sui pacchi sono pronti',
    'onboarding.notifications.enabling': 'Attivazione avvisi…',
    'onboarding.notifications.eyebrow': 'Un’ultima scelta',
    'onboarding.notifications.feature.delivery': 'Scopri quando un pacco è in consegna',
    'onboarding.notifications.feature.issues': 'Intervieni per dogana e tentativi non riusciti',
    'onboarding.notifications.feature.pickup': 'Ricevi un promemoria quando il ritiro è pronto',
    'onboarding.notifications.fineTune': 'Hai sempre il controllo. Modifica aggiornamenti e ore silenziose in qualsiasi momento nelle impostazioni delle notifiche.',
    'onboarding.notifications.notNow': 'Non ora',
    'onboarding.notifications.subtitle': 'Gli avvisi tempestivi ti aiutano quando una consegna richiede attenzione. iOS chiederà il permesso solo dopo che avrai scelto Attiva.',
    'onboarding.notifications.title': 'Lascia che le consegne importanti ti trovino',
    'welcome.back': 'Indietro',
    'welcome.demo': 'Prova la demo',
    'welcome.demoDescription': 'I pacchi demo restano su questo iPhone e non richiedono un account.',
    'welcome.feature.alerts': 'Ricevi avvisi tempestivi sugli aggiornamenti importanti',
    'welcome.feature.private': 'Mantieni privati numeri di tracciamento e cronologia',
    'welcome.feature.track': 'Segui ogni pacco dall’annuncio all’arrivo',
    'welcome.signIn': 'Accedi alla mia casella consegne',
    'welcome.signInInstead': 'Accedi invece',
    'welcome.subtitle': 'Segui ogni consegna sul web e su questo iPhone.',
    'welcome.title': 'Tutti i tuoi pacchi in un unico posto',
  },
};

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported localization property at ${node.pos}`);
}

function stringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  throw new Error(`Localization value must be a string at ${node.pos}`);
}

function evaluateObject(node) {
  const result = {};
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!ts.isIdentifier(property.expression)) {
        throw new Error(`Unsupported localization spread at ${property.pos}`);
      }
      Object.assign(result, objects.get(property.expression.text));
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      result[propertyName(property.name)] = stringValue(property.initializer);
    }
  }
  return result;
}

for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (!['en', 'de', 'fr', 'it'].includes(declaration.name.text)) continue;
    const expression = ts.isAsExpression(declaration.initializer)
      ? declaration.initializer.expression
      : declaration.initializer;
    if (ts.isObjectLiteralExpression(expression)) {
      objects.set(declaration.name.text, evaluateObject(expression));
      directKeys.set(
        declaration.name.text,
        new Set(expression.properties.filter(ts.isPropertyAssignment).map((property) =>
          propertyName(property.name))),
      );
    }
  }
}

const englishWebKeys = directKeys.get('en');
if (!englishWebKeys) throw new Error('Missing English localization catalog');
for (const code of ['de', 'fr', 'it']) {
  const keys = directKeys.get(code);
  if (!keys) throw new Error(`Missing ${code} localization catalog`);
  const missing = [...englishWebKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !englishWebKeys.has(key));
  if (missing.length || extra.length) {
    throw new Error(
      `${code} must define every web translation directly. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`,
    );
  }
}

const englishNativeKeys = new Set(Object.keys(nativeMessages.en));
for (const code of ['de', 'fr', 'it']) {
  const keys = new Set(Object.keys(nativeMessages[code]));
  const missing = [...englishNativeKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !englishNativeKeys.has(key));
  if (missing.length || extra.length) {
    throw new Error(
      `${code} native copy does not match English. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`,
    );
  }
}

const languages = Object.fromEntries(
  ['en', 'de', 'fr', 'it'].map((code) => {
    const messages = objects.get(code);
    if (!messages) throw new Error(`Missing ${code} localization catalog`);
    const merged = { ...messages, ...nativeMessages[code] };
    return [code, Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))];
  }),
);

const swiftSources = fs.readdirSync(path.join(root, 'ios', 'SwissDeliveryTracker'))
  .filter((name) => name.endsWith('.swift'))
  .map((name) => fs.readFileSync(path.join(root, 'ios', 'SwissDeliveryTracker', name), 'utf8'))
  .join('\n');
const localizationPrefixes = new Set(Object.keys(languages.en).map((key) => key.split('.')[0]));
const referencedKeys = new Set(
  [...swiftSources.matchAll(/"([a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)"/g)]
    .map((match) => match[1])
    .filter((key) => localizationPrefixes.has(key.split('.')[0])),
);
const missingNativeReferences = [...referencedKeys].filter((key) => !(key in languages.en));
if (missingNativeReferences.length) {
  throw new Error(
    `Native localization references are missing from the generated catalog: ${missingNativeReferences.sort().join(', ')}`,
  );
}

const resources = path.join(root, 'ios', 'SwissDeliveryTracker', 'Resources');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'openapi.json'), 'utf8'));
const apiFixture = JSON.parse(fs.readFileSync(
  path.join(root, 'contracts', 'fixtures', 'delivery-api.json'),
  'utf8',
));
const outputs = new Map([
  ['Localization.json', `${JSON.stringify(languages, null, 2)}\n`],
  ['CarrierCatalog.json', `${JSON.stringify({ 'x-carriers': contract['x-carriers'] }, null, 2)}\n`],
  ['ContractFixtures.json', `${JSON.stringify(apiFixture, null, 2)}\n`],
]);

if (process.argv.includes('--check')) {
  const stale = [...outputs].flatMap(([name, expected]) => {
    const target = path.join(resources, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    return current === expected ? [] : [path.relative(root, target)];
  });
  if (stale.length) {
    throw new Error(`Generated iOS resources are stale: ${stale.join(', ')}. Run npm run ios:resources.`);
  }
  console.log('Generated iOS resources are current.');
} else {
  fs.mkdirSync(resources, { recursive: true });
  for (const [name, contents] of outputs) {
    fs.writeFileSync(path.join(resources, name), contents);
  }
  console.log(`Generated iOS resources for ${Object.keys(languages).length} languages and ${Object.keys(contract['x-carriers']).length} carriers.`);
}
