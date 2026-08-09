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

// Copy that exists only in the native shell still belongs in the generated
// catalog. Keeping it here means the checked-in resource remains reproducible
// from the web catalog instead of becoming a second hand-maintained file.
const nativeMessages = {
  en: {
    'native.account': 'Account',
    'native.apnsTokenError': 'Apple did not return a notification token. Try again on a signed development build.',
    'native.deliveries': 'Deliveries',
    'native.deliveryProgress': 'Delivery progress',
    'native.done': 'Done',
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
  },
  de: {
    'native.account': 'Konto',
    'native.apnsTokenError': 'Apple hat kein Benachrichtigungstoken zurückgegeben. Versuche es erneut mit einem signierten Entwicklungs-Build.',
    'native.deliveries': 'Sendungen',
    'native.deliveryProgress': 'Zustellfortschritt',
    'native.done': 'Fertig',
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
  },
  fr: {
    'native.account': 'Compte',
    'native.apnsTokenError': 'Apple n’a pas renvoyé de jeton de notification. Réessayez avec une version de développement signée.',
    'native.deliveries': 'Livraisons',
    'native.deliveryProgress': 'Progression de la livraison',
    'native.done': 'Terminé',
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
  },
  it: {
    'native.account': 'Account',
    'native.apnsTokenError': 'Apple non ha restituito un token di notifica. Riprova con una build di sviluppo firmata.',
    'native.deliveries': 'Consegne',
    'native.deliveryProgress': 'Avanzamento della consegna',
    'native.done': 'Fine',
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
    }
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

const resources = path.join(root, 'ios', 'SwissDeliveryTracker', 'Resources');
fs.mkdirSync(resources, { recursive: true });
fs.writeFileSync(
  path.join(resources, 'Localization.json'),
  `${JSON.stringify(languages, null, 2)}\n`,
);

const contract = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'openapi.json'), 'utf8'));
fs.writeFileSync(
  path.join(resources, 'CarrierCatalog.json'),
  `${JSON.stringify({ 'x-carriers': contract['x-carriers'] }, null, 2)}\n`,
);

console.log(`Generated iOS resources for ${Object.keys(languages).length} languages and ${Object.keys(contract['x-carriers']).length} carriers.`);
