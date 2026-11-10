import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/app";

export const messages = {
  // Errors from app, notification, and secret storage actions.
  "error.app.externalLinkProtocol": "Seuls les liens HTTP(S) peuvent s’ouvrir dans le navigateur externe.",
  "error.app.notificationsUnsupported": "Ce système ne prend pas en charge les notifications de bureau.",
  "error.app.notificationSettingsMissing": "Ce système n’a pas de page de réglages des notifications.",
  "error.app.notReady": "OpenBot n’est pas prêt.",
  "error.app.macSecureStorageUnavailable": "Le stockage sécurisé de macOS n’est pas disponible.",
  "error.app.secretStorageUnavailable": "Le stockage des secrets du système n’est pas disponible.",
  "error.app.remoteIdentityUnavailable": "L’identité de l’hôte distant n’est pas disponible.",
  "error.app.iceServersMissing": "Remote Signal n’a pas encore fourni de serveurs ICE.",
  "error.app.finishLocalTest": "Terminez le test local avant de changer d’écran.",
  "error.app.serverUrlInvalid":
    "L’URL du service de comptes doit être une adresse https:, ou une adresse http: sur cet ordinateur.",
  "error.app.serverUrlSignalInvalid":
    "L’URL de Signal doit être une adresse wss: sans nom d’utilisateur ni mot de passe.",
} as const satisfies PartialTranslation<typeof source>;
