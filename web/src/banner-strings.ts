/**
 * Every string the drop-in banner shows, in English, French and Spanish. Nothing else in the
 * banner holds user-facing text.
 */

import type { WritNavigator } from "./types.js";

/** Languages the banner speaks. */
export type WritBannerLocale = "en" | "fr" | "es";

/** The banner's languages, in fallback order. */
export const WRIT_BANNER_LOCALES: readonly WritBannerLocale[] = Object.freeze(["en", "fr", "es"]);

/** The banner's strings for one language. `browser` is "Chrome" or "Edge". */
export interface BannerStrings {
  region(app: string): string;
  dismiss: string;
  checking: string;
  retry: string;
  reload: string;

  extensionTitle(browser: string): string;
  extensionBody(app: string): string;
  extensionButton(browser: string): string;
  extensionInstalled: string;
  extensionUpdateTitle(browser: string): string;
  extensionUpdateBody(app: string): string;
  extensionUpdateButton(browser: string): string;
  extensionUpdated: string;
  extensionStillMissing(browser: string): string;

  unsupportedTitle: string;
  unsupportedBody(app: string): string;

  desktopTitle: string;
  desktopBody(app: string): string;
  desktopButton: string;
  desktopInstalled: string;
  desktopUpdateTitle: string;
  desktopUpdateBody(app: string): string;
  desktopUpdateButton: string;
  desktopUpdated: string;
  desktopStillMissing: string;

  engineTitle: string;
  engineBody: string;
  engineStillMissing: string;

  vaultTitle: string;
  vaultBody: string;
  vaultStillLocked: string;

  installTitle(name: string): string;
  installBody(app: string): string;
  installButton(name: string): string;
  updateTitle(name: string): string;
  updateBody(app: string): string;
  updateButton(name: string): string;
  connectTitle(app: string): string;
  connectBody(app: string): string;
  connectButton: string;
  waitingForConsent: string;

  declinedTitle: string;
  declinedBody(app: string): string;
  tryAgain: string;

  errorTitle: string;
  errorBody: string;
  rateLimitedBody: string;

  /** A linked workflow (CONTRACT.md §11) Writ cannot get right now, or that the site withdrew. */
  unavailableTitle(name: string): string;
  /** `RECIPE_UNAVAILABLE`: Writ could not reach the site's Writ Cloud; Retry. */
  unavailableBody(app: string): string;
  /** `PUBLICATION_REVOKED`: the site withdrew the workflow; nothing to retry. */
  withdrawnBody(app: string): string;

  /** Writ Bridge, `required`: the banner cannot be closed. */
  requiredNote(app: string): string;
  /** Writ Bridge, `recommended`: closing the banner keeps the site working (on Writ Cloud). */
  recommendedNote(app: string): string;
}

const EN: BannerStrings = {
  region: (app) => `Set up Writ for ${app}`,
  dismiss: "Dismiss",
  checking: "Checking…",
  retry: "Retry",
  reload: "Reload page",

  extensionTitle: (browser) => `Add Writ to ${browser}`,
  extensionBody: (app) => `${app} runs on your own computer through Writ. Start with the Writ extension.`,
  extensionButton: (browser) => `Writ for ${browser}`,
  extensionInstalled: "I installed it",
  extensionUpdateTitle: (browser) => `Update Writ for ${browser}`,
  extensionUpdateBody: (app) => `${app} needs a newer version of the Writ extension.`,
  extensionUpdateButton: (browser) => `Update Writ for ${browser}`,
  extensionUpdated: "I updated it",
  extensionStillMissing: (browser) =>
    `Writ for ${browser} was not found yet. If you just added it, reload this page.`,

  unsupportedTitle: "Writ needs Chrome or Edge on a computer",
  unsupportedBody: (app) =>
    `To run ${app} on your own computer, open this page in Google Chrome or Microsoft Edge on a desktop or laptop.`,

  desktopTitle: "Get Writ desktop",
  desktopBody: (app) => `The extension is ready. Writ desktop is what runs ${app} on this computer.`,
  desktopButton: "Get Writ desktop",
  desktopInstalled: "I installed it",
  desktopUpdateTitle: "Update Writ desktop",
  desktopUpdateBody: (app) => `${app} needs a newer version of Writ desktop.`,
  desktopUpdateButton: "Update Writ desktop",
  desktopUpdated: "I updated it",
  desktopStillMissing: "Writ desktop was not found yet. Open it once after installing, then check again.",

  engineTitle: "Open Writ on this computer, then retry",
  engineBody: "Writ desktop is installed but not running.",
  engineStillMissing: "Writ is still not running.",

  vaultTitle: "Unlock Writ, then retry",
  vaultBody: "Writ is locked on this computer.",
  vaultStillLocked: "Writ is still locked.",

  installTitle: (name) => `Install ${name} on this computer`,
  installBody: (app) =>
    `One click. Writ shows what it does and where it connects before anything runs. Passwords you type stay on this computer; ${app} never sees them.`,
  installButton: (name) => `Install ${name} (one click)`,
  updateTitle: (name) => `Update ${name}`,
  updateBody: (app) => `${app} has a new version. Writ shows what it does before anything runs.`,
  updateButton: (name) => `Update ${name} (one click)`,
  connectTitle: (app) => `Connect ${app} to Writ`,
  connectBody: (app) => `Choose which of your Writ workflows ${app} may run. You decide in a Writ window.`,
  connectButton: "Connect",
  waitingForConsent: "Answer in the Writ window…",

  declinedTitle: "Not now",
  declinedBody: (app) => `${app} will not use Writ on this computer until you allow it.`,
  tryAgain: "Try again",

  errorTitle: "Writ could not finish",
  errorBody: "Something went wrong. Try again in a moment.",
  rateLimitedBody: "Too many attempts. Wait a moment, then try again.",

  unavailableTitle: (name) => `${name} is unavailable`,
  unavailableBody: (app) => `Writ could not get it from ${app}. Check your internet connection, then retry.`,
  withdrawnBody: (app) => `${app} withdrew it. It will not run on this computer until ${app} offers it again.`,

  requiredNote: (app) => `${app} needs Writ on this computer to continue.`,
  recommendedNote: (app) => `Optional. If you close this, ${app} keeps working without Writ.`,
};

const FR: BannerStrings = {
  region: (app) => `Configurer Writ pour ${app}`,
  dismiss: "Fermer",
  checking: "Vérification…",
  retry: "Réessayer",
  reload: "Recharger la page",

  extensionTitle: (browser) => `Ajoutez Writ à ${browser}`,
  extensionBody: (app) =>
    `${app} fonctionne sur votre propre ordinateur grâce à Writ. Commencez par l’extension Writ.`,
  extensionButton: (browser) => `Writ pour ${browser}`,
  extensionInstalled: "Je l’ai installée",
  extensionUpdateTitle: (browser) => `Mettez à jour Writ pour ${browser}`,
  extensionUpdateBody: (app) => `${app} nécessite une version plus récente de l’extension Writ.`,
  extensionUpdateButton: (browser) => `Mettre à jour Writ pour ${browser}`,
  extensionUpdated: "Je l’ai mise à jour",
  extensionStillMissing: (browser) =>
    `Writ pour ${browser} est introuvable pour l’instant. Si vous venez de l’ajouter, rechargez cette page.`,

  unsupportedTitle: "Writ fonctionne avec Chrome ou Edge sur ordinateur",
  unsupportedBody: (app) =>
    `Pour utiliser ${app} sur votre propre ordinateur, ouvrez cette page dans Google Chrome ou Microsoft Edge sur un ordinateur de bureau ou portable.`,

  desktopTitle: "Installez Writ desktop",
  desktopBody: (app) =>
    `L’extension est prête. C’est Writ desktop qui exécute ${app} sur cet ordinateur.`,
  desktopButton: "Obtenir Writ desktop",
  desktopInstalled: "Je l’ai installé",
  desktopUpdateTitle: "Mettez à jour Writ desktop",
  desktopUpdateBody: (app) => `${app} nécessite une version plus récente de Writ desktop.`,
  desktopUpdateButton: "Mettre à jour Writ desktop",
  desktopUpdated: "Je l’ai mis à jour",
  desktopStillMissing:
    "Writ desktop est introuvable pour l’instant. Ouvrez-le une fois après l’installation, puis vérifiez de nouveau.",

  engineTitle: "Ouvrez Writ sur cet ordinateur, puis réessayez",
  engineBody: "Writ desktop est installé, mais n’est pas ouvert.",
  engineStillMissing: "Writ n’est toujours pas ouvert.",

  vaultTitle: "Déverrouillez Writ, puis réessayez",
  vaultBody: "Writ est verrouillé sur cet ordinateur.",
  vaultStillLocked: "Writ est toujours verrouillé.",

  installTitle: (name) => `Installez ${name} sur cet ordinateur`,
  installBody: (app) =>
    `En un clic. Writ vous montre ce qu’il fait et où il se connecte avant toute exécution. Les mots de passe que vous saisissez restent sur cet ordinateur ; ${app} ne les voit jamais.`,
  installButton: (name) => `Installer ${name} (en un clic)`,
  updateTitle: (name) => `Mettez à jour ${name}`,
  updateBody: (app) =>
    `${app} propose une nouvelle version. Writ vous montre ce qu’elle fait avant toute exécution.`,
  updateButton: (name) => `Mettre à jour ${name} (en un clic)`,
  connectTitle: (app) => `Connectez ${app} à Writ`,
  connectBody: (app) =>
    `Choisissez les workflows Writ que ${app} peut exécuter. Vous décidez dans une fenêtre Writ.`,
  connectButton: "Connecter",
  waitingForConsent: "Répondez dans la fenêtre Writ…",

  declinedTitle: "Pas maintenant",
  declinedBody: (app) =>
    `${app} n’utilisera pas Writ sur cet ordinateur tant que vous ne l’aurez pas autorisé.`,
  tryAgain: "Réessayer",

  errorTitle: "Writ n’a pas pu terminer",
  errorBody: "Un problème est survenu. Réessayez dans un instant.",
  rateLimitedBody: "Trop de tentatives. Patientez un instant, puis réessayez.",

  unavailableTitle: (name) => `${name} est indisponible`,
  unavailableBody: (app) =>
    `Writ n’a pas pu le récupérer auprès de ${app}. Vérifiez votre connexion Internet, puis réessayez.`,
  withdrawnBody: (app) =>
    `${app} l’a retiré. Il ne s’exécutera plus sur cet ordinateur tant que ${app} ne le proposera pas de nouveau.`,

  requiredNote: (app) => `${app} a besoin de Writ sur cet ordinateur pour continuer.`,
  recommendedNote: (app) =>
    `Facultatif. Si vous fermez ce message, ${app} continue de fonctionner sans Writ.`,
};

const ES: BannerStrings = {
  region: (app) => `Configurar Writ para ${app}`,
  dismiss: "Cerrar",
  checking: "Comprobando…",
  retry: "Reintentar",
  reload: "Recargar la página",

  extensionTitle: (browser) => `Añade Writ a ${browser}`,
  extensionBody: (app) =>
    `${app} funciona en tu propio equipo gracias a Writ. Empieza por la extensión de Writ.`,
  extensionButton: (browser) => `Writ para ${browser}`,
  extensionInstalled: "Ya la instalé",
  extensionUpdateTitle: (browser) => `Actualiza Writ para ${browser}`,
  extensionUpdateBody: (app) => `${app} necesita una versión más reciente de la extensión de Writ.`,
  extensionUpdateButton: (browser) => `Actualizar Writ para ${browser}`,
  extensionUpdated: "Ya la actualicé",
  extensionStillMissing: (browser) =>
    `Todavía no se encuentra Writ para ${browser}. Si acabas de añadirla, recarga esta página.`,

  unsupportedTitle: "Writ necesita Chrome o Edge en un equipo",
  unsupportedBody: (app) =>
    `Para usar ${app} en tu propio equipo, abre esta página en Google Chrome o Microsoft Edge en un equipo de escritorio o portátil.`,

  desktopTitle: "Instala Writ desktop",
  desktopBody: (app) => `La extensión está lista. Writ desktop es lo que ejecuta ${app} en este equipo.`,
  desktopButton: "Descargar Writ desktop",
  desktopInstalled: "Ya lo instalé",
  desktopUpdateTitle: "Actualiza Writ desktop",
  desktopUpdateBody: (app) => `${app} necesita una versión más reciente de Writ desktop.`,
  desktopUpdateButton: "Actualizar Writ desktop",
  desktopUpdated: "Ya lo actualicé",
  desktopStillMissing:
    "Todavía no se encuentra Writ desktop. Ábrelo una vez después de instalarlo y vuelve a comprobar.",

  engineTitle: "Abre Writ en este equipo y vuelve a intentarlo",
  engineBody: "Writ desktop está instalado, pero no está abierto.",
  engineStillMissing: "Writ todavía no está abierto.",

  vaultTitle: "Desbloquea Writ y vuelve a intentarlo",
  vaultBody: "Writ está bloqueado en este equipo.",
  vaultStillLocked: "Writ sigue bloqueado.",

  installTitle: (name) => `Instala ${name} en este equipo`,
  installBody: (app) =>
    `Con un clic. Writ te muestra qué hace y a dónde se conecta antes de ejecutar nada. Las contraseñas que escribas se quedan en este equipo; ${app} nunca las ve.`,
  installButton: (name) => `Instalar ${name} (un clic)`,
  updateTitle: (name) => `Actualiza ${name}`,
  updateBody: (app) => `${app} tiene una nueva versión. Writ te muestra qué hace antes de ejecutar nada.`,
  updateButton: (name) => `Actualizar ${name} (un clic)`,
  connectTitle: (app) => `Conecta ${app} con Writ`,
  connectBody: (app) => `Elige qué flujos de Writ puede ejecutar ${app}. Tú decides en una ventana de Writ.`,
  connectButton: "Conectar",
  waitingForConsent: "Responde en la ventana de Writ…",

  declinedTitle: "Ahora no",
  declinedBody: (app) => `${app} no usará Writ en este equipo hasta que lo permitas.`,
  tryAgain: "Volver a intentar",

  errorTitle: "Writ no pudo terminar",
  errorBody: "Algo salió mal. Vuelve a intentarlo en un momento.",
  rateLimitedBody: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",

  unavailableTitle: (name) => `${name} no está disponible`,
  unavailableBody: (app) => `Writ no pudo obtenerlo de ${app}. Comprueba tu conexión a internet y vuelve a intentarlo.`,
  withdrawnBody: (app) => `${app} lo retiró. No volverá a ejecutarse en este equipo hasta que ${app} lo ofrezca de nuevo.`,

  requiredNote: (app) => `${app} necesita Writ en este equipo para continuar.`,
  recommendedNote: (app) => `Opcional. Si cierras este aviso, ${app} sigue funcionando sin Writ.`,
};

const STRINGS: Readonly<Record<WritBannerLocale, BannerStrings>> = Object.freeze({ en: EN, fr: FR, es: ES });

/** The strings for a language. */
export function bannerStrings(locale: WritBannerLocale): BannerStrings {
  return STRINGS[locale];
}

/** True for a language the banner speaks. */
export function isBannerLocale(value: unknown): value is WritBannerLocale {
  return typeof value === "string" && (WRIT_BANNER_LOCALES as readonly string[]).includes(value);
}

/**
 * The banner's language: `requested` when given, else the visitor's first preferred language
 * the banner speaks (`navigator.languages`, then `navigator.language`), else English.
 */
export function resolveBannerLocale(
  requested: WritBannerLocale | undefined,
  nav: WritNavigator | undefined,
): WritBannerLocale {
  if (requested !== undefined) return requested;
  const preferred: string[] = [];
  if (nav !== undefined && Array.isArray(nav.languages)) {
    for (const tag of nav.languages) if (typeof tag === "string") preferred.push(tag);
  }
  if (nav !== undefined && typeof nav.language === "string") preferred.push(nav.language);
  for (const tag of preferred) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
    if (isBannerLocale(primary)) return primary;
  }
  return "en";
}
